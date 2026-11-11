// Phase 1 workbook routes — contract: packages/shared/src/api.ts.

import { Hono } from 'hono'
import type { Context } from 'hono'
import type {
  CreateWorkbookResponse,
  PutWorkbookMembersResponse,
  SaveSnapshotResponse,
  WorkbookListResponse,
  WorkbookMemberRole,
  WorkbookMembersResponse,
  WorkbookResponse,
} from '@naf-sheets/shared'
import { withDashboardSheet } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import type { Caller, WorkbookAccess } from '../access'
import { canCreateWorkbooks, canManageMembers, canWrite, resolveAccess } from '../access'
import { auditStatement } from '../audit'
import { existingMemberIds, getWorkbookRow, listSheets, listWorkbookMembers, listWorkbookRows, toSummary } from '../db'
import type { WorkbookSummaryRow } from '../db'
import { ApiFailure } from '../errors'
import { callerOf, isPlainObject, nowIso, readJson } from '../request'
import { roomRequest, roomSessionActive } from '../room'
import { FIRST_SHEET_TITLE, blankWorkbookSnapshot, readSnapshot, writeSnapshotVersion } from '../snapshot'
import { detectAfterSave, parseConfirmedDeletions } from '../sync/detect'
import { createWorkbookFromTemplate } from '../phase7/templates'

export interface WorkbookRouteOptions {
  /** See DEFAULT_SNAPSHOT_ORPHAN_AGE_MS. */
  snapshotOrphanAgeMs: number
}

// OPEN: the spec sets no title limit; 200 chosen (OPEN_QUESTIONS.md #10).
const MAX_TITLE_LENGTH = 200
const MAX_QUERY_LENGTH = 200
const MAX_ID_LENGTH = 128

interface LoadedWorkbook {
  caller: Caller
  row: WorkbookSummaryRow
  access: WorkbookAccess
}

/** The workbook and the caller's access to it; 404 when missing *or* not accessible. */
async function loadWorkbook(c: Context<AppEnv>): Promise<LoadedWorkbook> {
  const caller = callerOf(c)
  const id = c.req.param('id') ?? ''
  if (id === '' || id.length > MAX_ID_LENGTH) throw new ApiFailure(404, 'workbook_not_found')

  const row = await getWorkbookRow(c.env.DB, caller.id, id)
  if (!row) throw new ApiFailure(404, 'workbook_not_found')

  const access = resolveAccess(caller, row.owner_id, row.member_role)
  if (access === null) throw new ApiFailure(404, 'workbook_not_found')
  return { caller, row, access }
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string') throw new ApiFailure(400, 'invalid_title')
  const title = value.trim()
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) throw new ApiFailure(400, 'invalid_title')
  return title
}

const MEMBER_ROLES: ReadonlySet<string> = new Set<WorkbookMemberRole>(['editor', 'viewer'])

function parseMembers(body: unknown): Array<{ userId: string; role: WorkbookMemberRole }> {
  if (!isPlainObject(body) || !Array.isArray(body.members)) throw new ApiFailure(400, 'invalid_members')
  const seen = new Set<string>()
  return body.members.map((entry: unknown) => {
    if (!isPlainObject(entry)) throw new ApiFailure(400, 'invalid_members')
    const { userId, role } = entry
    if (typeof userId !== 'string' || userId === '' || userId.length > MAX_ID_LENGTH) throw new ApiFailure(400, 'invalid_members')
    if (typeof role !== 'string' || !MEMBER_ROLES.has(role)) throw new ApiFailure(400, 'invalid_members')
    if (seen.has(userId)) throw new ApiFailure(400, 'invalid_members')
    seen.add(userId)
    return { userId, role: role as WorkbookMemberRole }
  })
}

