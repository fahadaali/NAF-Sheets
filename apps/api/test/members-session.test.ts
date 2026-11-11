// The real naf-auth middleware with a real (locally signed) session: a role or
// active-state change in D1 applies from the person's very next request.
// naf-auth verifies the session token on every protected request against the
// JWKS cached in AUTH_KV and then reads `members` (getMember) — there is no
// role cache in the session or in KV. No request leaves the test: the JWKS is
// put in naf-auth's own KV cache, and the token is valid, so no refresh runs.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { call, json, seedMember, testApp } from './helpers'

const issuer = 'https://app.naflaw.sa'
const fetchMode = { 'sec-fetch-mode': 'cors' }

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A session as naf-auth's callback would store it, signed by a test key whose JWKS is cached. */
async function signIn(sub: string): Promise<string> {
  const keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
  const kid = `test-${crypto.randomUUID()}`
  await env.AUTH_KV.put(`jwks:${issuer}`, JSON.stringify({ keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', kid, use: 'sig' }] }))

  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const payload = b64url(JSON.stringify({ iss: issuer, aud: env.PLATFORM_ID, sub, iat: now, exp: now + 600 }))
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${header}.${payload}`)))
  const token = `${header}.${payload}.${b64url(signature)}`

  const sid = `sid-${crypto.randomUUID()}`
  await env.AUTH_KV.put(`sess:${await sha256Hex(sid)}`, JSON.stringify({ sub, token }))
  return `naf_sid=${sid}`
}

describe('platform role and active state through the real naf-auth middleware', () => {
  it('applies a role change and a suspension on the next request, with no cache', async () => {
    const real = createApp()
    const admin = await seedMember('admin')
    const member = await seedMember('viewer')
    const cookie = await signIn(member.id)
    const me = () => call(real, 'GET', '/api/me', { headers: { ...fetchMode, cookie } })

    const first = await me()
    expect(first.status).toBe(200)
    expect(await json(first)).toMatchObject({ user: { id: member.id, role: 'viewer' } })

    // Promoted through the admin screen's route (fake reporter: naf-id is not called).
    const adminApp = testApp({ reportAccess: async () => undefined })
    expect((await call(adminApp, 'PUT', `/api/admin/members/${member.id}`, { user: admin, body: { role: 'admin' } })).status).toBe(200)
    expect(await json(await me())).toMatchObject({ user: { role: 'admin' } })

    // A change made directly in D1 (the console) shows as well: nothing caches it.
    await env.DB.prepare(`UPDATE members SET role = 'editor' WHERE user_id = ?1`).bind(member.id).run()
    expect(await json(await me())).toMatchObject({ user: { role: 'editor' } })

    // Suspended: the very next request is refused by naf-auth itself.
    expect((await call(adminApp, 'PUT', `/api/admin/members/${member.id}`, { user: admin, body: { active: false } })).status).toBe(200)
    const refused = await me()
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ ok: false, error: 'access_denied', reason: 'inactive' })

    // Reactivated: back in, same session.
    expect((await call(adminApp, 'PUT', `/api/admin/members/${member.id}`, { user: admin, body: { active: true } })).status).toBe(200)
    expect((await me()).status).toBe(200)
  })
})
