// Sign-in through naf-id via naf-auth (CLAUDE.md §2, naf-auth README).
//
// Authentication is central, permissions are local: naf-auth decides who is
// signed in and puts `{ id, role, perms }` in `c.get('user')`; what that user
// may do on this platform comes from `members.role` and the workbook tables.

import { createConfig, honoMiddleware } from 'naf-auth'
import type { AuthConfig } from 'naf-auth'
import type { MiddlewareHandler } from 'hono'
import type { PlatformRole } from '@naf-sheets/shared'
import type { Env } from './env'
import { messageForAuthCode } from './errors'

/** What naf-auth injects as `c.get('user')`. */
export interface AuthUser {
  /** members.user_id = the `sub` from naf-id. */
  id: string
  role: string
  perms: Record<string, unknown> | null
}

export interface AppVariables {
  user: AuthUser
}

export interface AppEnv {
  Bindings: Env
  Variables: AppVariables
}

export type AuthMiddleware = MiddlewareHandler<AppEnv>

/**
 * Paths reachable without a session. Every other path is protected by default.
 * `/auth/logout` is public so an expired session can still sign out (naf-auth
 * README, «الخروج»); `/auth/backchannel-logout` is guarded by naf-id's
 * signature, not by a cookie.
 * OPEN: `/denied` (naf-auth's refusal page) is not served by this Worker; see
 * apps/api/OPEN_QUESTIONS.md #3.
 */
export const PUBLIC_PATHS = ['/auth/callback', '/auth/logout', '/auth/backchannel-logout', '/health']
// `/api/v1/` is the internal API (§13): guarded by its own service tokens.
export const PUBLIC_PREFIXES = ['/webhooks/basecamp/', '/api/v1/']

export function authConfig(env: Env): AuthConfig {
  return createConfig(env, {
    publicPaths: PUBLIC_PATHS,
    publicPrefixes: PUBLIC_PREFIXES,
    // Errors are reported by code only: never a token, a secret or a cookie.
    onError: (code) => console.warn(`naf-auth: ${code}`),
  })
}

/** Platform role from `members.role`; anything unexpected is treated as read-only. */
export function platformRole(role: string): PlatformRole {
  return role === 'admin' || role === 'editor' ? role : 'viewer'
}

/**
 * naf-auth's JSON refusals (`unauthorized` 401, `access_denied` 403,
 * `auth_unavailable` 503) carry a code but no sentence: the contract requires
 * an Arabic `message` in every error body, so it is added here. Everything
 * else naf-auth returns (redirects, fields such as `login`) passes untouched.
 */
export async function withArabicMessage(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') ?? ''
  if (response.status < 400 || !type.includes('application/json')) return response

  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return response
  }
  if (!body || typeof body !== 'object' || 'message' in body) return response

  const message = messageForAuthCode((body as { error?: unknown }).error)
  if (!message) return response

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify({ ...body, message }), { status: response.status, headers })
}

/** Production middleware: naf-auth's Hono wiring, with Arabic error messages. */
export const nafAuthMiddleware: AuthMiddleware = async (c, next) => {
  const result = await honoMiddleware(authConfig(c.env))(c, next)
  if (result instanceof Response) return withArabicMessage(result)
  return undefined
}