export function workbookRoutes(options: WorkbookRouteOptions): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  // GET /api/workbooks?q=
  // OPEN: plain substring match, no Arabic letter normalisation (OPEN_QUESTIONS.md #11).
  routes.get('/', async (c) => {
    const caller = callerOf(c)
    const raw = (c.req.query('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH)
    const rows = await listWorkbookRows(c.env.DB, caller.id, { all: caller.role === 'admin', q: raw === '' ? null : raw })

    const workbooks = rows.flatMap((row) => {
      const access = resolveAccess(caller, row.owner_id, row.member_role)
      return access === null ? [] : [toSummary(row, access)]
    })
    return c.json<WorkbookListResponse>({ workbooks })
  })

  // POST /api/workbooks — blank (§7.1 option 1) or from a template (option 2).
  routes.post('/', async (c) => {
    const caller = callerOf(c)
    if (!canCreateWorkbooks(caller)) throw new ApiFailure(403, 'forbidden_create')

    const body = await readJson(c)
    if (!isPlainObject(body)) throw new ApiFailure(400, 'invalid_title')
    const title = parseTitle(body.title)
    // §7.1 option 2 (phase 7): a copy of a template's snapshot.
    if (body.source === 'template') {
      const id = await createWorkbookFromTemplate(c.env, caller, { title, templateId: body.templateId })
      return c.json<CreateWorkbookResponse>({ id }, 201)
    }
    if (body.source !== 'blank') throw new ApiFailure(400, 'unsupported_source')

    const now = nowIso()
    const workbookId = crypto.randomUUID()
    const sheetId = crypto.randomUUID()
    const univerSheetId = crypto.randomUUID()
    const version = 1

    // R2 first: the D1 row must never point at a snapshot that does not exist.
    // The id is fresh, so an existing object is never replaced here.
    const snapshot = blankWorkbookSnapshot({ workbookId, title, univerSheetId })
    const written = await writeSnapshotVersion(
      c.env,
      { workbookId, version, savedBy: caller.id },
      JSON.stringify(snapshot),
      { orphanAgeMs: options.snapshotOrphanAgeMs, stillUncommitted: async () => false },
    )
    if (!written) throw new Error(`snapshot key already taken for new workbook ${workbookId}`)

    const db = c.env.DB
    await db.batch([
      db
        .prepare(
          `INSERT INTO workbooks (id, title, owner_id, bc_project_id, source, source_ref, current_snapshot_version, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, 'blank', NULL, ?4, ?5, ?5)`,
        )
        .bind(workbookId, title, caller.id, version, now),
      db
        .prepare(
          `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row, created_at)
           VALUES (?1, ?2, ?3, ?4, 1, 'local', NULL, 1, ?5)`,
        )
        .bind(sheetId, workbookId, univerSheetId, FIRST_SHEET_TITLE, now),
      // Creating a workbook grants its owner every right on it (§14: permission changes).
      auditStatement(
        db,
        { actorId: caller.id, action: 'workbook.create', entityType: 'workbook', entityId: workbookId, workbookId, details: { title, source: 'blank', ownerId: caller.id } },
        now,
      ),
    ])

    return c.json<CreateWorkbookResponse>({ id: workbookId }, 201)
  })

  // GET /api/workbooks/:id — metadata + latest snapshot.
  routes.get('/:id', async (c) => {
    const { row, access } = await loadWorkbook(c)
    const version = row.current_snapshot_version
    const [sheets, snapshot] = await Promise.all([listSheets(c.env.DB, row.id), readSnapshot(c.env, row.id, version)])
    if (snapshot === null) {
      console.error(`snapshot missing: workbook ${row.id} version ${version}`)
      throw new ApiFailure(500, 'snapshot_missing')
    }

    return c.json<WorkbookResponse>({
      workbook: { ...toSummary(row, access), ownerId: row.owner_id, source: row.source, createdAt: row.created_at },
      sheets,
      // The dashboard tab «اللوحة» is added to a workbook that predates it,
      // exactly as the room adds it when it loads (room.ts `load`).
      snapshot: isPlainObject(snapshot) ? withDashboardSheet(snapshot) : snapshot,
      version,
    })
  })

  // PUT /api/workbooks/:id/snapshot — optimistic concurrency on baseVersion.
  routes.put('/:id/snapshot', async (c) => {
    const { caller, row, access } = await loadWorkbook(c)
    if (!canWrite(access)) throw new ApiFailure(403, 'forbidden_write')

    const body = await readJson(c)
    if (!isPlainObject(body)) throw new ApiFailure(400, 'invalid_snapshot')
    // OPEN: no size cap beyond the Workers request limit (OPEN_QUESTIONS.md #12).
    const { baseVersion, snapshot } = body
    if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 1) {
      throw new ApiFailure(400, 'invalid_base_version')
    }
    if (!isPlainObject(snapshot)) throw new ApiFailure(400, 'invalid_snapshot')
    // Spec §9.2.7: only rows listed here may be deleted in Basecamp. A malformed
    // list is refused before anything is written, so it can never delete.
    const confirmedDeletions = parseConfirmedDeletions(body.confirmedDeletions)
    if (confirmedDeletions === null) throw new ApiFailure(400, 'invalid_snapshot')

    // Nothing is written on a stale base.
    if (baseVersion !== row.current_snapshot_version) throw new ApiFailure(409, 'version_conflict')
    // While editors are connected, the room is the only writer (apps/api/OPEN_QUESTIONS.md R7).
    if (await roomSessionActive(c.env, row.id)) throw new ApiFailure(409, 'room_active')

    const db = c.env.DB
    const next = baseVersion + 1
    const currentVersion = async (): Promise<number | null> =>
      (await db.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1').bind(row.id).first<{ v: number }>())?.v ?? null

    const written = await writeSnapshotVersion(c.env, { workbookId: row.id, version: next, savedBy: caller.id }, JSON.stringify(snapshot), {
      orphanAgeMs: options.snapshotOrphanAgeMs,
      stillUncommitted: async () => (await currentVersion()) === baseVersion,
    })
    if (!written) throw new ApiFailure(409, 'version_conflict')

    const result = await db
      .prepare(
        `UPDATE workbooks SET current_snapshot_version = ?1, updated_at = ?2
         WHERE id = ?3 AND current_snapshot_version = ?4 AND archived_at IS NULL`,
      )
      .bind(next, nowIso(), row.id, baseVersion)
      .run()
    if (result.meta.changes !== 1) throw new ApiFailure(409, 'version_conflict')

    // Outbound sync (§9.2): changed task rows go to Basecamp. Never fails the save.
    await detectAfterSave(c.env, { workbookId: row.id, actorUserId: caller.id, snapshot, version: next, confirmedDeletions })

    return c.json<SaveSnapshotResponse>({ version: next })
  })

  // GET /api/workbooks/:id/members — owner or admin only.
  routes.get('/:id/members', async (c) => {
    const { row, access } = await loadWorkbook(c)
    if (!canManageMembers(access)) throw new ApiFailure(403, 'forbidden_members')
    const members = await listWorkbookMembers(c.env.DB, row.id)
    return c.json<WorkbookMembersResponse>({ ownerId: row.owner_id, members })
  })

  // PUT /api/workbooks/:id/members — replaces the list; owner or admin only; audited.
  // Answers `PutWorkbookMembersResponse`, the list after the change, like GET.
  // OPEN: an 'editor' seat for a platform viewer is stored but capped to read-only
  // by resolveAccess, and inactive members may be listed (OPEN_QUESTIONS.md #9).
  routes.put('/:id/members', async (c) => {
    const { caller, row, access } = await loadWorkbook(c)
    if (!canManageMembers(access)) throw new ApiFailure(403, 'forbidden_members')

    const desired = parseMembers(await readJson(c))
    if (desired.some((m) => m.userId === row.owner_id)) throw new ApiFailure(400, 'owner_in_members')

    const db = c.env.DB
    const known = await existingMemberIds(
      db,
      desired.map((m) => m.userId),
    )
    if (desired.some((m) => !known.has(m.userId))) throw new ApiFailure(400, 'unknown_user')

    const { results: currentRows } = await db
      .prepare('SELECT user_id, role FROM workbook_members WHERE workbook_id = ?1')
      .bind(row.id)
      .all<{ user_id: string; role: WorkbookMemberRole }>()
    const current = new Map(currentRows.map((r) => [r.user_id, r.role]))
    const wanted = new Map(desired.map((m) => [m.userId, m.role]))

    const added = desired.filter((m) => !current.has(m.userId))
    const changed = desired.filter((m) => current.has(m.userId) && current.get(m.userId) !== m.role).map((m) => ({ userId: m.userId, from: current.get(m.userId), to: m.role }))
    const removed = currentRows.filter((r) => !wanted.has(r.user_id)).map((r) => ({ userId: r.user_id, role: r.role }))

    if (added.length + changed.length + removed.length > 0) {
      const now = nowIso()
      const statements: D1PreparedStatement[] = []
      for (const r of removed) {
        statements.push(db.prepare('DELETE FROM workbook_members WHERE workbook_id = ?1 AND user_id = ?2').bind(row.id, r.userId))
      }
      for (const m of [...added, ...changed.map((x) => ({ userId: x.userId, role: x.to }))]) {
        statements.push(
          db
            .prepare(
              `INSERT INTO workbook_members (workbook_id, user_id, role, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT (workbook_id, user_id) DO UPDATE SET role = excluded.role`,
            )
            .bind(row.id, m.userId, m.role, caller.id, now),
        )
      }
      statements.push(
        auditStatement(
          db,
          { actorId: caller.id, action: 'workbook.members.replace', entityType: 'workbook', entityId: row.id, workbookId: row.id, details: { added, changed, removed } },
          now,
        ),
      )
      await db.batch(statements)
    }

    const members = await listWorkbookMembers(db, row.id)
    return c.json<PutWorkbookMembersResponse>({ ownerId: row.owner_id, members })
  })

  // GET /api/workbooks/:id/room — WebSocket to the workbook's room (phase 6 stub),
  // documented in packages/shared/src/api.ts; the message protocol is phase 6.
  routes.get('/:id/room', async (c) => {
    const { caller, row, access } = await loadWorkbook(c)
    if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') throw new ApiFailure(426, 'websocket_required')
    const stub = c.env.WORKBOOK_ROOM.get(c.env.WORKBOOK_ROOM.idFromName(row.id))
    return stub.fetch(roomRequest(c.req.raw, { workbookId: row.id, userId: caller.id, access }))
  })

  return routes
}
