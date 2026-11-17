// GET /auth/basecamp/start and /auth/basecamp/callback: an admin connects the
// sync account (CLAUDE.md §2, owner decision 7; spec §14).

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
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
    const admin = await seedMember('admin')
    const { res, location, state } = await startLink(app, ACCOUNT, admin, '?service=1&next=%2Fsettings%3Ftab%3D2')

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
    expect(stored).toMatchObject({ userId: admin.id, next: '/settings?tab=2', service: true, redirectUri: 'http://localhost/auth/basecamp/callback' })
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
      const user = await seedMember('admin')
      const { state } = await startLink(app, ACCOUNT, user, `?service=1&next=${encodeURIComponent(unsafe)}`)
      const stored = JSON.parse((await env.SETTINGS.get(await stateKey(state as string))) as string) as { next: string }
      expect(stored.next).toBe('/')

      const res = await callback(app, ACCOUNT, user, { code: fake.grantCode(person({ admin: true })), state: state as string })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/')
    },
  )

  it('refuses editors and viewers, with or without ?service=1, with an Arabic message (no personal links any more)', async () => {
    const { app } = setup()
    for (const role of ['editor', 'viewer'] as const) {
      const member = await seedMember(role)
      for (const query of ['?service=1', '']) {
        const { res } = await startLink(app, ACCOUNT, member, query)
        await expectLinkError(res, 403, 'forbidden', 'مسؤول المنصة')
      }
    }
  })

  it('answers 503 in Arabic when the Launchpad secrets are not configured, naming no secret', async () => {
    const { app } = setup()
    const user = await seedMember('admin')
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
  it('exchanges the code, reads the account and /my/profile.json, then redirects to next', async () => {
    const { app, fake } = setup()
    const admin = await seedMember('admin')
    const res = await linkAccount(app, fake, admin, person({ admin: true }), { service: true, next: '/settings' })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings')

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
  })

  it('refuses a state started by another user, links nothing, and the state cannot be used again', async () => {
    const { app, fake } = setup()
    const owner = await seedMember('admin')
    const intruder = await seedMember('admin')
    const { state } = await startLink(app, ACCOUNT, owner, '?service=1')
    const code = fake.grantCode(person({ admin: true }))

    await expectLinkError(await callback(app, ACCOUNT, intruder, { code, state: state as string }), 403, 'basecamp_state_invalid', 'ابدأ')
    expect(fake.tokenCalls()).toHaveLength(0)

    // Single use: consumed by the failed attempt, so the owner cannot finish with it either.
    await expectLinkError(await callback(app, ACCOUNT, owner, { code, state: state as string }), 403, 'basecamp_state_invalid')
    expect(fake.tokenCalls()).toHaveLength(0)
  })

  it('refuses an unknown, malformed or reused state', async () => {
    const { app, fake } = setup()
    const user = await seedMember('admin')
    await expectLinkError(await callback(app, ACCOUNT, user, { code: 'c', state: 'a'.repeat(64) }), 403, 'basecamp_state_invalid')
    await expectLinkError(await callback(app, ACCOUNT, user, { code: 'c', state: 'not-a-state' }), 403, 'basecamp_state_invalid')
    await expectLinkError(await callback(app, ACCOUNT, user, { code: 'c' }), 403, 'basecamp_state_invalid')

    const { state } = await startLink(app, ACCOUNT, user, '?service=1')
    expect((await callback(app, ACCOUNT, user, { code: fake.grantCode(person({ admin: true })), state: state as string })).status).toBe(302)
    await expectLinkError(await callback(app, ACCOUNT, user, { code: fake.grantCode(person({ admin: true })), state: state as string }), 403, 'basecamp_state_invalid')
  })

  it('refuses a state left from a personal link (removed), without calling Launchpad', async () => {
    const { app, fake } = setup()
    const user = await seedMember('admin')
    const state = 'b'.repeat(64)
    await env.SETTINGS.put(await stateKey(state), JSON.stringify({ userId: user.id, next: '/', service: false, redirectUri: 'http://localhost/auth/basecamp/callback', createdAt: new Date().toISOString() }))
    await expectLinkError(await callback(app, ACCOUNT, user, { code: fake.grantCode(person({ admin: true })), state }), 403, 'basecamp_state_invalid')
    expect(fake.tokenCalls()).toHaveLength(0)
  })

  it('stops when the user declines at Launchpad, without calling the token endpoint', async () => {
    const { app, fake } = setup()
    const user = await seedMember('admin')
    const { state } = await startLink(app, ACCOUNT, user, '?service=1')
    await expectLinkError(await callback(app, ACCOUNT, user, { error: 'user_denied', state: state as string }), 403, 'basecamp_authorization_denied', 'الإذن')
    expect(fake.tokenCalls()).toHaveLength(0)
  })

  it("refuses a Basecamp identity that cannot reach NAF's account", async () => {
    const { app, fake } = setup()
    const user = await seedMember('admin')
    const { state } = await startLink(app, ACCOUNT, user, '?service=1')
    const code = fake.grantCode(person({ admin: true }), [
      { product: 'bc3', id: ACCOUNT + 1 },
      { product: 'bcx', id: ACCOUNT },
    ])
    await expectLinkError(await callback(app, ACCOUNT, user, { code, state: state as string }), 403, 'basecamp_account_missing', 'حساب ناف')
    expect(fake.apiCalls()).toHaveLength(0)
  })

  it('refuses a Basecamp person that is not a human account', async () => {
    const { app, fake } = setup()
    const user = await seedMember('admin')
    const res = await linkAccount(app, fake, user, person({ personable_type: 'Agent', admin: true }), { service: true })
    await expectLinkError(res, 403, 'forbidden')
  })

  it('maps a refused code exchange to 403 and a Launchpad outage to 503, storing nothing', async () => {
    const { app, fake } = setup()
    const user = await seedMember('admin')
    const connect = () => linkAccount(app, fake, user, person({ admin: true }), { service: true })
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM integrations WHERE account_id = ?1`).bind(String(ACCOUNT)).first<{ n: number }>()

    fake.exchangeAnswer = { status: 400, body: { error: 'invalid_grant' } }
    await expectLinkError(await connect(), 403, 'forbidden')
    fake.exchangeAnswer = { status: 502, body: { error: 'bad_gateway' } }
    await expectLinkError(await connect(), 503, 'basecamp_unavailable', 'أعد المحاولة')
    // Wrong client credentials are the platform's configuration, not the user's fault.
    fake.exchangeAnswer = { status: 401, body: { error: 'invalid_client' } }
    await expectLinkError(await connect(), 503, 'basecamp_not_configured', 'مسؤول المنصة')
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM integrations WHERE account_id = ?1`).bind(String(ACCOUNT)).first<{ n: number }>()
    expect(after).toEqual(before)
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

  it('lets an admin connect the sync account; stored encrypted in `integrations` with its name, audited', async () => {
    const { app, fake } = setup()
    // Other tests of this file connected one already: start from none.
    await env.DB.prepare(`DELETE FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`).bind(String(ACCOUNT)).run()
    const admin = await seedMember('admin')
    const bcAdmin = person({ admin: true, name: 'فهد العتيبي' })
    const res = await linkAccount(app, fake, admin, bcAdmin, { service: true, next: '/settings' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings')

    const row = await integration()
    expect(row).toMatchObject({ provider: 'basecamp', status: 'active', bc_person_id: bcAdmin.id, created_by: admin.id })
    const tokens = await decryptJson<{ access_token: string }>(ENCRYPTION_KEY, row?.encrypted_tokens as string, `integrations:${row?.id}`)
    expect(fake.issued).toContain(tokens.access_token)
    // Copied to another row's identity, it does not decrypt.
    await expect(decryptJson(ENCRYPTION_KEY, row?.encrypted_tokens as string, `integrations:other`)).rejects.toThrow()
    // Its name, for Settings («مربوط: …»).
    const cached = await env.DB.prepare(`SELECT name FROM bc_account_people_cache WHERE bc_person_id = ?1`).bind(bcAdmin.id).first<{ name: string }>()
    expect(cached?.name).toBe('فهد العتيبي')

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
