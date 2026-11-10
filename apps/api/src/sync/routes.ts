// Routes of packages/shared/src/api-sync.ts and the link wizard of
// api-integrations.ts. A workbook nobody may open answers 404 (as in
// src/routes/workbooks.ts); a `viewer` is refused (403) on every route that
// writes, whatever the UI shows; sync health is for platform admins.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { ForbiddenError, NotFoundError } from '@naf-sheets/basecamp'
import type {
  Assignee,
  AssigneeOptionsResponse,
  BcPerson,
  ConflictRecord,
  ExternalContact,
  FieldConflict,
  InboundAction,
  SyncHealthResponse,
  SyncNowResponse,
  SyncState,
  TaskSyncInfo,
  WorkbookConflictsResponse,
  WorkbookSyncResponse,
} from '@naf-sheets/shared'
import type { Caller, WorkbookAccess } from '../access'
import { canWrite, resolveAccess } from '../access'
import { auditStatement } from '../audit'
import type { AppEnv } from '../auth'
import { LinkFailure, PEOPLE_CACHE_TTL_MS, refreshAccountPeople, withUserToken } from '../basecamp-link'
import { projectError, projectPeople, storeProjectPeople } from '../basecamp-link/people'
import { getWorkbookRow } from '../db'
import { ApiFailure } from '../errors'
import { callerOf, isPlainObject, readJson } from '../request'
import { readClient, syncContext } from './deps'
import type { SyncDeps } from './deps'
import { enqueueTasks } from './detect'
import { onSyncError, SyncFailure } from './errors'
import { commitLink, previewLink } from './link'
import { CONFLICT_ROW_MESSAGE, NOTICES } from './messages'
import { publicOrigin } from './inbound/webhooks'
import { requeueRelinked } from './inbound/reconcile'
import { applyToSheet, loadWorkbookState, refusal } from './state'
import { accountInactive, getWorkbookSync, isLinked, markAccountActive } from './store'
import type { WorkbookSyncRow } from './store'

interface Loaded {
  caller: Caller
  access: WorkbookAccess
  wb: WorkbookSyncRow
}

/** The workbook and the caller's access; 404 when missing or not accessible. */
async function load(c: Context<AppEnv>): Promise<Loaded> {
  const caller = callerOf(c)
  const id = c.req.param('id') ?? ''
  if (id === '' || id.length > 128) throw new ApiFailure(404, 'workbook_not_found')
  const row = await getWorkbookRow(c.env.DB, caller.id, id)
  const access = row ? resolveAccess(caller, row.owner_id, row.member_role) : null
  if (!row || access === null) throw new ApiFailure(404, 'workbook_not_found')
  const wb = await getWorkbookSync(c.env.DB, id)
  if (!wb) throw new ApiFailure(404, 'workbook_not_found')
  return { caller, access, wb }
}

function requireWrite(loaded: Loaded): void {
  if (!canWrite(loaded.access)) throw new SyncFailure('forbidden_write')
}

/** §7.3: the owner or a platform admin (a platform viewer is capped at viewer even on their own workbook). */
function requireLinker(loaded: Loaded): void {
  if (loaded.access !== 'owner' && loaded.access !== 'admin') throw new SyncFailure('forbidden_link')
}

function accountIdOf(env: Env): number | null {
  const text = (env as Env & { BASECAMP_ACCOUNT_ID?: string }).BASECAMP_ACCOUNT_ID?.trim() ?? ''
  return /^[1-9]\d{0,15}$/.test(text) ? Number(text) : null
}

type Env = AppEnv['Bindings']

