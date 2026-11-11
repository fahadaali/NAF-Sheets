// «أعضاء المنصة»: GET/PUT /api/admin/members (src/routes/platform-members.ts).
// naf-id is never called: the reporter is a fake, or global fetch is stubbed.

import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformMembersResponse, UpdatePlatformMemberResponse } from '@naf-sheets/shared'
import { createApp } from '../src/app'
import type { AuthMiddleware } from '../src/auth'
import { REVOKE_REASON } from '../src/routes/platform-members'
import type { AccessReporter } from '../src/routes/platform-members'
import { ROOM_CLOSE_ACCESS_CHANGED } from '../src/room'
import { call, createWorkbook, isArabic, json, seedMember, testApp } from './helpers'
import type { SeededMember } from './helpers'

type Report = Parameters<AccessReporter>[1]

function appWithReports(fail = false) {
  const reports: Report[] = []
  const app = testApp({
    reportAccess: async (_env, change) => {
      reports.push(change)
      if (fail) throw Object.assign(new Error('naf-id down'), { code: 'access_report_failed' })
    },
  })
  return { app, reports }
}

interface AuditRow {
  actor_id: string
  action: string
  entity_type: string
  entity_id: string
  details_json: string
}

async function memberAudit(userId: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_type = 'member' AND entity_id = ?1 AND action = 'member.access.update' ORDER BY id`)
    .bind(userId)
    .all<AuditRow>()
  return results
}

async function memberRow(userId: string) {
  return env.DB.prepare('SELECT role, is_active FROM members WHERE user_id = ?1').bind(userId).first<{ role: string; is_active: number }>()
}

async function expectApiError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  const body = await json(res)
  expect(body).toMatchObject({ ok: false, error })
  expect(isArabic(body.message)).toBe(true)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/admin/members', () => {
  it('lists every member with role, state, dates and Basecamp match', async () => {
    const { app } = appWithReports()
    const admin = await seedMember('admin')
    const auto = await seedMember('editor')
    const manual = await seedMember('viewer')
    const declined = await seedMember('viewer')
    const none = await seedMember('viewer', { active: false })
    await env.DB.prepare(`UPDATE members SET last_seen_at = 1793000000 WHERE user_id = ?1`).bind(auto.id).run()

    const at = new Date().toISOString()
    const p1 = 900_000_000 + Math.floor(Math.random() * 1_000_000)
    const p2 = p1 + 1
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bc_account_people_cache (bc_person_id, name, email, personable_type, client, refreshed_at) VALUES (?1, 'سارة', 's@x.sa', 'User', 0, ?2)`).bind(p1, at),
      env.DB.prepare(`INSERT INTO bc_account_people_cache (bc_person_id, name, email, personable_type, client, refreshed_at) VALUES (?1, 'علي', 'a@x.sa', 'User', 0, ?2)`).bind(p2, at),
      env.DB.prepare(`INSERT INTO bc_person_matches (user_id, bc_person_id, source, matched_by, matched_at) VALUES (?1, ?2, 'email', NULL, ?3)`).bind(auto.id, p1, at),
      env.DB.prepare(`INSERT INTO bc_person_matches (user_id, bc_person_id, source, matched_by, matched_at) VALUES (?1, ?2, 'manual', ?3, ?4)`).bind(manual.id, p2, admin.id, at),
      env.DB.prepare(`INSERT INTO bc_person_matches (user_id, bc_person_id, source, matched_by, matched_at) VALUES (?1, NULL, 'manual', ?2, ?3)`).bind(declined.id, admin.id, at),
    ])

    const res = await call(app, 'GET', '/api/admin/members', { user: admin })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { members } = await json<PlatformMembersResponse>(res)
    const byId = new Map(members.map((m) => [m.userId, m]))

    expect(byId.get(auto.id)).toMatchObject({
      name: auto.name,
      email: auto.email,
      role: 'editor',
      active: true,
      lastSeenAt: new Date(1793000000 * 1000).toISOString(),
      basecamp: { state: 'auto', bcPersonId: p1, personName: 'سارة' },
    })
    expect(byId.get(auto.id)?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(byId.get(manual.id)?.basecamp).toEqual({ state: 'manual', bcPersonId: p2, personName: 'علي' })
    expect(byId.get(declined.id)?.basecamp).toEqual({ state: 'declined', bcPersonId: null, personName: null })
    expect(byId.get(none.id)).toMatchObject({ active: false, lastSeenAt: null, basecamp: { state: 'none', bcPersonId: null, personName: null } })
    // Active members come first.
    const firstInactive = members.findIndex((m) => !m.active)
    expect(members.slice(firstInactive).every((m) => !m.active)).toBe(true)
  })

  it('refuses editors and viewers with 403', async () => {
    const { app } = appWithReports()
    for (const role of ['editor', 'viewer'] as const) {
      const member = await seedMember(role)
      await expectApiError(await call(app, 'GET', '/api/admin/members', { user: member }), 403, 'forbidden')
    }
  })
})

