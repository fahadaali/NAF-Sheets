// Token refresh before expiry, expiry on a refused refresh (spec §3: never fall
// back to another account's token) and revocation that keeps the row.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { decryptJson } from '../../src/crypto'
import { LinkFailure, REFRESH_MARGIN_MS, linkContextFor, withUserToken } from '../../src/basecamp-link'
import { call, json, seedMember } from '../helpers'
import { Clock, ENCRYPTION_KEY, FakeBasecamp, MINUTE, auditFor, expectLinkError, linkAccount, linkApp, linkEnv, linkRow, person, uniqueId } from './fake'
import type { FakePerson } from './fake'

const ACCOUNT = 7_200_002

async function linkedSetup(role: 'viewer' | 'editor' = 'editor') {
  const fake = new FakeBasecamp(ACCOUNT)
  const clock = new Clock()
  const app = linkApp(fake, clock)
  const user = await seedMember(role)
  const who: FakePerson = person()
  fake.projects.push({ id: uniqueId(), name: 'خطة الاتصال', description: 'وصف', todosetId: uniqueId(), peopleIds: [who.id], todolists: [] })
  const res = await linkAccount(app, fake, user, who)
  if (res.status !== 302) throw new Error(`link failed: ${res.status}`)
  return { fake, clock, app, user, who }
}

async function storedTokens(userId: string): Promise<{ access_token: string; refresh_token: string | null }> {
  const row = await linkRow(userId)
  return decryptJson(ENCRYPTION_KEY, row?.encrypted_tokens as string, `user_basecamp_links:${userId}`)
}

function bearer(c: { headers: Record<string, string> }): string {
  return (c.headers['authorization'] ?? '').replace(/^Bearer /, '')
}

const projects = (app: ReturnType<typeof linkApp>, user: { id: string }) => call(app, 'GET', '/api/basecamp/projects', { user, env: linkEnv(ACCOUNT) })

describe('refresh before expiry', () => {
  it('uses the stored token while it is far from expiry (no refresh)', async () => {
    const { app, fake, user } = await linkedSetup()
    const before = await storedTokens(user.id)
    const res = await projects(app, user)
    expect(res.status).toBe(200)
    expect(fake.tokenCalls('refresh')).toHaveLength(0)
    expect(bearer(fake.apiCalls().at(-1) as { headers: Record<string, string> })).toBe(before.access_token)
  })

  it('refreshes when the token is about to expire, uses the new token, and stores it encrypted with the new expiry', async () => {
    const { app, fake, clock, user } = await linkedSetup()
    const before = await storedTokens(user.id)
    const rowBefore = await linkRow(user.id)
    clock.advance(fake.expiresIn * 1000 - REFRESH_MARGIN_MS + MINUTE)

    const res = await projects(app, user)
    expect(res.status).toBe(200)

    const [refresh] = fake.tokenCalls('refresh')
    const form = new URLSearchParams(refresh?.body ?? '')
    expect(form.get('refresh_token')).toBe(before.refresh_token)
    expect(refresh?.url).not.toContain('refresh_token')

    const after = await storedTokens(user.id)
    expect(after.access_token).not.toBe(before.access_token)
    // Launchpad's refresh answer carried no refresh token: the previous one is kept.
    expect(after.refresh_token).toBe(before.refresh_token)
    expect(bearer(fake.apiCalls().at(-1) as { headers: Record<string, string> })).toBe(after.access_token)

    const rowAfter = await linkRow(user.id)
    expect(rowAfter?.status).toBe('active')
    expect(rowAfter?.expires_at).toBe(new Date(clock.now + fake.expiresIn * 1000).toISOString())
    expect(rowAfter?.encrypted_tokens).not.toBe(rowBefore?.encrypted_tokens)
    expect(rowAfter?.linked_at).toBe(rowBefore?.linked_at)
  })

  it('keeps a rotated refresh token when Launchpad sends one', async () => {
    const { app, fake, clock, user } = await linkedSetup()
    const before = await storedTokens(user.id)
    fake.rotateRefreshTokens = true
    clock.advance(fake.expiresIn * 1000)
    expect((await projects(app, user)).status).toBe(200)
    const after = await storedTokens(user.id)
    expect(after.refresh_token).not.toBe(before.refresh_token)
    expect(fake.issued).toContain(after.refresh_token)
  })

  it('on a 401 from Basecamp refreshes once and retries once', async () => {
    const { app, fake, user } = await linkedSetup()
    const before = await storedTokens(user.id)
    fake.rejectedAccess.add(before.access_token)
    const res = await projects(app, user)
    expect(res.status).toBe(200)
    expect(fake.tokenCalls('refresh')).toHaveLength(1)
    const used = fake.apiCalls().slice(-2).map(bearer)
    expect(used[0]).toBe(before.access_token)
    expect(used[1]).toBe((await storedTokens(user.id)).access_token)
    expect((await linkRow(user.id))?.status).toBe('active')
  })

  it('expires the link when Basecamp still answers 401 after a successful refresh', async () => {
    const { app, fake, user } = await linkedSetup()
    // Every access token is refused, whatever Launchpad issues.
    const original = fake.fetch
    fake.fetch = async (url, init) => {
      const res = await original(url, init)
      if (url.startsWith(fake.apiBase)) return new Response('{}', { status: 401 })
      return res
    }
    const app2 = linkApp(fake, new Clock())
    await expectLinkError(await projects(app2, user), 403, 'basecamp_link_expired', 'أعد ربط')
    expect((await linkRow(user.id))?.status).toBe('expired')
    void app
  })
})

