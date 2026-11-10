// Row deletion (spec §9.2.7). Runs only after the user confirmed the dialog.
// - To-do → Basecamp trash (recoverable); undo brings the same record back
//   from the trash (§16 scenario 3).
// - Subtask → permanent DELETE, so the full record travels with the action as
//   a snapshot; undo re-creates it as a new subtask (§16 scenario 10).
// - A to-do with subtasks → only the to-do is trashed; its subtasks go with it,
//   and come back with it.

import type { LocalTask, OutboundAction, RemoteSubtask, TaskUid } from '@naf-sheets/shared'
import { fail, ok, type Result } from './errors'

export interface DeletionRequest {
  task: Pick<LocalTask, 'uid' | 'level' | 'parentUid'>
  /** `tasks.bc_recording_id`; `null` when the row never reached Basecamp. */
  bcId: number | null
  /** Subtask: the record as just fetched from Basecamp. Required to delete a synced subtask. */
  remoteSubtask?: RemoteSubtask | null
}

function copySubtask(s: RemoteSubtask): RemoteSubtask {
  return { ...s, assigneeIds: [...s.assigneeIds] }
}

/**
 * Actions for deleting the given rows together. All or nothing: if one synced
 * subtask has no snapshot, nothing is planned and the error says what to do.
 */
export function planDeletion(requests: readonly DeletionRequest[]): Result<OutboundAction[]> {
  const deleting = new Set<TaskUid>(requests.map((r) => r.task.uid))
  const actions: OutboundAction[] = []
  for (const r of requests) {
    if (r.bcId === null) continue // never synced: nothing in Basecamp
    if (r.task.level === 0) {
      actions.push({ type: 'trash_todo', uid: r.task.uid, todoId: r.bcId })
      continue
    }
    if (r.task.parentUid !== null && deleting.has(r.task.parentUid)) continue // trashed with its to-do
    const snapshot = r.remoteSubtask
    if (!snapshot || snapshot.id !== r.bcId) return fail('snapshot_required')
    actions.push({ type: 'delete_subtask', uid: r.task.uid, subtaskId: r.bcId, snapshot: copySubtask(snapshot) })
  }
  return ok(actions)
}

/**
 * Undo of a subtask deletion: Basecamp has no trash for subtasks, so the
 * snapshot becomes a new subtask (a new Basecamp id) under the same to-do, at
 * the restored row's position — where the diff of that row would create it
 * too (the snapshot may carry no position: single-record GET).
 * The restored row must have no base and no `bcId`; if the snapshot was
 * completed, the next diff sends `set_completion` once the new id exists.
 */
export function recreateSubtaskFromSnapshot(
  snapshot: RemoteSubtask,
  row: Pick<LocalTask, 'uid' | 'position'>,
  parentTodoId: number = snapshot.todoId,
): OutboundAction {
  return {
    type: 'create_subtask',
    uid: row.uid,
    parentTodoId,
    create: { title: snapshot.title, dueOn: snapshot.dueOn, assigneeIds: [...snapshot.assigneeIds] },
    position: row.position,
  }
}

/** What `planDeletion` produces, and what an undo reverses. */
export type DeletionAction = Extract<OutboundAction, { type: 'trash_todo' | 'delete_subtask' }>

/**
 * Undo (Ctrl+Z) of one deletion that was executed, for the row the undo
 * brought back (same uid):
 * - `trash_todo` → `untrash_todo`: the same to-do, with its subtasks, comes
 *   back from the trash; it is never created again (§16 scenario 3). The row
 *   keeps its `bcId` and base.
 * - `delete_subtask` → `create_subtask` from the snapshot (§16 scenario 10).
 * A deletion that was never executed has nothing to undo in Basecamp.
 * OPEN: untrashing relies on Basecamp's "unarchive" endpoint restoring from
 * the trash, and on the executor running it before the row is diffed again
 * (OPEN_QUESTIONS.md #16).
 */
export function undoDeletion(action: DeletionAction, row: Pick<LocalTask, 'uid' | 'position'>): OutboundAction {
  if (row.uid !== action.uid) throw new Error('undoDeletion: the row is not the one the action deleted')
  if (action.type === 'trash_todo') return { type: 'untrash_todo', uid: action.uid, todoId: action.todoId }
  return recreateSubtaskFromSnapshot(action.snapshot, row)
}
