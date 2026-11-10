// GET /auth/basecamp/start and /auth/basecamp/callback (spec §3, §14).

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { BasecampLinkResponse } from '@naf-sheets/shared'
import { decryptJson } from '../../src/crypto'
import { LAUNCHPAD_AUTHORIZATION_URL, LAUNCHPAD_AUTHORIZE_URL, LAUNCHPAD_TOKEN_URL } from '../../src/basecamp-link/oauth'
import { stateKey } from '../../src/basecamp-link/state'
import { call, json, seedMember } from '../helpers'
import {
  CLIENT_ID,
  CLIENT_SECRET,
  Clock,
  ENCRYPTION_KEY,
  FakeBasecamp,
  auditFor,
  callback,
  expectLinkError,
  linkAccount,
  linkApp,
  linkEnv,
  linkRow,
  person,
  startLink,
} from './fake'

const ACCOUNT = 7_100_001

function setup() {
  const fake = new FakeBasecamp(ACCOUNT)
  const clock = new Clock()
  return { fake, clock, app: linkApp(fake, clock) }
}

describe('GET /auth/basecamp/start', () => {
  it('sends the browser to Launchpad with the documented parameters and a state bound to the user', async () => {
    const { app } = setup()
    const viewer = await seedMember('viewer')
    const { res, location, state } = await startLink(app, ACCOUNT, viewer, '?next=%2Fworkbooks%2Fabc%3Ftab%3D2')

    expect(res.status).toBe(302)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(`${location?.origin}${location?.pathname}`).toBe(LAUNCHPAD_AUTHORIZE_URL)
    expect(location?.searchParams.get('type')).toBe('web_server')
    expect(location?.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location?.searchParams.get('redirect_uri')).toBe('http://localhost/auth/basecamp/callback')
    expect(state).toMatch(/^[0-9a-f]{64}$/)
    // The client secret never travels to the browser.
    expect(res.headers.get('location')).not.toContain(CLIENT_SECRET)

    // Stored under its hash, never the state itself; bound to the user and to the sanitised next.
    expect(await env.SETTINGS.get(`bc-oauth-state:${state}`)).toBeNull()
    const stored = JSON.parse((await env.SETTINGS.get(await stateKey(state as string))) as string) as Record<string, unknown>
    expect(stored).toMatchObject({ userId: viewer.id, next: '/workbooks/abc?tab=2', service: false, redirectUri: 'http://localhost/auth/basecamp/callback' })
  })

  it('needs a signed-in user', async () => {
    const { app } = setup()
    const res = await call(app, 'GET', '/auth/basecamp/start', { env: linkEnv(ACCOUNT) })
    expect(res.status).toBe(401)
  })

  it.each(['//evil.example', 'https://evil.example/x', '/\\evil.example', '/%2F%2Fevil.example', 'javascript:alert(1)', ''])(
    'replaces the unsafe next %j with "/" (naf-auth safeNext), and the callback lands on "/"',
    async (unsafe) => {
      const { app, fake } = setup()
      const user = await seedMember('editor')
      const { state } = await startLink(app, ACCOUNT, user, `?next=${encodeURIComponent(unsafe)}`)
      const stored = JSON.parse((await env.SETTINGS.get(await stateKey(state as string))) as string) as { next: string }
      expect(stored.next).toBe('/')

      const res = await callback(app, ACCOUNT, user, { code: fake.grantCode(person()), state: state as string })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/')
    },
  )

  it('refuses ?service=1 to editors and viewers, with an Arabic message', async () => {
    const { app } = setup()
    for (const role of ['editor', 'viewer'] as const) {
      const member = await seedMember(role)
      const { res } = await startLink(app, ACCOUNT, member, '?service=1')
      await expectLinkError(res, 403, 'forbidden', 'مسؤول المنصة')
    }
  })

  it('answers 503 in Arabic when the Launchpad secrets are not configured, naming no secret', async () => {
    const { app } = setup()
    const user = await seedMember('editor')
    const res = await call(app, 'GET', '/auth/basecamp/start', { user, env: linkEnv(ACCOUNT, { BASECAMP_CLIENT_SECRET: undefined }) })
    expect(res.status).toBe(503)
    const body = await json<{ error: string; message: string }>(res)
    expect(body.error).toBe('basecamp_not_configured')
    expect(body.message).toMatch(/[؀-ۿ]/)
    expect(body.message).not.toContain('BASECAMP')

    // A key that is not 32 bytes is "not configured" too, before anything is stored.
    for (const TOKEN_ENCRYPTION_KEY of [btoa('short'), 'not base64 !', '']) {
      const res2 = await call(app, 'GET', '/auth/basecamp/start', { user, env: linkEnv(ACCOUNT, { TOKEN_ENCRYPTION_KEY }) })
      expect(res2.status).toBe(503)
    }
    expect((await call(app, 'GET', '/auth/basecamp/start', { user, env: linkEnv(ACCOUNT, { BASECAMP_ACCOUNT_ID: 'abc' }) })).status).toBe(503)
  })
})

