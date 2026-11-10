// Service tokens of the internal API (spec §13 «محمية برموز خدمة»).
//
//   GET  /api/admin/api-tokens              list (admin)
//   POST /api/admin/api-tokens              create; the token is in the answer, once (admin)
//   POST /api/admin/api-tokens/:id/revoke   revoke; never deleted (admin)
//
// A token is `nafs_` + 32 random bytes (base64url). Only its SHA-256 is
// stored, so a D1 copy (or backup) cannot be replayed as a token.
// OPEN (I1): how tokens are issued, rotated and scoped is not in the spec;
// this is the safe default (admin-issued, read-only, revocable).

import { Hono } from 'hono'
import type { ApiTokenListResponse, ApiTokenSummary, CreateApiTokenResponse } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { auditStatement } from '../audit'
import { ApiFailure } from '../errors'
import { callerOf, isPlainObject, nowIso, readJson } from '../request'

export const TOKEN_PREFIX = 'nafs_'
const PREFIX_SHOWN = 10
const MAX_NAME = 100

interface TokenRow {
  id: string
  name: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

function toSummary(row: TokenRow): ApiTokenSummary {
  return { id: row.id, name: row.name, prefix: row.token_prefix, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at }
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function newTokenSecret(): string {
  return TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** The live token a request presents, or null. Marks it used. */
export async function tokenFromRequest(db: D1Database, authorization: string | undefined): Promise<{ id: string } | null> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')
  const secret = match?.[1]
  if (!secret || !secret.startsWith(TOKEN_PREFIX) || secret.length > 200) return null
  const hash = await sha256Hex(secret)
  const row = await db.prepare(`SELECT id FROM api_tokens WHERE token_hash = ?1 AND revoked_at IS NULL`).bind(hash).first<{ id: string }>()
  if (!row) return null
  await db.prepare(`UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1`).bind(row.id, nowIso()).run()
  return row
}

export function apiTokenRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.use('*', async (c, next) => {
    if (callerOf(c).role !== 'admin') throw new ApiFailure(403, 'admin_only')
    await next()
  })

  routes.get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, token_prefix, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC, id`,
    ).all<TokenRow>()
    return c.json<ApiTokenListResponse>({ tokens: results.map(toSummary) })
  })

  routes.post('/', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c)
    const name = isPlainObject(body) && typeof body.name === 'string' ? body.name.trim() : ''
    if (name.length === 0 || name.length > MAX_NAME) throw new ApiFailure(400, 'invalid_token_name')
    const id = crypto.randomUUID()
    const secret = newTokenSecret()
    const now = nowIso()
    const db = c.env.DB
    await db.batch([
      db
        .prepare(`INSERT INTO api_tokens (id, name, token_hash, token_prefix, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(id, name, await sha256Hex(secret), secret.slice(0, PREFIX_SHOWN), caller.id, now),
      // The token itself is never logged or audited (§14).
      auditStatement(db, { actorId: caller.id, action: 'api_token.create', entityType: 'api_token', entityId: id, workbookId: null, details: { name } }, now),
    ])
    const row: TokenRow = { id, name, token_prefix: secret.slice(0, PREFIX_SHOWN), created_at: now, last_used_at: null, revoked_at: null }
    return c.json<CreateApiTokenResponse>({ token: toSummary(row), secret }, 201)
  })

  routes.post('/:id/revoke', async (c) => {
    const caller = callerOf(c)
    const db = c.env.DB
    const id = c.req.param('id')
    const row = await db.prepare(`SELECT id, name, token_prefix, created_at, last_used_at, revoked_at FROM api_tokens WHERE id = ?1`).bind(id).first<TokenRow>()
    if (!row) throw new ApiFailure(404, 'api_token_not_found')
    if (row.revoked_at === null) {
      const now = nowIso()
      await db.batch([
        db.prepare(`UPDATE api_tokens SET revoked_at = ?2, revoked_by = ?3 WHERE id = ?1 AND revoked_at IS NULL`).bind(id, now, caller.id),
        auditStatement(db, { actorId: caller.id, action: 'api_token.revoke', entityType: 'api_token', entityId: id, workbookId: null, details: { name: row.name } }, now),
      ])
      row.revoked_at = now
    }
    return c.json<ApiTokenSummary>(toSummary(row))
  })

  return routes
}
