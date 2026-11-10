// D1 queries for workbooks (schema: migrations/0001_initial.sql).

import type { ColumnPlan, MappedField, SheetMeta, SheetSyncMode, SyncState, WorkbookMember, WorkbookMemberRole, WorkbookSource, WorkbookSummary } from '@naf-sheets/shared'
import type { WorkbookAccess } from './access'

/** One workbook as the summary queries return it, for one caller. */
export interface WorkbookSummaryRow {
  id: string
  title: string
  owner_id: string
  bc_project_id: number | null
  source: WorkbookSource
  current_snapshot_version: number
  created_at: string
  updated_at: string
  /** The caller's row in workbook_members, if any. */
  member_role: WorkbookMemberRole | null
  sheet_count: number
  task_total: number
  task_done: number
  /** 4 error, 3 conflict, 2 pending, 1 synced, 0/null nothing synced. */
  sync_rank: number | null
}

/*
 * Completion counts to-dos (level 0) of synced sheets that are still active
 * in Basecamp, like Basecamp's own list progress.
 * OPEN: whether subtasks count too (OPEN_QUESTIONS.md #6).
 *
 * ?1 is always the caller's members.user_id.
 */
const SUMMARY_SELECT = `
SELECT
  w.id, w.title, w.owner_id, w.bc_project_id, w.source, w.current_snapshot_version,
  w.created_at, w.updated_at,
  wm.role AS member_role,
  (SELECT COUNT(*) FROM sheets s WHERE s.workbook_id = w.id) AS sheet_count,
  (SELECT COUNT(*) FROM tasks t JOIN sheets s ON s.id = t.sheet_id
     WHERE s.workbook_id = w.id AND s.sync_mode = 'synced' AND t.level = 0
       AND t.remote_status = 'active' AND t.trashed_at IS NULL) AS task_total,
  (SELECT COUNT(*) FROM tasks t JOIN sheets s ON s.id = t.sheet_id
     WHERE s.workbook_id = w.id AND s.sync_mode = 'synced' AND t.level = 0
       AND t.remote_status = 'active' AND t.trashed_at IS NULL AND t.completed = 1) AS task_done,
  (SELECT MAX(CASE t.sync_state WHEN 'error' THEN 4 WHEN 'conflict' THEN 3 WHEN 'pending' THEN 2 WHEN 'synced' THEN 1 ELSE 0 END)
     FROM tasks t JOIN sheets s ON s.id = t.sheet_id
     WHERE s.workbook_id = w.id AND s.sync_mode = 'synced' AND t.trashed_at IS NULL) AS sync_rank
FROM workbooks w
LEFT JOIN workbook_members wm ON wm.workbook_id = w.id AND wm.user_id = ?1`

/** `q` → a LIKE pattern matching it anywhere, with LIKE's wildcards escaped. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/**
 * Workbooks visible to the caller, newest first. Archived workbooks are left
 * out. `all` is for platform admins; everyone else sees the workbooks they
 * own or are a member of.
 */
// OPEN: archived workbooks are hidden from everyone, admins included (OPEN_QUESTIONS.md #8).
export async function listWorkbookRows(db: D1Database, callerId: string, options: { all: boolean; q: string | null }): Promise<WorkbookSummaryRow[]> {
  const conditions = ['w.archived_at IS NULL']
  if (!options.all) conditions.push('(w.owner_id = ?1 OR wm.user_id IS NOT NULL)')
  if (options.q !== null) conditions.push(`w.title LIKE ?2 ESCAPE '\\'`)

  const sql = `${SUMMARY_SELECT}
WHERE ${conditions.join(' AND ')}
ORDER BY w.updated_at DESC, w.id`

  const statement = options.q !== null ? db.prepare(sql).bind(callerId, likePattern(options.q)) : db.prepare(sql).bind(callerId)
  const { results } = await statement.all<WorkbookSummaryRow>()
  return results
}

/** One live workbook with the caller's membership, or null. */
export async function getWorkbookRow(db: D1Database, callerId: string, workbookId: string): Promise<WorkbookSummaryRow | null> {
  return db
    .prepare(`${SUMMARY_SELECT}
WHERE w.id = ?2 AND w.archived_at IS NULL`)
    .bind(callerId, workbookId)
    .first<WorkbookSummaryRow>()
}

// OPEN: worst state wins; a linked workbook with no synced task reads 'synced' (OPEN_QUESTIONS.md #7).
function syncStateOf(row: WorkbookSummaryRow): WorkbookSummary['syncState'] {
  if (row.bc_project_id === null) return 'unlinked'
  const byRank: Record<number, SyncState> = { 4: 'error', 3: 'conflict', 2: 'pending' }
  return byRank[row.sync_rank ?? 0] ?? 'synced'
}

