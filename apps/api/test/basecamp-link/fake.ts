// A fake Launchpad + Basecamp for the link tests. Nothing real is ever called:
// every request the routes make goes through `FakeBasecamp.fetch`, which
// records it and answers from in-memory data shaped like the documented
// responses (authentication.md, people.md, projects.md, todolists.md).

import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import type { BasecampLinkEnv, HttpFetch } from '../../src/basecamp-link'
import { registerBasecampLinkRoutes } from '../../src/basecamp-link'
import { LAUNCHPAD_AUTHORIZATION_URL, LAUNCHPAD_TOKEN_URL } from '../../src/basecamp-link/oauth'
import { call, testApp } from '../helpers'

export const CLIENT_ID = 'naf-sheets-test-client'
export const CLIENT_SECRET = 'test-client-secret-5f1c0e9a7b'
export const ENCRYPTION_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

/** Test-only bindings. Each test file passes its own account id so files never share an integration row. */
export function linkEnv(accountId: number, overrides: Partial<BasecampLinkEnv> = {}): BasecampLinkEnv {
  return {
    ...env,
    BASECAMP_CLIENT_ID: CLIENT_ID,
    BASECAMP_CLIENT_SECRET: CLIENT_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    BASECAMP_ACCOUNT_ID: String(accountId),
    ...overrides,
  }
}

export class Clock {
  now = Date.now()
  advance(ms: number): void {
    this.now += ms
  }
}

export const MINUTE = 60_000

export interface FakePerson {
  id: number
  name: string
  email_address: string
  personable_type?: string
  admin?: boolean
  owner?: boolean
  client?: boolean
  avatar_url?: string
}

export interface FakeProject {
  id: number
  name: string
  description: string | null
  /** null: the to-dos tool is turned off in the dock. */
  todosetId: number | null
  peopleIds: number[]
  todolists: Array<{ id: number; name: string; completed_ratio: string }>
}

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

interface Grant {
  person: FakePerson
  accounts: Array<{ product: string; id: number }>
}

type Canned = { status: number; body: unknown }

let sequence = 0
export function uniqueId(): number {
  sequence += 1
  return Math.floor(Math.random() * 1e9) * 1000 + sequence
}

export function person(overrides: Partial<FakePerson> = {}): FakePerson {
  const id = overrides.id ?? uniqueId()
  return { id, name: `شخص ${id}`, email_address: `p${id}@naflaw.sa`, personable_type: 'User', ...overrides }
}

export class FakeBasecamp {
  readonly calls: RecordedCall[] = []
  /** Every secret value this fake handed out (codes, access and refresh tokens), for leak scans. */
  readonly issued: string[] = []
  readonly projects: FakeProject[] = []
  accountPeople: FakePerson[] = []
  expiresIn = 14 * 24 * 3600
  /** Launchpad's refresh answer carries a new refresh token only when true. */
  rotateRefreshTokens = false
  exchangeAnswer: Canned | null = null
  refreshAnswer: Canned | null = null
  /** Every Basecamp API request answers this status (e.g. 503). */
  apiFailure: number | null = null
  /** Access tokens Basecamp refuses with 401 although they were issued. */
  readonly rejectedAccess = new Set<string>()

  private readonly codes = new Map<string, Grant>()
  private readonly usedCodes = new Set<string>()
  private readonly access = new Map<string, Grant>()
  private readonly refresh = new Map<string, Grant>()

  constructor(readonly accountId: number) {}

  get apiBase(): string {
    return `https://3.basecampapi.com/${this.accountId}`
  }

  /** A verification code Launchpad would hand back for `who`. */
  grantCode(who: FakePerson, accounts: Grant['accounts'] = [{ product: 'bc3', id: this.accountId }]): string {
    const code = `code-${crypto.randomUUID()}`
    this.codes.set(code, { person: who, accounts })
    this.issued.push(code)
    return code
  }

  /** Requests whose URL starts with `prefix`. */
  callsTo(prefix: string): RecordedCall[] {
    return this.calls.filter((c) => c.url.startsWith(prefix))
  }

  apiCalls(): RecordedCall[] {
    return this.callsTo(this.apiBase)
  }

  tokenCalls(type?: string): RecordedCall[] {
    return this.callsTo(LAUNCHPAD_TOKEN_URL).filter((c) => type === undefined || new URLSearchParams(c.body ?? '').get('type') === type)
  }

