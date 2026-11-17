// The sync account's token (CLAUDE.md §2, owner decision 7): refreshed before
// it expires, refreshed and retried once on a 401, expired (never replaced by
// another token) when Launchpad refuses the refresh.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { decryptJson } from '../../src/crypto'
import { LinkFailure, REFRESH_MARGIN_MS, basecampClient, linkContextFor, withServiceToken } from '../../src/basecamp-link'
import { seedMember } from '../helpers'
import { Clock, ENCRYPTION_KEY, FakeBasecamp, MINUTE, auditFor, linkAccount, linkApp, linkEnv, person, uniqueId } from './fake'

interface ServiceRowForTest {
  id: string
  encrypted_tokens: string
  expires_at: string | null
  status: string
  bc_person_id: number
  created_at: string
}

/** A fake account with its sync account connected by an admin. Each test has its own account (D1 is shared). */
async function connected() {
  const account = uniqueId()
  const fake = new FakeBasecamp(account)
  const clock = new Clock()
  const app = linkApp(fake, clock)
  const admin = await seedMember('admin')
  const who = person({ admin: true })
  fake.projects.push({ id: uniqueId(), name: 'خطة الاتصال', description: 'وصف', todosetId: uniqueId(), peopleIds: [who.id], todolists: [] })
  const res = await linkAccount(app, fake, admin, who, { service: true })
  if (res.status !== 302) throw new Error(`connect failed: ${res.status}`)
  const ctx = linkContextFor(linkEnv(account), { fetch: (url, init) => fake.fetch(url, init), now: () => clock.now, limiter: { acquire: async () => {} }, sleep: async () => {} })
  /** A read with the sync account's token, as the station makes them. */
  const projects = () => withServiceToken(ctx, (token) => basecampClient(ctx).projects.list(token).all())
  return { account, fake, clock, admin, who, projects }
}

async function serviceRow(account: number): Promise<ServiceRowForTest | null> {
  return env.DB.prepare(`SELECT id, encrypted_tokens, expires_at, status, bc_person_id, created_at FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`)
    .bind(String(account))
    .first<ServiceRowForTest>()
}

async function storedTokens(account: number): Promise<{ access_token: string; refresh_token: string | null }> {
  const row = await serviceRow(account)
  return decryptJson(ENCRYPTION_KEY, row?.encrypted_tokens as string, `integrations:${row?.id}`)
}

function bearer(c: { headers: Record<string, string> }): string {
  return (c.headers['authorization'] ?? '').replace(/^Bearer /, '')
}

async function failureOf(p: Promise<unknown>): Promise<LinkFailure> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(LinkFailure)
  return error as LinkFailure
}

describe('refresh before expiry', () => {
  it('uses the stored token while it is far from expiry (no refresh)', async () => {
    const { account, fake, projects } = await connected()
    const before = await storedTokens(account)
    await projects()
    expect(fake.tokenCalls('refresh')).toHaveLength(0)
    expect(bearer(fake.apiCalls().at(-1) as { headers: Record<string, string> })).toBe(before.access_token)
  })

  it('refreshes when the token is about to expire, uses the new token, and stores it encrypted with the new expiry', async () => {
    const { account, fake, clock, projects } = await connected()
    const before = await storedTokens(account)
    const rowBefore = await serviceRow(account)
    clock.advance(fake.expiresIn * 1000 - REFRESH_MARGIN_MS + MINUTE)

    await projects()

    const [refresh] = fake.tokenCalls('refresh')
    const form = new URLSearchParams(refresh?.body ?? '')
    expect(form.get('refresh_token')).toBe(before.refresh_token)
    expect(refresh?.url).not.toContain('refresh_token')

    const after = await storedTokens(account)
    expect(after.access_token).not.toBe(before.access_token)
    // Launchpad's refresh answer carried no refresh token: the previous one is kept.
    expect(after.refresh_token).toBe(before.refresh_token)
    expect(bearer(fake.apiCalls().at(-1) as { headers: Record<string, string> })).toBe(after.access_token)

    const rowAfter = await serviceRow(account)
    expect(rowAfter?.status).toBe('active')
    expect(rowAfter?.expires_at).toBe(new Date(clock.now + fake.expiresIn * 1000).toISOString())
    expect(rowAfter?.encrypted_tokens).not.toBe(rowBefore?.encrypted_tokens)
    expect(rowAfter?.created_at).toBe(rowBefore?.created_at)
  })

  it('keeps a rotated refresh token when Launchpad sends one', async () => {
    const { account, fake, clock, projects } = await connected()
    const before = await storedTokens(account)
    fake.rotateRefreshTokens = true
    clock.advance(fake.expiresIn * 1000)
    await projects()
    const after = await storedTokens(account)
    expect(after.refresh_token).not.toBe(before.refresh_token)
    expect(fake.issued).toContain(after.refresh_token)
  })

  it('on a 401 from Basecamp refreshes once and retries once', async () => {
    const { account, fake, projects } = await connected()
    const before = await storedTokens(account)
    fake.rejectedAccess.add(before.access_token)
    await projects()
    expect(fake.tokenCalls('refresh')).toHaveLength(1)
    const used = fake.apiCalls().slice(-2).map(bearer)
    expect(used[0]).toBe(before.access_token)
    expect(used[1]).toBe((await storedTokens(account)).access_token)
    expect((await serviceRow(account))?.status).toBe('active')
  })

  it('expires the sync account when Basecamp still answers 401 after a successful refresh', async () => {
    const { account, fake, projects } = await connected()
    // Every access token is refused, whatever Launchpad issues.
    const original = fake.fetch
    fake.fetch = async (url, init) => {
      const res = await original(url, init)
      if (url.startsWith(fake.apiBase)) return new Response('{}', { status: 401 })
      return res
    }
    expect((await failureOf(projects())).key).toBe('service_not_linked')
    expect((await serviceRow(account))?.status).toBe('expired')
  })
})