describe('PUT /api/admin/members/:userId', () => {
  it('refuses editors and viewers with 403 and changes nothing', async () => {
    const { app, reports } = appWithReports()
    const target = await seedMember('viewer')
    for (const role of ['editor', 'viewer'] as const) {
      const member = await seedMember(role)
      await expectApiError(await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: member, body: { role: 'admin' } }), 403, 'forbidden')
      // Not even on themselves.
      await expectApiError(await call(app, 'PUT', `/api/admin/members/${member.id}`, { user: member, body: { role: 'admin' } }), 403, 'forbidden')
    }
    expect(await memberRow(target.id)).toEqual({ role: 'viewer', is_active: 1 })
    expect(await memberAudit(target.id)).toEqual([])
    expect(reports).toEqual([])
  })

  it('changes the role, audits it, reports it to naf-id, and the next request runs with it', async () => {
    const { app, reports } = appWithReports()
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')

    // A viewer cannot create workbooks.
    await expectApiError(await call(app, 'POST', '/api/workbooks', { user: target, body: { title: 'خطة', source: 'blank' } }), 403, 'forbidden')

    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { role: 'editor' } })
    expect(res.status).toBe(200)
    const body = await json<UpdatePlatformMemberResponse>(res)
    expect(body).toMatchObject({ changed: true, nafIdReport: 'sent', member: { userId: target.id, role: 'editor', active: true } })
    expect(reports).toEqual([{ email: target.email, role: 'editor' }])

    const audit = await memberAudit(target.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: admin.id, entity_type: 'member', entity_id: target.id })
    expect(JSON.parse(audit[0]!.details_json)).toEqual({ from: { role: 'viewer', active: true }, to: { role: 'editor', active: true } })

    // Next request: /api/me shows the new role, and creating a workbook works.
    expect(await json(await call(app, 'GET', '/api/me', { user: target }))).toMatchObject({ user: { role: 'editor' } })
    expect((await call(app, 'POST', '/api/workbooks', { user: target, body: { title: 'خطة', source: 'blank' } })).status).toBe(201)
  })

  it('caps workbook roles by the new platform role (demotion to viewer)', async () => {
    const { app } = appWithReports()
    const admin = await seedMember('admin')
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)

    const before = await json<{ workbook: { access: string } }>(await call(app, 'GET', `/api/workbooks/${id}`, { user: owner }))
    expect(before.workbook.access).toBe('owner')

    expect((await call(app, 'PUT', `/api/admin/members/${owner.id}`, { user: admin, body: { role: 'viewer' } })).status).toBe(200)
    const after = await json<{ workbook: { access: string } }>(await call(app, 'GET', `/api/workbooks/${id}`, { user: owner }))
    expect(after.workbook.access).toBe('viewer')
  })

  it('suspends: the next request is refused; reactivating lets them back in; both reported to naf-id', async () => {
    const { app, reports } = appWithReports()
    const admin = await seedMember('admin')
    const target = await seedMember('editor')

    const off = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { active: false } })
    expect(off.status).toBe(200)
    expect(await json(off)).toMatchObject({ changed: true, nafIdReport: 'sent', member: { active: false, role: 'editor' } })
    await expectApiError(await call(app, 'GET', '/api/me', { user: target }), 403, 'access_denied')

    const on = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { active: true } })
    expect(on.status).toBe(200)
    expect((await call(app, 'GET', '/api/me', { user: target })).status).toBe(200)

    expect(reports).toEqual([
      { email: target.email, state: 'revoked', reason: REVOKE_REASON },
      { email: target.email, state: 'granted' },
    ])
    const audit = await memberAudit(target.id)
    expect(audit.map((a) => JSON.parse(a.details_json).to)).toEqual([
      { role: 'editor', active: false },
      { role: 'editor', active: true },
    ])
  })

  it('sends role and state together when both change', async () => {
    const { app, reports } = appWithReports()
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')
    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { role: 'editor', active: false } })
    expect(res.status).toBe(200)
    expect(reports).toEqual([{ email: target.email, role: 'editor', state: 'revoked', reason: REVOKE_REASON }])
  })

  it('answers changed:false and reports nothing when nothing changes', async () => {
    const { app, reports } = appWithReports()
    const admin = await seedMember('admin')
    const target = await seedMember('editor')
    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { role: 'editor', active: true } })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ changed: false, nafIdReport: 'not_needed' })
    expect(reports).toEqual([])
    expect(await memberAudit(target.id)).toEqual([])
  })

  it('keeps the change when the naf-id report fails, and says so', async () => {
    const { app, reports } = appWithReports(true)
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { role: 'editor' } })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ changed: true, nafIdReport: 'failed', member: { role: 'editor' } })
    expect(reports).toHaveLength(1)
    expect(await memberRow(target.id)).toEqual({ role: 'editor', is_active: 1 })
    expect(await memberAudit(target.id)).toHaveLength(1)
    // Logged by code only: no email.
    expect(warn).toHaveBeenCalledWith('members: naf-id access report failed (access_report_failed)')
    expect(String(warn.mock.calls)).not.toContain(target.email)
    warn.mockRestore()
  })

  it('skips the report for a member without an email', async () => {
    const { app, reports } = appWithReports()
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')
    await env.DB.prepare('UPDATE members SET email = NULL WHERE user_id = ?1').bind(target.id).run()
    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { role: 'editor' } })
    expect(await json(res)).toMatchObject({ changed: true, nafIdReport: 'skipped' })
    expect(reports).toEqual([])
  })

  it('refuses an admin changing their own role or state', async () => {
    const { app, reports } = appWithReports()
    const admin = await seedMember('admin')
    await seedMember('admin')
    for (const body of [{ role: 'editor' }, { role: 'viewer' }, { active: false }]) {
      await expectApiError(await call(app, 'PUT', `/api/admin/members/${admin.id}`, { user: admin, body }), 409, 'cannot_change_self')
    }
    expect(await memberRow(admin.id)).toEqual({ role: 'admin', is_active: 1 })
    expect(await memberAudit(admin.id)).toEqual([])
    expect(reports).toEqual([])
    // A no-op on oneself is fine.
    expect((await call(app, 'PUT', `/api/admin/members/${admin.id}`, { user: admin, body: { role: 'admin' } })).status).toBe(200)
  })

  it('lets one admin demote another while another admin remains', async () => {
    const { app } = appWithReports()
    const a = await seedMember('admin')
    const b = await seedMember('admin')
    const res = await call(app, 'PUT', `/api/admin/members/${b.id}`, { user: a, body: { role: 'editor' } })
    expect(res.status).toBe(200)
    expect(await memberRow(b.id)).toEqual({ role: 'editor', is_active: 1 })
  })

  it('rejects invalid bodies and unknown members', async () => {
    const { app } = appWithReports()
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')
    for (const body of [{}, { role: 'owner' }, { active: 'no' }, { role: 'editor', extra: 1 }, [], 'x']) {
      await expectApiError(await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body }), 400, 'invalid_request')
    }
    await expectApiError(await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, rawBody: '{', headers: { 'content-type': 'application/json' } }), 400, 'invalid_json')
    await expectApiError(await call(app, 'PUT', '/api/admin/members/sub-nobody', { user: admin, body: { role: 'editor' } }), 404, 'not_found')
  })

  it('closes the member’s open realtime connections so they reconnect under the new access', async () => {
    const { app } = appWithReports()
    const admin = await seedMember('admin')
    const owner = await seedMember('editor')
    const id = await createWorkbook(app, owner)
    const res = await call(app, 'GET', `/api/workbooks/${id}/room`, { user: owner, headers: { upgrade: 'websocket' } })
    expect(res.status).toBe(101)
    const socket = res.webSocket!
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (e) => resolve(e.code)))
    socket.accept()

    expect((await call(app, 'PUT', `/api/admin/members/${owner.id}`, { user: admin, body: { role: 'viewer' } })).status).toBe(200)
    expect(await closed).toBe(ROOM_CLOSE_ACCESS_CHANGED)
  })
})

