// Basecamp people: the project cache for the assignee drop-down (spec §9.5),
// the account cache, and matching naf-id members to Basecamp people (§3).
//
//   bc_people_cache         ← GET /projects/{id}/people.json with the CALLER's token
//   bc_account_people_cache ← GET /people.json with the SERVICE token — emails
//                             are shown in full only to account admins and
//                             owners (Appendix A-7, people.md), so matching by
//                             email needs the service (admin) account.
//
// A cache is refreshed when its newest row is older than 10 minutes (§9.5).
// People who disappear from Basecamp are marked `removed_at`, never deleted:
// a removed person may still be assigned to tasks (§9.5).

import type { RawPerson } from '@naf-sheets/basecamp'
import { BasecampError, NotFoundError, ForbiddenError } from '@naf-sheets/basecamp'
import type { BasecampPeopleResponse, BcPerson, PeopleMatchesResponse } from '@naf-sheets/shared'
import type { Caller } from '../access'
import { auditStatement } from '../audit'
import type { LinkContext } from './env'
import { LinkFailure } from './errors'
import { activeUserLink, auditIf, basecampClient, isoAt, withServiceToken, withUserToken } from './store'

export const PEOPLE_CACHE_TTL_MS = 10 * 60_000

/**
 * The email as Basecamp gave it, or null when it is absent or redacted.
 * people.md: for everyone but admins, owners and the person, the address is
 * redacted to something like "j••••@•••••••••.•••" — never a usable value.
 */
export function usableEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim()
  if (email.includes('•')) return null
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}

/** Case-insensitive comparison key. */
function emailKey(email: string): string {
  return email.trim().toLowerCase()
}

interface PersonJson {
  id: number
  name: string
  email: string | null
  avatarUrl: string | null
  personableType: string | null
  client: 0 | 1
}

function toPersonJson(raw: RawPerson): PersonJson | null {
  if (typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    email: usableEmail(raw.email_address),
    avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : null,
    // An open set: stored as given, never rejected.
    personableType: typeof raw.personable_type === 'string' ? raw.personable_type : null,
    client: raw.client === true ? 1 : 0,
  }
}

interface CachedPersonRow {
  bc_person_id: number
  name: string
  email: string | null
  avatar_url: string | null
  personable_type: string | null
  client: number
}

function toBcPerson(row: CachedPersonRow, showEmail: boolean): BcPerson {
  return {
    id: row.bc_person_id,
    name: row.name,
    email: showEmail ? row.email : null,
    avatarUrl: row.avatar_url,
    // OPEN: the contract types it as string; a person without the field is reported as '' (OPEN_QUESTIONS.md "Basecamp link" B18).
    personableType: row.personable_type ?? '',
    client: row.client === 1,
  }
}

function isStale(refreshedAt: string | null, now: number): boolean {
  if (refreshedAt === null) return true
  const at = Date.parse(refreshedAt)
  return Number.isNaN(at) || now - at > PEOPLE_CACHE_TTL_MS
}

// An email fetched by an admin is kept when a later refresh by a non-admin
// sees it redacted (COALESCE): the cache never loses a known address.
const UPSERT_COLUMNS = `name = excluded.name,
       email = COALESCE(excluded.email, email),
       avatar_url = excluded.avatar_url,
       personable_type = excluded.personable_type,
       client = excluded.client,
       refreshed_at = excluded.refreshed_at,
       removed_at = NULL`

// ---------------------------------------------------------------------------
// Project people (§9.5) — the caller's own token
// ---------------------------------------------------------------------------

/**
 * People on a Basecamp project, from `bc_people_cache`.
 *
 * The cache is served only to a caller who is in it: otherwise (or when it is
 * older than 10 minutes) it is refreshed with the caller's own token, so a
 * member never learns who is on a project their Basecamp account cannot see.
 * Emails are returned to platform admins only.
 * OPEN: whether editors may see project members' emails
 * (apps/api/OPEN_QUESTIONS.md "Basecamp link" B13, B14).
 */