describe('refresh failure', () => {
  it('marks the sync account expired, discards the tokens, audits, and calls Basecamp no more', async () => {
    const { account, fake, clock, projects } = await connected()
    const apiCallsBefore = fake.apiCalls().length

    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } }
    clock.advance(fake.expiresIn * 1000)
    expect((await failureOf(projects())).key).toBe('service_not_linked')

    expect(fake.apiCalls()).toHaveLength(apiCallsBefore)
    const row = await serviceRow(account)
    expect(row?.status).toBe('expired')
    expect(row?.encrypted_tokens).toBe('')
    expect(row?.bc_person_id).toBeGreaterThan(0)

    const audit = await auditFor(row!.id, 'basecamp.service.expire')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor_id).toBeNull()
    expect(JSON.parse(audit[0]?.details_json as string)).toMatchObject({ reason: 'refresh_refused' })

    // Later calls fail at once, without asking Launchpad again.
    const refreshes = fake.tokenCalls('refresh').length
    expect((await failureOf(projects())).key).toBe('service_not_linked')
    expect(fake.tokenCalls('refresh')).toHaveLength(refreshes)
  })

  it('treats a bare 401 from the token endpoint as a refusal too', async () => {
    const { account, fake, clock, projects } = await connected()
    fake.refreshAnswer = { status: 401, body: 'nope' }
    clock.advance(fake.expiresIn * 1000)
    expect((await failureOf(projects())).key).toBe('service_not_linked')
    expect((await serviceRow(account))?.status).toBe('expired')
  })

  it('keeps the sync account active on a Launchpad outage (503) and on an unrecognised 4xx', async () => {
    const { account, fake, clock, projects } = await connected()
    const before = await serviceRow(account)
    clock.advance(fake.expiresIn * 1000)

    fake.refreshAnswer = { status: 503, body: { error: 'unavailable' } }
    expect((await failureOf(projects())).key).toBe('basecamp_unavailable')
    fake.refreshAnswer = { status: 400, body: { message: 'something else' } }
    expect((await failureOf(projects())).key).toBe('basecamp_unavailable')

    expect(await serviceRow(account)).toEqual(before)
    expect(await auditFor(before!.id, 'basecamp.service.expire')).toHaveLength(0)
  })

  it('never expires the sync account because of the platform’s own client credentials (invalid_client)', async () => {
    const { account, fake, clock, projects } = await connected()
    clock.advance(fake.expiresIn * 1000)
    fake.refreshAnswer = { status: 401, body: { error: 'invalid_client' } }
    expect((await failureOf(projects())).key).toBe('not_configured')
    expect((await serviceRow(account))?.status).toBe('active')
  })

  it('refuses when no sync account is connected', async () => {
    const account = uniqueId()
    const fake = new FakeBasecamp(account)
    const ctx = linkContextFor(linkEnv(account), { fetch: fake.fetch, now: () => Date.now(), limiter: { acquire: async () => {} } })
    expect((await failureOf(withServiceToken(ctx, async () => 'never'))).key).toBe('service_not_linked')
    expect(fake.apiCalls()).toHaveLength(0)
  })
})
