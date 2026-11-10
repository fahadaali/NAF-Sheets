// The production wiring: naf-auth's middleware and handlers, as createApp()
// sets them up. Only paths that need no network are exercised — none of these
// requests reaches naf-id (no session → naf-auth answers on its own).

import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { call, isArabic, json, seedMember, testApp } from './helpers'

const app = createApp()
const issuer = 'https://app.naflaw.sa'
const fetchMode = { 'sec-fetch-mode': 'cors' }

describe('naf-auth wiring (real middleware)', () => {
  it('serves /health without a session', async () => {
    const res = await call(app, 'GET', '/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('answers an API call without a session with 401, the login URL and an Arabic message', async () => {
    const res = await call(app, 'GET', '/api/me', { headers: fetchMode })
    expect(res.status).toBe(401)
    const body = await json(res)
    expect(body.ok).toBe(false)
    expect(body.error).toBe('unauthorized')
    expect(body.login).toBe(`${issuer}/go/${env.PLATFORM_ID}`)
    expect(isArabic(body.message)).toBe(true)
  })

  it('protects every path not declared public', async () => {
    for (const path of ['/api/workbooks', '/api/workbooks/x/members', '/anything-else']) {
      const res = await call(app, 'GET', path, { headers: fetchMode })
      expect(res.status, path).toBe(401)
    }
    const res = await call(app, 'POST', '/api/workbooks', { headers: fetchMode, body: { title: 'x', source: 'blank' } })
    expect(res.status).toBe(401)
  })

  it('treats an unknown session cookie as no session', async () => {
    const res = await call(app, 'GET', '/api/me', { headers: { ...fetchMode, cookie: 'naf_sid=not-a-session' } })
    expect(res.status).toBe(401)
  })

  it('sends a page navigation to naf-id to sign in', async () => {
    const res = await call(app, 'GET', '/api/workbooks', { headers: { 'sec-fetch-mode': 'navigate' } })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(new RegExp(`^${issuer}/go/${env.PLATFORM_ID}\\?`))
  })

  it('restarts sign-in when /auth/callback is reached without a code', async () => {
    const res = await call(app, 'GET', '/auth/callback', { headers: { 'sec-fetch-mode': 'navigate' } })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(new RegExp(`^${issuer}/go/`))
  })

  it('signs out locally and points the browser at naf-id', async () => {
    const res = await call(app, 'POST', '/auth/logout', { headers: fetchMode })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, next: `${issuer}/` })
    expect(res.headers.get('set-cookie')).toMatch(/naf_sid=;/)
  })

  it('keeps the back-channel logout public and guarded by its own token check', async () => {
    const missing = await call(app, 'POST', '/auth/backchannel-logout', { body: {} })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ ok: false, error: 'invalid_body' })

    const wrongMethod = await call(app, 'GET', '/auth/backchannel-logout')
    expect(wrongMethod.status).toBe(405)
  })

  it('leaves the Basecamp webhook path public (secret check, not a session)', async () => {
    const res = await call(app, 'POST', `/webhooks/basecamp/${'a'.repeat(40)}`, { rawBody: '{}' })
    expect(res.status).toBe(404)
    expect((await json(res)).error).toBe('not_found')
  })

  it('is what the Worker entry point serves', async () => {
    const health = await exports.default.fetch('https://sheets.naflaw.sa/health')
    expect(health.status).toBe(200)
    const me = await exports.default.fetch('https://sheets.naflaw.sa/api/me', { headers: fetchMode })
    expect(me.status).toBe(401)
  })

  it('denies a signed-in-looking request for an inactive member through the injected guard', async () => {
    // The injected guard mirrors naf-auth: an inactive member is refused.
    const inactive = await seedMember('editor', { active: false })
    const res = await call(testApp(), 'GET', '/api/me', { user: inactive })
    expect(res.status).toBe(403)
    expect(isArabic((await json(res)).message)).toBe(true)
  })
})
