// Confirmed row deletions and their undo (spec §9.2.7, §16 scenarios 3, 10).
//
// Runs only for a row the person removed AND confirmed (`confirmedDeletions`),
// with that person's own token, after checking the row is still absent from
// the latest snapshot.
// - To-do → Basecamp's trash (recoverable). Its subtasks go with it.
// - Subtask → permanent DELETE: the full record is fetched and stored in the
//   platform's log (sync_log + task_deletions.snapshot_json) BEFORE the call.
// - Undo (the uid is back in the sheet): the to-do comes back from the trash,
//   never created again; the subtask is re-created from its snapshot as a new
//   subtask (a new Basecamp id).

import type { BasecampClient } from '@naf-sheets/basecamp'
import type { OutboundAction, RemoteSubtask } from '@naf-sheets/shared'
import { baseAfterSubtaskWrite, planDeletion, recreateSubtaskFromSnapshot, undoDeletion } from '@naf-sheets/sync-engine'
import type { DeletionAction } from '@naf-sheets/sync-engine'
import { auditStatement } from '../../audit'
import type { Env } from '../../env'
import { ROW_MESSAGES } from '../messages'
import { readSheet } from '../state'
import type { WorkbookState } from '../state'
import { baseStatement, deletionStateStatement, openDeletion, rowErrorStatement, runBatches, syncLogStatement } from '../store'
import type { DeletionRow } from '../store'

export interface DeletionStep {
  env: Env
  state: WorkbookState
  client: BasecampClient
  token: string
  actor: string
  uid: string
  deletion: DeletionRow
  now: () => string
}

/** Is the row in its sheet of the latest snapshot? `null`: the sheet cannot be read. */
function rowPosition(state: WorkbookState, uid: string): { present: boolean; position: number | null } | null {
  const row = state.taskRows.get(uid)
  const sheet = row ? state.sheetsById.get(row.sheet_id) : undefined
  if (!row || !sheet) return { present: false, position: null }
  const read = readSheet(state, sheet)
  if (!read.ok) return read.error.code === 'sheet_not_found' ? { present: false, position: null } : null
  const task = read.value.tasks.find((t) => t.uid === uid)
  return { present: task !== undefined, position: task?.position ?? null }
}

export type DeletionResult = 'executed' | 'covered' | 'present' | 'held'

