// naf-id members ↔ Basecamp people (spec §3): automatic by email with the
// SERVICE token (account emails are visible to admins only, Appendix A-7),
// manual by a platform admin. Admin only; every change audited.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { PeopleMatchesResponse } from '@naf-sheets/shared'
import { decryptJson } from '../../src/crypto'
import { call, json, seedMember } from '../helpers'
import { Clock, ENCRYPTION_KEY, FakeBasecamp, MINUTE, auditFor, expectLinkError, linkAccount, linkApp, linkEnv, person } from './fake'

// Its own account id: no other test file touches this file's service integration row.
const ACCOUNT = 7_400_004
// The account cache is one table for the whole file, so time only moves forward across tests.
const clock = new Clock()

async function serviceSetup() {
  const fake = new FakeBasecamp(ACCOUNT)
  const app = linkApp(fake, clock)
  const admin = await seedMember('admin')
  const bcAdmin = person({ admin: true, name: 'حساب الخدمة' })
  fake.accountPeople = [bcAdmin]
  expect((await linkAccount(app, fake, admin, bcAdmin, { service: true })).status).toBe(302)
  // Every test starts from a stale account cache.
  clock.advance(11 * MINUTE)
  return { fake, clock, app, admin, bcAdmin }
}

const getMatches = (app: ReturnType<typeof linkApp>, user: { id: string }) => call(app, 'GET', '/api/admin/people-matches', { user, env: linkEnv(ACCOUNT) })
const putMatch = (app: ReturnType<typeof linkApp>, user: { id: string }, userId: string, body: unknown) =>
  call(app, 'PUT', `/api/admin/people-matches/${encodeURIComponent(userId)}`, { user, body, env: linkEnv(ACCOUNT) })

function matchOf(body: PeopleMatchesResponse, userId: string) {
  return body.matches.find((m) => m.userId === userId)
}

async function setMemberEmail(userId: string, email: string): Promise<void> {
  await env.DB.prepare(`UPDATE members SET email = ?1 WHERE user_id = ?2`).bind(email, userId).run()
}

describe('admin only', () => {
  it('refuses editors and viewers on GET and PUT (Arabic), changes and logs nothing', async () => {
    const { app } = await serviceSetup()
    const target = await seedMember('viewer')
    for (const role of ['editor', 'viewer'] as const) {
      const member = await seedMember(role)
      await expectLinkError(await getMatches(app, member), 403, 'forbidden', 'مسؤول المنصة')
      await expectLinkError(await putMatch(app, member, target.id, { bcPersonId: null }), 403, 'forbidden', 'مسؤول المنصة')
    }
    expect(await env.DB.prepare(`SELECT * FROM bc_person_matches WHERE user_id = ?1`).bind(target.id).first()).toBeNull()
    expect(await auditFor(target.id)).toHaveLength(0)
  })

  it('needs a sign-in', async () => {
    const { app } = await serviceSetup()
    expect((await call(app, 'GET', '/api/admin/people-matches', { env: linkEnv(ACCOUNT) })).status).toBe(401)
  })
})