describe('GET /auth/basecamp/callback', () => {
  it('links a viewer: exchanges the code, reads the account and /my/profile.json, stores encrypted tokens, audits, redirects to next', async () => {
    const { app, fake, clock } = setup()
    const viewer = await seedMember('viewer')
    const who = person({ name: 'أحمد السالم' })
    const res = await linkAccount(app, fake, viewer, who, { next: '/workbooks/w1' })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/workbooks/w1')

    // Code exchange: documented `type=web_server`, form body, secret never in the URL.
    const [exchange] = fake.tokenCalls('web_server')
    expect(exchange?.url).toBe(LAUNCHPAD_TOKEN_URL)
    expect(exchange?.method).toBe('POST')
    expect(exchange?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(exchange?.headers['user-agent']).toBe('NAF Comms (info@naflaw.sa)')
    const form = new URLSearchParams(exchange?.body ?? '')
    expect(form.get('client_id')).toBe(CLIENT_ID)
    expect(form.get('client_secret')).toBe(CLIENT_SECRET)
    expect(form.get('redirect_uri')).toBe('http://localhost/auth/basecamp/callback')
    for (const c of fake.calls) expect(c.url).not.toContain(CLIENT_SECRET)

    // Then the account list and the person inside NAF's account.
    expect(fake.callsTo(LAUNCHPAD_AUTHORIZATION_URL)).toHaveLength(1)
    expect(fake.apiCalls().map((c) => c.url)).toEqual([`${fake.apiBase}/my/profile.json`])

    const row = await linkRow(viewer.id)
    expect(row).toMatchObject({ bc_person_id: who.id, bc_account_id: ACCOUNT, status: 'active', bc_person_name: 'أحمد السالم' })
    expect(row?.expires_at).toBe(new Date(clock.now + fake.expiresIn * 1000).toISOString())
    expect(row?.encrypted_tokens.startsWith('v1:')).toBe(true)
    const tokens = await decryptJson<{ access_token: string; refresh_token: string }>(ENCRYPTION_KEY, row?.encrypted_tokens as string, `user_basecamp_links:${viewer.id}`)
    expect(fake.issued).toContain(tokens.access_token)
    expect(fake.issued).toContain(tokens.refresh_token)

    const audit = await auditFor(viewer.id, 'basecamp.link.create')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: viewer.id, entity_type: 'basecamp_link' })
    expect(JSON.parse(audit[0]?.details_json as string)).toMatchObject({ bcAccountId: ACCOUNT, bcPersonId: who.id, previous: null })

    const link = await call(app, 'GET', '/api/basecamp/link', { user: viewer, env: linkEnv(ACCOUNT) })
    expect(link.status).toBe(200)
    expect(await json<BasecampLinkResponse>(link)).toEqual({ state: 'active', bcPersonId: who.id, bcAccountId: ACCOUNT, name: 'أحمد السالم' })
  })

  it('reports `unlinked` before any link', async () => {
    const { app } = setup()
    const user = await seedMember('editor')
    const res = await call(app, 'GET', '/api/basecamp/link', { user, env: linkEnv(ACCOUNT) })
    expect(await json(res)).toEqual({ state: 'unlinked', bcPersonId: null, bcAccountId: null, name: null })
  })

  it('refuses a state started by another user, links nothing, and the state cannot be used again', async () => {
    const { app, fake } = setup()
    const owner = await seedMember('editor')
    const intruder = await seedMember('editor')
    const { state } = await startLink(app, ACCOUNT, owner)
    const code = fake.grantCode(person())

    await expectLinkError(await callback(app, ACCOUNT, intruder, { code, state: state as string }), 403, 'basecamp_state_invalid', 'ابدأ')
    expect(fake.tokenCalls()).toHaveLength(0)
    expect(await linkRow(intruder.id)).toBeNull()

    // Single use: consumed by the failed attempt, so the owner cannot finish with it either.
    await expectLinkError(await callback(app, ACCOUNT, owner, { code, state: state as string }), 403, 'basecamp_state_invalid')
    expect(await linkRow(owner.id)).toBeNull()
  })

  it('refuses an unknown, malformed or reused state', async () => {
    const { app, fake } = setup()
    const user = await seedMember('editor')
    await expectLinkError(await callback(app, ACCOUNT, user, { code: 'c', state: 'a'.repeat(64) }), 403, 'basecamp_state_invalid')
    await expectLinkError(await callback(app, ACCOUNT, user, { code: 'c', state: 'not-a-state' }), 403, 'basecamp_state_invalid')
    await expectLinkError(await callback(app, ACCOUNT, user, { code: 'c' }), 403, 'basecamp_state_invalid')

    const { state } = await startLink(app, ACCOUNT, user)
    expect((await callback(app, ACCOUNT, user, { code: fake.grantCode(person()), state: state as string })).status).toBe(302)
    await expectLinkError(await callback(app, ACCOUNT, user, { code: fake.grantCode(person()), state: state as string }), 403, 'basecamp_state_invalid')
  })

  it('stops when the user declines at Launchpad, without calling the token endpoint', async () => {
    const { app, fake } = setup()
    const user = await seedMember('editor')
    const { state } = await startLink(app, ACCOUNT, user)
    await expectLinkError(await callback(app, ACCOUNT, user, { error: 'user_denied', state: state as string }), 403, 'basecamp_authorization_denied', 'الإذن')
    expect(fake.tokenCalls()).toHaveLength(0)
    expect(await linkRow(user.id)).toBeNull()
  })

  it("refuses a Basecamp identity that cannot reach NAF's account", async () => {
    const { app, fake } = setup()
    const user = await seedMember('editor')
    const { state } = await startLink(app, ACCOUNT, user)
    const code = fake.grantCode(person(), [
      { product: 'bc3', id: ACCOUNT + 1 },
      { product: 'bcx', id: ACCOUNT },
    ])
    await expectLinkError(await callback(app, ACCOUNT, user, { code, state: state as string }), 403, 'basecamp_account_missing', 'حساب ناف')
    expect(await linkRow(user.id)).toBeNull()
    expect(fake.apiCalls()).toHaveLength(0)
  })

  it('refuses a Basecamp person that is not a human account', async () => {
    const { app, fake } = setup()
    const user = await seedMember('editor')
    const res = await linkAccount(app, fake, user, person({ personable_type: 'Agent' }))
    await expectLinkError(res, 403, 'forbidden')
    expect(await linkRow(user.id)).toBeNull()
  })

  it('refuses to link a Basecamp person already actively linked to another member', async () => {
    const { app, fake } = setup()
    const first = await seedMember('editor')
    const second = await seedMember('viewer')
    const who = person()
    expect((await linkAccount(app, fake, first, who)).status).toBe(302)
    await expectLinkError(await linkAccount(app, fake, second, who), 409, 'basecamp_person_taken', 'عضو آخر')
    expect(await linkRow(second.id)).toBeNull()
    expect((await linkRow(first.id))?.status).toBe('active')
    expect(await auditFor(second.id)).toHaveLength(0)
  })

  it('maps a refused code exchange to 403 and a Launchpad outage to 503, storing nothing', async () => {
    const { app, fake } = setup()
    const user = await seedMember('editor')

    fake.exchangeAnswer = { status: 400, body: { error: 'invalid_grant' } }
    await expectLinkError(await linkAccount(app, fake, user, person()), 403, 'forbidden')
    fake.exchangeAnswer = { status: 502, body: { error: 'bad_gateway' } }
    await expectLinkError(await linkAccount(app, fake, user, person()), 503, 'basecamp_unavailable', 'أعد المحاولة')
    // Wrong client credentials are the platform's configuration, not the user's fault.
    fake.exchangeAnswer = { status: 401, body: { error: 'invalid_client' } }
    await expectLinkError(await linkAccount(app, fake, user, person()), 503, 'basecamp_not_configured', 'مسؤول المنصة')
    expect(await linkRow(user.id)).toBeNull()
  })

  it('relinks after a revocation: active again, audited as a relink', async () => {
    const { app, fake } = setup()
    const user = await seedMember('viewer')
    const who = person()
    expect((await linkAccount(app, fake, user, who)).status).toBe(302)
    expect((await call(app, 'POST', '/api/basecamp/link/revoke', { user, env: linkEnv(ACCOUNT) })).status).toBe(200)
    expect((await linkAccount(app, fake, user, who)).status).toBe(302)

    expect((await linkRow(user.id))?.status).toBe('active')
    const relink = await auditFor(user.id, 'basecamp.link.relink')
    expect(relink).toHaveLength(1)
    expect(JSON.parse(relink[0]?.details_json as string)).toMatchObject({ previous: { status: 'revoked', bcPersonId: who.id } })
  })
})

