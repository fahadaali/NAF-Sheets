// Spec §14: tokens are encrypted at rest and never logged. Every secret the
// fake Launchpad hands out (codes, access and refresh tokens), the client
// secret and the encryption key are looked for in D1, KV, responses and every
// console call made during a run of every flow, failures included.

import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { basecampClient, linkContextFor, registerBasecampLinkRoutes, withServiceToken } from '../../src/basecamp-link'
import { call, seedMember, testApp } from '../helpers'
import { CLIENT_SECRET, Clock, ENCRYPTION_KEY, FakeBasecamp, linkAccount, linkApp, linkEnv, person, uniqueId } from './fake'

const ACCOUNT = 7_500_005

describe('secrets at rest and in logs', () => {
  const logged: unknown[][] = []
  beforeEach(() => {
    logged.length = 0
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args)
      })
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never stores, logs or returns a token, a code, the client secret or the key in plaintext', async () => {
    const account = uniqueId()
    const fake = new FakeBasecamp(account)
    const clock = new Clock()
    const app = linkApp(fake, clock)
    const ctx = linkContextFor(linkEnv(account), { fetch: (url, init) => fake.fetch(url, init), now: () => clock.now, limiter: { acquire: async () => {} }, sleep: async () => {} })
    const read = () => withServiceToken(ctx, (token) => basecampClient(ctx).projects.list(token).all()).catch((e: unknown) => e)
    const bodies: string[] = []
    const keep = async (res: Response) => {
      bodies.push(`${res.status} ${res.headers.get('location') ?? ''} ${await res.text()}`)
    }

    const admin = await seedMember('admin')
    fake.projects.push({ id: uniqueId(), name: 'م', description: null, todosetId: uniqueId(), peopleIds: [], todolists: [] })

    await keep(await linkAccount(app, fake, admin, person({ owner: true }), { service: true }))
    await read()
    // A refresh that works, then failures of every kind.
    clock.advance(fake.expiresIn * 1000)
    await read()
    clock.advance(fake.expiresIn * 1000)
    const failures: unknown[] = []
    for (const answer of [
      { status: 503, body: { error: 'x' } },
      { status: 401, body: { error: 'invalid_client' } },
      { status: 400, body: { error: 'invalid_grant', access_token: 'leaked?' } },
    ]) {
      fake.refreshAnswer = answer
      failures.push(await read())
    }
    fake.exchangeAnswer = { status: 500, body: { error: 'boom' } }
    await keep(await linkAccount(app, fake, admin, person({ owner: true }), { service: true }))
    fake.exchangeAnswer = null

    const secrets = [...fake.issued, CLIENT_SECRET, ENCRYPTION_KEY]
    expect(fake.issued.length).toBeGreaterThanOrEqual(4)

    // D1: every table the link writes, and the audit log.
    const dump: unknown[] = []
    for (const table of ['integrations', 'audit_log', 'bc_account_people_cache']) {
      dump.push((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)
    }
    const stored = JSON.stringify(dump)
    // KV: pending states hold no token or code.
    const keys = await env.SETTINGS.list({ prefix: 'bc-oauth-state:' })
    const kv = JSON.stringify(await Promise.all(keys.keys.map((k) => env.SETTINGS.get(k.name))))
    const logs = JSON.stringify(logged.map((args) => args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${String(a.stack)}` : a))))
    const responses = bodies.join('\n') + JSON.stringify(failures.map((f) => (f instanceof Error ? `${f.name} ${f.message}` : f)))

    for (const secret of secrets) {
      expect(stored, 'D1').not.toContain(secret)
      expect(kv, 'KV').not.toContain(secret)
      expect(logs, 'console').not.toContain(secret)
      expect(responses, 'responses').not.toContain(secret)
    }
    // Something was logged (the failures above), by code only.
    expect(logs).toContain('basecamp-link')
    expect(logs).not.toContain('leaked?')
  })

  it('reports an undecryptable token as an error without logging the ciphertext or the key', async () => {
    const account = uniqueId()
    const fake = new FakeBasecamp(account)
    const app = linkApp(fake, new Clock())
    const admin = await seedMember('admin')
    expect((await linkAccount(app, fake, admin, person({ admin: true }), { service: true })).status).toBe(302)

    const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const ctx = linkContextFor(linkEnv(account, { TOKEN_ENCRYPTION_KEY: otherKey }), { fetch: fake.fetch, limiter: { acquire: async () => {} } })
    await expect(withServiceToken(ctx, async (token) => token)).rejects.toThrow(/could not be decrypted/)

    const row = await env.DB.prepare(`SELECT status, encrypted_tokens FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`).bind(String(account)).first<{ status: string; encrypted_tokens: string }>()
    // Not "repaired" by expiring the account: a wrong key is an operator's problem.
    expect(row?.status).toBe('active')
    const logs = JSON.stringify(logged)
    expect(logs).not.toContain(row?.encrypted_tokens as string)
    expect(logs).not.toContain(otherKey)
    expect(logs).not.toContain(ENCRYPTION_KEY)
  })
})

describe('registration', () => {
  it('refuses to register the routes twice on one app (the first set would shadow the second)', () => {
    const app = testApp()
    registerBasecampLinkRoutes(app, { fetch: async () => new Response('{}') })
    expect(() => registerBasecampLinkRoutes(app, { fetch: async () => new Response('{}') })).toThrow(/already registered/)
  })

  it('leaves the existing routes alone', async () => {
    const app = linkApp(new FakeBasecamp(ACCOUNT), new Clock())
    const user = await seedMember('viewer')
    expect((await call(app, 'GET', '/api/me', { user })).status).toBe(200)
    expect((await call(app, 'GET', '/health')).status).toBe(200)
    // The editor's personal-link routes are gone.
    for (const path of ['/api/basecamp/link', '/api/basecamp/projects', '/api/admin/people-matches']) expect((await call(app, 'GET', path, { user })).status).toBe(404)
  })
})
