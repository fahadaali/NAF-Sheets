// D1 rows the sync reads and writes (migrations 0001, 0002, 0003).
//
// Statements are returned rather than run where they belong in a batch with
// other changes (one D1 transaction). Nothing is deleted: replaced assignees
// get `removed_at`, conflicts `resolved_at`, deletions a state.

import type { Assignee, AssignMode, ColumnPlan, MappedField, SheetPlan, SyncedBase, SyncState } from '@naf-sheets/shared'

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface WorkbookSyncRow {
  id: string
  title: string
  owner_id: string
  bc_project_id: number | null
  current_snapshot_version: number
  new_list_behavior: 'create_sheet' | 'ignore'
  link_state: 'linking' | 'linked' | null
  unclassified_sheet_id: string | null
  last_sync_success_at: string | null
}

const WORKBOOK_COLUMNS = `id, title, owner_id, bc_project_id, current_snapshot_version, new_list_behavior, link_state, unclassified_sheet_id, last_sync_success_at`

export async function getWorkbookSync(db: D1Database, workbookId: string): Promise<WorkbookSyncRow | null> {
  return db.prepare(`SELECT ${WORKBOOK_COLUMNS} FROM workbooks WHERE id = ?1 AND archived_at IS NULL`).bind(workbookId).first<WorkbookSyncRow>()
}

/** The live workbook linked to a Basecamp project (uq_workbooks_bc_project makes it unique). */
export async function workbookByProject(db: D1Database, projectId: number): Promise<WorkbookSyncRow | null> {
  return db
    .prepare(`SELECT ${WORKBOOK_COLUMNS} FROM workbooks WHERE bc_project_id = ?1 AND archived_at IS NULL`)
    .bind(projectId)
    .first<WorkbookSyncRow>()
}

export async function linkedWorkbooks(db: D1Database): Promise<WorkbookSyncRow[]> {
  const { results } = await db
    .prepare(`SELECT ${WORKBOOK_COLUMNS} FROM workbooks WHERE bc_project_id IS NOT NULL AND link_state = 'linked' AND archived_at IS NULL ORDER BY id`)
    .all<WorkbookSyncRow>()
  return results
}

export function isLinked(wb: WorkbookSyncRow): wb is WorkbookSyncRow & { bc_project_id: number } {
  return wb.bc_project_id !== null && wb.link_state === 'linked'
}

export interface SheetRow {
  id: string
  workbook_id: string
  univer_sheet_id: string
  title: string
  position: number
  sync_mode: 'synced' | 'local'
  bc_todolist_id: number | null
  header_row: number
  auto_assign_parents: number
  exclude_completed_subtask_assignees: number
  assignee_matches_json: string
}