describe('service token (?service=1, admins only)', () => {
  interface IntegrationRow {
    id: string
    provider: string
    account_id: string
    encrypted_tokens: string
    status: string
    bc_person_id: number
    created_by: string
    updated_by: string | null
  }

  async function integration(): Promise<IntegrationRow | null> {
    return env.DB.prepare(`SELECT * FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`).bind(String(ACCOUNT)).first<IntegrationRow>()
  }

  it('lets an admin connect the service token; stored encrypted in `integrations`, audited; not a personal link', async () => {
    const { app, fake } = setup()
    const admin = await seedMember('admin')
    const bcAdmin = person({ admin: true })
    const res = await linkAccount(app, fake, admin, bcAdmin, { service: true, next: '/admin/basecamp' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/basecamp')

    const row = await integration()
    expect(row).toMatchObject({ provider: 'basecamp', status: 'active', bc_person_id: bcAdmin.id, created_by: admin.id })
    const tokens = await decryptJson<{ access_token: string }>(ENCRYPTION_KEY, row?.encrypted_tokens as string, `integrations:${row?.id}`)
    expect(fake.issued).toContain(tokens.access_token)
    // Copied to another row's identity, it does not decrypt.
    await expect(decryptJson(ENCRYPTION_KEY, row?.encrypted_tokens as string, `user_basecamp_links:${admin.id}`)).rejects.toThrow()
    expect(await linkRow(admin.id)).toBeNull()

    const audit = await auditFor(row?.id as string, 'basecamp.service.connect')
    expect(audit.length).toBeGreaterThanOrEqual(1)
    expect(audit.at(-1)).toMatchObject({ actor_id: admin.id, entity_type: 'integration' })
    expect(JSON.parse(audit.at(-1)?.details_json as string)).toMatchObject({ provider: 'basecamp', accountId: ACCOUNT, bcPersonId: bcAdmin.id })

    // Reconnecting replaces the tokens in the same row.
    const otherAdmin = await seedMember('admin')
    const bcOwner = person({ owner: true })
    expect((await linkAccount(app, fake, otherAdmin, bcOwner, { service: true })).status).toBe(302)
    const replaced = await integration()
    expect(replaced).toMatchObject({ id: row?.id, bc_person_id: bcOwner.id, created_by: admin.id, updated_by: otherAdmin.id })
    expect(replaced?.encrypted_tokens).not.toBe(row?.encrypted_tokens)
  })

  it('refuses a service account that is not a Basecamp admin or owner (emails would be redacted)', async () => {
    const { app, fake } = setup()
    const admin = await seedMember('admin')
    const before = await integration()
    await expectLinkError(await linkAccount(app, fake, admin, person(), { service: true }), 403, 'forbidden', 'مدير')
    expect(await integration()).toEqual(before)
  })

  it('checks the admin role again at the callback', async () => {
    const { app, fake } = setup()
    const admin = await seedMember('admin')
    const { state } = await startLink(app, ACCOUNT, admin, '?service=1')
    await env.DB.prepare(`UPDATE members SET role = 'editor' WHERE user_id = ?1`).bind(admin.id).run()
    const before = await integration()
    await expectLinkError(await callback(app, ACCOUNT, admin, { code: fake.grantCode(person({ admin: true })), state: state as string }), 403, 'forbidden')
    expect(await integration()).toEqual(before)
    expect(fake.tokenCalls()).toHaveLength(0)
  })
})