describe('the last active admin', () => {
  // The caller must be an active admin to reach the route, so the guard is
  // only reachable when the caller was demoted or suspended while their
  // request ran. This guard trusts a stale caller to reproduce that.
  const staleAdmin = (id: string): AuthMiddleware => async (c, next) => {
    c.set('user', { id, role: 'admin', perms: null })
    await next()
  }

  it('is never demoted or suspended', async () => {
    const target = await seedMember('admin')
    const stale: SeededMember = await seedMember('viewer')
    // Make `target` the only active admin of the database.
    await env.DB.prepare(`UPDATE members SET is_active = 0 WHERE role = 'admin' AND user_id <> ?1`).bind(target.id).run()
    const reports: Report[] = []
    const app = createApp({ auth: staleAdmin(stale.id), reportAccess: async (_e, change) => void reports.push(change) })

    for (const body of [{ role: 'editor' }, { role: 'viewer' }, { active: false }]) {
      await expectApiError(await call(app, 'PUT', `/api/admin/members/${target.id}`, { body }), 409, 'last_active_admin')
    }
    expect(await memberRow(target.id)).toEqual({ role: 'admin', is_active: 1 })
    expect(await memberAudit(target.id)).toEqual([])
    expect(reports).toEqual([])

    // Once another admin is active, the change goes through.
    await seedMember('admin')
    expect((await call(app, 'PUT', `/api/admin/members/${target.id}`, { body: { role: 'editor' } })).status).toBe(200)
  })
})

