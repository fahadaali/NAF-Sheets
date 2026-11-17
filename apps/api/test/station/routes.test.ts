// The station's triggers, admin API and alert emails, on the fake Basecamp
// and the fake sheet (nothing remote is called).

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BcInboundQueueMessage, Env } from '../../src/env'
import { handleStationMessages, runStation, sendDueAlerts, stationMinute, stationRoutes, stationWebhookRoutes } from '../../src/station'
import { call, isArabic, json, seedMember, testApp } from '../helpers'
import { harness, linkService, type Harness } from './harness'
import { FakeSheet } from './fake-sheet'

const HEADER = ['المهمة الرئيسية', 'المهمة', 'القسم', 'الحالة', 'الموعد', 'الاسم']
const ROLES = [['المسمى', 'الاسم'], ['مسؤول السوشل ميديا', 'عمر العمار']]

interface Setup {
  h: Harness
  sheet: FakeSheet
  app: ReturnType<typeof testApp>
  admin: { id: string }
  viewer: { id: string }
  project: { id: number; todosetId: number }
  omarId: number
}

async function setup(): Promise<Setup> {
  const h = harness()
  const fahad = h.fake.person('Fahad Alotaibi', { admin: true })
  const omar = h.fake.person('عمر العمار')
  const project = h.fake.project('الاتصال المؤسسي', [fahad.id, omar.id])
  const admin = await seedMember('admin')
  const viewer = await seedMember('viewer')
  await linkService(h, admin.id, fahad)
  const sheet = new FakeSheet()
  sheet.addTab(1, 'المسميات', ROLES)
  sheet.addTab(2, 'السوشل ميديا', [HEADER, ['فيديو الموشن'], ['فيديو الموشن', 'بنك الأفكار', 'مسؤول السوشل ميديا', 'لم تبدأ', 46338]])
  sheet.addTab(3, 'الأرقام', [['الشهر', 'العدد']])
  const app = testApp()
  app.route('/api/station', stationRoutes({ ...h.deps, google: sheet }))
  await env.DB.batch([env.DB.prepare(`DELETE FROM station_alerts`), env.DB.prepare(`DELETE FROM station_names`)])
  return { h, sheet, app, admin, viewer, project, omarId: omar.id }
}

// D1 keeps rows across the tests of a file: each test links its own spreadsheet id.
let SID = ''

beforeEach(async () => {
  SID = `1Nyy${crypto.randomUUID().replace(/-/g, '')}`
  await env.DB.prepare(`DELETE FROM station_alerts`).run()
})

describe('setup status', () => {
  it('says whether the sync account, the Google key and the email key are in place, without their values', async () => {
    const s = await setup()
    const res = await call(s.app, 'GET', '/api/station/status', { user: s.viewer, env: { ...s.h.env, RESEND_API_KEY: 're_secret' } as Env })
    const body = await json<{ basecamp: { status: string } | null; google: string | null; email: boolean }>(res)
    expect(body.basecamp?.status).toBe('active')
    expect(body.google).toBe('naf-sync@naf-sheets-station.iam.gserviceaccount.com')
    expect(body.email).toBe(true)
    expect(JSON.stringify(body)).not.toContain('re_secret')
  })
})

