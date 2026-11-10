// D1 rows of phase 5 (migrations 0001 `attachments`, 0004): files of tasks
// and what a task can take. Nothing is deleted: a removed file keeps its row
// (`removed_at`) and its R2 copy (`purge_after`).

import type { AttachmentInfo, AttachmentRef, AttachmentState } from '@naf-sheets/shared'
import type { SheetRow, TaskRow, WorkbookSyncRow } from '../sync/store'
import { getTask, isLinked, isSyncedSheet } from '../sync/store'
import { ATTACHMENT_NOTICES } from './errors'

/** §10: the R2 copy of a removed file is kept this long. */
export const ARCHIVE_DAYS = 30

export interface AttachmentRow {
  id: string
  task_uid: string
  r2_key: string
  filename: string
  size: number
  mime: string | null
  bc_sgid: string | null
  bc_blob_url: string | null
  origin: 'local' | 'basecamp'
  created_by: string | null
  created_at: string
  removed_at: string | null
  state: AttachmentState
  r2_stored: number
  bc_attachment_id: number | null
  last_error: string | null
  last_error_code: string | null
  removed_by: string | null
  purge_after: string | null
  updated_at: string | null
}

const COLUMNS = `a.id, a.task_uid, a.r2_key, a.filename, a.size, a.mime, a.bc_sgid, a.bc_blob_url, a.origin, a.created_by, a.created_at,
  a.removed_at, a.state, a.r2_stored, a.bc_attachment_id, a.last_error, a.last_error_code, a.removed_by, a.purge_after, a.updated_at`

/** The files of a task that are not removed, in the order they were added. */
export async function liveAttachments(db: D1Database, uid: string): Promise<AttachmentRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM attachments a WHERE a.task_uid = ?1 AND a.removed_at IS NULL ORDER BY a.created_at, a.id`)
    .bind(uid)
    .all<AttachmentRow>()
  return results
}

/** One file of a workbook (through its task's sheet), removed or not. */
export async function attachmentOfWorkbook(db: D1Database, workbookId: string, attachmentId: string): Promise<AttachmentRow | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM attachments a JOIN tasks t ON t.task_uid = a.task_uid JOIN sheets s ON s.id = t.sheet_id
       WHERE a.id = ?1 AND s.workbook_id = ?2`,
    )
    .bind(attachmentId, workbookId)
    .first<AttachmentRow>()
}

export async function attachmentById(db: D1Database, id: string): Promise<AttachmentRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM attachments a WHERE a.id = ?1`).bind(id).first<AttachmentRow>()
}

export function downloadPath(workbookId: string, attachmentId: string): string {
  return `/api/workbooks/${encodeURIComponent(workbookId)}/attachments/${encodeURIComponent(attachmentId)}/download`
}

export function toInfo(row: AttachmentRow, workbookId: string): AttachmentInfo {
  return {
    id: row.id,
    taskUid: row.task_uid,
    filename: row.filename,
    size: row.size,
    mime: row.mime,
    origin: row.origin,
    state: row.state,
    message: row.state === 'failed' ? row.last_error : null,
    downloadPath: downloadPath(workbookId, row.id),
    createdAt: row.created_at,
  }
}

/** What the attachments cell shows (sheet-model writes the names). */
export function toRefs(rows: readonly AttachmentRow[]): AttachmentRef[] {
  return rows.map((r) => ({ id: r.id, filename: r.filename, bcSgid: r.bc_sgid, origin: r.origin }))
}

export function plusDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 3600_000).toISOString()
}

/** A task of the workbook with its sheet, or null (not in this workbook, or removed from the sheet). */
export async function taskOfWorkbook(db: D1Database, workbookId: string, uid: string): Promise<{ task: TaskRow; sheet: SheetRow } | null> {
  if (uid === '' || uid.length > 128) return null
  const task = await getTask(db, uid)
  if (!task || task.trashed_at !== null) return null
  const sheet = await db
    .prepare(
      `SELECT id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row,
              auto_assign_parents, exclude_completed_subtask_assignees, assignee_matches_json
       FROM sheets WHERE id = ?1 AND workbook_id = ?2`,
    )
    .bind(task.sheet_id, workbookId)
    .first<SheetRow>()
  return sheet ? { task, sheet } : null
}

/**
 * Where a task's files go (spec §8 table, §10):
 * - `basecamp`: a to-do in Basecamp — into its description;
 * - `local`: a subtask (Basecamp subtasks have no attachments), or a row of a
 *   sheet that does not sync — kept in the platform with a notice;
 * - `refused`: a to-do not in Basecamp yet, or deleted / archived there.
 */
export type FileMode =
  | { kind: 'basecamp'; todoId: number }
  | { kind: 'local'; notice: string }
  | { kind: 'refused'; key: 'task_not_in_basecamp' | 'task_deleted_remotely'; notice: string }

export function fileMode(wb: WorkbookSyncRow, sheet: SheetRow, task: TaskRow): FileMode {
  if (task.remote_status !== 'active') return { kind: 'refused', key: 'task_deleted_remotely', notice: ATTACHMENT_NOTICES.deleted_remotely }
  // OPEN (P3): a subtask's files stay local; the spec's alternative (attach to the parent) is a setting not built yet.
  if (task.level === 1) return { kind: 'local', notice: ATTACHMENT_NOTICES.subtask_local }
  if (!isLinked(wb) || !isSyncedSheet(sheet)) return { kind: 'local', notice: ATTACHMENT_NOTICES.sheet_local }
  if (task.bc_recording_id === null) return { kind: 'refused', key: 'task_not_in_basecamp', notice: ATTACHMENT_NOTICES.not_in_basecamp }
  return { kind: 'basecamp', todoId: task.bc_recording_id }
}

/** The to-do whose comments a row shows: the row itself, or a subtask's parent (§8 table). */
export async function commentTarget(db: D1Database, task: TaskRow): Promise<TaskRow | null> {
  if (task.level === 0) return task
  if (task.parent_uid === null) return null
  return getTask(db, task.parent_uid)
}