export async function sheetsOf(db: D1Database, workbookId: string): Promise<SheetRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row,
              auto_assign_parents, exclude_completed_subtask_assignees, assignee_matches_json
       FROM sheets WHERE workbook_id = ?1 ORDER BY position, id`,
    )
    .bind(workbookId)
    .all<SheetRow>()
  return results
}

/** A sheet that syncs with a Basecamp list. */
export function isSyncedSheet(sheet: SheetRow): sheet is SheetRow & { bc_todolist_id: number } {
  return sheet.sync_mode === 'synced' && sheet.bc_todolist_id !== null
}

export interface MappingRow {
  sheet_id: string
  column_key: string
  field: MappedField
  free_to_description: number
  completed_value: string | null
  completed_values_json: string | null
}

export async function mappingsOf(db: D1Database, sheetIds: readonly string[]): Promise<Map<string, MappingRow[]>> {
  const out = new Map<string, MappingRow[]>()
  if (sheetIds.length === 0) return out
  const { results } = await db
    .prepare(
      `SELECT sheet_id, column_key, field, free_to_description, completed_value, completed_values_json
       FROM column_mappings WHERE sheet_id IN (SELECT value FROM json_each(?1)) ORDER BY sheet_id, column_key`,
    )
    .bind(JSON.stringify(sheetIds))
    .all<MappingRow>()
  for (const row of results) out.set(row.sheet_id, [...(out.get(row.sheet_id) ?? []), row])
  return out
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * The plan sheet-model reads a linked sheet with. The hierarchy is in the
 * system columns once linked, so it reads `flat` here.
 */
export function planOf(sheet: SheetRow, mappings: readonly MappingRow[]): SheetPlan {
  const columns: ColumnPlan[] = mappings.map((m) =>
    m.field === 'free' ? { columnKey: m.column_key, field: 'free', appendToDescription: m.free_to_description === 1 } : { columnKey: m.column_key, field: m.field },
  )
  const completed = mappings.find((m) => m.field === 'completed')
  const completedValues = completed
    ? parseJson<string[]>(completed.completed_values_json, completed.completed_value !== null ? [completed.completed_value] : [])
    : []
  const plan: SheetPlan = {
    sheetId: sheet.id,
    mode: isSyncedSheet(sheet) ? 'existing' : 'local',
    headerRow: sheet.header_row,
    columns,
    completedValues,
    hierarchy: { mode: 'flat' },
    existingTasks: 'create_all',
    assigneeMatches: parseJson<Record<string, number | null>>(sheet.assignee_matches_json, {}),
  }
  if (sheet.bc_todolist_id !== null) plan.todolistId = sheet.bc_todolist_id
  return plan
}

export interface TaskRow {
  task_uid: string
  sheet_id: string
  parent_uid: string | null
  level: 0 | 1
  bc_recording_id: number | null
  bc_type: 'todo' | 'subtask' | null
  assign_mode: AssignMode
  completed: number
  last_synced_hash: string | null
  last_synced_base_json: string | null
  last_local_change_at: string | null
  last_remote_change_at: string | null
  sync_state: SyncState
  last_error: string | null
  last_error_code: string | null
  remote_status: 'active' | 'archived' | 'trashed' | 'deleted'
  trashed_at: string | null
  local_hash: string | null
  pending_actor_id: string | null
  bc_subtasks_count: number | null
  bc_subtasks_completed_count: number | null
  created_at: string
  /** Phase 5 (migration 0004): the to-do's comment counter as last seen in Basecamp. */
  bc_comments_count?: number | null
}

const TASK_COLUMNS = `t.task_uid, t.sheet_id, t.parent_uid, t.level, t.bc_recording_id, t.bc_type, t.assign_mode, t.completed,
  t.last_synced_hash, t.last_synced_base_json, t.last_local_change_at, t.last_remote_change_at, t.sync_state, t.last_error,
  t.last_error_code, t.remote_status, t.trashed_at, t.local_hash, t.pending_actor_id, t.bc_subtasks_count,
  t.bc_subtasks_completed_count, t.created_at, t.bc_comments_count`

export async function tasksOfWorkbook(db: D1Database, workbookId: string): Promise<TaskRow[]> {
  const { results } = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN sheets s ON s.id = t.sheet_id WHERE s.workbook_id = ?1 ORDER BY t.created_at, t.task_uid`)
    .bind(workbookId)
    .all<TaskRow>()
  return results
}

export async function getTask(db: D1Database, uid: string): Promise<TaskRow | null> {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.task_uid = ?1`).bind(uid).first<TaskRow>()
}

/**
 * A task's family as D1 has it now: the task, its parent, its subtasks and its
 * siblings — every row one step of that task reads besides its own (the
 * parent's Basecamp id, the subtasks of §8.1's automatic assignment, the
 * children a deletion or a creation touches).
 */
export async function taskFamily(db: D1Database, uid: string): Promise<TaskRow[]> {
  const { results } = await db
    .prepare(
      `WITH me AS (SELECT task_uid, parent_uid FROM tasks WHERE task_uid = ?1)
       SELECT ${TASK_COLUMNS} FROM tasks t
       WHERE t.task_uid = ?1
          OR t.task_uid = (SELECT parent_uid FROM me)
          OR t.parent_uid = ?1
          OR (t.parent_uid IS NOT NULL AND t.parent_uid = (SELECT parent_uid FROM me))`,
    )
    .bind(uid)
    .all<TaskRow>()
  return results
}

/** The workbook a task belongs to (through its sheet). */
export async function workbookIdOfTask(db: D1Database, uid: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT s.workbook_id AS id FROM tasks t JOIN sheets s ON s.id = t.sheet_id WHERE t.task_uid = ?1`)
    .bind(uid)
    .first<{ id: string }>()
  return row?.id ?? null
}

export function baseOfRow(row: Pick<TaskRow, 'last_synced_base_json'>): SyncedBase | null {
  return parseJson<SyncedBase | null>(row.last_synced_base_json, null)
}

