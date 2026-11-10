// Routes of packages/shared/src/api-sync.ts: who may call what (a viewer is
// read-only on every write route; sync health is admin only), and what they
// answer.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { AssigneeOptionsResponse, ExternalContact, SyncHealthResponse, WorkbookSyncResponse } from '@naf-sheets/shared'
import { isArabic } from '../helpers'
import { call, edit, harness, json, linkUser, seedMember, setupLinked } from './harness'

async function addMember(workbookId: string, userId: string, role: 'editor' | 'viewer', by: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(workbookId, userId, role, by, new Date().toISOString()).run()
}

describe('permissions', () => {
  it('a viewer gets 403 (Arabic) on every write route, and nothing reaches Basecamp or the queues', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const viewer = await seedMember('editor')
    await addMember(l.wbId, viewer.id, 'viewer', l.owner.id)
    await linkUser(h, viewer.id, h.fake.person('قارئ'))
    const platformViewer = await seedMember('viewer')
    const calls = h.fake.calls.length
    const routes: Array<[string, string, unknown, { id: string }]> = [
      ['POST', `/api/workbooks/${l.wbId}/link/preview`, { project: { mode: 'none' }, sheets: [] }, viewer],
      ['POST', `/api/workbooks/${l.wbId}/link`, { project: { mode: 'none' }, sheets: [] }, viewer],
      ['POST', `/api/workbooks/${l.wbId}/sync-now`, {}, viewer],
      ['POST', `/api/workbooks/${l.wbId}/conflicts/any/restore`, {}, viewer],
      ['POST', `/api/workbooks/${l.wbId}/conflicts/any/dismiss`, {}, viewer],
      ['POST', `/api/workbooks/${l.wbId}/project-people`, { bcPersonId: 5 }, viewer],
      ['POST', '/api/external-contacts', { name: 'جهة' }, platformViewer],
      ['GET', '/api/admin/sync-health', undefined, viewer],
    ]
    for (const [method, path, body, user] of routes) {
      const res = await call(h.app, method, path, { user, env: h.env, body })
      expect(res.status, path).toBe(403)
      const err = await json<{ error: string; message: string }>(res)
      expect(err.error, path).toBe('forbidden')
      expect(isArabic(err.message), path).toBe(true)
    }
    expect(h.fake.calls.length).toBe(calls)
    expect(h.outbound.sent).toEqual([])
    expect(h.inbound.sent).toEqual([])
    // Read routes stay open to the viewer.
    for (const path of [`/api/workbooks/${l.wbId}/sync`, `/api/workbooks/${l.wbId}/conflicts`, `/api/workbooks/${l.wbId}/assignee-options`]) {
      expect((await call(h.app, 'GET', path, { user: viewer, env: h.env })).status, path).toBe(200)
    }
  })

  it('someone outside the workbook gets 404 on every sync route', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }] })
    const outsider = await seedMember('editor')
    for (const path of [`/api/workbooks/${l.wbId}/sync`, `/api/workbooks/${l.wbId}/conflicts`]) {
      expect((await call(h.app, 'GET', path, { user: outsider, env: h.env })).status).toBe(404)
    }
    expect((await call(h.app, 'POST', `/api/workbooks/${l.wbId}/sync-now`, { user: outsider, env: h.env })).status).toBe(404)
  })
})

describe('GET /api/workbooks/:id/sync', () => {
  it('reports each row, the counts and the Basecamp link; unlinked workbooks read unlinked', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }, { title: 'ب' }], service: true })
    await edit(l, (v) => v.remove(v.row('ب')))
    const res = await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env })
    const body = await json<WorkbookSyncResponse>(res)
    expect(body.state).toBe('error')
    expect(body.counts).toEqual({ pending: 0, error: 1, conflict: 0 })
    expect(body.notice).toBeNull()
    expect(body.lastSuccessAt).not.toBeNull()
    const a = body.tasks.find((t) => t.uid === (body.tasks[0]?.uid ?? ''))
    expect(a).toBeDefined()
    const synced = body.tasks.find((t) => t.state === 'synced')
    expect(synced?.bcUrl).toMatch(new RegExp(`^https://3\\.basecamp\\.com/${h.fake.accountId}/buckets/${l.project.id}/todos/\\d+$`))
    expect(synced?.assignMode).toBe('auto')
    expect(synced?.remoteStatus).toBe('active')
    const broken = body.tasks.find((t) => t.state === 'error')
    expect(isArabic(broken?.message)).toBe(true)

    const other = await seedMember('editor')
    const created = await call(h.app, 'POST', '/api/workbooks', { user: other, env: h.env, body: { title: 'غير مربوط', source: 'blank' } })
    const { id } = await json<{ id: string }>(created)
    const unlinked = await json<WorkbookSyncResponse>(await call(h.app, 'GET', `/api/workbooks/${id}/sync`, { user: other, env: h.env }))
    expect(unlinked).toMatchObject({ state: 'unlinked', tasks: [], notice: null })
  })
})

