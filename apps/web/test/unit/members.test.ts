import { describe, expect, it } from 'vitest'
import type { PlatformMember } from '@naf-sheets/shared'
import { createApiClient } from '../../src/lib/api'
import { lastSeenDay, memberLock, peopleMatchHref } from '../../src/lib/members'
import { parseRoute, pathFor } from '../../src/lib/routes'
import { t } from '../../src/strings'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown, calls: Call[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

function member(userId: string, role: PlatformMember['role'], active = true): PlatformMember {
  return {
    userId,
    name: userId,
    email: `${userId}@naflaw.sa`,
    role,
    active,
    lastSeenAt: null,
    createdAt: null,
    basecamp: { state: 'none', bcPersonId: null, personName: null },
  }
}

describe('«أعضاء المنصة» route', () => {
  it('maps /admin/members both ways', () => {
    expect(parseRoute('/admin/members')).toEqual({ name: 'members' })
    expect(parseRoute('/admin/members/')).toEqual({ name: 'members' })
    expect(pathFor({ name: 'members' })).toBe('/admin/members')
  })

  it('links to the people-matching row of one member', () => {
    expect(peopleMatchHref('sub-1')).toBe('/admin/people-matches#match-sub-1')
    expect(peopleMatchHref('a/b c')).toBe('/admin/people-matches#match-a%2Fb%20c')
    // The hash does not change the route.
    expect(parseRoute('/admin/people-matches')).toEqual({ name: 'peopleMatches' })
  })
})

describe('members API client', () => {
  it('GET /api/admin/members and PUT /api/admin/members/:userId with the body as given', async () => {
    const calls: Call[] = []
    await createApiClient({ fetch: fakeFetch(200, { members: [] }, calls) }).listMembers()
    const res = await createApiClient({ fetch: fakeFetch(200, { member: member('u', 'editor'), changed: true, nafIdReport: 'sent' }, calls) }).updateMember('u/1', {
      role: 'editor',
    })
    await createApiClient({ fetch: fakeFetch(200, { member: member('u', 'editor', false), changed: true, nafIdReport: 'failed' }, calls) }).updateMember('u-2', { active: false })
    expect(res.nafIdReport).toBe('sent')
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', '/api/admin/members'],
      ['PUT', '/api/admin/members/u%2F1'],
      ['PUT', '/api/admin/members/u-2'],
    ])
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ role: 'editor' })
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ active: false })
  })

  it('surfaces the API’s Arabic message for the guards', async () => {
    const message = 'لم يُحفظ التغيير: هذا آخر مسؤول نشط في المنصة.'
    const client = createApiClient({ fetch: fakeFetch(409, { ok: false, error: 'last_active_admin', message }) })
    await expect(client.updateMember('u', { role: 'viewer' })).rejects.toMatchObject({ status: 409, code: 'last_active_admin', message })
  })
})

describe('memberLock', () => {
  it('locks the signed-in admin’s own row', () => {
    const me = member('me', 'admin')
    expect(memberLock(me, 'me', [me, member('other', 'admin')])).toBe('self')
  })

  it('locks the last active admin, and only them', () => {
    const only = member('a', 'admin')
    const suspendedAdmin = member('b', 'admin', false)
    const list = [only, suspendedAdmin, member('c', 'editor')]
    expect(memberLock(only, 'me', list)).toBe('last_admin')
    expect(memberLock(suspendedAdmin, 'me', list)).toBeNull()
    expect(memberLock(list[2]!, 'me', list)).toBeNull()
    expect(memberLock(only, 'me', [...list, member('d', 'admin')])).toBeNull()
  })
})

describe('lastSeenDay', () => {
  it('is YYYY-MM-DD with Latin digits, or null', () => {
    expect(lastSeenDay('2026-11-10T22:30:00Z', 'Asia/Riyadh')).toBe('2026-11-11')
    expect(lastSeenDay('2026-11-10T22:30:00Z', 'UTC')).toBe('2026-11-10')
    expect(lastSeenDay(null)).toBeNull()
    expect(lastSeenDay('not a date')).toBeNull()
  })
})

describe('strings', () => {
  it('names the three platform roles and both states', () => {
    expect(t.members.roles).toEqual({ admin: 'مسؤول', editor: 'محرّر', viewer: 'مشاهد' })
    expect(t.members.status).toEqual({ active: 'نشط', suspended: 'موقوف' })
    expect(t.members.savedRole(t.members.roles.editor)).toBe('تم تغيير الدور إلى «محرّر»')
  })
})