  fetch: HttpFetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries())
    const body = typeof init.body === 'string' ? init.body : null
    const method = (init.method ?? 'GET').toUpperCase()
    this.calls.push({ url, method, headers, body })

    if (url === LAUNCHPAD_TOKEN_URL && method === 'POST') return this.tokenEndpoint(new URLSearchParams(body ?? ''))
    if (url === LAUNCHPAD_AUTHORIZATION_URL && method === 'GET') {
      const grant = this.bearer(headers)
      if (!grant) return reply(401, { error: 'unauthorized' })
      return reply(200, {
        expires_at: '2099-01-01T00:00:00Z',
        identity: { id: 1, first_name: 'x', last_name: 'y', email_address: grant.person.email_address },
        accounts: grant.accounts.map((a) => ({ ...a, name: 'حساب', href: `https://3.basecampapi.com/${a.id}`, app_href: `https://3.basecamp.com/${a.id}` })),
      })
    }
    if (url.startsWith(`${this.apiBase}/`)) return this.api(url.slice(this.apiBase.length), method, headers)
    throw new Error(`FakeBasecamp: unexpected request ${method} ${url}`)
  }

  private tokenEndpoint(p: URLSearchParams): Response {
    if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET) return reply(401, { error: 'invalid_client' })
    if (p.get('type') === 'web_server') {
      if (this.exchangeAnswer) return reply(this.exchangeAnswer.status, this.exchangeAnswer.body)
      const code = p.get('code') ?? ''
      const grant = this.codes.get(code)
      if (!grant || this.usedCodes.has(code)) return reply(400, { error: 'invalid_grant' })
      this.usedCodes.add(code)
      return reply(200, this.issue(grant, true))
    }
    if (p.get('type') === 'refresh') {
      if (this.refreshAnswer) return reply(this.refreshAnswer.status, this.refreshAnswer.body)
      const grant = this.refresh.get(p.get('refresh_token') ?? '')
      if (!grant) return reply(400, { error: 'invalid_grant' })
      return reply(200, this.issue(grant, this.rotateRefreshTokens))
    }
    return reply(400, { error: 'unsupported_grant_type' })
  }

  private issue(grant: Grant, withRefresh: boolean): Record<string, unknown> {
    const accessToken = `at-${crypto.randomUUID()}`
    this.access.set(accessToken, grant)
    this.issued.push(accessToken)
    const answer: Record<string, unknown> = { access_token: accessToken, expires_in: this.expiresIn }
    if (withRefresh) {
      const refreshToken = `rt-${crypto.randomUUID()}`
      this.refresh.set(refreshToken, grant)
      this.issued.push(refreshToken)
      answer['refresh_token'] = refreshToken
    }
    return answer
  }

  private bearer(headers: Record<string, string>): Grant | null {
    const auth = headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (this.rejectedAccess.has(token)) return null
    return this.access.get(token) ?? null
  }

  private api(path: string, method: string, headers: Record<string, string>): Response {
    const grant = this.bearer(headers)
    if (!grant) return reply(401, { error: 'unauthorized' })
    if (this.apiFailure !== null) return reply(this.apiFailure, { error: 'unavailable' })
    if (method !== 'GET') return reply(405, {})
    const me = grant.person
    const visible = (p: FakePerson): Record<string, unknown> => ({
      id: p.id,
      name: p.name,
      personable_type: p.personable_type ?? 'User',
      email_address: me.admin || me.owner || me.id === p.id ? p.email_address : redact(p.email_address),
      admin: p.admin ?? false,
      owner: p.owner ?? false,
      client: p.client ?? false,
      avatar_url: p.avatar_url ?? `https://3.basecampapi.com/${this.accountId}/people/${p.id}/avatar`,
    })

    if (path === '/my/profile.json') return reply(200, visible(me))
    if (path === '/people.json') return reply(200, this.accountPeople.map(visible))
    if (path === '/projects.json') {
      return reply(
        200,
        this.projects.filter((p) => p.peopleIds.includes(me.id)).map((p) => ({ id: p.id, status: 'active', name: p.name, description: p.description, dock: dock(p) })),
      )
    }
    let m = /^\/projects\/(\d+)\.json$/.exec(path)
    if (m) {
      const project = this.projects.find((p) => p.id === Number(m?.[1]) && p.peopleIds.includes(me.id))
      return project ? reply(200, { id: project.id, status: 'active', name: project.name, description: project.description, dock: dock(project) }) : reply(404, {})
    }
    m = /^\/projects\/(\d+)\/people\.json$/.exec(path)
    if (m) {
      const project = this.projects.find((p) => p.id === Number(m?.[1]) && p.peopleIds.includes(me.id))
      if (!project) return reply(404, {})
      const everyone = [...this.accountPeople, me]
      const people = project.peopleIds.map((id) => everyone.find((p) => p.id === id)).filter((p): p is FakePerson => p !== undefined)
      return reply(200, dedupe(people).map(visible))
    }
    m = /^\/todosets\/(\d+)\/todolists\.json$/.exec(path)
    if (m) {
      const project = this.projects.find((p) => p.todosetId === Number(m?.[1]) && p.peopleIds.includes(me.id))
      if (!project) return reply(404, {})
      return reply(
        200,
        project.todolists.map((l) => ({ id: l.id, status: 'active', type: 'Todolist', title: l.name, name: l.name, completed_ratio: l.completed_ratio })),
      )
    }
    return reply(404, {})
  }
}