export function toSummary(row: WorkbookSummaryRow, access: WorkbookAccess): WorkbookSummary {
  return {
    id: row.id,
    title: row.title,
    bcProjectId: row.bc_project_id,
    sheetCount: row.sheet_count,
    completion: row.task_total > 0 ? row.task_done / row.task_total : null,
    syncState: syncStateOf(row),
    updatedAt: row.updated_at,
    access,
  }
}

interface SheetRow {
  id: string
  univer_sheet_id: string
  title: string
  position: number
  sync_mode: SheetSyncMode
  bc_todolist_id: number | null
  header_row: number
}

export async function listSheets(db: D1Database, workbookId: string): Promise<SheetMeta[]> {
  const [{ results }, { results: mappings }] = await db.batch([
    db
      .prepare(
        `SELECT id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row
         FROM sheets WHERE workbook_id = ?1 ORDER BY position, id`,
      )
      .bind(workbookId),
    db
      .prepare(
        `SELECT m.sheet_id, m.column_key, m.field, m.free_to_description, m.completed_value, m.completed_values_json
         FROM column_mappings m JOIN sheets s ON s.id = m.sheet_id
         WHERE s.workbook_id = ?1 ORDER BY m.sheet_id, length(m.column_key), m.column_key`,
      )
      .bind(workbookId),
  ]) as [D1Result<SheetRow>, D1Result<MappingRow>]
  const bySheet = new Map<string, MappingRow[]>()
  for (const m of mappings) bySheet.set(m.sheet_id, [...(bySheet.get(m.sheet_id) ?? []), m])
  return results.map((s) => {
    const rows = bySheet.get(s.id) ?? []
    const columns: ColumnPlan[] = rows.map((m) =>
      m.field === 'free' ? { columnKey: m.column_key, field: 'free', appendToDescription: m.free_to_description === 1 } : { columnKey: m.column_key, field: m.field },
    )
    return {
      id: s.id,
      univerSheetId: s.univer_sheet_id,
      title: s.title,
      position: s.position,
      syncMode: s.sync_mode,
      bcTodolistId: s.bc_todolist_id,
      headerRow: s.header_row,
      columns,
      completedValues: completedValuesOf(rows.find((m) => m.field === 'completed')),
    }
  })
}

/** A sheet's column mapping row (D1 `column_mappings`, migrations 0001 and 0003). */
interface MappingRow {
  sheet_id: string
  column_key: string
  field: MappedField
  free_to_description: number
  completed_value: string | null
  completed_values_json: string | null
}

function completedValuesOf(row: MappingRow | undefined): string[] {
  if (!row) return []
  if (row.completed_values_json) {
    try {
      const values = JSON.parse(row.completed_values_json) as unknown
      if (Array.isArray(values)) return values.filter((v): v is string => typeof v === 'string')
    } catch {
      // Malformed JSON: fall back to the single value.
    }
  }
  return row.completed_value !== null ? [row.completed_value] : []
}

interface MemberRow {
  user_id: string
  role: WorkbookMemberRole
  display_name: string | null
  email: string | null
}

export async function listWorkbookMembers(db: D1Database, workbookId: string): Promise<WorkbookMember[]> {
  const { results } = await db
    .prepare(
      `SELECT wm.user_id, wm.role, m.display_name, m.email
       FROM workbook_members wm JOIN members m ON m.user_id = wm.user_id
       WHERE wm.workbook_id = ?1
       ORDER BY wm.added_at, wm.user_id`,
    )
    .bind(workbookId)
    .all<MemberRow>()
  return results.map((m) => ({ userId: m.user_id, name: m.display_name, email: m.email, role: m.role }))
}

export interface MemberIdentity {
  user_id: string
  display_name: string | null
  email: string | null
  role: string
}

export async function getMemberIdentity(db: D1Database, userId: string): Promise<MemberIdentity | null> {
  return db
    .prepare('SELECT user_id, display_name, email, role FROM members WHERE user_id = ?1')
    .bind(userId)
    .first<MemberIdentity>()
}

/** Which of `userIds` exist in members (one bound parameter, whatever the count). */
export async function existingMemberIds(db: D1Database, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const { results } = await db
    .prepare('SELECT user_id FROM members WHERE user_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(userIds))
    .all<{ user_id: string }>()
  return new Set(results.map((r) => r.user_id))
}