describe('wizard and links', () => {
  it('inspects a file (admin only): linkable tabs with counts, others with the reason', async () => {
    const s = await setup()
    const path = `/api/station/inspect?source=${encodeURIComponent(`https://docs.google.com/spreadsheets/d/${SID}/edit?usp=sharing`)}`
    expect((await call(s.app, 'GET', path, { user: s.viewer, env: s.h.env })).status).toBe(403)
    const res = await call(s.app, 'GET', path, { user: s.admin, env: s.h.env })
    expect(res.status).toBe(200)
    const body = await json<{ spreadsheetId: string; hasRolesTab: boolean; tabs: { title: string; linkable: boolean; todos?: number; subtasks?: number; reason?: string }[] }>(res)
    expect(body.spreadsheetId).toBe(SID)
    expect(body.hasRolesTab).toBe(true)
    expect(body.tabs.find((t) => t.title === 'السوشل ميديا')).toMatchObject({ linkable: true, todos: 1, subtasks: 1 })
    const numbers = body.tabs.find((t) => t.title === 'الأرقام')!
    expect(numbers.linkable).toBe(false)
    expect(isArabic(numbers.reason)).toBe(true)
  })

  it('creates a link (admin only), queues its first run, and refuses a tab linked twice', async () => {
    const s = await setup()
    const body = { source: SID, bcProjectId: s.project.id, tabs: [2] }
    expect((await call(s.app, 'POST', '/api/station/links', { user: s.viewer, body, env: s.h.env })).status).toBe(403)
    const res = await call(s.app, 'POST', '/api/station/links', { user: s.admin, body, env: s.h.env })
    expect(res.status).toBe(201)
    const { id } = await json<{ id: string }>(res)
    const link = await env.DB.prepare(`SELECT bc_todoset_id, title FROM station_links WHERE id = ?1`).bind(id).first<{ bc_todoset_id: number; title: string }>()
    expect(link).toEqual({ bc_todoset_id: s.project.todosetId, title: 'الاتصال المؤسسي والتسويق' })
    expect(s.h.inbound.take().map((m) => m.body)).toEqual([{ kind: 'station_sync', linkId: id, reason: 'manual' }])
    // The project's webhook was registered with the sync account.
    expect([...s.h.fake.webhooks.values()].some((w) => w.projectId === s.project.id)).toBe(true)

    const again = await call(s.app, 'POST', '/api/station/links', { user: s.admin, body, env: s.h.env })
    expect(again.status).toBe(409)
    expect(isArabic((await json<{ message: string }>(again)).message)).toBe(true)
  })

  it('runs a queued link end to end and shows it with its history', async () => {
    const s = await setup()
    const res = await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env })
    const { id } = await json<{ id: string }>(res)
    await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    expect([...s.h.fake.subtasks.values()].map((x) => [x.title, x.assigneeIds])).toEqual([['بنك الأفكار', [s.omarId]]])
    const detail = await json<{ projectUrl: string | null; tabs: { bc_todolist_id: number | null }[]; log: { action: string }[] }>(
      await call(s.app, 'GET', `/api/station/links/${id}`, { user: s.viewer, env: s.h.env }),
    )
    expect(detail.projectUrl).toBe(`https://3.basecamp.com/${s.h.fake.accountId}/projects/${s.project.id}`)
    expect(detail.tabs[0]!.bc_todolist_id).not.toBeNull()
    expect(detail.log.map((l) => l.action)).toContain('create_subtask')
  })
})

describe('pause and unlink', () => {
  it('pauses and resumes a link (admin only), and unlinks it with an audit entry', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    s.h.inbound.take()
    expect((await call(s.app, 'PATCH', `/api/station/links/${id}`, { user: s.viewer, body: { state: 'paused' }, env: s.h.env })).status).toBe(403)
    expect((await call(s.app, 'PATCH', `/api/station/links/${id}`, { user: s.admin, body: { state: 'paused' }, env: s.h.env })).status).toBe(200)
    expect(s.h.inbound.take()).toEqual([])
    expect((await call(s.app, 'PATCH', `/api/station/links/${id}`, { user: s.admin, body: { state: 'active' }, env: s.h.env })).status).toBe(200)
    expect(s.h.inbound.take().map((m) => m.body)).toEqual([{ kind: 'station_sync', linkId: id, reason: 'manual' }])

    expect((await call(s.app, 'DELETE', `/api/station/links/${id}`, { user: s.viewer, env: s.h.env })).status).toBe(403)
    const res = await call(s.app, 'DELETE', `/api/station/links/${id}`, { user: s.admin, env: s.h.env })
    expect(res.status).toBe(200)
    // Marked, not deleted: the link no longer shows, its record is kept.
    expect(await env.DB.prepare(`SELECT state, unlinked_at FROM station_links WHERE id = ?1`).bind(id).first()).toMatchObject({ state: 'paused', unlinked_at: expect.any(String) })
    const list = await json<{ links: { id: string }[] }>(await call(s.app, 'GET', '/api/station/links', { user: s.viewer, env: s.h.env }))
    expect(list.links.map((l) => l.id)).not.toContain(id)
    expect((await call(s.app, 'GET', `/api/station/links/${id}`, { user: s.viewer, env: s.h.env })).status).toBe(404)
    const audit = await env.DB.prepare(`SELECT actor_id, details_json FROM audit_log WHERE action = 'station.link.unlink' AND entity_id = ?1`).bind(id).first<{ actor_id: string; details_json: string }>()
    expect(audit?.actor_id).toBe(s.admin.id)
    expect(JSON.parse(audit!.details_json)).toEqual({ spreadsheetId: SID, bcProjectId: s.project.id })
    const gone = await call(s.app, 'DELETE', `/api/station/links/${id}`, { user: s.admin, env: s.h.env })
    expect(gone.status).toBe(404)
    expect(isArabic((await json<{ message: string }>(gone)).message)).toBe(true)
  })
})