describe('GET /api/admin/people-matches', () => {
  it('matches by email (case-insensitive) using the service token, audited as a system action', async () => {
    const { app, fake, admin } = await serviceSetup()
    const member = await seedMember('editor')
    await setMemberEmail(member.id, 'Noura.Ali@NAFLAW.sa')
    const noura = person({ name: 'نورة', email_address: 'noura.ali@naflaw.sa' })
    fake.accountPeople.push(noura)

    const res = await getMatches(app, admin)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json<PeopleMatchesResponse>(res)
    expect(matchOf(body, member.id)).toEqual({ userId: member.id, name: member.name, email: 'Noura.Ali@NAFLAW.sa', bcPersonId: noura.id, source: 'email' })
    expect(body.people.find((p) => p.id === noura.id)).toMatchObject({ name: 'نورة', email: 'noura.ali@naflaw.sa', personableType: 'User', client: false })

    // /people.json was read with the service token, not the admin's own link.
    const service = await env.DB.prepare(`SELECT id, encrypted_tokens FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`)
      .bind(String(ACCOUNT))
      .first<{ id: string; encrypted_tokens: string }>()
    const serviceToken = (await decryptJson<{ access_token: string }>(ENCRYPTION_KEY, service?.encrypted_tokens as string, `integrations:${service?.id}`)).access_token
    expect(fake.callsTo(`${fake.apiBase}/people.json`).at(-1)?.headers['authorization']).toBe(`Bearer ${serviceToken}`)

    const audit = await auditFor(member.id, 'basecamp.people_match.auto')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: null, entity_type: 'member' })
    expect(JSON.parse(audit[0]?.details_json as string)).toEqual({ bcPersonId: noura.id, source: 'email' })

    // A second visit matches nothing new and logs nothing new.
    expect((await getMatches(app, admin)).status).toBe(200)
    expect(await auditFor(member.id, 'basecamp.people_match.auto')).toHaveLength(1)
  })

  it('leaves ambiguous, redacted, non-human and already-taken cases unmatched', async () => {
    const { app, fake, admin } = await serviceSetup()
    const tag = crypto.randomUUID().slice(0, 8)

    // Two Basecamp people with one address.
    const twinMember = await seedMember('editor')
    await setMemberEmail(twinMember.id, `twin-${tag}@naflaw.sa`)
    fake.accountPeople.push(person({ email_address: `twin-${tag}@naflaw.sa` }), person({ email_address: `TWIN-${tag}@naflaw.sa` }))

    // Two members with one address.
    const shared1 = await seedMember('editor')
    const shared2 = await seedMember('viewer')
    await setMemberEmail(shared1.id, `shared-${tag}@naflaw.sa`)
    await setMemberEmail(shared2.id, `shared-${tag}@naflaw.sa`)
    fake.accountPeople.push(person({ email_address: `shared-${tag}@naflaw.sa` }))

    // An agent with the member's address.
    const agentMember = await seedMember('editor')
    await setMemberEmail(agentMember.id, `agent-${tag}@naflaw.sa`)
    fake.accountPeople.push(person({ email_address: `agent-${tag}@naflaw.sa`, personable_type: 'Agent' }))

    const body = await json<PeopleMatchesResponse>(await getMatches(app, admin))
    for (const id of [twinMember.id, shared1.id, shared2.id, agentMember.id]) {
      expect(matchOf(body, id)).toMatchObject({ bcPersonId: null, source: null })
    }
    // Only humans are offered for manual matching (Appendix A-2).
    expect(body.people.every((p) => p.personableType === 'User')).toBe(true)
  })

  it('cannot match by email when the service account sees redacted emails', async () => {
    const { app, fake, admin, bcAdmin } = await serviceSetup()
    bcAdmin.admin = false
    const member = await seedMember('editor')
    await setMemberEmail(member.id, 'hidden@naflaw.sa')
    fake.accountPeople.push(person({ email_address: 'hidden@naflaw.sa' }))
    const body = await json<PeopleMatchesResponse>(await getMatches(app, admin))
    expect(matchOf(body, member.id)).toMatchObject({ bcPersonId: null, source: null })
    const stored = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bc_account_people_cache WHERE email LIKE '%•%'`).first<{ n: number }>()
    expect(stored?.n).toBe(0)
  })

  it('refreshes the account cache only when older than 10 minutes; people who left are marked removed, not deleted', async () => {
    const { app, fake, clock, admin } = await serviceSetup()
    const leaving = person({ name: 'مغادر' })
    fake.accountPeople.push(leaving)
    const calls = () => fake.callsTo(`${fake.apiBase}/people.json`).length

    await getMatches(app, admin)
    const afterFirst = calls()
    clock.advance(9 * MINUTE)
    await getMatches(app, admin)
    expect(calls()).toBe(afterFirst)

    fake.accountPeople = fake.accountPeople.filter((p) => p.id !== leaving.id)
    clock.advance(2 * MINUTE)
    const body = await json<PeopleMatchesResponse>(await getMatches(app, admin))
    expect(calls()).toBe(afterFirst + 1)
    expect(body.people.map((p) => p.id)).not.toContain(leaving.id)
    const row = await env.DB.prepare(`SELECT name, removed_at FROM bc_account_people_cache WHERE bc_person_id = ?1`).bind(leaving.id).first<{ name: string; removed_at: string }>()
    expect(row).toEqual({ name: 'مغادر', removed_at: new Date(clock.now).toISOString() })
  })

  it('answers 409 in Arabic when no service token is connected, or when its refresh is refused (then marked expired)', async () => {
    const { app, fake, clock, admin } = await serviceSetup()
    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } }
    clock.advance(fake.expiresIn * 1000)
    await expectLinkError(await getMatches(app, admin), 409, 'basecamp_service_not_linked', 'حساب الخدمة')
    const row = await env.DB.prepare(`SELECT id, status, encrypted_tokens FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`)
      .bind(String(ACCOUNT))
      .first<{ id: string; status: string; encrypted_tokens: string }>()
    expect(row).toMatchObject({ status: 'expired', encrypted_tokens: '' })
    expect(await auditFor(row?.id as string, 'basecamp.service.expire')).toHaveLength(1)

    clock.advance(11 * MINUTE)
    await expectLinkError(await getMatches(app, admin), 409, 'basecamp_service_not_linked', 'حساب الخدمة')
  })
})

describe('PUT /api/admin/people-matches/:userId', () => {
  it('sets a manual match, audited with the admin as actor; the same value again logs nothing', async () => {
    const { app, fake, admin } = await serviceSetup()
    const member = await seedMember('viewer')
    const target = person({ name: 'خالد' })
    fake.accountPeople.push(target)
    await getMatches(app, admin)

    const res = await putMatch(app, admin, member.id, { bcPersonId: target.id })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ userId: member.id, name: member.name, email: member.email, bcPersonId: target.id, source: 'manual' })

    const audit = await auditFor(member.id, 'basecamp.people_match.set')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: admin.id, entity_type: 'member' })
    expect(JSON.parse(audit[0]?.details_json as string)).toEqual({ from: null, to: { bcPersonId: target.id, source: 'manual' } })

    expect((await putMatch(app, admin, member.id, { bcPersonId: target.id })).status).toBe(200)
    expect(await auditFor(member.id, 'basecamp.people_match.set')).toHaveLength(1)

    const body = await json<PeopleMatchesResponse>(await getMatches(app, admin))
    expect(matchOf(body, member.id)).toMatchObject({ bcPersonId: target.id, source: 'manual' })
  })

  it('overrides an email match, and a manual "no person" (null) is never re-matched automatically', async () => {
    const { app, fake, clock, admin } = await serviceSetup()
    const member = await seedMember('editor')
    const tag = crypto.randomUUID().slice(0, 8)
    await setMemberEmail(member.id, `auto-${tag}@naflaw.sa`)
    const auto = person({ email_address: `auto-${tag}@naflaw.sa` })
    fake.accountPeople.push(auto)
    expect(matchOf(await json<PeopleMatchesResponse>(await getMatches(app, admin)), member.id)).toMatchObject({ bcPersonId: auto.id, source: 'email' })

    const res = await putMatch(app, admin, member.id, { bcPersonId: null })
    expect(await json(res)).toMatchObject({ bcPersonId: null, source: 'manual' })
    const audit = await auditFor(member.id, 'basecamp.people_match.set')
    expect(JSON.parse(audit.at(-1)?.details_json as string)).toEqual({ from: { bcPersonId: auto.id, source: 'email' }, to: { bcPersonId: null, source: 'manual' } })

    clock.advance(11 * MINUTE)
    expect(matchOf(await json<PeopleMatchesResponse>(await getMatches(app, admin)), member.id)).toMatchObject({ bcPersonId: null, source: 'manual' })
    // The row was replaced, never deleted.
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bc_person_matches WHERE user_id = ?1`).bind(member.id).first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })

  it('refuses a person matched to someone else (409), an unknown person or member (404), and a malformed body (400)', async () => {
    const { app, fake, admin } = await serviceSetup()
    const first = await seedMember('editor')
    const second = await seedMember('editor')
    const target = person()
    const agent = person({ personable_type: 'Agent' })
    fake.accountPeople.push(target, agent)
    await getMatches(app, admin)
    expect((await putMatch(app, admin, first.id, { bcPersonId: target.id })).status).toBe(200)

    await expectLinkError(await putMatch(app, admin, second.id, { bcPersonId: target.id }), 409, 'person_already_matched', 'عضو آخر')
    await expectLinkError(await putMatch(app, admin, second.id, { bcPersonId: 987654321987 }), 404, 'not_found', 'Basecamp')
    await expectLinkError(await putMatch(app, admin, second.id, { bcPersonId: agent.id }), 404, 'not_found')
    await expectLinkError(await putMatch(app, admin, 'sub-does-not-exist', { bcPersonId: null }), 404, 'not_found', 'العضو')
    for (const body of [{}, { bcPersonId: '12' }, { bcPersonId: -1 }, { bcPersonId: 1.5 }, [1]]) {
      await expectLinkError(await putMatch(app, admin, second.id, body), 400, 'invalid_request', 'bcPersonId')
    }
    const notJson = await call(app, 'PUT', `/api/admin/people-matches/${second.id}`, { user: admin, rawBody: '{', env: linkEnv(ACCOUNT) })
    await expectLinkError(notJson, 400, 'invalid_json')
    expect(await auditFor(second.id, 'basecamp.people_match.set')).toHaveLength(0)
  })
})