// ---------------------------------------------------------------------------
// Assignees (task_assignees: the single source of a task's assignees, §8.2)
// ---------------------------------------------------------------------------

interface AssigneeRow {
  task_uid: string
  kind: 'bc_person' | 'external' | 'follower'
  bc_person_id: number | null
  external_contact_id: string | null
  source: 'manual' | 'auto'
  notify_email: number
}

export async function assigneesOf(db: D1Database, uids: readonly string[]): Promise<Map<string, Assignee[]>> {
  const out = new Map<string, Assignee[]>()
  if (uids.length === 0) return out
  const { results } = await db
    .prepare(
      `SELECT task_uid, kind, bc_person_id, external_contact_id, source, notify_email FROM task_assignees
       WHERE removed_at IS NULL AND task_uid IN (SELECT value FROM json_each(?1)) ORDER BY rowid`,
    )
    .bind(JSON.stringify(uids))
    .all<AssigneeRow>()
  for (const r of results) {
    let a: Assignee | null = null
    if (r.kind === 'external' && r.external_contact_id !== null) {
      a = { kind: 'external', externalContactId: r.external_contact_id, source: r.source, notifyEmail: r.notify_email === 1 }
    } else if (r.kind !== 'external' && r.bc_person_id !== null) {
      a = { kind: r.kind, bcPersonId: r.bc_person_id, source: r.source }
    }
    if (a) out.set(r.task_uid, [...(out.get(r.task_uid) ?? []), a])
  }
  return out
}

function assigneeKey(a: Assignee): string {
  return a.kind === 'external' ? `external::${a.externalContactId}` : `${a.kind}:${a.bcPersonId}:`
}

/** Makes `assignees` the task's current set: others are marked removed, never deleted. */
export function assigneeStatements(db: D1Database, uid: string, assignees: readonly Assignee[], at: string): D1PreparedStatement[] {
  const keys = assignees.map(assigneeKey)
  const statements = [
    db
      .prepare(
        `UPDATE task_assignees SET removed_at = ?2 WHERE task_uid = ?1 AND removed_at IS NULL
         AND (kind || ':' || IFNULL(bc_person_id, '') || ':' || IFNULL(external_contact_id, '')) NOT IN (SELECT value FROM json_each(?3))`,
      )
      .bind(uid, at, JSON.stringify(keys)),
  ]
  for (const a of assignees) {
    const person = a.kind === 'external' ? null : a.bcPersonId
    const external = a.kind === 'external' ? a.externalContactId : null
    const notify = a.kind === 'external' ? (a.notifyEmail ? 1 : 0) : 1
    const match = `task_uid = ?1 AND kind = ?2 AND IFNULL(bc_person_id, -1) = IFNULL(?3, -1) AND IFNULL(external_contact_id, '') = IFNULL(?4, '')`
    statements.push(
      db
        .prepare(`UPDATE task_assignees SET source = ?5, notify_email = ?6, removed_at = NULL WHERE ${match}`)
        .bind(uid, a.kind, person, external, a.source, notify),
      db
        .prepare(
          `INSERT INTO task_assignees (task_uid, kind, bc_person_id, external_contact_id, source, notify_email)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM task_assignees WHERE ${match})`,
        )
        .bind(uid, a.kind, person, external, a.source, notify),
    )
  }
  return statements
}

// ---------------------------------------------------------------------------
// Row state
// ---------------------------------------------------------------------------

export function rowErrorStatement(db: D1Database, uid: string, code: string, message: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE tasks SET sync_state = 'error', last_error = ?2, last_error_code = ?3 WHERE task_uid = ?1`)
    .bind(uid, message, code)
}

export async function setRowError(db: D1Database, uid: string, code: string, message: string): Promise<void> {
  await rowErrorStatement(db, uid, code, message).run()
}

/** Codes of a row held for its author's Basecamp link (spec §3): the row stays `pending`. */
export const ACTOR_LINK_CODES = ['actor_not_linked', 'actor_link_expired', 'actor_link_revoked'] as const

/**
 * Spec §3: the edits of a person whose link is missing, expired or revoked
 * stay `pending`, with the Arabic re-link message, and are never sent under
 * another account. They go out once that person links again.
 */
export async function setRowAwaitingLink(db: D1Database, uid: string, code: (typeof ACTOR_LINK_CODES)[number], message: string): Promise<void> {
  await db
    .prepare(`UPDATE tasks SET sync_state = 'pending', last_error = ?2, last_error_code = ?3 WHERE task_uid = ?1`)
    .bind(uid, message, code)
    .run()
}

/** Persists a base: the last synced values (3-way diff base) and its hash (echo suppression). */
export function baseStatement(db: D1Database, uid: string, base: SyncedBase): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tasks SET last_synced_base_json = ?2, last_synced_hash = ?3, last_remote_change_at = ?4,
              bc_recording_id = ?5, bc_type = ?6
       WHERE task_uid = ?1`,
    )
    .bind(uid, JSON.stringify(base), base.hash, base.remoteUpdatedAt, base.bcId, base.bcType)
}