export function syncWorkbookRoutes(deps: SyncDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onSyncError)

  // ── Link wizard (§7.3)
  routes.post('/:id/link/preview', async (c) => {
    const loaded = await load(c)
    requireLinker(loaded)
    return c.json(await previewLink(c.env, deps, loaded.caller, loaded.wb.id, await readJson(c)))
  })

  routes.post('/:id/link', async (c) => {
    const loaded = await load(c)
    requireLinker(loaded)
    return c.json(await commitLink(c.env, deps, loaded.caller, loaded.wb.id, await readJson(c)))
  })

  // ── Sync state (§5.2, §9.2.8)
  routes.get('/:id/sync', async (c) => {
    const { wb } = await load(c)
    // S17: a person who linked Basecamp again gets their held rows sent; the editor polls this route.
    if (isLinked(wb)) await requeueRelinked(c.env, deps, wb.id)
    return c.json<WorkbookSyncResponse>(await syncResponse(c.env, wb))
  })

  routes.post('/:id/sync-now', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const { wb, caller } = loaded
    if (!isLinked(wb)) throw new SyncFailure('not_linked')
    const now = new Date(deps.now()).toISOString()
    // OPEN: an admin's «مزامنة الآن» resumes an account stopped by `Account Inactive` (S6).
    const account = accountIdOf(c.env)
    if (caller.role === 'admin' && account !== null) await markAccountActive(c.env.DB, account, caller.id, now)
    try {
      await c.env.BC_INBOUND.send({ kind: 'reconcile', workbookId: wb.id, requestedBy: caller.id, enqueuedAt: now })
    } catch {
      throw new SyncFailure('queue_unavailable')
    }
    // Rows still waiting go again, each with its own author (§3).
    const { results } = await c.env.DB.prepare(
      `SELECT t.task_uid, t.pending_actor_id FROM tasks t JOIN sheets s ON s.id = t.sheet_id
       WHERE s.workbook_id = ?1 AND t.sync_state = 'pending' AND t.pending_actor_id IS NOT NULL AND t.trashed_at IS NULL`,
    )
      .bind(wb.id)
      .all<{ task_uid: string; pending_actor_id: string }>()
    await enqueueTasks(c.env, wb.id, results.map((r) => ({ uid: r.task_uid, actor: r.pending_actor_id })), deps.now, 0)
    const lists = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sheets WHERE workbook_id = ?1 AND sync_mode = 'synced' AND bc_todolist_id IS NOT NULL`)
      .bind(wb.id)
      .first<{ n: number }>()
    return c.json<SyncNowResponse>({ queued: lists?.n ?? 0 }, 202)
  })

  // ── Conflicts (§9.1)
  routes.get('/:id/conflicts', async (c) => {
    const { wb } = await load(c)
    const { results } = await c.env.DB.prepare(
      `SELECT id, sheet_id, task_uid, field, local_value_json, remote_value_json, winner, local_changed_at, remote_updated_at, created_at
       FROM sync_conflicts WHERE workbook_id = ?1 AND resolved_at IS NULL ORDER BY created_at, id`,
    )
      .bind(wb.id)
      .all<ConflictRow>()
    return c.json<WorkbookConflictsResponse>({ conflicts: results.map(toConflict) })
  })

  routes.post('/:id/conflicts/:conflictId/restore', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    await restoreConflict(c.env, deps, loaded, c.req.param('conflictId'))
    return c.json({ restored: true as const }, 202)
  })

  routes.post('/:id/conflicts/:conflictId/dismiss', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const conflict = await conflictOf(c.env.DB, loaded.wb.id, c.req.param('conflictId'))
    const at = new Date(deps.now()).toISOString()
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE sync_conflicts SET resolved_at = ?2, resolution = 'dismissed', resolved_by = ?3 WHERE id = ?1 AND resolved_at IS NULL`).bind(
        conflict.id,
        at,
        loaded.caller.id,
      ),
      c.env.DB.prepare(
        `UPDATE tasks SET sync_state = 'synced' WHERE task_uid = ?1 AND sync_state = 'conflict'
           AND NOT EXISTS (SELECT 1 FROM sync_conflicts WHERE task_uid = ?1 AND resolved_at IS NULL)`,
      ).bind(conflict.task_uid),
    ])
    return c.body(null, 204)
  })

  // ── Assignee cell (§8.2, §9.5)
  routes.get('/:id/assignee-options', async (c) => {
    const { wb, caller } = await load(c)
    return c.json<AssigneeOptionsResponse>(await assigneeOptions(c.env, deps, wb, caller))
  })

  routes.post('/:id/project-people', async (c) => {
    const loaded = await load(c)
    requireWrite(loaded)
    const { wb, caller } = loaded
    if (!isLinked(wb)) throw new SyncFailure('not_linked')
    const body = await readJson(c)
    const id = isPlainObject(body) ? body.bcPersonId : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new SyncFailure('invalid_person')
    const ctx = syncContext(c.env, deps)
    const client = readClient(ctx)
    const at = new Date(deps.now()).toISOString()
    // §8.2 case 1: with the caller's own token, after the editor's confirmation dialog.
    await withUserToken(ctx, caller.id, async (token) => {
      try {
        await client.people.updateProjectAccess(token, wb.bc_project_id, { grant: [id] })
      } catch (error) {
        // OPEN: «أرسل طلباً» (access_requests, admin notice, row «بانتظار إضافة عضو») is not built (S24).
        if (error instanceof ForbiddenError) throw new SyncFailure('project_people_forbidden')
        if (error instanceof NotFoundError) throw projectError(error)
        throw error
      }
      await storeProjectPeople(c.env.DB, wb.bc_project_id, await client.people.listProject(token, wb.bc_project_id).all(), at)
    })
    await auditStatement(
      c.env.DB,
      { actorId: caller.id, action: 'basecamp.project.grant', entityType: 'bc_project', entityId: String(wb.bc_project_id), workbookId: wb.id, details: { bcPersonId: id } },
      at,
    ).run()
    return c.json<AssigneeOptionsResponse>(await assigneeOptions(c.env, deps, wb, caller))
  })

  return routes
}

