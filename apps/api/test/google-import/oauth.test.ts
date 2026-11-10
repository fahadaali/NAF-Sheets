// Google OAuth for the importing user: /auth/google/start, /auth/google/callback,
// GET /api/google/link. Google is faked; nothing leaves the test.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { decryptJson, encryptJson } from '../../src/crypto'
import { registerGoogleImportRoutes } from '../../src/google-import'
import { linkKey, sha256Hex, tokenAad, tokenKey } from '../../src/google-import/oauth'
import { call, isArabic, json, seedMember, testApp } from '../helpers'
import { ACCESS_TOKEN, SCOPE, defaultTokenBody, fakeGoogle, googleEnv, linkGoogle } from './google-fake'
import type { FakeGoogleOptions } from './google-fake'

function setup(options: FakeGoogleOptions = {}) {
  const fake = fakeGoogle(options)
  const app = testApp()
  registerGoogleImportRoutes(app, { fetch: fake.fetch })
  return { app, fake }
}

async function start(app: ReturnType<typeof testApp>, user: { id: string }, next?: string) {
  const query = next === undefined ? '' : `?next=${encodeURIComponent(next)}`
  return call(app, 'GET', `/auth/google/start${query}`, { user, env: googleEnv })
}

function stateOf(res: Response): string {
  return new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? ''
}

async function callback(app: ReturnType<typeof testApp>, user: { id: string }, query: string) {
  return call(app, 'GET', `/auth/google/callback?${query}`, { user, env: googleEnv })
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  const body = await json(res)
  expect(body).toMatchObject({ ok: false, error })
  expect(isArabic(body.message)).toBe(true)
  return body
}

async function linkState(app: ReturnType<typeof testApp>, user: { id: string }) {
  const res = await call(app, 'GET', '/api/google/link', { user, env: googleEnv })
  expect(res.status).toBe(200)
  return json<{ state: string; email: string | null }>(res)
}

describe('GET /auth/google/start', () => {
  it('redirects an editor to Google with exactly the documented parameters and the read-only scope', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    const res = await start(app, editor, '/files/new')
    expect(res.status).toBe(302)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: googleEnv.GOOGLE_CLIENT_ID,
      redirect_uri: 'http://localhost/auth/google/callback',
      response_type: 'code',
      scope: SCOPE,
      access_type: 'online',
      state: stateOf(res),
    })
    expect(stateOf(res)).toMatch(/^[0-9a-f]{64}$/)

    // Stored under the state's hash, bound to the user, with the validated next.
    const raw = await env.SETTINGS.get(`google-oauth-state:${await sha256Hex(stateOf(res))}`)
    expect(JSON.parse(raw ?? 'null')).toMatchObject({ userId: editor.id, next: '/files/new' })
    expect(await env.SETTINGS.get(`google-oauth-state:${stateOf(res)}`)).toBeNull()
  })

  it('validates next like naf-auth safeNext: anything off-site becomes "/"', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    const cases: Array<[string | undefined, string]> = [
      [undefined, '/'],
      ['/import?step=2', '/import?step=2'],
      ['//evil.sa', '/'],
      ['https://evil.sa', '/'],
      ['/\\evil.sa', '/'],
      ['/%2F%2Fevil.sa', '/'],
      ['javascript:alert(1)', '/'],
      ['files', '/'],
    ]
    for (const [next, expected] of cases) {
      const res = await start(app, editor, next)
      const raw = await env.SETTINGS.get(`google-oauth-state:${await sha256Hex(stateOf(res))}`)
      expect(JSON.parse(raw ?? 'null').next, String(next)).toBe(expected)
    }
  })

  it('refuses a viewer (403) and stores nothing', async () => {
    const { app } = setup()
    const viewer = await seedMember('viewer')
    const res = await start(app, viewer, '/x')
    await expectError(res, 403, 'forbidden')
  })

  it('answers 503 google_not_configured when a Google setting is missing', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    for (const missing of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'] as const) {
      const res = await call(app, 'GET', '/auth/google/start', { user: editor, env: { ...googleEnv, [missing]: undefined } })
      await expectError(res, 503, 'google_not_configured')
    }
  })

  it('is behind the session guard', async () => {
    const { app } = setup()
    const res = await call(app, 'GET', '/auth/google/start', { env: googleEnv })
    expect(res.status).toBe(401)
  })
})