export async function runDeletion(step: DeletionStep): Promise<DeletionResult> {
  const { env, state, client, token, actor, uid, deletion } = step
  const db = env.DB
  const row = state.taskRows.get(uid)
  if (!row) return 'held'
  const where = rowPosition(state, uid)
  if (where === null) return 'held'
  const at = step.now()
  if (where.present) {
    // Restored before it was deleted: nothing to delete.
    await deletionStateStatement(db, deletion.id, 'cancelled', at).run()
    return 'present'
  }

  if (row.level === 1 && row.parent_uid !== null) {
    const parent = await openDeletion(db, row.parent_uid)
    if (parent && (parent.state === 'requested' || parent.state === 'executed')) {
      // Goes to the trash with its to-do; never deleted on its own.
      await runBatches(db, [
        deletionStateStatement(db, deletion.id, 'covered', at, { coveredBy: row.parent_uid }),
        db
          .prepare(`UPDATE tasks SET trashed_at = ?2, remote_status = 'trashed', sync_state = 'synced', last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`)
          .bind(uid, at),
      ])
      return 'covered'
    }
  }

  const bcId = row.bc_recording_id
  const audit = (action: string, details: unknown) =>
    auditStatement(db, { actorId: actor, action, entityType: 'task', entityId: uid, workbookId: state.wb.id, details }, at)

  if (bcId === null) {
    // Never reached Basecamp: nothing to delete there.
    await runBatches(db, [
      deletionStateStatement(db, deletion.id, 'executed', at),
      db.prepare(`UPDATE tasks SET trashed_at = ?2, sync_state = 'synced', last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`).bind(uid, at),
      audit('task.delete', { bcId: null }),
    ])
    return 'executed'
  }

  if (row.level === 0) {
    const plan = planDeletion([{ task: { uid, level: 0, parentUid: null }, bcId }])
    const action = plan.ok ? plan.value[0] : undefined
    if (!action || action.type !== 'trash_todo') return 'held'
    await client.todos.trash(token, action.todoId)
    const children = [...state.taskRows.values()].filter((r) => r.parent_uid === uid && r.trashed_at === null)
    const statements: D1PreparedStatement[] = [
      deletionStateStatement(db, deletion.id, 'executed', at, { action }),
      db
        .prepare(`UPDATE tasks SET trashed_at = ?2, remote_status = 'trashed', sync_state = 'synced', last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`)
        .bind(uid, at),
      syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'out', action: 'trash_todo', newValue: action, actor, status: 'ok' }, at),
      audit('task.delete', { bcType: 'todo', bcId, trash: true }),
    ]
    for (const child of children) {
      const childWhere = rowPosition(state, child.task_uid)
      // OPEN: a subtask row still in the sheet went to the trash with its to-do in Basecamp; it is left as it is (S27).
      if (childWhere?.present) continue
      const open = await openDeletion(db, child.task_uid)
      statements.push(
        db.prepare(`UPDATE tasks SET trashed_at = ?2, remote_status = 'trashed', sync_state = 'synced' WHERE task_uid = ?1`).bind(child.task_uid, at),
        open
          ? deletionStateStatement(db, open.id, 'covered', at, { coveredBy: uid })
          : db
              .prepare(
                `INSERT INTO task_deletions (id, task_uid, workbook_id, state, requested_by, requested_at, covered_by_uid, executed_at, updated_at)
                 VALUES (?1, ?2, ?3, 'covered', ?4, ?5, ?6, ?5, ?5)`,
              )
              .bind(crypto.randomUUID(), child.task_uid, state.wb.id, actor, at, uid),
      )
    }
    await runBatches(db, statements)
    row.trashed_at = at
    return 'executed'
  }

  // Subtask: fetch the full record, keep it, then delete for good.
  const snapshot: RemoteSubtask = await client.subtasks.get(token, bcId)
  const plan = planDeletion([{ task: { uid, level: 1, parentUid: row.parent_uid }, bcId, remoteSubtask: snapshot }])
  const action = plan.ok ? plan.value[0] : undefined
  if (!action || action.type !== 'delete_subtask') {
    await rowErrorStatement(db, uid, 'snapshot_required', ROW_MESSAGES.snapshot_required).run()
    return 'held'
  }
  await runBatches(db, [
    syncLogStatement(
      db,
      { workbookId: state.wb.id, taskUid: uid, direction: 'out', action: 'delete_subtask_snapshot', oldValue: action.snapshot, actor, status: 'ok' },
      at,
    ),
    deletionStateStatement(db, deletion.id, 'requested', at, { action, snapshot: action.snapshot }),
  ])
  await client.subtasks.deletePermanently(token, action.subtaskId, action.snapshot)
  await runBatches(db, [
    deletionStateStatement(db, deletion.id, 'executed', at),
    db
      .prepare(`UPDATE tasks SET trashed_at = ?2, remote_status = 'deleted', sync_state = 'synced', last_error = NULL, last_error_code = NULL WHERE task_uid = ?1`)
      .bind(uid, at),
    syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'out', action: 'delete_subtask', newValue: { subtaskId: action.subtaskId }, actor, status: 'ok' }, at),
    audit('task.delete', { bcType: 'subtask', bcId, permanent: true }),
  ])
  row.trashed_at = at
  return 'executed'
}

export type UndoResult = 'undone' | 'absent' | 'waiting' | 'held'