/** POST /api/external-contacts (§8.2 case 3): platform editors and admins. */
export function externalContactRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onSyncError)
  routes.post('/', async (c) => {
    const caller = callerOf(c)
    if (caller.role !== 'admin' && caller.role !== 'editor') throw new SyncFailure('forbidden_contacts')
    const body = await readJson(c)
    if (!isPlainObject(body)) throw new SyncFailure('invalid_contact')
    const text = (value: unknown, required: boolean): string | null => {
      if (value === undefined || value === null) {
        if (required) throw new SyncFailure('invalid_contact')
        return null
      }
      if (typeof value !== 'string') throw new SyncFailure('invalid_contact')
      const v = value.trim()
      if (v.length > 200 || (required && v === '')) throw new SyncFailure('invalid_contact')
      return v === '' ? null : v
    }
    const contact: ExternalContact = {
      id: crypto.randomUUID(),
      name: text(body.name, true) as string,
      organization: text(body.organization, false),
      email: text(body.email, false),
      phone: text(body.phone, false),
    }
    if (contact.email !== null && !/^[^\s@]+@[^\s@]+$/.test(contact.email)) throw new SyncFailure('invalid_contact')
    await c.env.DB.prepare(
      `INSERT INTO external_contacts (id, name, organization, email, phone, note, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)`,
    )
      .bind(contact.id, contact.name, contact.organization, contact.email, contact.phone, caller.id, new Date().toISOString())
      .run()
    return c.json<ExternalContact>(contact, 201)
  })
  return routes
}

/** GET /api/admin/sync-health (§9.4): platform admins only. */
export function syncHealthRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  routes.onError(onSyncError)
  routes.get('/', async (c) => {
    const caller = callerOf(c)
    if (caller.role !== 'admin') throw new SyncFailure('admin_only')
    const db = c.env.DB
    const [wbs, counts, hooks, dead] = await db.batch([
      db.prepare(`SELECT id, title, bc_project_id, last_sync_success_at FROM workbooks WHERE bc_project_id IS NOT NULL AND archived_at IS NULL ORDER BY title, id`),
      db.prepare(
        `SELECT s.workbook_id, t.sync_state, COUNT(*) AS n FROM tasks t JOIN sheets s ON s.id = t.sheet_id
         WHERE t.trashed_at IS NULL GROUP BY s.workbook_id, t.sync_state`,
      ),
      db.prepare(`SELECT bc_project_id, MAX(active) AS active FROM bc_webhooks WHERE replaced_at IS NULL GROUP BY bc_project_id`),
      db.prepare(`SELECT COUNT(*) AS n FROM sync_dead_letters WHERE retried_at IS NULL`),
    ])
    const countRows = (counts?.results ?? []) as Array<{ workbook_id: string; sync_state: SyncState; n: number }>
    const hookRows = new Map(((hooks?.results ?? []) as Array<{ bc_project_id: number; active: number }>).map((h) => [h.bc_project_id, h.active]))
    const workbooks = ((wbs?.results ?? []) as Array<{ id: string; title: string; bc_project_id: number; last_sync_success_at: string | null }>).map((w) => {
      const of = (state: SyncState) => countRows.find((r) => r.workbook_id === w.id && r.sync_state === state)?.n ?? 0
      const active = hookRows.get(w.bc_project_id)
      return {
        workbookId: w.id,
        title: w.title,
        bcProjectId: w.bc_project_id,
        counts: { pending: of('pending'), error: of('error'), conflict: of('conflict') },
        lastSuccessAt: w.last_sync_success_at,
        webhook: active === undefined ? ('missing' as const) : active === 1 ? ('active' as const) : ('inactive' as const),
      }
    })
    const deadLetters = ((dead?.results ?? []) as Array<{ n: number }>)[0]?.n ?? 0
    return c.json<SyncHealthResponse>({ workbooks, deadLetters })
  })
  return routes
}

