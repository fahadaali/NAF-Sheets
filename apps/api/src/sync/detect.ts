// Outbound detection (spec §9.2.1–2): after a committed save, find the task
// rows of synced sheets that changed and queue them for Basecamp.
//
// Called after PUT /api/workbooks/:id/snapshot commits, and by the workbook
// room after it persists (same function, same arguments). It never refuses a
// save: every sync problem becomes a row state (`error` + Arabic message).
//
// - A row is compared with its stored base through the engine's own diff
//   (auto-assignment and the managed block included). A row whose content
//   changed in this save gets `last_local_change_at = now` (last-writer-wins).
// - Changed rows go to `pending` and one message each is queued with
//   `delaySeconds: 2` (the room's 2 s debounce, §9.2.2). The consumer rebuilds
//   the full state, so duplicate messages are harmless no-ops.
// - A synced row missing from the snapshot is deleted in Basecamp only when
//   the save lists it in `confirmedDeletions` (§9.2.7); otherwise Basecamp is
//   not touched and the row goes to `error`.
// - A deleted row that comes back (Ctrl+Z) asks for the undo: the to-do comes
//   back from the trash, the subtask is re-created.

import type { LocalTask } from '@naf-sheets/shared'
import type { SheetError, SheetIssue } from '@naf-sheets/sheet-model'
import { diffTask } from '@naf-sheets/sync-engine'
import type { BcOutboundMessage, Env } from '../env'
import { localFingerprint } from './fingerprint'
import { ROW_MESSAGES } from './messages'
import { diffContextFor, loadWorkbookState, readSheet, syncedSheets } from './state'
import type { WorkbookState } from './state'
import {
  assigneeStatements,
  baseOfRow,
  deletionStateStatement,
  getWorkbookSync,
  isLinked,
  isSyncedSheet,
  openDeletions,
  rowErrorStatement,
  runBatches,
} from './store'
import type { SheetRow, TaskRow } from './store'

export interface DetectionInput {
  workbookId: string
  /** members.user_id of the person who saved. */
  actorUserId: string
  /** The snapshot that was just committed. */
  snapshot: unknown
  /** Its version. */
  version: number
  /** `SaveSnapshotRequest.confirmedDeletions`. */
  confirmedDeletions?: readonly string[]
}

export interface DetectionResult {
  /** False when the workbook is not linked to a project: nothing to do. */
  linked: boolean
  pending: string[]
  held: string[]
  deletions: string[]
  undos: string[]
  enqueued: number
}

/** Error codes detection itself sets, and clears when the row is fine again. */
export function isDetectionCode(code: string | null): boolean {
  return code === 'row_missing' || code === 'duplicate_uid' || (code !== null && (code.startsWith('sheet:') || code.startsWith('engine:')))
}

const OUTBOUND_DELAY_SECONDS = 2