function dock(p: FakeProject): unknown[] {
  const tools: unknown[] = [{ id: p.id + 1, title: 'Message Board', name: 'message_board', enabled: true, position: 1, url: '', app_url: '' }]
  if (p.todosetId !== null) tools.push({ id: p.todosetId, title: 'To-dos', name: 'todoset', enabled: true, position: 2, url: '', app_url: '' })
  else tools.push({ id: p.id + 2, title: 'To-dos', name: 'todoset', enabled: false, position: null, url: '', app_url: '' })
  return tools
}

function dedupe(people: FakePerson[]): FakePerson[] {
  const seen = new Set<number>()
  return people.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
}

/** people.md: redacted like "j••••@•••••••••.•••". */
export function redact(email: string): string {
  return `${email[0]}••••@•••••••••.•••`
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/** An app with the link routes on a fake Basecamp and a controllable clock. */
export function linkApp(fake: FakeBasecamp, clock: Clock) {
  const app = testApp()
  registerBasecampLinkRoutes(app, { fetch: fake.fetch, now: () => clock.now, limiter: { acquire: async () => {} }, sleep: async () => {} })
  return app
}

export type LinkTestApp = ReturnType<typeof linkApp>

/** GET /auth/basecamp/start, returning the response and the `state` sent to Launchpad. */
export async function startLink(app: LinkTestApp, accountId: number, user: { id: string }, query = ''): Promise<{ res: Response; state: string | null; location: URL | null }> {
  const res = await call(app, 'GET', `/auth/basecamp/start${query}`, { user, env: linkEnv(accountId) })
  const header = res.headers.get('location')
  const location = header ? new URL(header) : null
  return { res, state: location?.searchParams.get('state') ?? null, location }
}

export async function callback(app: LinkTestApp, accountId: number, user: { id: string } | null, params: Record<string, string>): Promise<Response> {
  return call(app, 'GET', `/auth/basecamp/callback?${new URLSearchParams(params).toString()}`, { user, env: linkEnv(accountId) })
}

/** The whole link flow for `user` as Basecamp person `who`. Returns the callback response. */
export async function linkAccount(
  app: LinkTestApp,
  fake: FakeBasecamp,
  user: { id: string },
  who: FakePerson,
  options: { next?: string; service?: boolean } = {},
): Promise<Response> {
  const query = new URLSearchParams()
  if (options.next !== undefined) query.set('next', options.next)
  if (options.service) query.set('service', '1')
  const qs = query.toString()
  const { res, state } = await startLink(app, fake.accountId, user, qs ? `?${qs}` : '')
  if (res.status !== 302 || state === null) throw new Error(`startLink: ${res.status} ${await res.text()}`)
  return callback(app, fake.accountId, user, { code: fake.grantCode(who), state })
}

export interface AuditRow {
  at: string
  actor_id: string | null
  action: string
  entity_type: string
  entity_id: string
  workbook_id: string | null
  details_json: string
}

export async function auditFor(entityId: string, action?: string): Promise<AuditRow[]> {
  const sql = action
    ? `SELECT at, actor_id, action, entity_type, entity_id, workbook_id, details_json FROM audit_log WHERE entity_id = ?1 AND action = ?2 ORDER BY id`
    : `SELECT at, actor_id, action, entity_type, entity_id, workbook_id, details_json FROM audit_log WHERE entity_id = ?1 ORDER BY id`
  const statement = action ? env.DB.prepare(sql).bind(entityId, action) : env.DB.prepare(sql).bind(entityId)
  return (await statement.all<AuditRow>()).results
}

export interface LinkRowForTest {
  user_id: string
  bc_person_id: number
  bc_account_id: number
  encrypted_tokens: string
  expires_at: string | null
  linked_at: string
  status: string
  bc_person_name: string | null
  updated_at: string | null
}

export async function linkRow(userId: string): Promise<LinkRowForTest | null> {
  return env.DB.prepare(`SELECT * FROM user_basecamp_links WHERE user_id = ?1`).bind(userId).first<LinkRowForTest>()
}

export async function expectLinkError(res: Response, status: number, error: string, messagePart?: string): Promise<void> {
  expect(res.status).toBe(status)
  const body = (await res.json()) as { ok: boolean; error: string; message: string }
  expect(body.ok).toBe(false)
  expect(body.error).toBe(error)
  expect(/[؀-ۿ]/.test(body.message)).toBe(true)
  if (messagePart) expect(body.message).toContain(messagePart)
}