/** Has the task unresolved conflicts? Its state is then `conflict` rather than `synced`. */
export async function hasOpenConflicts(db: D1Database, uid: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS x FROM sync_conflicts WHERE task_uid = ?1 AND resolved_at IS NULL LIMIT 1`).bind(uid).first()
  return row !== null
}

export async function markSynced(db: D1Database, uid: string, at: string, extra: { completed?: boolean; clearActor?: boolean } = {}): Promise<void> {
  const state: SyncState = (await hasOpenConflicts(db, uid)) ? 'conflict' : 'synced'
  await db
    .prepare(
      `UPDATE tasks SET sync_state = ?2, last_error = NULL, last_error_code = NULL, last_synced_at = ?3,
              completed = COALESCE(?4, completed),
              pending_actor_id = CASE WHEN ?5 = 1 THEN NULL ELSE pending_actor_id END
       WHERE task_uid = ?1`,
    )
    .bind(uid, state, at, extra.completed === undefined ? null : extra.completed ? 1 : 0, extra.clearActor ? 1 : 0)
    .run()
}

export async function touchWorkbookSuccess(db: D1Database, workbookId: string, at: string): Promise<void> {
  await db.prepare(`UPDATE workbooks SET last_sync_success_at = ?2 WHERE id = ?1`).bind(workbookId, at).run()
}

// ---------------------------------------------------------------------------
// One sync step per task at a time
// ---------------------------------------------------------------------------

/** Lease length: longer than any single step (no in-Worker retries in consumers). */
export const LEASE_MS = 2 * 60_000

export async function acquireLease(db: D1Database, uid: string, leaseId: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE tasks SET sync_lease_id = ?1, sync_lease_until = ?2
       WHERE task_uid = ?3 AND (sync_lease_id IS NULL OR sync_lease_until IS NULL OR sync_lease_until < ?4)`,
    )
    .bind(leaseId, new Date(nowMs + LEASE_MS).toISOString(), uid, new Date(nowMs).toISOString())
    .run()
  return result.meta.changes === 1
}

export async function releaseLease(db: D1Database, uid: string, leaseId: string): Promise<void> {
  await db.prepare(`UPDATE tasks SET sync_lease_id = NULL, sync_lease_until = NULL WHERE task_uid = ?1 AND sync_lease_id = ?2`).bind(uid, leaseId).run()
}

// ---------------------------------------------------------------------------
// sync_log
// ---------------------------------------------------------------------------

export interface SyncLogEntry {
  workbookId: string
  taskUid: string | null
  direction: 'out' | 'in'
  /** e.g. create_todo, update_row, conflict, delete_subtask_snapshot, webhook_ignored. */
  action: string
  field?: string | null
  oldValue?: unknown
  newValue?: unknown
  /** members.user_id, 'system', or the automatic rule of §8.1 («قاعدة تلقائية»). */
  actor: string
  /** OPEN: vocabulary (apps/api/OPEN_QUESTIONS.md #14): ok | error | ignored | conflict. */
  status: 'ok' | 'error' | 'ignored' | 'conflict'
  error?: string | null
}

function logValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function syncLogStatement(db: D1Database, entry: SyncLogEntry, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sync_log (task_uid, workbook_id, direction, action, field, old_value, new_value, actor, status, error, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      entry.taskUid,
      entry.workbookId,
      entry.direction,
      entry.action,
      entry.field ?? null,
      logValue(entry.oldValue),
      logValue(entry.newValue),
      entry.actor,
      entry.status,
      entry.error ?? null,
      at,
    )
}