export async function detectOutboundChanges(env: Env, input: DetectionInput, now: () => number = Date.now): Promise<DetectionResult> {
  const result: DetectionResult = { linked: false, pending: [], held: [], deletions: [], undos: [], enqueued: 0 }
  const db = env.DB
  const wb = await getWorkbookSync(db, input.workbookId)
  if (!wb || !isLinked(wb)) return result
  result.linked = true
  const state = await loadWorkbookState(env, wb, { snapshot: input.snapshot, version: input.version })
  if (!state) return result

  const at = new Date(now()).toISOString()
  const actor = input.actorUserId
  const confirmed = new Set(input.confirmedDeletions ?? [])
  const deletions = await openDeletions(db, wb.id)
  const statements: D1PreparedStatement[] = []
  const queue = new Map<string, string>()
  const hold = (uid: string, code: string, message: string): void => {
    statements.push(rowErrorStatement(db, uid, code, message))
    result.held.push(uid)
  }

  // --- Read every synced sheet.
  // OPEN: a row without a uid (`untracked_row`) is not synced until the editor gives it one;
  // the API does not write uids after a browser save, which would 409 the editor's next save (S1).
  const present = new Map<string, { task: LocalTask; sheet: SheetRow; sheetTasks: LocalTask[] }>()
  const duplicated = new Set<string>()
  const issues = new Map<string, SheetIssue>()
  const unreadable = new Map<string, SheetError>()
  for (const sheet of syncedSheets(state)) {
    const read = readSheet(state, sheet)
    if (!read.ok) {
      // A sheet removed from the workbook: its rows are missing like any other.
      if (read.error.code !== 'sheet_not_found') unreadable.set(sheet.id, read.error)
      continue
    }
    for (const task of read.value.tasks) {
      if (present.has(task.uid)) duplicated.add(task.uid)
      else present.set(task.uid, { task, sheet, sheetTasks: read.value.tasks })
    }
    for (const issue of read.value.issues) if (issue.uid !== undefined && !issues.has(issue.uid)) issues.set(issue.uid, issue)
  }

  // --- Rows in the sheet.
  const created = new Map<string, TaskRow | 'new'>()
  const foreign = await uidsElsewhere(db, wb.id, [...present.keys()].filter((uid) => !state.taskRows.has(uid)))
  for (const [uid, { task, sheet, sheetTasks }] of present) {
    const row = state.taskRows.get(uid)
    if (duplicated.has(uid)) {
      if (row) hold(uid, 'duplicate_uid', ROW_MESSAGES.duplicate_across_sheets)
      continue
    }
    const issue = issues.get(uid)
    const fp = localFingerprint(task)

    if (!row) {
      if (foreign.has(uid)) {
        // OPEN: a uid that belongs to another workbook (a row copied across workbooks) is not tracked (S12).
        console.warn(`sync: a row of workbook ${wb.id} carries a uid owned by another workbook; not synced`)
        continue
      }
      if (task.level === 1 && (task.parentUid === null || (!state.taskRows.has(task.parentUid) && !created.has(task.parentUid)))) continue
      statements.push(
        db
          .prepare(
            `INSERT INTO tasks (task_uid, sheet_id, parent_uid, level, assign_mode, completed, local_hash, last_local_change_at,
                                sync_state, last_error, last_error_code, pending_actor_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?8)
             ON CONFLICT (task_uid) DO NOTHING`,
          )
          .bind(
            uid,
            sheet.id,
            task.level === 1 ? task.parentUid : null,
            task.level,
            task.assignMode,
            task.completed ? 1 : 0,
            fp,
            at,
            issue ? 'error' : 'pending',
            issue ? issue.message : null,
            issue ? `sheet:${issue.code}` : null,
            actor,
          ),
        ...assigneeStatements(db, uid, task.assignees, at),
      )
      created.set(uid, 'new')
      if (issue) {
        result.held.push(uid)
        continue
      }
      result.pending.push(uid)
      // A subtask waits for its to-do: the consumer queues it once the to-do exists.
      const parentHasId = task.parentUid !== null && (state.taskRows.get(task.parentUid)?.bc_recording_id ?? null) !== null
      if (task.level === 0 || parentHasId) queue.set(uid, actor)
      continue
    }

    if (row.sheet_id !== sheet.id) statements.push(db.prepare(`UPDATE tasks SET sheet_id = ?2 WHERE task_uid = ?1`).bind(uid, sheet.id))

    const deletion = deletions.get(uid)
    if (deletion && (deletion.state === 'executed' || deletion.state === 'covered')) {
      statements.push(
        deletionStateStatement(db, deletion.id, 'undo_requested', at),
        db.prepare(`UPDATE tasks SET sync_state = 'pending', pending_actor_id = ?2, local_hash = ?3, last_local_change_at = ?4 WHERE task_uid = ?1`).bind(uid, actor, fp, at),
      )
      result.undos.push(uid)
      queue.set(uid, actor)
      continue
    }
    if (deletion && deletion.state === 'requested') {
      // Back before Basecamp was touched: nothing to delete any more.
      statements.push(deletionStateStatement(db, deletion.id, 'cancelled', at))
    }
    if (deletion && deletion.state === 'undo_requested') {
      queue.set(uid, row.pending_actor_id ?? actor)
      continue
    }
    if (row.trashed_at !== null) continue

    if (issue) {
      hold(uid, `sheet:${issue.code}`, issue.message)
      statements.push(db.prepare(`UPDATE tasks SET local_hash = ?2 WHERE task_uid = ?1`).bind(uid, fp))
      continue
    }

    const changed = fp !== row.local_hash
    const needsPush = rowNeedsPush(state, sheet, task, sheetTasks, row)
    statements.push(
      db
        .prepare(
          `UPDATE tasks SET local_hash = ?2, completed = ?3,
                  last_local_change_at = CASE WHEN ?4 = 1 THEN ?5 ELSE last_local_change_at END
           WHERE task_uid = ?1`,
        )
        .bind(uid, fp, task.completed ? 1 : 0, changed ? 1 : 0, at),
    )
    if (changed) statements.push(...assigneeStatements(db, uid, task.assignees, at))

    const detectionError = row.sync_state === 'error' && isDetectionCode(row.last_error_code)
    if (needsPush && (changed || detectionError || row.sync_state === 'unlinked')) {
      // §3: an unchanged row keeps the person who edited it as its author.
      const author = changed ? actor : (row.pending_actor_id ?? actor)
      statements.push(
        db
          .prepare(`UPDATE tasks SET sync_state = 'pending', pending_actor_id = ?2, last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`)
          .bind(uid, author),
      )
      result.pending.push(uid)
      queue.set(uid, author)
    } else if (!needsPush && detectionError) {
      statements.push(db.prepare(`UPDATE tasks SET sync_state = 'synced', last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`).bind(uid))
    }
  }

  // --- Rows with an identity problem but no readable row (invalid level, duplicate uid in one sheet).
  for (const [uid, issue] of issues) {
    if (present.has(uid) || !state.taskRows.has(uid)) continue
    hold(uid, `sheet:${issue.code}`, issue.message)
  }

  // --- Rows missing from the snapshot.
  for (const row of state.taskRows.values()) {
    const uid = row.task_uid
    const sheet = state.sheetsById.get(row.sheet_id)
    if (!sheet || !isSyncedSheet(sheet)) continue
    if (present.has(uid) || issues.has(uid) || duplicated.has(uid)) continue
    const unread = unreadable.get(sheet.id)
    if (unread) {
      if (row.trashed_at === null) hold(uid, `sheet:${unread.code}`, unread.message)
      continue
    }
    const deletion = deletions.get(uid)
    if (deletion?.state === 'undo_requested') {
      // Undone, then removed again before the undo ran: the deletion stands.
      statements.push(deletionStateStatement(db, deletion.id, 'executed', at))
      continue
    }
    if (row.trashed_at !== null || deletion) continue
    if (confirmed.has(uid)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO task_deletions (id, task_uid, workbook_id, state, requested_by, requested_at, updated_at)
             VALUES (?1, ?2, ?3, 'requested', ?4, ?5, ?5)`,
          )
          .bind(crypto.randomUUID(), uid, wb.id, actor, at),
        db.prepare(`UPDATE tasks SET sync_state = 'pending', pending_actor_id = ?2, last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`).bind(uid, actor),
      )
      result.deletions.push(uid)
      queue.set(uid, actor)
      continue
    }
    // §9.2.7: never deleted in Basecamp without the person's confirmation.
    if (row.sync_state === 'error' && row.last_error_code === 'row_missing') continue
    hold(uid, 'row_missing', ROW_MESSAGES.row_missing)
  }

  await runBatches(db, statements)
  result.enqueued = await enqueueTasks(
    env,
    wb.id,
    [...queue].map(([uid, author]) => ({ uid, actor: author })),
    now,
  )
  return result
}

/**
 * Does the row hold something Basecamp does not have yet? A row never sent is
 * created; a linked row is compared with its base by the engine itself.
 */
function rowNeedsPush(state: WorkbookState, sheet: SheetRow, task: LocalTask, sheetTasks: readonly LocalTask[], row: TaskRow): boolean {
  if (task.deletedRemotely) return false
  if (task.bcId === null) return true
  const base = baseOfRow(row)
  // Linked to a record but never read (a title match at linking): the consumer fetches it.
  if (base === null) return true
  const outcome = diffTask(task, base, null, diffContextFor(state, sheet, task, sheetTasks))
  return outcome.outbound.length > 0
}

async function uidsElsewhere(db: D1Database, workbookId: string, uids: readonly string[]): Promise<Set<string>> {
  if (uids.length === 0) return new Set()
  const { results } = await db
    .prepare(
      `SELECT t.task_uid FROM tasks t JOIN sheets s ON s.id = t.sheet_id
       WHERE s.workbook_id <> ?1 AND t.task_uid IN (SELECT value FROM json_each(?2))`,
    )
    .bind(workbookId, JSON.stringify(uids))
    .all<{ task_uid: string }>()
  return new Set(results.map((r) => r.task_uid))
}

/**
 * Queues one `bc-outbound` message per task. A queue failure is logged and
 * the rows stay `pending`: reconciliation and «مزامنة الآن» queue them again.
 */
export async function enqueueTasks(
  env: Env,
  workbookId: string,
  entries: ReadonlyArray<{ uid: string; actor: string }>,
  now: () => number = Date.now,
  delaySeconds = OUTBOUND_DELAY_SECONDS,
): Promise<number> {
  const enqueuedAt = new Date(now()).toISOString()
  const messages: MessageSendRequest<BcOutboundMessage>[] = entries.map((e) => ({
    body: { kind: 'task_changed', workbookId, taskUid: e.uid, actorUserId: e.actor, enqueuedAt },
    delaySeconds,
  }))
  let sent = 0
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100)
    try {
      await env.BC_OUTBOUND.sendBatch(chunk)
      sent += chunk.length
    } catch (error) {
      console.error(`sync: bc-outbound send failed (${error instanceof Error ? error.name : 'unknown'}); rows stay pending`)
    }
  }
  return sent
}

/**
 * The save hook: detection after a committed save, never failing the save
 * (spec §9.2: sync problems become row states, not refused saves).
 */
export async function detectAfterSave(env: Env, input: DetectionInput): Promise<void> {
  try {
    await detectOutboundChanges(env, input)
  } catch (error) {
    // Rows keep their state; reconciliation and the next save pick them up.
    console.error(`sync: outbound detection failed for workbook ${input.workbookId} (${error instanceof Error ? error.name : 'unknown'})`)
  }
}

/** `SaveSnapshotRequest.confirmedDeletions`: absent, or an array of uids. `null` when malformed. */
export function parseConfirmedDeletions(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 10_000) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > 128) return null
    out.push(item)
  }
  return out
}
