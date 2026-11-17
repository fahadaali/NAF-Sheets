// The stored Basecamp token of the sync account (CLAUDE.md §2, owner
// decision 7): `integrations`, provider 'basecamp'. Every station read and
// write goes out with it (`withServiceToken`). The editor's per-user links
// (`user_basecamp_links`) are no longer read or written; their rows are kept.
//
// Tokens are AES-GCM ciphertext (src/crypto.ts) whose `aad` is the row's
// identity, so a value copied to another row does not decrypt. A token is
// refreshed shortly before it expires; when Launchpad refuses the refresh the
// row turns `expired` and its tokens are discarded, and the station stops
// with «اربط حساب المزامنة» until an admin connects it again. Rows are never deleted.

import { createBasecampClient, UnauthorizedError } from '@naf-sheets/basecamp'
import type { BasecampClient } from '@naf-sheets/basecamp'
import { auditStatement } from '../audit'
import type { AuditEntry } from '../audit'
import { decryptJson, encryptJson } from '../crypto'
import type { LinkContext } from './env'
import { LinkFailure } from './errors'
import type { LinkErrorKey } from './errors'
import { LaunchpadError, refreshTokens } from './oauth'
import type { TokenSet } from './oauth'

/** Refresh when the access token has less than this left (Launchpad tokens live 2 weeks). */
// OPEN: the margin is not in the spec (apps/api/OPEN_QUESTIONS.md "Basecamp link" B5).
export const REFRESH_MARGIN_MS = 5 * 60_000

/**
 * `encrypted_tokens` of a row that holds no token (revoked or expired).
 * OPEN: the column is NOT NULL in 0001 (see migrations/0002_basecamp_link.sql; B6).
 */
export const NO_TOKEN = ''

/** What is encrypted. The expiry is not secret and lives in `expires_at`. */
interface StoredTokens {
  access_token: string
  refresh_token: string | null
}

export function serviceAad(integrationId: string): string {
  return `integrations:${integrationId}`
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString()
}

/** A Basecamp client for the platform's account. It holds no token: each call is given one. */
export function basecampClient(ctx: LinkContext): BasecampClient {
  return createBasecampClient({
    accountId: ctx.config.accountId,
    fetch: ctx.fetch,
    limiter: ctx.limiter,
    sleep: ctx.sleep,
    now: ctx.now,
  })
}

/**
 * An audit row written only when `conditionSql` (a SELECT using ?8, ?9…)
 * finds a row — in the same batch as a conditional change, so the log never
 * records a change that a concurrent request made instead.
 */