// ---------------------------------------------------------------------------
// Account state (§9.2.9: `Reason: Account Inactive` stops the account's sync)
// ---------------------------------------------------------------------------

export async function accountInactive(db: D1Database, accountId: number): Promise<boolean> {
  const row = await db.prepare(`SELECT status FROM sync_accounts WHERE bc_account_id = ?1`).bind(accountId).first<{ status: string }>()
  return row?.status === 'inactive'
}

export async function markAccountInactive(db: D1Database, accountId: number, at: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO sync_accounts (bc_account_id, status, reason, changed_at) VALUES (?1, 'inactive', 'account_inactive', ?2)
         ON CONFLICT (bc_account_id) DO UPDATE SET status = 'inactive', reason = 'account_inactive', changed_at = excluded.changed_at`,
      )
      .bind(accountId, at),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json)
         VALUES (?1, NULL, 'basecamp.account.inactive', 'basecamp_account', ?2, NULL, ?3)`,
      )
      .bind(at, String(accountId), JSON.stringify({ reason: 'Reason: Account Inactive' })),
  ])
  console.warn(`sync: Basecamp account ${accountId} is inactive; its sync is stopped`)
}

export async function markAccountActive(db: D1Database, accountId: number, actorId: string, at: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE sync_accounts SET status = 'active', reason = NULL, changed_at = ?2 WHERE bc_account_id = ?1 AND status = 'inactive'`)
    .bind(accountId, at)
    .run()
  if (result.meta.changes === 1) {
    await db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, workbook_id, details_json)
         VALUES (?1, ?2, 'basecamp.account.resume', 'basecamp_account', ?3, NULL, '{}')`,
      )
      .bind(at, actorId, String(accountId))
      .run()
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Deletions (§9.2.7)
// ---------------------------------------------------------------------------

export type DeletionState = 'requested' | 'executed' | 'covered' | 'undo_requested' | 'undone' | 'cancelled'

export interface DeletionRow {
  id: string
  task_uid: string
  workbook_id: string
  state: DeletionState
  requested_by: string
  requested_at: string
  covered_by_uid: string | null
  action_json: string | null
  snapshot_json: string | null
  executed_at: string | null
}

export async function openDeletions(db: D1Database, workbookId: string): Promise<Map<string, DeletionRow>> {
  const { results } = await db
    .prepare(
      `SELECT id, task_uid, workbook_id, state, requested_by, requested_at, covered_by_uid, action_json, snapshot_json, executed_at
       FROM task_deletions WHERE workbook_id = ?1 AND state IN ('requested', 'executed', 'covered', 'undo_requested')`,
    )
    .bind(workbookId)
    .all<DeletionRow>()
  return new Map(results.map((r) => [r.task_uid, r]))
}

export async function openDeletion(db: D1Database, uid: string): Promise<DeletionRow | null> {
  return db
    .prepare(
      `SELECT id, task_uid, workbook_id, state, requested_by, requested_at, covered_by_uid, action_json, snapshot_json, executed_at
       FROM task_deletions WHERE task_uid = ?1 AND state IN ('requested', 'executed', 'covered', 'undo_requested')`,
    )
    .bind(uid)
    .first<DeletionRow>()
}

export function deletionStateStatement(db: D1Database, id: string, state: DeletionState, at: string, extra: { action?: unknown; snapshot?: unknown; coveredBy?: string } = {}): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE task_deletions SET state = ?2, updated_at = ?3,
              action_json = COALESCE(?4, action_json), snapshot_json = COALESCE(?5, snapshot_json),
              covered_by_uid = COALESCE(?6, covered_by_uid),
              executed_at = CASE WHEN ?2 IN ('executed', 'covered') THEN COALESCE(executed_at, ?3) ELSE executed_at END,
              undone_at = CASE WHEN ?2 = 'undone' THEN ?3 ELSE undone_at END
       WHERE id = ?1`,
    )
    .bind(
      id,
      state,
      at,
      extra.action === undefined ? null : JSON.stringify(extra.action),
      extra.snapshot === undefined ? null : JSON.stringify(extra.snapshot),
      extra.coveredBy ?? null,
    )
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

/** D1 batches in chunks, so a workbook of hundreds of rows never builds one huge transaction. */
export async function runBatches(db: D1Database, statements: readonly D1PreparedStatement[], size = 80): Promise<void> {
  for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size))
}