// ---------------------------------------------------------------------------
// GET …/sync
// ---------------------------------------------------------------------------

interface TaskStateRow {
  task_uid: string
  sheet_id: string
  level: 0 | 1
  parent_uid: string | null
  bc_recording_id: number | null
  sync_state: SyncState
  last_error: string | null
  remote_status: TaskSyncInfo['remoteStatus']
  assign_mode: 'auto' | 'manual'
  bc_comments_count: number | null
  attachments_count: number
}

const RANK: Record<SyncState, number> = { error: 4, conflict: 3, pending: 2, synced: 1, unlinked: 0 }

async function syncResponse(env: Env, wb: WorkbookSyncRow): Promise<WorkbookSyncResponse> {
  const { results } = await env.DB.prepare(
    `SELECT t.task_uid, t.sheet_id, t.level, t.parent_uid, t.bc_recording_id, t.sync_state, t.last_error, t.remote_status, t.assign_mode,
            t.bc_comments_count,
            (SELECT COUNT(*) FROM attachments a WHERE a.task_uid = t.task_uid AND a.removed_at IS NULL) AS attachments_count
     FROM tasks t JOIN sheets s ON s.id = t.sheet_id
     WHERE s.workbook_id = ?1 AND t.trashed_at IS NULL ORDER BY t.created_at, t.task_uid`,
  )
    .bind(wb.id)
    .all<TaskStateRow>()
  const linked = isLinked(wb)
  const account = accountIdOf(env)
  const byUid = new Map(results.map((r) => [r.task_uid, r]))
  // OPEN: the app URL is built from the documented pattern; a subtask links to its to-do (S13).
  const url = (id: number | null): string | null =>
    id === null || account === null || wb.bc_project_id === null ? null : `https://3.basecamp.com/${account}/buckets/${wb.bc_project_id}/todos/${id}`
  const tasks: TaskSyncInfo[] = results.map((r) => ({
    uid: r.task_uid,
    sheetId: r.sheet_id,
    state: r.sync_state,
    // `pending` carries a message only while it waits for its author's Basecamp link (spec §3, S17).
    message: r.sync_state === 'error' || r.sync_state === 'pending' ? r.last_error : r.sync_state === 'conflict' ? CONFLICT_ROW_MESSAGE : null,
    remoteStatus: r.remote_status,
    bcUrl: r.level === 0 ? url(r.bc_recording_id) : r.bc_recording_id === null ? null : url(byUid.get(r.parent_uid ?? '')?.bc_recording_id ?? null),
    assignMode: r.level === 0 ? r.assign_mode : null,
    // Phase 5: comments live on to-dos (§8 table); a subtask shows none of its own.
    commentsCount: r.level === 0 ? r.bc_comments_count : null,
    attachmentsCount: r.attachments_count,
  }))
  const counts = { pending: 0, error: 0, conflict: 0 }
  let worst: SyncState = 'synced'
  for (const t of tasks) {
    if (t.state === 'pending' || t.state === 'error' || t.state === 'conflict') counts[t.state] += 1
    if (RANK[t.state] > RANK[worst]) worst = t.state
  }
  return {
    state: linked ? worst : 'unlinked',
    lastSuccessAt: wb.last_sync_success_at,
    counts,
    notice: linked ? await noticeOf(env, wb, account) : null,
    tasks,
  }
}