describe('the naf-id report through naf-auth (global fetch stubbed)', () => {
  const issuer = 'https://app.naflaw.sa'
  const secretEnv = () => ({ ...env, AUTH_CLIENT_SECRET: 'test-only-not-a-secret' })

  it('POSTs the change to {AUTH_ISSUER}/api/internal/access', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) })
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const app = testApp()
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')
    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { active: false }, env: secretEnv() })
    expect(await json(res)).toMatchObject({ changed: true, nafIdReport: 'sent' })
    expect(seen).toEqual([
      {
        url: `${issuer}/api/internal/access`,
        body: { platformId: env.PLATFORM_ID, secret: 'test-only-not-a-secret', email: target.email, state: 'revoked', reason: REVOKE_REASON },
      },
    ])
  })

  it('reports failed when naf-id refuses, and the change stands', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = testApp()
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')
    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { role: 'admin' }, env: secretEnv() })
    expect(await json(res)).toMatchObject({ changed: true, nafIdReport: 'failed', member: { role: 'admin' } })
    expect(await memberRow(target.id)).toEqual({ role: 'admin', is_active: 1 })
    expect(warn).toHaveBeenCalledWith('members: naf-id access report failed (access_report_failed)')
    // The secret is never logged.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test-only-not-a-secret')
    warn.mockRestore()
  })

  it('reports failed when the secret is missing (no request is sent)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = testApp()
    const admin = await seedMember('admin')
    const target = await seedMember('viewer')
    const res = await call(app, 'PUT', `/api/admin/members/${target.id}`, { user: admin, body: { role: 'editor' }, env: { ...env, AUTH_CLIENT_SECRET: undefined } })
    expect(await json(res)).toMatchObject({ changed: true, nafIdReport: 'failed' })
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