describe('first sync with an existing list (decision 10)', () => {
  it('lists the project’s lists, previews the first sync without writing anything, then links and matches by title', async () => {
    const s = await setup()
    const list = s.h.fake.list(s.project.id, 'قائمة قائمة')
    const motion = s.h.fake.addTodo(list.id, { content: 'فيديو الموشن' })
    s.h.fake.addSubtask(motion.id, { title: 'بنك الأفكار', dueOn: '2026-12-31', assigneeIds: [s.omarId] })
    const only = s.h.fake.addTodo(list.id, { content: 'في Basecamp وحده' })

    expect((await call(s.app, 'GET', `/api/station/projects/${s.project.id}/lists`, { user: s.viewer, env: s.h.env })).status).toBe(403)
    const lists = await json<{ lists: { id: number; name: string; linked: boolean }[] }>(await call(s.app, 'GET', `/api/station/projects/${s.project.id}/lists`, { user: s.admin, env: s.h.env }))
    expect(lists.lists.find((l) => l.id === list.id)).toEqual({ id: list.id, name: 'قائمة قائمة', linked: false })

    const body = { source: SID, bcProjectId: s.project.id, tabs: [{ sheetId: 2, listId: list.id }], reference: 'file' }
    const writes = s.h.fake.calls.filter((c) => c.method !== 'GET').length
    const preview = await json<{ tabs: Record<string, unknown>[] }>(await call(s.app, 'POST', '/api/station/preview', { user: s.admin, body, env: s.h.env }))
    expect(preview.tabs).toEqual([{ sheetId: 2, title: 'السوشل ميديا', ok: true, matched: 2, changed: 2, toBasecamp: 0, toSheet: 0, ignored: 1, held: 0 }])
    const merge = await json<{ tabs: Record<string, unknown>[] }>(await call(s.app, 'POST', '/api/station/preview', { user: s.admin, body: { ...body, reference: 'merge' }, env: s.h.env }))
    expect(merge.tabs[0]).toMatchObject({ toSheet: 1, ignored: 0 })
    expect(s.h.fake.calls.filter((c) => c.method !== 'GET').length).toBe(writes)

    const res = await call(s.app, 'POST', '/api/station/links', { user: s.admin, body, env: s.h.env })
    expect(res.status).toBe(201)
    const { id } = await json<{ id: string }>(res)
    await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    expect([...s.h.fake.todos.values()].filter((t) => t.listId === list.id && t.status === 'active').map((t) => t.content).sort()).toEqual(['في Basecamp وحده', 'فيديو الموشن'])
    expect([...s.h.fake.subtasks.values()]).toHaveLength(1)
    expect(s.sheet.tab('السوشل ميديا').rows.some((r) => r[0] === 'في Basecamp وحده')).toBe(false)
    expect(s.h.fake.todos.get(only.id)!.status).toBe('active')

    // The list now feeds one tab only.
    const after = await json<{ lists: { id: number; linked: boolean }[] }>(await call(s.app, 'GET', `/api/station/projects/${s.project.id}/lists`, { user: s.admin, env: s.h.env }))
    expect(after.lists.find((l) => l.id === list.id)?.linked).toBe(true)
    const other = await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { ...body, source: `1Nyy${crypto.randomUUID().replace(/-/g, '')}` }, env: s.h.env })
    expect(other.status).toBe(409)
  })
})