describe('refresh failure', () => {
  it('marks the link expired, discards the tokens, audits, and sends nothing with any other token', async () => {
    const { app, fake, clock, user } = await linkedSetup('viewer')
    // A service token exists: it must never be used as a fallback.
    const admin = await seedMember('admin')
    expect((await linkAccount(app, fake, admin, person({ admin: true }), { service: true })).status).toBe(302)
    const apiCallsBefore = fake.apiCalls().length

    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } }
    clock.advance(fake.expiresIn * 1000)
    await expectLinkError(await projects(app, user), 403, 'basecamp_link_expired', 'أعد ربط حسابك')

    expect(fake.apiCalls()).toHaveLength(apiCallsBefore)
    const row = await linkRow(user.id)
    expect(row?.status).toBe('expired')
    expect(row?.encrypted_tokens).toBe('')
    expect(row?.bc_person_id).toBeGreaterThan(0)

    const audit = await auditFor(user.id, 'basecamp.link.expire')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor_id).toBeNull()
    expect(JSON.parse(audit[0]?.details_json as string)).toMatchObject({ reason: 'refresh_refused' })

    const link = await call(app, 'GET', '/api/basecamp/link', { user, env: linkEnv(ACCOUNT) })
    expect((await json<{ state: string }>(link)).state).toBe('expired')

    // Later calls fail at once, without asking Launchpad again.
    const refreshes = fake.tokenCalls('refresh').length
    await expectLinkError(await projects(app, user), 403, 'basecamp_link_expired')
    expect(fake.tokenCalls('refresh')).toHaveLength(refreshes)
  })

  it('treats a bare 401 from the token endpoint as a refusal too', async () => {
    const { app, fake, clock, user } = await linkedSetup()
    fake.refreshAnswer = { status: 401, body: 'nope' }
    clock.advance(fake.expiresIn * 1000)
    await expectLinkError(await projects(app, user), 403, 'basecamp_link_expired')
    expect((await linkRow(user.id))?.status).toBe('expired')
  })

  it('keeps the link active on a Launchpad outage (503) and on an unrecognised 4xx', async () => {
    const { app, fake, clock, user } = await linkedSetup()
    const before = await linkRow(user.id)
    clock.advance(fake.expiresIn * 1000)

    fake.refreshAnswer = { status: 503, body: { error: 'unavailable' } }
    await expectLinkError(await projects(app, user), 503, 'basecamp_unavailable')
    fake.refreshAnswer = { status: 400, body: { message: 'something else' } }
    await expectLinkError(await projects(app, user), 503, 'basecamp_unavailable')

    expect(await linkRow(user.id)).toEqual(before)
    expect(await auditFor(user.id, 'basecamp.link.expire')).toHaveLength(0)
  })

  it('never expires links because of the platform’s own client credentials (invalid_client)', async () => {
    const { app, fake, clock, user } = await linkedSetup()
    clock.advance(fake.expiresIn * 1000)
    fake.refreshAnswer = { status: 401, body: { error: 'invalid_client' } }
    await expectLinkError(await projects(app, user), 503, 'basecamp_not_configured', 'مسؤول المنصة')
    expect((await linkRow(user.id))?.status).toBe('active')
  })
})

