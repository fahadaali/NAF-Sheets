// Platform members «أعضاء المنصة» (spec §3, §14; contract packages/shared/src/api-members.ts).
//
//   GET /api/admin/members            PlatformMembersResponse         (admin)
//   PUT /api/admin/members/:userId    UpdatePlatformMemberResponse    (admin; audited)
//
// naf-auth creates every member as `viewer` at their first sign-in and never
// touches the role or the active state again; this is where an admin changes
// them. naf-auth's middleware reads `members.role` and `members.is_active` on
// every request (naf-auth getMember, no cache), so a change applies from the
// person's next request: a suspended member is refused (403 access_denied),
// and every workbook role stays capped by the new platform role (access.ts).
// Their open realtime connections are closed so they reconnect under the new
// access (WorkbookRoom.disconnectUser).
//
// After a change naf-id is told (naf-auth reportAccessChange): the role on a
// role change, `revoked` / `granted` on suspend / reactivate. Best effort: the
// local change stands when the report fails, and the response says so.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { reportAccessChange } from 'naf-auth'
import type { PlatformMember, PlatformMembersResponse, PlatformRole, UpdatePlatformMemberResponse, NafIdReport } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { authConfig } from '../auth'
import { storedMatches } from '../basecamp-link/people'
import type { StoredMatch } from '../basecamp-link/people'
import { auditIf } from '../basecamp-link/store'
import type { Env } from '../env'
import { ApiFailure } from '../errors'
import { callerOf, isPlainObject, nowIso, readJson } from '../request'

/** One report to naf-id; throws when it was not delivered. */
export type AccessReporter = (env: Env, change: { email: string; role?: PlatformRole; state?: 'granted' | 'revoked'; reason?: string }) => Promise<void>

/** Default: naf-auth's `reportAccessChange` (POST {AUTH_ISSUER}/api/internal/access). */
export const nafIdReporter: AccessReporter = async (env, change) => {
  await reportAccessChange(env, authConfig(env), change)
}

export interface PlatformMemberRouteOptions {
  report?: AccessReporter
}

/** Shown in naf-id next to a suspension (naf-auth README «التبليغ العكسي»). */
export const REVOKE_REASON = 'أُوقف من إعدادات المنصة'

interface MemberRow {
  user_id: string
  display_name: string | null
  email: string | null
  role: string
  is_active: number
  last_seen_at: number | null
  created_at: number | null
}

const MEMBER_COLUMNS = 'user_id, display_name, email, role, is_active, last_seen_at, created_at'
const ROLES: ReadonlySet<string> = new Set(['admin', 'editor', 'viewer'])
const NO_MATCH: StoredMatch = { state: 'none', bcPersonId: null, personName: null }

/** naf-auth writes epoch seconds (MEMBERS_TIME_FORMAT `epoch`, migrations/0001). */
function isoFromEpoch(seconds: number | null): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString()
}

function roleOf(role: string): PlatformRole {
  return role === 'admin' || role === 'editor' ? role : 'viewer'
}

function toMember(row: MemberRow, match: StoredMatch | undefined): PlatformMember {
  return {
    userId: row.user_id,
    name: row.display_name,
    email: row.email,
    role: roleOf(row.role),
    active: Number(row.is_active) === 1,
    lastSeenAt: isoFromEpoch(row.last_seen_at),
    createdAt: isoFromEpoch(row.created_at),
    basecamp: { ...(match ?? NO_MATCH) },
  }
}

function requireAdmin(c: Context<AppEnv>): string {
  const caller = callerOf(c)
  if (caller.role !== 'admin') throw new ApiFailure(403, 'admin_only')
  return caller.id
}

async function readMember(db: D1Database, userId: string): Promise<MemberRow | null> {
  return db.prepare(`SELECT ${MEMBER_COLUMNS} FROM members WHERE user_id = ?1`).bind(userId).first<MemberRow>()
}

function parseChange(body: unknown): { role?: PlatformRole; active?: boolean } {
  if (!isPlainObject(body)) throw new ApiFailure(400, 'invalid_member_change')
  const keys = Object.keys(body)
  if (keys.length === 0 || keys.some((k) => k !== 'role' && k !== 'active')) throw new ApiFailure(400, 'invalid_member_change')
  const change: { role?: PlatformRole; active?: boolean } = {}
  if ('role' in body) {
    const role = body['role']
    if (typeof role !== 'string' || !ROLES.has(role)) throw new ApiFailure(400, 'invalid_member_change')
    change.role = role as PlatformRole
  }
  if ('active' in body) {
    if (typeof body['active'] !== 'boolean') throw new ApiFailure(400, 'invalid_member_change')
    change.active = body['active']
  }
  return change
}