describe('restoring from the link screen (owner, 2026-11-17)', () => {
  it('creates a subtask deleted for good again from its snapshot (admin only, once); the next run gives it its row back', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    const run = () => runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    await run()
    s.sheet.deleteRows('السوشل ميديا', 2)
    await run()
    expect([...s.h.fake.subtasks.values()]).toHaveLength(0)

    const detail = await json<{ deleted: { id: number; title: string; restoredAt: string | null }[] }>(await call(s.app, 'GET', `/api/station/links/${id}`, { user: s.viewer, env: s.h.env }))
    expect(detail.deleted).toMatchObject([{ title: 'بنك الأفكار', restoredAt: null }])
    const path = `/api/station/links/${id}/deleted/${detail.deleted[0]!.id}/restore`
    expect((await call(s.app, 'POST', path, { user: s.viewer, env: s.h.env })).status).toBe(403)
    expect((await call(s.app, 'POST', path, { user: s.admin, env: s.h.env })).status).toBe(200)
    expect([...s.h.fake.subtasks.values()].map((x) => [x.title, x.assigneeIds])).toEqual([['بنك الأفكار', [s.omarId]]])
    const again = await call(s.app, 'POST', path, { user: s.admin, env: s.h.env })
    expect(again.status).toBe(409)
    expect(isArabic((await json<{ message: string }>(again)).message)).toBe(true)

    await run()
    const rows = s.sheet.tab('السوشل ميديا').rows
    expect(rows.some((r) => r[1] === 'بنك الأفكار' && r[2] === 'مسؤول السوشل ميديا')).toBe(true)
  })

  it('writes a conflict’s losing value back into the sheet, and the next run sends it to Basecamp', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    const run = () => runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    await run()
    const sub = [...s.h.fake.subtasks.values()][0]!
    // Both sides change the title before the next run: the later edit wins.
    s.sheet.set('السوشل ميديا', 2, 1, 'من الملف')
    sub.title = 'من Basecamp'
    sub.updatedAt = new Date(Date.UTC(2030, 0, 1)).toISOString()
    await run()
    const detail = await json<{ log: { id: number; action: string; detail_json: string }[] }>(await call(s.app, 'GET', `/api/station/links/${id}`, { user: s.viewer, env: s.h.env }))
    const conflict = detail.log.find((l) => l.action === 'conflict')!
    expect(JSON.parse(conflict.detail_json)).toMatchObject({ field: 'title', winner: 'remote', localValue: 'من الملف' })
    expect(s.sheet.tab('السوشل ميديا').rows[2]![1]).toBe('من Basecamp')

    const path = `/api/station/links/${id}/conflicts/${conflict.id}/restore`
    expect((await call(s.app, 'POST', path, { user: s.viewer, env: s.h.env })).status).toBe(403)
    expect((await call(s.app, 'POST', path, { user: s.admin, env: s.h.env })).status).toBe(200)
    expect(s.sheet.tab('السوشل ميديا').rows[2]![1]).toBe('من الملف')
    expect((await call(s.app, 'POST', path, { user: s.admin, env: s.h.env })).status).toBe(409)
    await run()
    expect(s.h.fake.subtasks.get(sub.id)!.title).toBe('من الملف')
  })
})

describe('linking the same file again', () => {
  it('to the same project takes the unlinked link back: same tasks, nothing created twice', async () => {
    const s = await setup()
    const body = { source: SID, bcProjectId: s.project.id, tabs: [2] }
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body, env: s.h.env }))
    await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    const created = () => s.h.fake.calls.filter((c) => c.method === 'POST' && /\/(todos|subtasks)\.json$/.test(c.path)).length
    const before = created()
    expect(before).toBe(2)

    expect((await call(s.app, 'DELETE', `/api/station/links/${id}`, { user: s.admin, env: s.h.env })).status).toBe(200)
    const again = await call(s.app, 'POST', '/api/station/links', { user: s.admin, body, env: s.h.env })
    expect(again.status).toBe(201)
    expect(await json(again)).toMatchObject({ id, relinked: true })
    await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    expect(created()).toBe(before)
    expect((await call(s.app, 'GET', `/api/station/links/${id}`, { user: s.viewer, env: s.h.env })).status).toBe(200)
  })

  it('to another project is a new link that takes over the rows, and does not create them twice', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })
    expect((await call(s.app, 'DELETE', `/api/station/links/${id}`, { user: s.admin, env: s.h.env })).status).toBe(200)

    const fahad = [...s.h.fake.people.values()].find((p) => p.name === 'Fahad Alotaibi')!
    const other = s.h.fake.project('مشروع آخر', [fahad.id, s.omarId])
    const res = await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: other.id, tabs: [2] }, env: s.h.env })
    expect(res.status).toBe(201)
    const next = await json<{ id: string; relinked?: boolean }>(res)
    expect(next.id).not.toBe(id)
    const inOther = () => [...s.h.fake.todos.values()].filter((t) => s.h.fake.lists.get(t.listId)?.projectId === other.id).length
    await runStation(s.h.env, next.id, { ...s.h.deps, google: s.sheet })
    expect(inOther()).toBe(1)
    await runStation(s.h.env, next.id, { ...s.h.deps, google: s.sheet })
    expect(inOther()).toBe(1)
  })
})

