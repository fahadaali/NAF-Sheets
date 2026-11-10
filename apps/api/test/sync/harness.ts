// Shared setup of the sync tests: a fake Basecamp, an env whose queues are
// recorders (nothing reaches a real queue or a real Basecamp), linked tokens
// stored exactly as src/basecamp-link stores them, and a workbook linked
// through the real wizard routes.

import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import type { LinkPlan, SheetPlan } from '@naf-sheets/shared'
import { storeProjectPeople } from '../../src/basecamp-link/people'
import { encryptJson } from '../../src/crypto'
import type { BcInboundQueueMessage, BcOutboundMessage, Env } from '../../src/env'
import type { SyncDeps } from '../../src/sync/deps'
import { handleInboundBatchWith, runReconciliationWith } from '../../src/sync/inbound'
import type { ReconcileOptions } from '../../src/sync/inbound/reconcile'
import { handleOutboundBatchWith, registerSyncRoutes } from '../../src/sync/outbound'
import { registerPhase5Routes } from '../../src/phase5'
import { call, createWorkbook, json, seedMember, testApp } from '../helpers'
import type { SeededMember } from '../helpers'
import { FakeBasecamp, uniqueId } from './fake-basecamp'
import type { FakeList, FakePerson } from './fake-basecamp'

export const ENCRYPTION_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
export const ORIGIN = 'https://sheets.naflaw.test'
const FAR = new Date(Date.now() + 365 * 24 * 3600_000).toISOString()

export class RecordingQueue<T> {
  sent: Array<{ body: T; delaySeconds?: number }> = []
  failing = false
  async send(body: T, options?: { delaySeconds?: number }): Promise<void> {
    if (this.failing) throw new Error('queue down')
    this.sent.push({ body: structuredClone(body), delaySeconds: options?.delaySeconds })
  }
  async sendBatch(messages: Iterable<{ body: T; delaySeconds?: number }>): Promise<void> {
    if (this.failing) throw new Error('queue down')
    for (const m of messages) this.sent.push({ body: structuredClone(m.body), delaySeconds: m.delaySeconds })
  }
  take(): Array<{ body: T; delaySeconds?: number }> {
    const out = this.sent
    this.sent = []
    return out
  }
}

export interface Harness {
  fake: FakeBasecamp
  env: Env
  deps: SyncDeps
  app: ReturnType<typeof testApp>
  outbound: RecordingQueue<BcOutboundMessage>
  inbound: RecordingQueue<BcInboundQueueMessage>
  dlq: RecordingQueue<BcOutboundMessage>
}

/** `overrides`: the load test passes the production limiter on a virtual clock (docs/load-test.md). */
export function harness(overrides: Partial<SyncDeps> = {}): Harness {
  const fake = new FakeBasecamp(uniqueId())
  const outbound = new RecordingQueue<BcOutboundMessage>()
  const inbound = new RecordingQueue<BcInboundQueueMessage>()
  const dlq = new RecordingQueue<BcOutboundMessage>()
  const syncEnv = {
    ...env,
    BASECAMP_CLIENT_ID: 'naf-sheets-test-client',
    BASECAMP_CLIENT_SECRET: 'test-client-secret',
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    BASECAMP_ACCOUNT_ID: String(fake.accountId),
    PUBLIC_API_ORIGIN: ORIGIN,
    BC_OUTBOUND: outbound as unknown as Queue<BcOutboundMessage>,
    BC_INBOUND: inbound as unknown as Queue<BcInboundQueueMessage>,
    BC_OUTBOUND_DLQ: dlq as unknown as Queue<BcOutboundMessage>,
  } as Env
  const deps: SyncDeps = { fetch: fake.fetch, now: () => Date.now(), limiter: { acquire: async () => {} }, sleep: async () => {}, ...overrides }
  const app = testApp()
  registerSyncRoutes(app, deps)
  registerPhase5Routes(app, deps)
  return { fake, env: syncEnv, deps, app, outbound, inbound, dlq }
}

