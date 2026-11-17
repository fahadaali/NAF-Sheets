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
    const detail = await json<{ tabs: { bc_todolist_id: number | null }[]; log: { action: string }[] }>(await call(s.app, 'GET', `/api/station/links/${id}`, { user: s.viewer, env: s.h.env }))
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
    expect(await env.DB.prepare(`SELECT id FROM station_links WHERE id = ?1`).bind(id).first()).toBeNull()
    const audit = await env.DB.prepare(`SELECT actor_id, details_json FROM audit_log WHERE action = 'station.link.delete' AND entity_id = ?1`).bind(id).first<{ actor_id: string; details_json: string }>()
    expect(audit?.actor_id).toBe(s.admin.id)
    expect(JSON.parse(audit!.details_json)).toEqual({ spreadsheetId: SID, bcProjectId: s.project.id })
    const gone = await call(s.app, 'DELETE', `/api/station/links/${id}`, { user: s.admin, env: s.h.env })
    expect(gone.status).toBe(404)
    expect(isArabic((await json<{ message: string }>(gone)).message)).toBe(true)
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
    // The link synced a minute ago (no full pass due), but the webhook check is 16 minutes old.
    await env.DB.prepare(`UPDATE station_links SET last_sync_at = ?2, last_modified = ?3 WHERE id = ?1`)
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