describe('triggers', () => {
  it('turns a Drive notification into a run, ignores the handshake, 404s an unknown channel', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    s.h.inbound.take()
    const secret = (await env.DB.prepare(`SELECT notify_secret FROM station_links WHERE id = ?1`).bind(id).first<{ notify_secret: string }>())!.notify_secret
    const hooks = testApp()
    hooks.route('/webhooks', stationWebhookRoutes())
    const post = (path: string, state: string) => hooks.request(path, { method: 'POST', headers: { 'X-Goog-Resource-State': state } }, s.h.env)
    expect((await post(`/webhooks/google/${secret}`, 'sync')).status).toBe(200)
    expect(s.h.inbound.take()).toEqual([])
    expect((await post(`/webhooks/google/${secret}`, 'update')).status).toBe(200)
    expect(s.h.inbound.take().map((m) => m.body)).toEqual([{ kind: 'station_sync', linkId: id, reason: 'drive' }])
    expect((await post('/webhooks/google/unknown-secret', 'update')).status).toBe(404)
  })

  it('checks the Basecamp webhook every 15 minutes, even when the link syncs more often than the full pass', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    s.h.inbound.take()
    // Only this link: the other tests' links share the database.
    await env.DB.prepare(`UPDATE station_links SET state = 'paused' WHERE id != ?1`).bind(id).run()
    const start = Date.now()
    const minute = (at: number) => stationMinute(s.h.env, { ...s.h.deps, google: s.sheet, now: () => at })
    const checks = () => s.h.fake.callsTo('GET', /\/webhooks\/\d+\.json$/).length
    // Just checked when the link was made: not again yet.
    const before = checks()
    await minute(start + 60_000)
    expect(checks()).toBe(before)
    // A full pass a minute ago (none due), but the webhook check is 16 minutes old.
    await env.DB.prepare(`UPDATE station_links SET last_sync_at = ?2, last_full_at = ?2, last_modified = ?3 WHERE id = ?1`)
      .bind(id, new Date(start + 15 * 60_000).toISOString(), await s.sheet.modifiedTime())
      .run()
    s.h.inbound.take()
    await minute(start + 16 * 60_000)
    expect(s.h.inbound.take().filter((m) => (m.body as { linkId?: string }).linkId === id)).toEqual([])
    expect(checks()).toBe(before + 1)
  })

  it('routes a Basecamp webhook of a linked project to the station, and leaves others to the old consumer', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    s.h.inbound.take()
    const acked: string[] = []
    const msg = (bcProjectId: number, mid: string) =>
      ({ id: mid, body: { kind: 'basecamp_webhook', bcWebhookId: 1, bcProjectId, receivedAt: '', body: '{}' }, ack: () => acked.push(mid), retry: () => undefined }) as unknown as Message<BcInboundQueueMessage>
    const batch = { queue: 'bc-inbound', messages: [msg(s.project.id, 'a'), msg(424242, 'b')] } as unknown as MessageBatch<BcInboundQueueMessage>
    const rest = await handleStationMessages(batch, s.h.env, { ...s.h.deps, google: s.sheet })
    expect(acked).toEqual(['a'])
    expect(rest.messages.map((m) => m.id)).toEqual(['b'])
    expect(s.h.inbound.take().map((m) => m.body)).toEqual([{ kind: 'station_sync', linkId: id, reason: 'basecamp' }])
  })

  it('lets one run hold a link; a second request asks it to run again', async () => {
    const s = await setup()
    const { id } = await json<{ id: string }>(await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env }))
    await env.DB.prepare(`UPDATE station_links SET lock_until = ?2 WHERE id = ?1`).bind(id, new Date(Date.now() + 60_000).toISOString()).run()
    expect(await runStation(s.h.env, id, { ...s.h.deps, google: s.sheet })).toBeNull()
    const row = await env.DB.prepare(`SELECT resync FROM station_links WHERE id = ?1`).bind(id).first<{ resync: number }>()
    expect(row!.resync).toBe(1)
  })
})