/** A user's own Basecamp link, stored as src/basecamp-link stores it. Returns the access token. */
export async function linkUser(h: Harness, userId: string, person: FakePerson): Promise<string> {
  const token = h.fake.token(person.id)
  const sealed = await encryptJson(ENCRYPTION_KEY, { access_token: token, refresh_token: 'rt-unused' }, `user_basecamp_links:${userId}`)
  const at = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_basecamp_links (user_id, bc_person_id, bc_account_id, encrypted_tokens, expires_at, linked_at, status, bc_person_name, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?6)
     ON CONFLICT (user_id) DO UPDATE SET bc_person_id = excluded.bc_person_id, encrypted_tokens = excluded.encrypted_tokens,
       expires_at = excluded.expires_at, linked_at = excluded.linked_at, status = 'active', updated_at = excluded.updated_at`,
  )
    .bind(userId, person.id, h.fake.accountId, sealed, FAR, at, person.name)
    .run()
  return token
}

/** The link as src/basecamp-link leaves it after a revocation or a refused refresh: no token held. */
export async function dropLink(userId: string, status: 'revoked' | 'expired'): Promise<void> {
  await env.DB.prepare(`UPDATE user_basecamp_links SET status = ?2, encrypted_tokens = '', updated_at = ?3 WHERE user_id = ?1`)
    .bind(userId, status, new Date().toISOString())
    .run()
}

/** The service token (an admin's Basecamp account). Returns the access token. */
export async function linkService(h: Harness, adminId: string, person: FakePerson): Promise<string> {
  const token = h.fake.token(person.id)
  const id = crypto.randomUUID()
  const sealed = await encryptJson(ENCRYPTION_KEY, { access_token: token, refresh_token: 'rt-unused' }, `integrations:${id}`)
  const at = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO integrations (id, provider, account_id, encrypted_tokens, expires_at, created_by, created_at, status, bc_person_id, updated_at, updated_by)
     VALUES (?1, 'basecamp', ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?6, ?5)`,
  )
    .bind(id, String(h.fake.accountId), sealed, FAR, adminId, at, person.id)
    .run()
  return token
}

export async function seedProjectPeople(projectId: number, people: FakePerson[]): Promise<void> {
  await storeProjectPeople(
    env.DB,
    projectId,
    people.map((p) => ({ id: p.id, name: p.name, personable_type: 'User', email_address: p.email_address })),
    new Date().toISOString(),
  )
}

export interface RowSpec {
  title: string
  assignees?: string
  starts?: string
  due?: string
  done?: boolean
  notes?: string
  /** Leading spaces: a subtask when the plan detects hierarchy by indentation. */
  indent?: boolean
}

type Cells = Record<number, Record<number, Record<string, unknown>>>
interface SheetData {
  cellData: Cells
}
interface Snapshot {
  sheets: Record<string, SheetData>
}

const COLUMN = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 } as const

export function writeRow(cells: Cells, row: number, spec: RowSpec): void {
  const line: Record<number, Record<string, unknown>> = { ...(cells[row] ?? {}) }
  line[COLUMN.A] = { v: spec.indent ? `    ${spec.title}` : spec.title }
  if (spec.assignees !== undefined) line[COLUMN.B] = { v: spec.assignees }
  if (spec.starts !== undefined) line[COLUMN.C] = { v: spec.starts }
  if (spec.due !== undefined) line[COLUMN.D] = { v: spec.due }
  if (spec.done !== undefined) line[COLUMN.E] = { v: spec.done ? 'منجز' : 'قيد التنفيذ' }
  if (spec.notes !== undefined) line[COLUMN.G] = { v: spec.notes }
  cells[row] = line
}

export function defaultSheetPlan(sheetId: string, overrides: Partial<SheetPlan> = {}): SheetPlan {
  return {
    sheetId,
    mode: 'existing',
    headerRow: 1,
    columns: [
      { columnKey: 'A', field: 'title' },
      { columnKey: 'B', field: 'assignees' },
      { columnKey: 'C', field: 'starts_on' },
      { columnKey: 'D', field: 'due_on' },
      { columnKey: 'E', field: 'completed' },
      { columnKey: 'F', field: 'attachments' },
      { columnKey: 'G', field: 'notes' },
    ],
    completedValues: ['منجز'],
    hierarchy: { mode: 'flat' },
    existingTasks: 'create_all',
    assigneeMatches: {},
    ...overrides,
  }
}