async function noticeOf(env: Env, wb: WorkbookSyncRow, account: number | null): Promise<string | null> {
  if (account === null) return NOTICES.not_configured
  if (await accountInactive(env.DB, account)) return NOTICES.account_inactive
  const service = await env.DB.prepare(`SELECT status, encrypted_tokens FROM integrations WHERE provider = 'basecamp' AND account_id = ?1`)
    .bind(String(account))
    .first<{ status: string; encrypted_tokens: string }>()
  if (!service || service.status !== 'active' || service.encrypted_tokens === '') return NOTICES.service_not_linked
  const hook = await env.DB.prepare(`SELECT 1 AS x FROM bc_webhooks WHERE bc_project_id = ?1 AND replaced_at IS NULL AND active = 1`).bind(wb.bc_project_id).first()
  if (!hook || publicOrigin(env) === null) return NOTICES.webhook_pending
  return null
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

interface ConflictRow {
  id: string
  sheet_id: string
  task_uid: string
  field: FieldConflict['field']
  local_value_json: string
  remote_value_json: string
  winner: 'local' | 'remote'
  local_changed_at: string | null
  remote_updated_at: string
  created_at: string
  resolved_at?: string | null
}

function toConflict(r: ConflictRow): ConflictRecord {
  return {
    id: r.id,
    sheetId: r.sheet_id,
    createdAt: r.created_at,
    uid: r.task_uid,
    field: r.field,
    localValue: JSON.parse(r.local_value_json) as unknown,
    remoteValue: JSON.parse(r.remote_value_json) as unknown,
    winner: r.winner,
    localChangedAt: r.local_changed_at,
    remoteUpdatedAt: r.remote_updated_at,
  }
}

async function conflictOf(db: D1Database, workbookId: string, conflictId: string | undefined): Promise<ConflictRow> {
  const row = await db
    .prepare(
      `SELECT id, sheet_id, task_uid, field, local_value_json, remote_value_json, winner, local_changed_at, remote_updated_at, created_at, resolved_at
       FROM sync_conflicts WHERE id = ?1 AND workbook_id = ?2`,
    )
    .bind(conflictId ?? '', workbookId)
    .first<ConflictRow>()
  if (!row) throw new SyncFailure('conflict_not_found')
  if (row.resolved_at) throw new SyncFailure('conflict_resolved')
  return row
}

/**
 * Puts the losing value back. It is written into the sheet as the caller's
 * own edit, then sent to Basecamp with the caller's token by the outbound
 * consumer: a local loser reaches Basecamp, a remote loser the sheet (and
 * then Basecamp, so both sides agree).
 */
async function restoreConflict(env: Env, deps: SyncDeps, loaded: Loaded, conflictId: string | undefined): Promise<void> {
  const { wb, caller } = loaded
  const conflict = await conflictOf(env.DB, wb.id, conflictId)
  const loser = JSON.parse(conflict.winner === 'remote' ? conflict.local_value_json : conflict.remote_value_json) as unknown
  const uid = conflict.task_uid
  let action: InboundAction
  switch (conflict.field) {
    case 'assignees': {
      const assignees: Assignee[] = Array.isArray(loser)
        ? loser.map((x) => (typeof x === 'number' ? ({ kind: 'bc_person', bcPersonId: x, source: 'manual' } as Assignee) : ({ ...(x as Assignee), source: 'manual' } as Assignee)))
        : []
      action = { type: 'update_row', uid, fields: { assignees, assignMode: 'manual' } }
      break
    }
    case 'listId':
      action = { type: 'move_row', uid, toListId: typeof loser === 'number' ? loser : null, position: null }
      break
    case 'position':
      action = { type: 'update_row', uid, fields: { position: loser as number } }
      break
    default:
      action = { type: 'update_row', uid, fields: { [conflict.field]: loser } }
  }
  const state = await loadWorkbookState(env, wb)
  const row = state?.taskRows.get(uid)
  const sheet = row ? state?.sheetsById.get(row.sheet_id) : undefined
  if (!state || !row || !sheet) throw new SyncFailure('conflict_not_found')
  const at = new Date(deps.now()).toISOString()
  const apply = await applyToSheet(env, state, sheet, [action], caller.id, at)
  if (apply.status === 'contended') throw new SyncFailure('link_contended')
  const refused = refusal(apply)
  if (refused) throw new SyncFailure('restore_refused', refused.message)
  await env.DB.batch([
    env.DB.prepare(`UPDATE sync_conflicts SET resolved_at = ?2, resolution = 'restored', resolved_by = ?3 WHERE id = ?1 AND resolved_at IS NULL`).bind(conflict.id, at, caller.id),
    env.DB.prepare(`UPDATE tasks SET sync_state = 'pending', pending_actor_id = ?2, last_local_change_at = ?3, last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`).bind(
      uid,
      caller.id,
      at,
    ),
  ])
  await enqueueTasks(env, wb.id, [{ uid, actor: caller.id }], deps.now, 0)
}

// ---------------------------------------------------------------------------
// Assignee options
// ---------------------------------------------------------------------------

interface CachedPerson {
  bc_person_id: number
  name: string
  email: string | null
  avatar_url: string | null
  personable_type: string | null
  client: number
  refreshed_at?: string
}

function person(row: CachedPerson, showEmail: boolean): BcPerson {
  return {
    id: row.bc_person_id,
    name: row.name,
    email: showEmail ? row.email : null,
    avatarUrl: row.avatar_url,
    personableType: row.personable_type ?? '',
    client: row.client === 1,
  }
}

async function assigneeOptions(env: Env, deps: SyncDeps, wb: WorkbookSyncRow, caller: Caller): Promise<AssigneeOptionsResponse> {
  const db = env.DB
  const showEmail = caller.role === 'admin'
  let projectPeopleList: BcPerson[] = []
  let refreshedAt: string | null = null
  if (wb.bc_project_id !== null) {
    try {
      const fresh = await projectPeople(syncContext(env, deps), caller, wb.bc_project_id)
      projectPeopleList = fresh.people
      refreshedAt = fresh.refreshedAt
    } catch (error) {
      if (!(error instanceof LinkFailure)) throw error
      // OPEN: without the caller's own link the cache is served as it is (S15).
      const { results } = await db
        .prepare(
          `SELECT bc_person_id, name, email, avatar_url, personable_type, client, refreshed_at FROM bc_people_cache
           WHERE bc_project_id = ?1 AND removed_at IS NULL ORDER BY name, bc_person_id`,
        )
        .bind(wb.bc_project_id)
        .all<CachedPerson>()
      projectPeopleList = results.map((r) => person(r, showEmail))
      refreshedAt = results.reduce<string | null>((max, r) => (r.refreshed_at && (max === null || r.refreshed_at > max) ? r.refreshed_at : max), null)
    }
  }
  const stale = await db.prepare(`SELECT MAX(refreshed_at) AS at FROM bc_account_people_cache`).first<{ at: string | null }>()
  if (stale?.at == null || deps.now() - Date.parse(stale.at) > PEOPLE_CACHE_TTL_MS) {
    try {
      await refreshAccountPeople(syncContext(env, deps))
    } catch {
      // The service token may be missing: the cache is served as it is.
    }
  }
  const inProject = new Set(projectPeopleList.map((p) => p.id))
  const { results: account } = await db
    .prepare(
      `SELECT bc_person_id, name, email, avatar_url, personable_type, client FROM bc_account_people_cache
       WHERE removed_at IS NULL AND personable_type = 'User' ORDER BY name, bc_person_id`,
    )
    .all<CachedPerson>()
  const { results: contacts } = await db
    .prepare(`SELECT id, name, organization, email, phone FROM external_contacts WHERE archived_at IS NULL ORDER BY name, id`)
    .all<ExternalContact>()
  return {
    projectPeople: projectPeopleList,
    accountPeople: account.filter((r) => !inProject.has(r.bc_person_id)).map((r) => person(r, showEmail)),
    externals: contacts.map((x) => ({ id: x.id, name: x.name, organization: x.organization, email: x.email, phone: x.phone })),
    refreshedAt,
  }
}
