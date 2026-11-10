// Test helpers. Authentication is injected: `testAuth` takes the user id from a
// header and reads the member row exactly as naf-auth does (`getMember`), so
// no test ever talks to naf-id.

import { env } from 'cloudflare:workers'
import { getMember } from 'naf-auth'
import type { PlatformRole } from '@naf-sheets/shared'
import { createApp } from '../src/app'
import type { AppOptions } from '../src/app'
import type { AuthMiddleware } from '../src/auth'
import { authConfig } from '../src/auth'
import type { Env } from '../src/env'
import { errorBody } from '../src/errors'

export const TEST_USER_HEADER = 'x-test-user'

export const testAuth: AuthMiddleware = async (c, next) => {
  const userId = c.req.header(TEST_USER_HEADER)
  if (!userId) return c.json(errorBody('unauthorized'), 401)
  const member = await getMember(c.env, authConfig(c.env), userId)
  if (!member || !member.isActive) return c.json(errorBody('access_denied'), 403)
  c.set('user', { id: member.id, role: member.role, perms: member.perms })
  await next()
}

export function testApp(options: Omit<AppOptions, 'auth'> = {}) {
  return createApp({ ...options, auth: testAuth })
}

export interface SeededMember {
  id: string
  name: string
  email: string
  role: PlatformRole
}

/** A members row as naf-auth's first sign-in would create it, then promoted to `role`. */
export async function seedMember(role: PlatformRole, options: { active?: boolean } = {}): Promise<SeededMember> {
  const id = `sub-${crypto.randomUUID()}`
  const name = `عضو ${id.slice(4, 10)}`
  const email = `${id}@naflaw.sa`
  await env.DB.prepare(
    `INSERT INTO members (user_id, display_name, email, role, perms, is_active, last_seen_at, created_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, ?6)`,
  )
    .bind(id, name, email, role, options.active === false ? 0 : 1, Math.floor(Date.now() / 1000))
    .run()
  return { id, name, email, role }
}

export interface CallOptions {
  user?: { id: string } | null
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
  env?: Env
}

export async function call(app: ReturnType<typeof createApp>, method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.user) headers.set(TEST_USER_HEADER, options.user.id)
  let body: string | undefined
  if (options.rawBody !== undefined) body = options.rawBody
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { method, headers, body }, options.env ?? env)
}

export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Creates a blank workbook as `owner` through the API and returns its id. */
export async function createWorkbook(app: ReturnType<typeof createApp>, owner: { id: string }, title = 'خطة الاتصال المؤسسي'): Promise<string> {
  const res = await call(app, 'POST', '/api/workbooks', { user: owner, body: { title, source: 'blank' } })
  if (res.status !== 201) throw new Error(`createWorkbook: ${res.status} ${await res.text()}`)
  return (await json<{ id: string }>(res)).id
}

export async function addMember(workbookId: string, userId: string, role: 'editor' | 'viewer', addedBy: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(workbookId, userId, role, addedBy, new Date().toISOString())
    .run()
}

/** Arabic letters present: the message is user-facing Arabic, not a code. */
export function isArabic(text: unknown): boolean {
  return typeof text === 'string' && /[؀-ۿ]/.test(text)
}