export interface Linked {
  h: Harness
  owner: SeededMember
  ownerPerson: FakePerson
  token: string
  admin: SeededMember | null
  servicePerson: FakePerson | null
  people: Record<string, FakePerson>
  project: { id: number; todosetId: number }
  list: FakeList
  wbId: string
  sheetId: string
  univerSheetId: string
}

export interface SetupOptions {
  rows?: RowSpec[]
  /** Extra Basecamp people in the project, by name. */
  people?: string[]
  hierarchy?: SheetPlan['hierarchy']
  /** Link the service account (an admin) too. */
  service?: boolean
  /** Skip draining the initial creation. */
  noDrain?: boolean
  plan?: Partial<SheetPlan>
  /** To-dos already in the list before linking. */
  existingTodos?: string[]
}

/** A workbook with rows, linked to a fake project/list through POST …/link, its rows created in Basecamp. */
export async function setupLinked(h: Harness, options: SetupOptions = {}): Promise<Linked> {
  const owner = await seedMember('editor')
  const ownerPerson = h.fake.person('أحمد المالك')
  const token = await linkUser(h, owner.id, ownerPerson)
  const people: Record<string, FakePerson> = {}
  for (const name of options.people ?? []) people[name] = h.fake.person(name)
  let admin: SeededMember | null = null
  let servicePerson: FakePerson | null = null
  if (options.service) {
    admin = await seedMember('admin')
    servicePerson = h.fake.person('حساب الخدمة', { admin: true })
    await linkService(h, admin.id, servicePerson)
  }
  const members = [ownerPerson, ...Object.values(people), ...(servicePerson ? [servicePerson] : [])]
  const project = h.fake.project('حملة اليوم الوطني', members.map((p) => p.id))
  const list = h.fake.list(project.id, 'المحتوى')
  for (const content of options.existingTodos ?? []) h.fake.addTodo(list.id, { content })
  await seedProjectPeople(project.id, members)

  const wbId = await createWorkbook(h.app, owner)
  const res = await call(h.app, 'GET', `/api/workbooks/${wbId}`, { user: owner, env: h.env })
  const wb = await json<{ snapshot: Snapshot; version: number; sheets: Array<{ id: string; univerSheetId: string }> }>(res)
  const sheet = wb.sheets[0] as { id: string; univerSheetId: string }
  const cells = (wb.snapshot.sheets[sheet.univerSheetId] as SheetData).cellData
  ;(options.rows ?? []).forEach((spec, i) => writeRow(cells, i + 1, spec))
  const saved = await call(h.app, 'PUT', `/api/workbooks/${wbId}/snapshot`, { user: owner, env: h.env, body: { baseVersion: wb.version, snapshot: wb.snapshot } })
  expect(saved.status).toBe(200)

  const plan: LinkPlan = {
    project: { mode: 'existing', projectId: project.id },
    sheets: [defaultSheetPlan(sheet.id, { todolistId: list.id, hierarchy: options.hierarchy ?? { mode: 'flat' }, ...options.plan })],
  }
  const linked = await call(h.app, 'POST', `/api/workbooks/${wbId}/link`, { user: owner, env: h.env, body: plan })
  if (linked.status !== 200) throw new Error(`link: ${linked.status} ${await linked.text()}`)
  const result: Linked = { h, owner, ownerPerson, token, admin, servicePerson, people, project, list, wbId, sheetId: sheet.id, univerSheetId: sheet.univerSheetId }
  if (!options.noDrain) await drainOutbound(h)
  return result
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export interface SheetView {
  cells: Cells
  version: number
  snapshot: Snapshot
  uidColumn: number
  /** 0-based row of the task whose title (trimmed) is `title`. */
  row(title: string): number
  uid(title: string): string
  text(row: number, column: keyof typeof COLUMN): string
  set(row: number, column: keyof typeof COLUMN, value: string | null): void
  /** Removes the row's cells, as a person deleting the row would. */
  remove(row: number): Record<number, Record<string, unknown>>
}

export async function readSheetView(l: Linked, user: { id: string } = l.owner, univerSheetId: string = l.univerSheetId): Promise<SheetView> {
  const res = await call(l.h.app, 'GET', `/api/workbooks/${l.wbId}`, { user, env: l.h.env })
  const wb = await json<{ snapshot: Snapshot; version: number }>(res)
  const cells = (wb.snapshot.sheets[univerSheetId] as SheetData).cellData
  const header = cells[0] ?? {}
  let uidColumn = -1
  for (const [c, cell] of Object.entries(header)) if (cell['v'] === '__uid') uidColumn = Number(c)
  const view: SheetView = {
    cells,
    version: wb.version,
    snapshot: wb.snapshot,
    uidColumn,
    row(title) {
      for (const [r, line] of Object.entries(cells)) {
        if (Number(r) === 0) continue
        if (String(line[COLUMN.A]?.['v'] ?? '').trim() === title) return Number(r)
      }
      throw new Error(`no row titled ${title}`)
    },
    uid(title) {
      return String(cells[view.row(title)]?.[uidColumn]?.['v'] ?? '')
    },
    text(row, column) {
      const cell = cells[row]?.[COLUMN[column]]
      return cell === undefined ? '' : String(cell['v'] ?? '')
    },
    set(row, column, value) {
      cells[row] ??= {}
      const line = cells[row] as Record<number, Record<string, unknown>>
      if (value === null) {
        const { v: _v, t: _t, ...rest } = line[COLUMN[column]] ?? {}
        line[COLUMN[column]] = rest
      } else line[COLUMN[column]] = { ...(line[COLUMN[column]] ?? {}), v: value, t: 1 }
    },
    remove(row) {
      const line = cells[row] ?? {}
      delete cells[row]
      return line
    },
  }
  return view
}

/** Saves the edited view (PUT …/snapshot), as the editor would. */
export async function saveSheet(l: Linked, view: SheetView, options: { user?: { id: string }; confirmedDeletions?: string[] } = {}): Promise<Response> {
  const body: Record<string, unknown> = { baseVersion: view.version, snapshot: view.snapshot }
  if (options.confirmedDeletions) body['confirmedDeletions'] = options.confirmedDeletions
  return call(l.h.app, 'PUT', `/api/workbooks/${l.wbId}/snapshot`, { user: options.user ?? l.owner, env: l.h.env, body })
}

export async function edit(l: Linked, change: (view: SheetView) => void, options: { user?: { id: string }; confirmedDeletions?: string[] } = {}): Promise<Response> {
  const view = await readSheetView(l, options.user ?? l.owner)
  change(view)
  const res = await saveSheet(l, view, options)
  expect(res.status).toBe(200)
  return res
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

export interface BatchResult {
  explicitAcks: string[]
  retryMessages: Array<{ msgId: string; delaySeconds?: number }>
}

/** A batch whose messages record ack / retry (with the exact delay asked for). */
function recordingBatch<T>(queue: string, messages: Array<{ id: string; attempts: number; body: T }>): { batch: MessageBatch<T>; result: BatchResult } {
  const result: BatchResult = { explicitAcks: [], retryMessages: [] }
  const batch = {
    queue,
    messages: messages.map((m) => ({
      id: m.id,
      timestamp: new Date(),
      attempts: m.attempts,
      body: structuredClone(m.body),
      ack: () => result.explicitAcks.push(m.id),
      retry: (options?: { delaySeconds?: number }) => result.retryMessages.push({ msgId: m.id, delaySeconds: options?.delaySeconds }),
    })),
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<T>
  return { batch, result }
}

export async function runOutbound(h: Harness, messages: Array<{ body: BcOutboundMessage; attempts?: number; id?: string }>): Promise<BatchResult> {
  const { batch, result } = recordingBatch(
    'bc-outbound',
    messages.map((m) => ({ id: m.id ?? `m-${crypto.randomUUID()}`, attempts: m.attempts ?? 1, body: m.body })),
  )
  await handleOutboundBatchWith(batch, h.env, h.deps)
  return result
}

/**
 * Delivers every recorded outbound message (and the follow-ups they queue)
 * once. `batchSize`: deliver them in batches of at most that many, as the
 * real queue does (`max_batch_size` in wrangler.toml); default: one batch.
 */
export async function drainOutbound(h: Harness, rounds = 10, batchSize = Number.POSITIVE_INFINITY): Promise<BatchResult[]> {
  const results: BatchResult[] = []
  for (let i = 0; i < rounds; i++) {
    const pending = h.outbound.take()
    if (pending.length === 0) break
    for (let at = 0; at < pending.length; at += Math.min(pending.length, batchSize)) {
      results.push(await runOutbound(h, pending.slice(at, at + Math.min(pending.length, batchSize)).map((p) => ({ body: p.body }))))
    }
  }
  return results
}

export async function runInbound(h: Harness, bodies: BcInboundQueueMessage[], attempts = 1): Promise<BatchResult> {
  const { batch, result } = recordingBatch(
    'bc-inbound',
    bodies.map((body) => ({ id: `i-${crypto.randomUUID()}`, attempts, body })),
  )
  await handleInboundBatchWith(batch, h.env, h.deps)
  return result
}

/** A webhook delivery as POST /webhooks/basecamp/:secret would queue it. */
export async function deliver(l: Linked, kind: string, recording: { id: number; type: string; bucketId?: number }, creatorId = 1, attempts = 1) {
  const hook = await env.DB.prepare(`SELECT bc_webhook_id FROM bc_webhooks WHERE bc_project_id = ?1 AND replaced_at IS NULL`).bind(l.project.id).first<{ bc_webhook_id: number }>()
  if (!hook) throw new Error('no webhook registered')
  return runInbound(l.h, [
    {
      kind: 'basecamp_webhook',
      bcWebhookId: hook.bc_webhook_id,
      bcProjectId: l.project.id,
      receivedAt: new Date().toISOString(),
      body: l.h.fake.delivery(kind, { id: recording.id, type: recording.type, bucketId: recording.bucketId ?? l.project.id }, creatorId),
    },
  ], attempts)
}

export async function reconcile(h: Harness, options?: ReconcileOptions) {
  return runReconciliationWith(h.env, h.deps, options)
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

export interface TaskRowForTest {
  task_uid: string
  sheet_id: string
  bc_recording_id: number | null
  bc_type: string | null
  sync_state: string
  last_error: string | null
  last_error_code: string | null
  remote_status: string
  trashed_at: string | null
  assign_mode: string
  level: number
  parent_uid: string | null
  last_local_change_at: string | null
}

export async function task(uid: string): Promise<TaskRowForTest> {
  const row = await env.DB.prepare(`SELECT * FROM tasks WHERE task_uid = ?1`).bind(uid).first<TaskRowForTest>()
  if (!row) throw new Error(`no task ${uid}`)
  return row
}

export async function syncLog(workbookId: string, action?: string): Promise<Array<{ id: number; action: string; actor: string; status: string; old_value: string | null; new_value: string | null; error: string | null; task_uid: string | null; direction: string }>> {
  const sql = action
    ? `SELECT * FROM sync_log WHERE workbook_id = ?1 AND action = ?2 ORDER BY id`
    : `SELECT * FROM sync_log WHERE workbook_id = ?1 ORDER BY id`
  const statement = action ? env.DB.prepare(sql).bind(workbookId, action) : env.DB.prepare(sql).bind(workbookId)
  return (await statement.all()).results as never
}

export function todoByTitle(h: Harness, title: string) {
  const found = [...h.fake.todos.values()].find((t) => t.content === title)
  if (!found) throw new Error(`no to-do ${title} in Basecamp`)
  return found
}

export function subtaskByTitle(h: Harness, title: string) {
  const found = [...h.fake.subtasks.values()].find((s) => s.title === title)
  if (!found) throw new Error(`no subtask ${title} in Basecamp`)
  return found
}

export { call, json, seedMember, uniqueId }
