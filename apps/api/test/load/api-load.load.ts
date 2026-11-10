// Load test of the API (spec §15 phase 7): 10 workbooks × 7 sheets × 500 rows
// by default (see vitest.load.config.ts). Phases, in order, each its own test
// so vitest reports its wall time too:
//
//   1. save and read      POST /api/workbooks, PUT …/snapshot, GET /api/workbooks/:id
//   2. room               two editors join each workbook's room; ops applied and acked
//   3. link + outbound    the wizard's POST …/link, then every task created in the fake Basecamp
//   4. detection          1% of the rows edited and saved; detection, queue, Basecamp writes
//   5. reconciliation     50 to-dos changed in Basecamp; the 15-minute run, then a run with no change
//   6. internal API       GET /api/v1/stats over every workbook
//
// Basecamp's pace: the fake answers at once, so the production rate limiter
// (`createBasecampLimiter`, spec §9.2.9) runs on a virtual clock: every wait it
// asks for is added to `pace.waitedMs` instead of being slept. A phase's
// "paced" time is its measured time plus the limiter's waits: what the same
// requests take when Basecamp's limit is respected (docs/load-test.md §2).
//
// Timings are read inside workerd with Date.now(), which advances at I/O only
// (CPU-only stretches between two I/O calls are not seen). The wall time of
// each phase is the test duration vitest prints. Local Miniflare is not
// Cloudflare: these numbers compare runs of this script, they do not predict
// production latency (docs/load-test.md).

import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { createBasecampLimiter } from '@naf-sheets/basecamp'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type { LinkPlan, WorkbookResponse } from '@naf-sheets/shared'
import { newTokenSecret, sha256Hex } from '../../src/phase7'
import { addMember, call, json, seedMember } from '../helpers'
import type { SeededMember } from '../helpers'
import { clientId, opId, openRoom, setValue } from '../room/ws-client'
import type { TestSocket } from '../room/ws-client'
import { defaultSheetPlan, drainOutbound, harness, linkService, linkUser, reconcile, seedProjectPeople } from '../sync/harness'
import type { Harness } from '../sync/harness'
import type { FakePerson, RecordedCall } from '../sync/fake-basecamp'

interface LoadConfig {
  workbooks: number
  sheets: number
  rows: number
  syncWorkbooks: number
  roomOps: number
  /** `max_batch_size` of the bc-outbound consumer in wrangler.toml. */
  outboundBatch: number
}

const CONFIG = JSON.parse((env as unknown as { LOAD_CONFIG: string }).LOAD_CONFIG) as LoadConfig

type Cell = { v?: string | number; s?: string }
type Snap = { id: string; name: string; sheetOrder: string[]; styles?: Record<string, unknown>; sheets: Record<string, Record<string, unknown> & { cellData: Record<number, Record<number, Cell>> }> }

function stats(values: number[]): { n: number; min: number; median: number; p95: number; max: number; total: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0
  return { n: sorted.length, min: sorted[0] ?? 0, median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0, total: sorted.reduce((a, b) => a + b, 0) }
}

function report(phase: string, data: Record<string, unknown>): void {
  console.log(`LOAD_RESULT ${JSON.stringify({ phase, config: CONFIG, ...data })}`)
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now()
  const out = await work()
  return [out, Date.now() - t0]
}

/** The limiter's virtual clock: waits are counted, never slept; `idleMs` is time let pass between phases (not counted). */
const pace = { waitedMs: 0, idleMs: 0 }
const paceNow = () => Date.now() + pace.waitedMs + pace.idleMs
/** Lets `ms` of virtual time pass with no request (the window empties), e.g. the 15 minutes between two cron runs. */
const idle = (ms: number) => {
  pace.idleMs += ms
}
const paceSleep = async (ms: number): Promise<void> => {
  pace.waitedMs += Math.max(0, ms)
}