export async function projectPeople(ctx: LinkContext, caller: Caller, projectId: number): Promise<BasecampPeopleResponse> {
  const link = await activeUserLink(ctx, caller.id)
  const meta = await ctx.db
    .prepare(
      `SELECT MAX(refreshed_at) AS refreshed_at,
              COALESCE(SUM(CASE WHEN bc_person_id = ?2 AND removed_at IS NULL THEN 1 ELSE 0 END), 0) AS caller_present
       FROM bc_people_cache WHERE bc_project_id = ?1`,
    )
    .bind(projectId, link.bc_person_id)
    .first<{ refreshed_at: string | null; caller_present: number }>()

  if (isStale(meta?.refreshed_at ?? null, ctx.now()) || !meta || meta.caller_present === 0) {
    const client = basecampClient(ctx)
    const raw = await withUserToken(ctx, caller.id, async (token) => {
      try {
        return await client.people.listProject(token, projectId).all()
      } catch (error) {
        throw projectError(error)
      }
    })
    await storeProjectPeople(ctx.db, projectId, raw, isoAt(ctx.now()))
  }

  const { results } = await ctx.db
    .prepare(
      `SELECT bc_person_id, name, email, avatar_url, personable_type, client
       FROM bc_people_cache WHERE bc_project_id = ?1 AND removed_at IS NULL
       ORDER BY name, bc_person_id`,
    )
    .bind(projectId)
    .all<CachedPersonRow>()
  const refreshed = await ctx.db
    .prepare(`SELECT MAX(refreshed_at) AS refreshed_at FROM bc_people_cache WHERE bc_project_id = ?1`)
    .bind(projectId)
    .first<{ refreshed_at: string | null }>()

  const showEmail = caller.role === 'admin'
  return { people: results.map((row) => toBcPerson(row, showEmail)), refreshedAt: refreshed?.refreshed_at ?? isoAt(ctx.now()) }
}

/** Upsert the project's people and mark the ones no longer listed as removed — one transaction. */
export async function storeProjectPeople(db: D1Database, projectId: number, people: RawPerson[], at: string): Promise<void> {
  const rows = people.map(toPersonJson).filter((p): p is PersonJson => p !== null)
  const json = JSON.stringify(rows)
  await db.batch([
    db
      .prepare(
        `INSERT INTO bc_people_cache (bc_project_id, bc_person_id, name, email, avatar_url, personable_type, client, refreshed_at, removed_at)
         SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.email'),
                json_extract(value, '$.avatarUrl'), json_extract(value, '$.personableType'), json_extract(value, '$.client'), ?2, NULL
         FROM json_each(?3) WHERE true
         ON CONFLICT (bc_project_id, bc_person_id) DO UPDATE SET ${UPSERT_COLUMNS}`,
      )
      .bind(projectId, at, json),
    db
      .prepare(
        `UPDATE bc_people_cache SET removed_at = COALESCE(removed_at, ?2), refreshed_at = ?2
         WHERE bc_project_id = ?1 AND bc_person_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`,
      )
      .bind(projectId, at, json),
  ])
}

/** A Basecamp failure on a project read, as the caller should read it. */
export function projectError(error: unknown): unknown {
  if (error instanceof NotFoundError || error instanceof ForbiddenError) return new LinkFailure('project_not_found')
  return basecampFailure(error)
}

/** Outages and unexpected answers from Basecamp; logged by code and status only. */
export function basecampFailure(error: unknown): unknown {
  if (error instanceof BasecampError && !(error.code === 'unauthorized')) {
    console.warn(`basecamp-link: Basecamp ${error.code} (${error.status ?? 'no response'})`)
    return new LinkFailure('basecamp_unavailable')
  }
  return error
}

// ---------------------------------------------------------------------------
// Account people and matching (§3) — the service token
// ---------------------------------------------------------------------------