describe('POST /api/basecamp/link/revoke', () => {
  it('keeps the row with state revoked, discards the token, audits once, and blocks Basecamp calls', async () => {
    const { app, fake, user, who } = await linkedSetup('viewer')
    const linkedAt = (await linkRow(user.id))?.linked_at

    const res = await call(app, 'POST', '/api/basecamp/link/revoke', { user, env: linkEnv(ACCOUNT) })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json(res)).toEqual({ state: 'revoked' })

    const row = await linkRow(user.id)
    expect(row).toMatchObject({ status: 'revoked', encrypted_tokens: '', bc_person_id: who.id, bc_account_id: ACCOUNT, linked_at: linkedAt })
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM user_basecamp_links WHERE user_id = ?1`).bind(user.id).first<{ n: number }>()
    expect(count?.n).toBe(1)

    const audit = await auditFor(user.id, 'basecamp.link.revoke')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: user.id, entity_type: 'basecamp_link' })
    expect(JSON.parse(audit[0]?.details_json as string)).toMatchObject({ previousStatus: 'active', bcPersonId: who.id })

    const link = await call(app, 'GET', '/api/basecamp/link', { user, env: linkEnv(ACCOUNT) })
    expect(await json(link)).toMatchObject({ state: 'revoked', bcPersonId: who.id })

    const apiCalls = fake.apiCalls().length
    await expectLinkError(await projects(app, user), 403, 'basecamp_link_revoked', 'ألغيت')
    expect(fake.apiCalls()).toHaveLength(apiCalls)

    // Again: same answer, nothing new in the log.
    expect((await call(app, 'POST', '/api/basecamp/link/revoke', { user, env: linkEnv(ACCOUNT) })).status).toBe(200)
    expect(await auditFor(user.id, 'basecamp.link.revoke')).toHaveLength(1)
  })

  it('answers 403 not-linked in Arabic when there is nothing to revoke', async () => {
    const fake = new FakeBasecamp(ACCOUNT)
    const app = linkApp(fake, new Clock())
    const user = await seedMember('editor')
    await expectLinkError(await call(app, 'POST', '/api/basecamp/link/revoke', { user, env: linkEnv(ACCOUNT) }), 403, 'basecamp_not_linked', 'لم تربط')
    expect(await linkRow(user.id)).toBeNull()
  })

  it('revokes an expired link too', async () => {
    const { app, fake, clock, user } = await linkedSetup()
    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } }
    clock.advance(fake.expiresIn * 1000)
    await projects(app, user)
    expect((await linkRow(user.id))?.status).toBe('expired')
    expect((await call(app, 'POST', '/api/basecamp/link/revoke', { user, env: linkEnv(ACCOUNT) })).status).toBe(200)
    expect((await linkRow(user.id))?.status).toBe('revoked')
    expect(JSON.parse((await auditFor(user.id, 'basecamp.link.revoke'))[0]?.details_json as string)).toMatchObject({ previousStatus: 'expired' })
  })
})

describe('outside a request (queue consumer, cron)', () => {
  it("gives the acting user's own token through linkContextFor + withUserToken, and refuses an unlinked user", async () => {
    const { fake, clock, user } = await linkedSetup()
    const ctx = linkContextFor(linkEnv(ACCOUNT), { fetch: fake.fetch, now: () => clock.now, limiter: { acquire: async () => {} } })
    const token = await withUserToken(ctx, user.id, async (t) => t)
    expect(token).toBe((await storedTokens(user.id)).access_token)

    const stranger = await seedMember('editor')
    const failure = await withUserToken(ctx, stranger.id, async () => 'never').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(LinkFailure)
    expect((failure as LinkFailure).key).toBe('not_linked')
  })
})