/** Basecamp requests by kind (method and route), conditional reads apart. */
function requestKinds(calls: readonly RecordedCall[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of calls) {
    const route = c.path
      .replace(/\/\d+/g, '/:id')
      .replace(/\.json$/, '')
    const key = `${c.method} ${route}${c.query.get('completed') === 'true' ? '?completed' : ''}${c.headers['if-none-match'] ? ' (If-None-Match)' : ''}`
    out[key] = (out[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
}

/** Requests, their kinds and the limiter's waits during `work`. */
async function measured<T>(work: () => Promise<T>): Promise<{ out: T; ms: number; requests: number; kinds: Record<string, number>; limiterWaitMs: number; pacedMs: number }> {
  const calls0 = h.fake.calls.length
  const waited0 = pace.waitedMs
  const [out, ms] = await timed(work)
  const calls = h.fake.calls.slice(calls0)
  const limiterWaitMs = pace.waitedMs - waited0
  return { out, ms, requests: calls.length, kinds: requestKinds(calls), limiterWaitMs, pacedMs: ms + limiterWaitMs }
}

const PEOPLE = ['سارة القحطاني', 'خالد العمري', 'نورة الشهري', 'فهد العتيبي']
const SHEET_NAMES = ['المحتوى', 'التصميم', 'الإعلام', 'الفعاليات', 'التقارير', 'الميزانية', 'المتابعة']

function date(offset: number): string {
  const d = new Date(Date.UTC(2026, 10, 1 + (offset % 90)))
  return d.toISOString().slice(0, 10)
}

/** One task sheet: the §7.1 default columns, `rows` task rows of realistic text. */
function taskSheet(id: string, name: string, sheetIndex: number, rows: number): Snap['sheets'][string] {
  const cellData: Record<number, Record<number, Cell>> = { 0: Object.fromEntries(DEFAULT_COLUMNS.map((v, c) => [c, { v, s: 'header' }])) }
  for (let r = 1; r <= rows; r++) {
    const line: Record<number, Cell> = {
      0: { v: `مهمة ${r} في ${name}: إعداد ومراجعة واعتماد` },
      1: { v: PEOPLE[(r + sheetIndex) % PEOPLE.length]! },
      2: { v: date(r) },
      3: { v: date(r + 14) },
      4: { v: r % 5 === 0 ? 'منجز' : 'قيد التنفيذ' },
    }
    if (r % 10 === 0) line[6] = { v: 'يحتاج مراجعة قانونية قبل النشر' }
    cellData[r] = line
  }
  return { id, name, rowCount: Math.max(1000, rows + 100), columnCount: 26, rightToLeft: 1, defaultStyle: { ff: 'Thmanyah Sans' }, cellData }
}

interface LoadedWorkbook {
  id: string
  owner: SeededMember
  version: number
  sheets: Array<{ id: string; univerSheetId: string }>
  bytes: number
}

let h: Harness
let admin: SeededMember
let editor: SeededMember
let ownerPerson: FakePerson
const people: FakePerson[] = []
const workbooks: LoadedWorkbook[] = []

beforeAll(async () => {
  h = harness({ limiter: createBasecampLimiter({ now: paceNow, sleep: paceSleep }) })
  admin = await seedMember('admin')
  editor = await seedMember('editor')
  await linkService(h, admin.id, h.fake.person('حساب الخدمة', { admin: true }))
  ownerPerson = h.fake.person('مالك الملفات')
  for (const name of PEOPLE) people.push(h.fake.person(name))
})

describe(`load: ${CONFIG.workbooks} workbooks × ${CONFIG.sheets} sheets × ${CONFIG.rows} rows`, () => {
  it('1. save and read', async () => {
    const createMs: number[] = []
    const saveMs: number[] = []
    const readMs: number[] = []
    const sizes: number[] = []
    const owner = await seedMember('editor')
    await linkUser(h, owner.id, ownerPerson)
    for (let w = 0; w < CONFIG.workbooks; w++) {
      const [created, cMs] = await timed(() => call(h.app, 'POST', '/api/workbooks', { user: owner, env: h.env, body: { title: `ملف الحمل ${w + 1}`, source: 'blank' } }))
      expect(created.status).toBe(201)
      createMs.push(cMs)
      const { id } = await json<{ id: string }>(created)
      const wb = await json<WorkbookResponse>(await call(h.app, 'GET', `/api/workbooks/${id}`, { user: owner, env: h.env }))
      const snapshot = wb.snapshot as Snap
      const first = wb.sheets[0]!
      const sheets = [{ id: first.id, univerSheetId: first.univerSheetId }]
      const now = new Date().toISOString()
      // Extra sheets get their D1 rows the way the import writes them (google-import/store.ts).
      for (let s = 1; s < CONFIG.sheets; s++) {
        const sheet = { id: crypto.randomUUID(), univerSheetId: `load-sheet-${s + 1}` }
        await env.DB.prepare(
          `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'local', NULL, 1, ?6)`,
        )
          .bind(sheet.id, id, sheet.univerSheetId, SHEET_NAMES[s % SHEET_NAMES.length]!, s + 1, now)
          .run()
        sheets.push(sheet)
      }
      snapshot.sheetOrder = sheets.map((s) => s.univerSheetId)
      snapshot.styles = { header: { bl: 1 } }
      snapshot.sheets = Object.fromEntries(sheets.map((s, i) => [s.univerSheetId, taskSheet(s.univerSheetId, i === 0 ? 'ورقة 1' : SHEET_NAMES[i % SHEET_NAMES.length]!, i, CONFIG.rows)]))
      const body = JSON.stringify({ baseVersion: wb.version, snapshot })
      sizes.push(new TextEncoder().encode(body).byteLength)
      const [saved, sMs] = await timed(() => call(h.app, 'PUT', `/api/workbooks/${id}/snapshot`, { user: owner, env: h.env, rawBody: body, headers: { 'content-type': 'application/json' } }))
      expect(saved.status).toBe(200)
      saveMs.push(sMs)
      const { version } = await json<{ version: number }>(saved)
      for (let i = 0; i < 3; i++) {
        const [read, rMs] = await timed(async () => {
          const res = await call(h.app, 'GET', `/api/workbooks/${id}`, { user: owner, env: h.env })
          await res.arrayBuffer()
          return res
        })
        expect(read.status).toBe(200)
        readMs.push(rMs)
      }
      await addMember(id, editor.id, 'editor', owner.id)
      workbooks.push({ id, owner, version, sheets, bytes: sizes[sizes.length - 1]! })
    }
    const list = await timed(() => call(h.app, 'GET', '/api/workbooks', { user: owner, env: h.env }))
    report('save_and_read', {
      snapshotBytes: stats(sizes),
      createMs: stats(createMs),
      saveMs: stats(saveMs),
      readMs: stats(readMs),
      listMs: list[1],
    })
  })

  it('2. room: join and apply', async () => {
    const joinColdMs: number[] = []
    const joinWarmMs: number[] = []
    const ackMs: number[] = []
    const broadcastMs: number[] = []
    const persistMs: number[] = []
    let rejected = 0
    for (const wb of workbooks) {
      const sheet = wb.sheets[0]!.univerSheetId
      const open = async (user: { id: string }) => {
        const socket = await openRoom(user, wb.id)
        socket.hello(clientId())
        const welcome = await socket.take('welcome', () => true, 120_000)
        return { socket, welcome }
      }
      const [a, cold] = await timed(() => open(wb.owner))
      joinColdMs.push(cold)
      const [b, warm] = await timed(() => open(editor))
      joinWarmMs.push(warm)
      let seq = a.welcome.seq
      const epoch = a.welcome.epoch
      for (let i = 0; i < CONFIG.roomOps; i++) {
        const id = opId()
        const t0 = Date.now()
        a.socket.send({ type: 'op', opId: id, baseSeq: seq, epoch, mutations: [setValue(wb.id, sheet, 1 + (i % CONFIG.rows), 6, { v: `ملاحظة ${i}` })] })
        const outcome = await Promise.race([
          a.socket.take('ack', (m) => m.opId === id, 60_000).then((m) => ({ kind: 'ack' as const, seq: m.seq })),
          a.socket.take('reject', (m) => m.opId === id, 60_000).then(() => ({ kind: 'reject' as const, seq })),
        ])
        ackMs.push(Date.now() - t0)
        if (outcome.kind === 'reject') rejected++
        seq = outcome.seq
        const t1 = Date.now()
        await b.socket.take('op', (m) => m.op.opId === id, 60_000).catch(() => null)
        broadcastMs.push(Date.now() - t1)
      }
      closeAll([a.socket, b.socket])
      const stub = env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(wb.id))
      const [, pMs] = await timed(() => runDurableObjectAlarm(stub))
      persistMs.push(pMs)
      const v = await env.DB.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1').bind(wb.id).first<{ v: number }>()
      wb.version = v!.v
      // Wait until the room no longer holds the workbook (the link phase writes it next).
      for (let i = 0; i < 50 && (await stub.isLive()); i++) await new Promise((r) => setTimeout(r, 100))
    }
    report('room', {
      opsPerWorkbook: CONFIG.roomOps,
      joinColdMs: stats(joinColdMs),
      joinWarmMs: stats(joinWarmMs),
      ackMs: stats(ackMs),
      broadcastMs: stats(broadcastMs),
      persistMs: stats(persistMs),
      rejected,
    })
  })

  const synced = () => workbooks.slice(0, CONFIG.syncWorkbooks)
  const outboundTotals = { tasks: 0, messages: 0, batches: 0, basecampCalls: 0, ms: 0, limiterWaitMs: 0, pacedMs: 0, kinds: {} as Record<string, number> }
  const linkTotals = { requests: 0, limiterWaitMs: 0, kinds: {} as Record<string, number> }
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n
  }

  it('3. link and initial outbound sync', async () => {
    idle(60_000)
    const linkMs: number[] = []
    const drainMs: number[] = []
    const drainPacedMs: number[] = []
    const perTaskMs: number[] = []
    const perTaskPacedMs: number[] = []
    for (const wb of synced()) {
      const project = h.fake.project(`مشروع ${wb.id.slice(0, 8)}`, [ownerPerson.id, ...people.map((p) => p.id)])
      await seedProjectPeople(project.id, [ownerPerson, ...people])
      const plan: LinkPlan = {
        project: { mode: 'existing', projectId: project.id },
        sheets: wb.sheets.map((s, i) => defaultSheetPlan(s.id, { todolistId: h.fake.list(project.id, SHEET_NAMES[i % SHEET_NAMES.length]!).id })),
      }
      const link = await measured(() => call(h.app, 'POST', `/api/workbooks/${wb.id}/link`, { user: wb.owner, env: h.env, body: plan }))
      if (link.out.status !== 200) throw new Error(`link ${wb.id}: ${link.out.status} ${await link.out.text()}`)
      linkMs.push(link.ms)
      linkTotals.requests += link.requests
      linkTotals.limiterWaitMs += link.limiterWaitMs
      add(linkTotals.kinds, link.kinds)
      const messages = h.outbound.sent.length
      const todosBefore = h.fake.todos.size
      const drain = await measured(() => drainOutbound(h, 20, CONFIG.outboundBatch))
      drainMs.push(drain.ms)
      drainPacedMs.push(drain.pacedMs)
      const created = h.fake.todos.size - todosBefore
      expect(created).toBe(CONFIG.sheets * CONFIG.rows)
      perTaskMs.push(drain.ms / Math.max(1, created))
      perTaskPacedMs.push(drain.pacedMs / Math.max(1, created))
      outboundTotals.tasks += created
      outboundTotals.messages += messages
      outboundTotals.batches += drain.out.length
      outboundTotals.basecampCalls += drain.requests
      outboundTotals.ms += drain.ms
      outboundTotals.limiterWaitMs += drain.limiterWaitMs
      outboundTotals.pacedMs += drain.pacedMs
      add(outboundTotals.kinds, drain.kinds)
    }
    const states = await env.DB.prepare(
      `SELECT t.sync_state AS state, COUNT(*) AS n FROM tasks t JOIN sheets s ON s.id = t.sheet_id WHERE s.workbook_id IN (SELECT value FROM json_each(?1)) GROUP BY t.sync_state`,
    )
      .bind(JSON.stringify(synced().map((w) => w.id)))
      .all<{ state: string; n: number }>()
    const duplicates = new Map<string, number>()
    for (const t of h.fake.todos.values()) duplicates.set(`${t.listId}:${t.content}`, (duplicates.get(`${t.listId}:${t.content}`) ?? 0) + 1)
    report('link_and_outbound', {
      workbooks: synced().length,
      outboundBatch: CONFIG.outboundBatch,
      linkMs: stats(linkMs),
      link: linkTotals,
      drainMs: stats(drainMs),
      drainPacedMs: stats(drainPacedMs),
      perTaskMs: stats(perTaskMs),
      perTaskPacedMs: stats(perTaskPacedMs),
      totals: outboundTotals,
      requestsPerTask: outboundTotals.tasks > 0 ? Math.round((outboundTotals.basecampCalls / outboundTotals.tasks) * 1000) / 1000 : null,
      tasksPerSecond: outboundTotals.ms > 0 ? Math.round((outboundTotals.tasks / outboundTotals.ms) * 1000 * 10) / 10 : null,
      tasksPerSecondPaced: outboundTotals.pacedMs > 0 ? Math.round((outboundTotals.tasks / outboundTotals.pacedMs) * 1000 * 10) / 10 : null,
      duplicateTodos: [...duplicates.values()].filter((n) => n > 1).length,
      syncStates: Object.fromEntries(states.results.map((r) => [r.state, r.n])),
    })
    expect(states.results.filter((r) => r.state !== 'synced')).toEqual([])
    expect([...duplicates.values()].filter((n) => n > 1)).toEqual([])
  })

  it('4. outbound detection after an edit of 1% of the rows', async () => {
    idle(60_000)
    const saveMs: number[] = []
    const enqueued: number[] = []
    const drainMs: number[] = []
    const drainPacedMs: number[] = []
    const kinds: Record<string, number> = {}
    let requests = 0
    for (const wb of synced()) {
      const fresh = await json<WorkbookResponse>(await call(h.app, 'GET', `/api/workbooks/${wb.id}`, { user: wb.owner, env: h.env }))
      const snapshot = fresh.snapshot as Snap
      const perSheet = Math.max(1, Math.round(CONFIG.rows / 100))
      for (const s of wb.sheets) {
        const cells = snapshot.sheets[s.univerSheetId]!.cellData
        for (let k = 0; k < perSheet; k++) {
          const row = 1 + ((k * 37) % CONFIG.rows)
          cells[row]![0] = { ...(cells[row]![0] ?? {}), v: `${String(cells[row]![0]?.v ?? '')} (معدّلة)` }
        }
      }
      const before = h.outbound.sent.length
      const body = JSON.stringify({ baseVersion: fresh.version, snapshot })
      const [saved, sMs] = await timed(() => call(h.app, 'PUT', `/api/workbooks/${wb.id}/snapshot`, { user: wb.owner, env: h.env, rawBody: body, headers: { 'content-type': 'application/json' } }))
      expect(saved.status).toBe(200)
      saveMs.push(sMs)
      enqueued.push(h.outbound.sent.length - before)
      const drain = await measured(() => drainOutbound(h, 20, CONFIG.outboundBatch))
      drainMs.push(drain.ms)
      drainPacedMs.push(drain.pacedMs)
      requests += drain.requests
      add(kinds, drain.kinds)
    }
    report('detection', {
      editedPerWorkbook: Math.max(1, Math.round(CONFIG.rows / 100)) * CONFIG.sheets,
      saveWithDetectionMs: stats(saveMs),
      enqueued: stats(enqueued),
      drainMs: stats(drainMs),
      drainPacedMs: stats(drainPacedMs),
      requests,
      kinds,
    })
    for (const n of enqueued) expect(n).toBe(Math.max(1, Math.round(CONFIG.rows / 100)) * CONFIG.sheets)
  })

  it('5. reconciliation against the fake Basecamp', async () => {
    const ids = new Set(synced().map((w) => w.id))
    if (ids.size === 0) return
    const todos = [...h.fake.todos.values()]
    const changed = todos.filter((_, i) => i % Math.max(1, Math.floor(todos.length / 50)) === 0).slice(0, 50)
    for (const t of changed) {
      t.content = `${t.content} — من Basecamp`
      t.updatedAt = h.fake.tick()
    }
    // A run is cut into continuations when it reaches its time budget; each one is
    // delivered here as the cron would (the next run picks up where it stopped).
    const untilDone = async () => {
      const runs: Array<Awaited<ReturnType<typeof reconcile>>> = []
      for (let i = 0; i < 50; i++) {
        // The budget is measured on the limiter's clock, as it would pass in production.
        const r = await reconcile(h, { clock: paceNow })
        runs.push(r)
        if (!('continued' in r) || !r.continued) break
      }
      return runs
    }
    idle(15 * 60_000)
    const first = await measured(untilDone)
    // The next cron run, 15 minutes later.
    idle(15 * 60_000)
    const quiet = await measured(untilDone)
    const applied = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sync_log WHERE direction = 'in' AND action = 'update_row' AND status = 'ok' AND workbook_id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify([...ids]))
      .first<{ n: number }>()
    const summary = (m: typeof first) => ({ ms: m.ms, pacedMs: m.pacedMs, limiterWaitMs: m.limiterWaitMs, basecampReads: m.requests, kinds: m.kinds, runs: m.out })
    report('reconciliation', { changedInBasecamp: changed.length, rowsUpdatedFromBasecamp: applied?.n ?? null, firstRun: summary(first), unchangedRun: summary(quiet) })
    expect(first.out.reduce((n, r) => n + r.workbooks, 0)).toBeGreaterThanOrEqual(ids.size)
    expect(quiet.out.reduce((n, r) => n + r.notModified, 0)).toBeGreaterThan(0)
    // Every change made in Basecamp reached its row.
    for (const t of changed) {
      const row = await env.DB.prepare(`SELECT last_remote_change_at AS at FROM tasks WHERE bc_recording_id = ?1`).bind(t.id).first<{ at: string }>()
      expect(row?.at).toBe(t.updatedAt)
    }
  })

  it('6. internal API: /api/v1/stats over every workbook', async () => {
    const secret = newTokenSecret()
    await env.DB.prepare(`INSERT INTO api_tokens (id, name, token_hash, token_prefix, created_by, created_at) VALUES (?1, 'load', ?2, ?3, ?4, ?5)`)
      .bind(crypto.randomUUID(), await sha256Hex(secret), secret.slice(0, 10), admin.id, new Date().toISOString())
      .run()
    const [res, ms] = await timed(() => call(h.app, 'GET', '/api/v1/stats', { env: h.env, headers: { authorization: `Bearer ${secret}` } }))
    expect(res.status).toBe(200)
    const body = await json<{ totals: { tasks: number } }>(res)
    report('internal_api_stats', { ms, tasks: body.totals.tasks })
    expect(body.totals.tasks).toBeGreaterThanOrEqual(synced().length * CONFIG.sheets * CONFIG.rows)
  })
})

function closeAll(sockets: TestSocket[]): void {
  for (const s of sockets) s.close()
}
