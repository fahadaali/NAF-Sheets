import { describe, expect, it } from 'vitest'
import { ERROR_MESSAGES, planDeletion, recreateSubtaskFromSnapshot } from '../src'
import { BADR, remoteSubtask, SUBTASK_ID, TODO_ID } from './fixtures'

const todo = { uid: 'p', level: 0 as const, parentUid: null }
const sub = { uid: 's', level: 1 as const, parentUid: 'p' }

describe('planDeletion (§9.2.7)', () => {
  it('trashes a to-do (recoverable)', () => {
    expect(planDeletion([{ task: todo, bcId: TODO_ID }])).toEqual({
      ok: true,
      value: [{ type: 'trash_todo', uid: 'p', todoId: TODO_ID }],
    })
  })

  it('deletes a subtask with a full snapshot, copied so later changes cannot alter it', () => {
    const snapshot = remoteSubtask({ assigneeIds: [BADR] })
    const result = planDeletion([{ task: sub, bcId: SUBTASK_ID, remoteSubtask: snapshot }])
    expect(result).toEqual({ ok: true, value: [{ type: 'delete_subtask', uid: 's', subtaskId: SUBTASK_ID, snapshot }] })
    snapshot.assigneeIds.push(999)
    if (result.ok && result.value[0]?.type === 'delete_subtask') expect(result.value[0].snapshot.assigneeIds).toEqual([BADR])
  })

  it('refuses everything when a synced subtask has no snapshot (or the wrong one)', () => {
    const missing = planDeletion([{ task: todo, bcId: TODO_ID }, { task: { ...sub, parentUid: 'other' }, bcId: SUBTASK_ID }])
    expect(missing).toEqual({ ok: false, error: { code: 'snapshot_required', message: ERROR_MESSAGES.snapshot_required } })
    const wrong = planDeletion([{ task: sub, bcId: SUBTASK_ID, remoteSubtask: remoteSubtask({ id: 1 }) }])
    expect(wrong.ok).toBe(false)
  })

  it('a row that never reached Basecamp needs no action', () => {
    expect(planDeletion([{ task: todo, bcId: null }, { task: sub, bcId: null }])).toEqual({ ok: true, value: [] })
  })
})

describe('recreateSubtaskFromSnapshot', () => {
  it('re-creates a deleted subtask as a new one under the same to-do', () => {
    const snapshot = remoteSubtask({ position: 3, completed: true })
    expect(recreateSubtaskFromSnapshot(snapshot, 's')).toEqual({
      type: 'create_subtask',
      uid: 's',
      parentTodoId: TODO_ID,
      create: { title: snapshot.title, dueOn: snapshot.dueOn, assigneeIds: snapshot.assigneeIds },
      position: 3,
    })
  })
})