describe('GET /auth/google/callback', () => {
  it('exchanges the code, stores the access token encrypted with a TTL, audits the link and returns to next', async () => {
    const { app, fake } = setup({ token: { body: { ...defaultTokenBody(), refresh_token: '1//never-stored' } } })
    const editor = await seedMember('editor')
    const s = stateOf(await start(app, editor, '/files/new?tab=google'))

    const res = await callback(app, editor, `state=${s}&code=4%2Fauth-code&scope=${encodeURIComponent(SCOPE)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/files/new?tab=google')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')

    // The exchange: documented fields only, same redirect_uri as the start.
    const exchange = fake.calls.find((c) => c.url.href === 'https://oauth2.googleapis.com/token')
    expect(exchange?.method).toBe('POST')
    expect(exchange?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(exchange?.body ?? ''))).toEqual({
      code: '4/auth-code',
      client_id: googleEnv.GOOGLE_CLIENT_ID,
      client_secret: googleEnv.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'http://localhost/auth/google/callback',
      grant_type: 'authorization_code',
    })

    // Encrypted at rest, bound to the user; no refresh token anywhere.
    const sealed = await env.SETTINGS.getWithMetadata(tokenKey(editor.id))
    expect(sealed.value).toMatch(/^v1:/)
    expect(sealed.value).not.toContain(ACCESS_TOKEN)
    const token = await decryptJson<Record<string, unknown>>(googleEnv.TOKEN_ENCRYPTION_KEY!, sealed.value!, tokenAad(editor.id))
    expect(token).toMatchObject({ accessToken: ACCESS_TOKEN, scope: SCOPE })
    expect(Object.keys(token).sort()).toEqual(['accessToken', 'expiresAt', 'scope'])
    expect(token.expiresAt as number).toBeGreaterThan(Date.now() + 3500 * 1000)
    await expect(decryptJson(googleEnv.TOKEN_ENCRYPTION_KEY!, sealed.value!, tokenAad('someone-else'))).rejects.toThrow()

    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action = 'google.link' AND actor_id = ?1`).bind(editor.id).first<Record<string, unknown>>()
    expect(audit).toMatchObject({ entity_type: 'member', entity_id: editor.id, workbook_id: null })
    expect(String(audit?.details_json)).not.toContain(ACCESS_TOKEN)

    expect(await linkState(app, editor)).toEqual({ state: 'active', email: null })
  })

  it('uses a state once: a replay is refused', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    const s = stateOf(await start(app, editor, '/a'))
    expect((await callback(app, editor, `state=${s}&code=c1`)).status).toBe(302)
    await expectError(await callback(app, editor, `state=${s}&code=c1`), 400, 'google_state_invalid')
  })

  it('refuses a state started by another user, and consumes it', async () => {
    const { app, fake } = setup()
    const alice = await seedMember('editor')
    const mallory = await seedMember('editor')
    const s = stateOf(await start(app, alice, '/a'))
    await expectError(await callback(app, mallory, `state=${s}&code=c1`), 400, 'google_state_invalid')
    await expectError(await callback(app, alice, `state=${s}&code=c1`), 400, 'google_state_invalid')
    expect(fake.calls).toHaveLength(0)
    expect(await env.SETTINGS.get(tokenKey(mallory.id))).toBeNull()
    expect(await env.SETTINGS.get(tokenKey(alice.id))).toBeNull()
  })

  it('refuses a missing, malformed or unknown state', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    for (const query of ['code=c1', 'state=abc&code=c1', `state=${'0'.repeat(64)}&code=c1`]) {
      await expectError(await callback(app, editor, query), 400, 'google_state_invalid')
    }
  })

  it('returns to next with google_error when the user denies consent, and stores nothing', async () => {
    const { app, fake } = setup()
    const editor = await seedMember('editor')
    const s = stateOf(await start(app, editor, '/files/new'))
    const res = await callback(app, editor, `state=${s}&error=access_denied`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/files/new?google_error=denied')
    expect(fake.calls).toHaveLength(0)
    expect(await linkState(app, editor)).toEqual({ state: 'unlinked', email: null })
  })

  it('stores nothing when the read-only scope was not granted', async () => {
    const { app } = setup({ token: { body: { ...defaultTokenBody(), scope: 'openid' } } })
    const editor = await seedMember('editor')
    const s = stateOf(await start(app, editor, '/files/new'))
    const res = await callback(app, editor, `state=${s}&code=c1`)
    expect(res.headers.get('location')).toBe('/files/new?google_error=scope')
    expect(await env.SETTINGS.get(tokenKey(editor.id))).toBeNull()
  })

  it('stores nothing when the exchange fails', async () => {
    for (const token of [{ status: 400, body: { error: 'invalid_grant' } }, { body: { ...defaultTokenBody(), token_type: 'DPoP' } }, { body: { scope: SCOPE } }]) {
      const { app } = setup({ token })
      const editor = await seedMember('editor')
      const s = stateOf(await start(app, editor, '/x'))
      const res = await callback(app, editor, `state=${s}&code=c1`)
      expect(res.headers.get('location')).toBe('/x?google_error=failed')
      expect(await env.SETTINGS.get(tokenKey(editor.id))).toBeNull()
    }
  })
})

describe('GET /api/google/link', () => {
  it('reads unlinked, then active, then expired once the token has run out', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    expect(await linkState(app, editor)).toEqual({ state: 'unlinked', email: null })

    await linkGoogle(app, editor)
    expect(await linkState(app, editor)).toEqual({ state: 'active', email: null })

    // A token past its expiry (KV expiry is not instant).
    const stale = await encryptJson(googleEnv.TOKEN_ENCRYPTION_KEY!, { accessToken: 'old', expiresAt: Date.now() - 1000, scope: SCOPE }, tokenAad(editor.id))
    await env.SETTINGS.put(tokenKey(editor.id), stale)
    expect(await linkState(app, editor)).toEqual({ state: 'expired', email: null })
  })

  it('reads expired when only the link marker is left', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    await env.SETTINGS.put(linkKey(editor.id), JSON.stringify({ linkedAt: new Date().toISOString() }))
    expect(await linkState(app, editor)).toEqual({ state: 'expired', email: null })
  })

  it('reads expired when the stored token was sealed for another user', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    const foreign = await encryptJson(googleEnv.TOKEN_ENCRYPTION_KEY!, { accessToken: 'x', expiresAt: Date.now() + 3_600_000, scope: SCOPE }, tokenAad('other'))
    await env.SETTINGS.put(tokenKey(editor.id), foreign)
    expect(await linkState(app, editor)).toEqual({ state: 'expired', email: null })
  })

  it('is private (no-store)', async () => {
    const { app } = setup()
    const editor = await seedMember('editor')
    const res = await call(app, 'GET', '/api/google/link', { user: editor, env: googleEnv })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