export function platformMemberRoutes(options: PlatformMemberRouteOptions = {}): Hono<AppEnv> {
  const report = options.report ?? nafIdReporter
  const routes = new Hono<AppEnv>()

  routes.get('/', async (c) => {
    requireAdmin(c)
    const db = c.env.DB
    const [{ results }, matches] = await Promise.all([
      db.prepare(`SELECT ${MEMBER_COLUMNS} FROM members ORDER BY is_active DESC, display_name, user_id`).all<MemberRow>(),
      storedMatches(db),
    ])
    return c.json<PlatformMembersResponse>({ members: results.map((row) => toMember(row, matches.get(row.user_id))) })
  })

  routes.put('/:userId', async (c) => {
    const adminId = requireAdmin(c)
    const userId = c.req.param('userId')
    const change = parseChange(await readJson(c))
    const db = c.env.DB

    if (!userId || userId.length > 255) throw new ApiFailure(404, 'platform_member_not_found')
    const current = await readMember(db, userId)
    if (!current) throw new ApiFailure(404, 'platform_member_not_found')

    const fromRole = roleOf(current.role)
    const fromActive = Number(current.is_active) === 1
    const toRole = change.role ?? fromRole
    const toActive = change.active ?? fromActive
    const roleChanged = toRole !== fromRole
    const activeChanged = toActive !== fromActive

    if (!roleChanged && !activeChanged) {
      const matches = await storedMatches(db)
      return c.json<UpdatePlatformMemberResponse>({ member: toMember(current, matches.get(userId)), changed: false, nafIdReport: 'not_needed' })
    }

    // An admin cannot demote or suspend themselves (the only changes left to
    // an admin on their own row): one slip would lock them out.
    if (userId === adminId) throw new ApiFailure(409, 'cannot_change_self')

    // The last active admin is never demoted or suspended. Checked here for
    // the message, and again inside the UPDATE so two admins demoting each
    // other at the same moment cannot both succeed.
    const removesAdmin = fromRole === 'admin' && fromActive && (toRole !== 'admin' || !toActive)
    if (removesAdmin) {
      const others = await db
        .prepare(`SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND is_active = 1 AND user_id <> ?1`)
        .bind(userId)
        .first<{ n: number }>()
      if (!others || others.n === 0) throw new ApiFailure(409, 'last_active_admin')
    }

    const at = nowIso()
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE members SET role = ?2, is_active = ?3
           WHERE user_id = ?1 AND role = ?4 AND is_active = ?5
             AND (?6 = 0 OR EXISTS (SELECT 1 FROM members o WHERE o.role = 'admin' AND o.is_active = 1 AND o.user_id <> ?1))`,
        )
        .bind(userId, toRole, toActive ? 1 : 0, current.role, current.is_active, removesAdmin ? 1 : 0),
      // Written only when this request's UPDATE changed the row (spec §14:
      // every permission change is in the append-only audit log).
      auditIf(
        db,
        {
          actorId: adminId,
          action: 'member.access.update',
          entityType: 'member',
          entityId: userId,
          workbookId: null,
          details: { from: { role: fromRole, active: fromActive }, to: { role: toRole, active: toActive } },
        },
        at,
        `SELECT 1 WHERE changes() = 1`,
        [],
      ),
    ])

    if ((updated?.meta.changes ?? 0) !== 1) {
      // Someone else changed the row, or the last other admin went meanwhile.
      if (removesAdmin) {
        const others = await db
          .prepare(`SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND is_active = 1 AND user_id <> ?1`)
          .bind(userId)
          .first<{ n: number }>()
        if (!others || others.n === 0) throw new ApiFailure(409, 'last_active_admin')
      }
      throw new ApiFailure(409, 'member_changed')
    }

    const after = (await readMember(db, userId)) ?? { ...current, role: toRole, is_active: toActive ? 1 : 0 }
    await disconnectEverywhere(c, userId, fromRole === 'admin')

    // naf-id matches its access table by email (naf-auth README).
    let nafIdReport: NafIdReport = 'skipped'
    const email = typeof after.email === 'string' ? after.email.trim() : ''
    if (email) {
      const message: Parameters<AccessReporter>[1] = { email }
      if (roleChanged) message.role = toRole
      if (activeChanged) message.state = toActive ? 'granted' : 'revoked'
      if (activeChanged && !toActive) message.reason = REVOKE_REASON
      try {
        await report(c.env, message)
        nafIdReport = 'sent'
      } catch (error) {
        // The code only: never the secret, the body or the email.
        const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.name : 'unknown'
        console.warn(`members: naf-id access report failed (${code})`)
        nafIdReport = 'failed'
      }
    }

    const matches = await storedMatches(db)
    return c.json<UpdatePlatformMemberResponse>({ member: toMember(after, matches.get(userId)), changed: true, nafIdReport })
  })

  return routes
}

/**
 * Closes the member's realtime connections in every room they could be in:
 * their own and shared workbooks, or every live workbook if they were an
 * admin. Best effort, after the response when the runtime allows it.
 */
async function disconnectEverywhere(c: Context<AppEnv>, userId: string, wasAdmin: boolean): Promise<void> {
  const env = c.env
  if (!env.WORKBOOK_ROOM) return
  const work = (async () => {
    const sql = wasAdmin
      ? `SELECT id FROM workbooks WHERE archived_at IS NULL`
      : `SELECT id FROM workbooks w WHERE w.archived_at IS NULL
           AND (w.owner_id = ?1 OR EXISTS (SELECT 1 FROM workbook_members wm WHERE wm.workbook_id = w.id AND wm.user_id = ?1))`
    const statement = wasAdmin ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(userId)
    const { results } = await statement.all<{ id: string }>()
    await Promise.all(
      results.map((row) =>
        env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(row.id))
          .disconnectUser(userId)
          .catch(() => 0),
      ),
    )
  })().catch((error: unknown) => console.warn(`members: closing realtime connections failed (${error instanceof Error ? error.name : 'unknown'})`))
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null
  try {
    ctx = c.executionCtx
  } catch {
    // No execution context (tests): wait for it here instead.
  }
  if (ctx) ctx.waitUntil(work)
  else await work
}