/** Refresh `bc_account_people_cache` with the service token. Read-only in Basecamp. */
export async function refreshAccountPeople(ctx: LinkContext): Promise<void> {
  const client = basecampClient(ctx)
  const raw = await withServiceToken(ctx, async (token) => {
    try {
      return await client.people.listAll(token).all()
    } catch (error) {
      throw basecampFailure(error)
    }
  })
  const rows = raw.map(toPersonJson).filter((p): p is PersonJson => p !== null)
  const json = JSON.stringify(rows)
  const at = isoAt(ctx.now())
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO bc_account_people_cache (bc_person_id, name, email, avatar_url, personable_type, client, refreshed_at, removed_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.email'),
                json_extract(value, '$.avatarUrl'), json_extract(value, '$.personableType'), json_extract(value, '$.client'), ?1, NULL
         FROM json_each(?2) WHERE true
         ON CONFLICT (bc_person_id) DO UPDATE SET ${UPSERT_COLUMNS}`,
      )
      .bind(at, json),
    ctx.db
      .prepare(
        `UPDATE bc_account_people_cache SET removed_at = COALESCE(removed_at, ?1), refreshed_at = ?1
         WHERE bc_person_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`,
      )
      .bind(at, json),
  ])
}

/** Who can be matched to a member: account members (`User`, team or client), not removed. Appendix A-2. */
const MATCHABLE = `removed_at IS NULL AND personable_type = 'User'`

/**
 * Automatic matching by email (§3). A member is matched only when they have
 * no match row yet (an admin's manual decision always wins), their email is
 * unique among active members, exactly one matchable Basecamp person has it
 * (case-insensitive), and that person is not matched to anyone else.
 * Each match is audited in the same batch, as a system action.
 * OPEN: a stale automatic match (email changed, person removed) is kept until
 * an admin changes it (apps/api/OPEN_QUESTIONS.md "Basecamp link" B11).
 */
export async function matchByEmail(db: D1Database, at: string): Promise<number> {
  const [membersResult, peopleResult, takenResult] = await db.batch<{ user_id?: string; email?: string | null; matched?: number; bc_person_id?: number }>([
    db.prepare(
      `SELECT m.user_id, m.email, CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END AS matched
       FROM members m LEFT JOIN bc_person_matches pm ON pm.user_id = m.user_id
       WHERE m.is_active = 1 AND m.email IS NOT NULL`,
    ),
    db.prepare(`SELECT bc_person_id, email FROM bc_account_people_cache WHERE ${MATCHABLE} AND email IS NOT NULL`),
    db.prepare(`SELECT bc_person_id FROM bc_person_matches WHERE bc_person_id IS NOT NULL`),
  ])

  const members = (membersResult?.results ?? []) as Array<{ user_id: string; email: string; matched: number }>
  const people = (peopleResult?.results ?? []) as Array<{ bc_person_id: number; email: string }>
  const taken = new Set(((takenResult?.results ?? []) as Array<{ bc_person_id: number }>).map((r) => r.bc_person_id))

  const membersPerEmail = new Map<string, number>()
  for (const m of members) membersPerEmail.set(emailKey(m.email), (membersPerEmail.get(emailKey(m.email)) ?? 0) + 1)
  const peoplePerEmail = new Map<string, number[]>()
  for (const p of people) {
    const email = usableEmail(p.email)
    if (email === null) continue
    const key = emailKey(email)
    peoplePerEmail.set(key, [...(peoplePerEmail.get(key) ?? []), p.bc_person_id])
  }

  const statements: D1PreparedStatement[] = []
  for (const member of members) {
    if (member.matched === 1) continue
    const key = emailKey(member.email)
    if (membersPerEmail.get(key) !== 1) continue
    const candidates = peoplePerEmail.get(key) ?? []
    if (candidates.length !== 1) continue
    const bcPersonId = candidates[0] as number
    if (taken.has(bcPersonId)) continue
    taken.add(bcPersonId)
    statements.push(
      db
        .prepare(
          `INSERT INTO bc_person_matches (user_id, bc_person_id, source, matched_by, matched_at)
           VALUES (?1, ?2, 'email', NULL, ?3) ON CONFLICT DO NOTHING`,
        )
        .bind(member.user_id, bcPersonId, at),
      auditIf(
        db,
        {
          actorId: null,
          action: 'basecamp.people_match.auto',
          entityType: 'member',
          entityId: member.user_id,
          workbookId: null,
          details: { bcPersonId, source: 'email' },
        },
        at,
        `SELECT 1 FROM bc_person_matches WHERE user_id = ?8 AND bc_person_id = ?9 AND source = 'email' AND matched_at = ?10`,
        [member.user_id, bcPersonId, at],
      ),
    )
  }
  if (statements.length > 0) await db.batch(statements)
  return statements.length / 2
}

type MatchEntry = PeopleMatchesResponse['matches'][number]

interface MatchRow {
  user_id: string
  display_name: string | null
  email: string | null
  bc_person_id: number | null
  source: 'email' | 'manual' | null
}

function toMatchEntry(row: MatchRow): MatchEntry {
  return { userId: row.user_id, name: row.display_name, email: row.email, bcPersonId: row.bc_person_id, source: row.source }
}

/**
 * GET /api/admin/people-matches: refreshes the account cache when stale
 * (service token), runs the automatic email match, then lists every active
 * member with their match and every matchable Basecamp person.
 */
export async function peopleMatches(ctx: LinkContext): Promise<PeopleMatchesResponse> {
  const fresh = await ctx.db
    .prepare(`SELECT MAX(refreshed_at) AS refreshed_at FROM bc_account_people_cache`)
    .first<{ refreshed_at: string | null }>()
  if (isStale(fresh?.refreshed_at ?? null, ctx.now())) await refreshAccountPeople(ctx)
  await matchByEmail(ctx.db, isoAt(ctx.now()))

  const [matchesResult, peopleResult] = await ctx.db.batch([
    ctx.db.prepare(
      `SELECT m.user_id, m.display_name, m.email, pm.bc_person_id, pm.source
       FROM members m LEFT JOIN bc_person_matches pm ON pm.user_id = m.user_id
       WHERE m.is_active = 1
       ORDER BY m.display_name, m.user_id`,
    ),
    ctx.db.prepare(
      `SELECT bc_person_id, name, email, avatar_url, personable_type, client
       FROM bc_account_people_cache WHERE ${MATCHABLE}
       ORDER BY name, bc_person_id`,
    ),
  ])
  return {
    matches: ((matchesResult?.results ?? []) as unknown as MatchRow[]).map(toMatchEntry),
    // Admins only reach this; the emails came from the service (admin) token.
    people: ((peopleResult?.results ?? []) as unknown as CachedPersonRow[]).map((row) => toBcPerson(row, true)),
  }
}

/**
 * PUT /api/admin/people-matches/:userId — an admin's manual decision. `null`
 * records "no Basecamp person" so the automatic match never overrides it.
 * Audited in the same batch. Answers with the member's match entry.
 */
export async function setManualMatch(ctx: LinkContext, adminId: string, userId: string, bcPersonId: number | null): Promise<MatchEntry> {
  const db = ctx.db
  const member = await db
    .prepare(`SELECT user_id, display_name, email FROM members WHERE user_id = ?1`)
    .bind(userId)
    .first<{ user_id: string; display_name: string | null; email: string | null }>()
  if (!member) throw new LinkFailure('member_not_found')

  if (bcPersonId !== null) {
    const person = await db
      .prepare(`SELECT bc_person_id FROM bc_account_people_cache WHERE bc_person_id = ?1 AND ${MATCHABLE}`)
      .bind(bcPersonId)
      .first()
    if (!person) throw new LinkFailure('person_not_found')
    const other = await db
      .prepare(`SELECT user_id FROM bc_person_matches WHERE bc_person_id = ?1 AND user_id <> ?2`)
      .bind(bcPersonId, userId)
      .first()
    if (other) throw new LinkFailure('person_already_matched')
  }

  const current = await db
    .prepare(`SELECT bc_person_id, source FROM bc_person_matches WHERE user_id = ?1`)
    .bind(userId)
    .first<{ bc_person_id: number | null; source: 'email' | 'manual' }>()
  const entry: MatchEntry = { userId, name: member.display_name, email: member.email, bcPersonId, source: 'manual' }
  if (current && current.source === 'manual' && current.bc_person_id === bcPersonId) return entry

  const at = isoAt(ctx.now())
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO bc_person_matches (user_id, bc_person_id, source, matched_by, matched_at)
           VALUES (?1, ?2, 'manual', ?3, ?4)
           ON CONFLICT (user_id) DO UPDATE SET
             bc_person_id = excluded.bc_person_id, source = 'manual', matched_by = excluded.matched_by, matched_at = excluded.matched_at`,
        )
        .bind(userId, bcPersonId, adminId, at),
      auditStatement(
        db,
        {
          actorId: adminId,
          action: 'basecamp.people_match.set',
          entityType: 'member',
          entityId: userId,
          workbookId: null,
          details: {
            from: current ? { bcPersonId: current.bc_person_id, source: current.source } : null,
            to: { bcPersonId, source: 'manual' },
          },
        },
        at,
      ),
    ])
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new LinkFailure('person_already_matched')
    throw error
  }
  return entry
}