describe('POST /api/workbooks/:id/sync-now', () => {
  it('queues a reconciliation of the workbook (202) and the rows still waiting', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const res = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/sync-now`, { user: l.owner, env: h.env })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: 1 })
    expect(h.inbound.sent.map((m) => m.body)).toEqual([expect.objectContaining({ kind: 'reconcile', workbookId: l.wbId, requestedBy: l.owner.id })])
  })
})

describe('assignee options and external contacts (§8.2)', () => {
  it('lists project people, account people outside the project, and externals; emails only for admins', async () => {
    const h = harness()
    const l = await setupLinked(h, { people: ['سارة'], rows: [{ title: 'أ' }], service: true })
    const outside = h.fake.person('خارج المشروع')
    // The account cache is refreshed when older than 10 minutes (§9.5).
    await env.DB.prepare(`UPDATE bc_account_people_cache SET refreshed_at = ?1`).bind(new Date(Date.now() - 3600_000).toISOString()).run()
    const created = await call(h.app, 'POST', '/api/external-contacts', { user: l.owner, env: h.env, body: { name: 'وكالة', organization: 'شركة', email: 'a@b.sa' } })
    expect(created.status).toBe(201)
    const contact = await json<ExternalContact>(created)
    expect(contact).toMatchObject({ name: 'وكالة', organization: 'شركة', email: 'a@b.sa', phone: null })

    const res = await call(h.app, 'GET', `/api/workbooks/${l.wbId}/assignee-options`, { user: l.owner, env: h.env })
    const body = await json<AssigneeOptionsResponse>(res)
    expect(body.projectPeople.map((p) => p.name)).toEqual(expect.arrayContaining(['سارة', 'أحمد المالك']))
    expect(body.projectPeople.every((p) => p.email === null)).toBe(true)
    expect(body.accountPeople.map((p) => p.id)).toContain(outside.id)
    expect(body.accountPeople.map((p) => p.id)).not.toContain(l.people['سارة']?.id)
    expect(body.externals.map((e) => e.id)).toContain(contact.id)
    expect(body.refreshedAt).not.toBeNull()

    const bad = await call(h.app, 'POST', '/api/external-contacts', { user: l.owner, env: h.env, body: { name: '  ' } })
    expect(bad.status).toBe(400)
  })

  it('project-people adds an account member with the caller’s token; a 403 from Basecamp is the §8.2 Arabic message', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const outside = h.fake.person('عضو حساب')
    // The owner is not an admin in Basecamp: Basecamp answers 403.
    const refused = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/project-people`, { user: l.owner, env: h.env, body: { bcPersonId: outside.id } })
    expect(refused.status).toBe(403)
    expect((await json<{ message: string }>(refused)).message).toBe('لا تملك صلاحية إضافة أعضاء للمشروع؛ اطلب ذلك من مدير المشروع.')

    const ownerPerson = h.fake.people.get(l.ownerPerson.id)
    if (ownerPerson) ownerPerson.admin = true
    const granted = await call(h.app, 'POST', `/api/workbooks/${l.wbId}/project-people`, { user: l.owner, env: h.env, body: { bcPersonId: outside.id } })
    expect(granted.status).toBe(200)
    const put = h.fake.callsTo('PUT', /\/people\/users\.json$/).at(-1)
    expect(put?.token).toBe(l.token)
    expect(put?.body).toEqual({ grant: [outside.id] })
    const body = await json<AssigneeOptionsResponse>(granted)
    expect(body.projectPeople.map((p) => p.id)).toContain(outside.id)
  })
})

describe('GET /api/admin/sync-health', () => {
  it('reports counts, last success, webhook state and dead letters to admins', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'أ' }], service: true })
    const admin = l.admin as { id: string }
    const res = await call(h.app, 'GET', '/api/admin/sync-health', { user: admin, env: h.env })
    expect(res.status).toBe(200)
    const body = await json<SyncHealthResponse>(res)
    const mine = body.workbooks.find((w) => w.workbookId === l.wbId)
    expect(mine).toMatchObject({ bcProjectId: l.project.id, webhook: 'active', counts: { pending: 0, error: 0, conflict: 0 } })
    expect(typeof body.deadLetters).toBe('number')
  })
})