export function auditIf(db: D1Database, entry: AuditEntry, at: string, conditionSql: string, conditionParams: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (${conditionSql})`,
    )
    .bind(at, entry.actorId, entry.action, entry.entityType, entry.entityId, entry.workbookId, JSON.stringify(entry.details ?? {}), ...conditionParams)
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type LinkStatus = 'active' | 'expired' | 'revoked'

export interface ServiceRow {
  id: string
  account_id: string
  encrypted_tokens: string
  expires_at: string | null
  status: LinkStatus
  bc_person_id: number | null
  created_by: string
  created_at: string
  updated_at: string | null
  updated_by: string | null
}

export async function getServiceRow(db: D1Database, accountId: number): Promise<ServiceRow | null> {
  return db
    .prepare(
      `SELECT id, account_id, encrypted_tokens, expires_at, status, bc_person_id, created_by, created_at, updated_at, updated_by
       FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`,
    )
    .bind(String(accountId))
    .first<ServiceRow>()
}

// ---------------------------------------------------------------------------
// Using a token
// ---------------------------------------------------------------------------

/** One stored token, with compare-and-set writes keyed on the ciphertext that was read. */
interface Holder {
  aad: string
  encrypted: string
  expiresAt: string | null
  /** Failure thrown when this holder can no longer give a token. */
  gone: LinkErrorKey
  /** Replace the tokens if the row still holds `encrypted`. True when written. */
  save(next: string, expiresAt: string | null, at: string): Promise<boolean>
  /** Mark expired and discard the tokens if the row still holds `encrypted`. True when written. */
  expire(at: string, reason: string): Promise<boolean>
  /** Read the row again; throws the right failure when it is no longer active. */
  reload(): Promise<Holder>
}

/**
 * Runs `fn` with the sync account's token. Refreshes first when it is about to
 * expire; on a 401 from Basecamp refreshes once and retries once. Throws
 * `LinkFailure('service_not_linked')` when there is none (or it expired).
 */
export async function withServiceToken<T>(ctx: LinkContext, fn: (token: string) => Promise<T>): Promise<T> {
  return withHolder(ctx, await serviceHolder(ctx), fn)
}

async function withHolder<T>(ctx: LinkContext, holder: Holder, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await accessToken(ctx, holder, false, false)
  try {
    return await fn(token)
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error
  }
  // 401: Basecamp no longer accepts the access token although our clock says
  // it is valid. One forced refresh, one retry; a second 401 expires the link.
  const fresh = await holder.reload()
  const retryToken = await accessToken(ctx, fresh, true, false)
  try {
    return await fn(retryToken)
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error
    const current = await holder.reload()
    await current.expire(isoAt(ctx.now()), 'unauthorized')
    throw new LinkFailure(holder.gone)
  }
}

async function accessToken(ctx: LinkContext, holder: Holder, force: boolean, retried: boolean): Promise<string> {
  const tokens = await open(ctx, holder)
  const expiresAt = holder.expiresAt === null ? Number.NaN : Date.parse(holder.expiresAt)
  const due = force || (!Number.isNaN(expiresAt) && expiresAt - ctx.now() <= REFRESH_MARGIN_MS)
  if (!due) return tokens.access_token

  const at = isoAt(ctx.now())
  if (tokens.refresh_token === null) return expireOrReload(ctx, holder, at, 'no_refresh_token', retried)

  let next: TokenSet
  try {
    next = await refreshTokens(ctx, ctx.config, tokens.refresh_token)
  } catch (error) {
    if (!(error instanceof LaunchpadError)) throw error
    // Kind, status and OAuth code only — never a body or a token.
    console.warn(`basecamp-link: token refresh failed (${error.kind}, ${error.status ?? 'no response'}${error.oauthError ? `, ${error.oauthError}` : ''})`)
    if (error.kind === 'client_rejected') throw new LinkFailure('not_configured')
    if (error.kind === 'unavailable') throw new LinkFailure('basecamp_unavailable')
    return expireOrReload(ctx, holder, at, 'refresh_refused', retried)
  }

  const stored: StoredTokens = { access_token: next.accessToken, refresh_token: next.refreshToken ?? tokens.refresh_token }
  const sealed = await encryptJson(ctx.config.encryptionKey, stored, holder.aad)
  if (await holder.save(sealed, next.expiresAt === null ? null : isoAt(next.expiresAt), at)) return next.accessToken

  // The row changed under us (another request refreshed, or the user revoked
  // or relinked): use what is there now.
  if (retried) throw new LinkFailure('basecamp_unavailable')
  return accessToken(ctx, await holder.reload(), false, true)
}

async function expireOrReload(ctx: LinkContext, holder: Holder, at: string, reason: string, retried: boolean): Promise<string> {
  if (await holder.expire(at, reason)) throw new LinkFailure(holder.gone)
  // Not written: someone else changed the row first (e.g. a concurrent refresh
  // succeeded). Use the current row once; `reload` throws if it is not active.
  if (retried) throw new LinkFailure(holder.gone)
  return accessToken(ctx, await holder.reload(), false, true)
}

async function open(ctx: LinkContext, holder: Holder): Promise<StoredTokens> {
  if (holder.encrypted === NO_TOKEN) throw new LinkFailure(holder.gone)
  try {
    return await decryptJson<StoredTokens>(ctx.config.encryptionKey, holder.encrypted, holder.aad)
  } catch {
    // OPEN: a wrong or rotated TOKEN_ENCRYPTION_KEY. Reported, not "repaired"
    // by expiring links (apps/api/OPEN_QUESTIONS.md "Basecamp link" B17).
    console.error('basecamp-link: a stored token could not be decrypted')
    throw new Error('stored Basecamp token could not be decrypted')
  }
}

async function serviceHolder(ctx: LinkContext): Promise<Holder> {
  const row = await getServiceRow(ctx.db, ctx.config.accountId)
  if (!row || row.status !== 'active' || row.encrypted_tokens === NO_TOKEN) throw new LinkFailure('service_not_linked')
  const db = ctx.db
  return {
    aad: serviceAad(row.id),
    encrypted: row.encrypted_tokens,
    expiresAt: row.expires_at,
    gone: 'service_not_linked',
    async save(next, expiresAt, at) {
      const result = await db
        .prepare(
          `UPDATE integrations SET encrypted_tokens = ?1, expires_at = ?2, updated_at = ?3
           WHERE id = ?4 AND status = 'active' AND encrypted_tokens = ?5`,
        )
        .bind(next, expiresAt, at, row.id, row.encrypted_tokens)
        .run()
      return result.meta.changes === 1
    },
    async expire(at, reason) {
      const [update] = await db.batch([
        db
          .prepare(
            `UPDATE integrations SET status = 'expired', encrypted_tokens = ?1, updated_at = ?2
             WHERE id = ?3 AND status = 'active' AND encrypted_tokens = ?4`,
          )
          .bind(NO_TOKEN, at, row.id, row.encrypted_tokens),
        auditIf(
          db,
          {
            actorId: null,
            action: 'basecamp.service.expire',
            entityType: 'integration',
            entityId: row.id,
            workbookId: null,
            details: { provider: 'basecamp', accountId: row.account_id, bcPersonId: row.bc_person_id, reason },
          },
          at,
          `SELECT 1 FROM integrations WHERE id = ?8 AND status = 'expired' AND updated_at = ?9`,
          [row.id, at],
        ),
      ])
      return update?.meta.changes === 1
    },
    reload: () => serviceHolder(ctx),
  }
}

// ---------------------------------------------------------------------------
// Linking, connecting, revoking
// ---------------------------------------------------------------------------

export interface LinkedPerson {
  bcPersonId: number
  name: string
}

/** Stores (or replaces) the sync account's token and name, audited in the same batch. Admins only (checked by the caller). */
export async function saveServiceToken(ctx: LinkContext, adminId: string, person: LinkedPerson, tokens: TokenSet, at: string): Promise<void> {
  const db = ctx.db
  const accountId = ctx.config.accountId
  const existing = await getServiceRow(db, accountId)
  const id = existing?.id ?? crypto.randomUUID()
  const stored: StoredTokens = { access_token: tokens.accessToken, refresh_token: tokens.refreshToken }
  const sealed = await encryptJson(ctx.config.encryptionKey, stored, serviceAad(id))
  const expiresAt = tokens.expiresAt === null ? null : isoAt(tokens.expiresAt)

  const write = existing
    ? db
        .prepare(
          `UPDATE integrations SET encrypted_tokens = ?1, expires_at = ?2, status = 'active', bc_person_id = ?3, updated_at = ?4, updated_by = ?5
           WHERE id = ?6`,
        )
        .bind(sealed, expiresAt, person.bcPersonId, at, adminId, id)
    : db
        .prepare(
          `INSERT INTO integrations (id, provider, account_id, encrypted_tokens, expires_at, created_by, created_at, status, bc_person_id, updated_at, updated_by)
           VALUES (?1, 'basecamp', ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?6, ?5)`,
        )
        .bind(id, String(accountId), sealed, expiresAt, adminId, at, person.bcPersonId)

  await db.batch([
    write,
    // Its name, for Settings («مربوط: …»).
    db
      .prepare(
        `INSERT INTO bc_account_people_cache (bc_person_id, name, refreshed_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (bc_person_id) DO UPDATE SET name = excluded.name, refreshed_at = excluded.refreshed_at`,
      )
      .bind(person.bcPersonId, person.name, at),
    auditStatement(
      db,
      {
        actorId: adminId,
        action: 'basecamp.service.connect',
        entityType: 'integration',
        entityId: id,
        workbookId: null,
        details: {
          provider: 'basecamp',
          accountId,
          bcPersonId: person.bcPersonId,
          replaced: existing ? { status: existing.status, bcPersonId: existing.bc_person_id } : null,
        },
      },
      at,
    ),
  ])
}