describe('names', () => {
  it('maps a name (admin only) and queues a run of every link', async () => {
    const s = await setup()
    await call(s.app, 'POST', '/api/station/links', { user: s.admin, body: { source: SID, bcProjectId: s.project.id, tabs: [2] }, env: s.h.env })
    s.h.inbound.take()
    const body = { name: 'مسند المحمدي', bcPersonId: s.omarId }
    expect((await call(s.app, 'PUT', '/api/station/names', { user: s.viewer, body, env: s.h.env })).status).toBe(403)
    expect((await call(s.app, 'PUT', '/api/station/names', { user: s.admin, body, env: s.h.env })).status).toBe(200)
    expect(s.h.inbound.take().length).toBeGreaterThan(0)
    const list = await json<{ names: { name: string; bc_person_id: number }[]; people: { name: string }[] }>(await call(s.app, 'GET', '/api/station/names', { user: s.viewer, env: s.h.env }))
    expect(list.names).toEqual([expect.objectContaining({ name: 'مسند المحمدي', bc_person_id: s.omarId })])
    expect(list.people.map((p) => p.name)).toContain('Fahad Alotaibi')
  })
})

describe('alert emails', () => {
  const resendEnv = (h: Harness, extra: Partial<Env> = {}): Env => ({ ...h.env, RESEND_API_KEY: 're_test', ALERT_EMAIL_FROM: 'NAF Sheets <sheets@naflaw.sa>', ALERT_EMAIL_TO: 'owner@example.com', ...extra }) as Env

  it('sends one email after the batch window, from the configured sender, and never twice', async () => {
    const s = await setup()
    const seen = new Date(Date.now() - 3 * 60_000).toISOString()
    await env.DB.prepare(`INSERT INTO station_alerts (key, link_id, alert_json, first_seen, last_seen) VALUES ('link_stopped:x', 'x', ?1, ?2, ?2)`)
      .bind(JSON.stringify({ kind: 'link_stopped', linkId: 'x', linkTitle: 'الاتصال المؤسسي والتسويق', reason: 'أُلغيت المشاركة.' }), seen)
      .run()
    const sent: { url: string; body: { from: string; to: string[]; subject: string } }[] = []
    const fetch = async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ id: 'em_1' })
    }
    expect(await sendDueAlerts(resendEnv(s.h), { fetch, now: () => Date.now() })).toBe(1)
    expect(sent[0]!.url).toBe('https://api.resend.com/emails')
    expect(sent[0]!.body).toMatchObject({ from: 'NAF Sheets <sheets@naflaw.sa>', to: ['owner@example.com'] })
    expect(sent[0]!.body.subject).toContain('الاتصال المؤسسي والتسويق')
    expect(await sendDueAlerts(resendEnv(s.h), { fetch, now: () => Date.now() })).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it('waits while the batch window is open, and sends nothing without a Resend key', async () => {
    const s = await setup()
    const now = new Date().toISOString()
    await env.DB.prepare(`INSERT INTO station_alerts (key, link_id, alert_json, first_seen, last_seen) VALUES ('link_stopped:y', 'y', ?1, ?2, ?2)`)
      .bind(JSON.stringify({ kind: 'link_stopped', linkId: 'y', linkTitle: 'ملف', reason: 'سبب.' }), now)
      .run()
    let calls = 0
    const fetch = async () => {
      calls += 1
      return Response.json({})
    }
    expect(await sendDueAlerts(resendEnv(s.h), { fetch, now: () => Date.now() })).toBe(0)
    expect(await sendDueAlerts({ ...s.h.env, RESEND_API_KEY: undefined } as Env, { fetch, now: () => Date.now() + 10 * 60_000 })).toBe(0)
    expect(calls).toBe(0)
  })
})
