// Spec §14: tokens are encrypted at rest and never logged. Every secret the
// fake Launchpad hands out (codes, access and refresh tokens), the client
// secret and the encryption key are looked for in D1, KV, responses and every
// console call made during a run of every flow, failures included.

import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBasecampLinkRoutes } from '../../src/basecamp-link'
import { call, seedMember, testApp } from '../helpers'
import { CLIENT_SECRET, Clock, ENCRYPTION_KEY, FakeBasecamp, MINUTE, linkAccount, linkApp, linkEnv, person, uniqueId } from './fake'

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
    const fake = new FakeBasecamp(ACCOUNT)
    const clock = new Clock()
    const app = linkApp(fake, clock)
    const bodies: string[] = []
    const keep = async (res: Response) => {
      bodies.push(`${res.status} ${res.headers.get('location') ?? ''} ${await res.text()}`)
    }

    const admin = await seedMember('admin')
    const user = await seedMember('viewer')
    const who = person({ admin: true })
    fake.accountPeople = [who]
    const projectId = uniqueId()
    fake.projects.push({ id: projectId, name: 'م', description: null, todosetId: uniqueId(), peopleIds: [who.id], todolists: [{ id: uniqueId(), name: 'ق', completed_ratio: '0/1' }] })

    await keep(await linkAccount(app, fake, admin, person({ owner: true }), { service: true }))
    await keep(await linkAccount(app, fake, user, who))
    for (const path of ['/api/basecamp/link', '/api/basecamp/projects', `/api/basecamp/projects/${projectId}/todolists`, `/api/basecamp/projects/${projectId}/people`]) {
      await keep(await call(app, 'GET', path, { user, env: linkEnv(ACCOUNT) }))
    }
    await keep(await call(app, 'GET', '/api/admin/people-matches', { user: admin, env: linkEnv(ACCOUNT) }))

    // A refresh that works, then failures of every kind.
    clock.advance(fake.expiresIn * 1000)
    await keep(await call(app, 'GET', '/api/basecamp/projects', { user, env: linkEnv(ACCOUNT) }))
    clock.advance(fake.expiresIn * 1000)
    for (const answer of [
      { status: 503, body: { error: 'x' } },
      { status: 401, body: { error: 'invalid_client' } },
      { status: 400, body: { error: 'invalid_grant', access_token: 'leaked?' } },
    ]) {
      fake.refreshAnswer = answer
      await keep(await call(app, 'GET', '/api/basecamp/projects', { user, env: linkEnv(ACCOUNT) }))
    }
    clock.advance(11 * MINUTE)
    await keep(await call(app, 'GET', '/api/admin/people-matches', { user: admin, env: linkEnv(ACCOUNT) }))
    fake.exchangeAnswer = { status: 500, body: { error: 'boom' } }
    await keep(await linkAccount(app, fake, user, who))
    fake.exchangeAnswer = null
    await keep(await call(app, 'POST', '/api/basecamp/link/revoke', { user, env: linkEnv(ACCOUNT) }))

    const secrets = [...fake.issued, CLIENT_SECRET, ENCRYPTION_KEY]
    expect(fake.issued.length).toBeGreaterThanOrEqual(6)

    // D1: every table the link writes, and the audit log.
    const dump: unknown[] = []
    for (const table of ['user_basecamp_links', 'integrations', 'audit_log', 'bc_people_cache', 'bc_account_people_cache', 'bc_person_matches']) {
      dump.push((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)
    }
    const stored = JSON.stringify(dump)
    // KV: pending states hold no token or code.
    const keys = await env.SETTINGS.list({ prefix: 'bc-oauth-state:' })
    const kv = JSON.stringify(await Promise.all(keys.keys.map((k) => env.SETTINGS.get(k.name))))
    const logs = JSON.stringify(logged.map((args) => args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${String(a.stack)}` : a))))
    const responses = bodies.join('\n')

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

  it('reports an undecryptable token as a server error without logging the ciphertext or the key', async () => {
    const fake = new FakeBasecamp(ACCOUNT)
    const app = linkApp(fake, new Clock())
    const user = await seedMember('editor')
    const who = person()
    fake.projects.push({ id: uniqueId(), name: 'م', description: null, todosetId: null, peopleIds: [who.id], todolists: [] })
    expect((await linkAccount(app, fake, user, who)).status).toBe(302)

    const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const res = await call(app, 'GET', '/api/basecamp/projects', { user, env: linkEnv(ACCOUNT, { TOKEN_ENCRYPTION_KEY: otherKey }) })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, error: 'internal' })

    const row = await env.DB.prepare(`SELECT status, encrypted_tokens FROM user_basecamp_links WHERE user_id = ?1`).bind(user.id).first<{ status: string; encrypted_tokens: string }>()
    // Not "repaired" by expiring the link: a wrong key is an operator's problem.
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
    expect((await call(app, 'GET', '/api/basecamp/nothing-here', { user })).status).toBe(404)
  })
})