/** The row is back (Ctrl+Z): bring the record back before the row is diffed again (engine contract item 8). */
export async function runUndo(step: DeletionStep): Promise<UndoResult> {
  const { env, state, client, token, actor, uid, deletion } = step
  const db = env.DB
  const row = state.taskRows.get(uid)
  if (!row) return 'held'
  const where = rowPosition(state, uid)
  if (where === null) return 'held'
  const at = step.now()
  if (!where.present) {
    await deletionStateStatement(db, deletion.id, 'executed', at).run()
    return 'absent'
  }
  const action = deletion.action_json ? (JSON.parse(deletion.action_json) as OutboundAction) : null
  const restore = (extra: D1PreparedStatement[] = []) =>
    runBatches(db, [
      deletionStateStatement(db, deletion.id, 'undone', at),
      db.prepare(`UPDATE tasks SET trashed_at = NULL, remote_status = 'active' WHERE task_uid = ?1`).bind(uid),
      auditStatement(db, { actorId: actor, action: 'task.restore', entityType: 'task', entityId: uid, workbookId: state.wb.id, details: { undo: action?.type ?? null } }, at),
      ...extra,
    ])

  if (row.level === 0) {
    const statements: D1PreparedStatement[] = []
    if (action && action.type === 'trash_todo') {
      const back = undoDeletion(action as DeletionAction, { uid, position: where.position ?? 1 })
      if (back.type === 'untrash_todo') {
        await client.todos.untrash(token, back.todoId)
        statements.push(syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'out', action: 'untrash_todo', newValue: back, actor, status: 'ok' }, at))
      }
    }
    // Its subtasks came back from the trash with it.
    const { results } = await db
      .prepare(`SELECT id, task_uid FROM task_deletions WHERE covered_by_uid = ?1 AND state IN ('covered', 'undo_requested')`)
      .bind(uid)
      .all<{ id: string; task_uid: string }>()
    for (const child of results) {
      statements.push(
        deletionStateStatement(db, child.id, 'undone', at),
        db.prepare(`UPDATE tasks SET trashed_at = NULL, remote_status = 'active' WHERE task_uid = ?1`).bind(child.task_uid),
      )
      const childRow = state.taskRows.get(child.task_uid)
      if (childRow) {
        childRow.trashed_at = null
        childRow.remote_status = 'active'
      }
    }
    await restore(statements)
    row.trashed_at = null
    row.remote_status = 'active'
    return 'undone'
  }

  if (deletion.covered_by_uid !== null) {
    // It went to the trash with its to-do and comes back with it.
    const parent = await openDeletion(db, deletion.covered_by_uid)
    if (parent && parent.state !== 'undone') return 'waiting'
    await restore()
    row.trashed_at = null
    row.remote_status = 'active'
    return 'undone'
  }

  // Re-created as a new subtask: the old id and base are dropped first (engine contract item 8).
  await db
    .prepare(
      `UPDATE tasks SET bc_recording_id = NULL, bc_type = NULL, last_synced_base_json = NULL, last_synced_hash = NULL,
              trashed_at = NULL, remote_status = 'active' WHERE task_uid = ?1`,
    )
    .bind(uid)
    .run()
  row.bc_recording_id = null
  row.bc_type = null
  row.last_synced_base_json = null
  row.last_synced_hash = null
  row.trashed_at = null
  row.remote_status = 'active'
  if (action && action.type === 'delete_subtask') {
    const parentTodoId = (row.parent_uid !== null ? state.taskRows.get(row.parent_uid)?.bc_recording_id : null) ?? action.snapshot.todoId
    const create = recreateSubtaskFromSnapshot(action.snapshot, { uid, position: where.position ?? 1 }, parentTodoId)
    if (create.type !== 'create_subtask') return 'held'
    const response = await client.subtasks.create(token, create.parentTodoId, create.create)
    const base = baseAfterSubtaskWrite(uid, response, create.create, create.position)
    await runBatches(db, [
      baseStatement(db, uid, base),
      syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'out', action: 'create_subtask', newValue: { ...create.create, undo: true }, actor, status: 'ok' }, at),
    ])
    row.bc_recording_id = base.bcId
    row.bc_type = 'subtask'
    row.last_synced_base_json = JSON.stringify(base)
  }
  // Without a snapshot (never reached Basecamp, or already gone), the row's own diff creates it.
  await restore()
  return 'undone'
}
