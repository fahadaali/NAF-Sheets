// Adding or removing a file in a to-do's description in Basecamp (spec §10),
// with the acting person's own token (§3).
//
// `PUT /todos/{id}.json` clears every field it does not carry (§9.2.4), so the
// to-do is read fresh first and the PUT carries all of it again: content,
// assignees, completion subscribers, dates — and the full description, with
// only the one `<bc-attachment>` added at the end of the person's part (or
// removed from it). The managed block and everything else are sent back byte
// for byte; `notify` is false (nothing new to tell the assignees).
//
// The step holds the task's sync lease (the outbound consumer and the webhook
// consumer hold the same one), so no other write to the same to-do can come in
// between the read and the PUT. Right after the PUT the ordinary sync step
// runs on Basecamp's answer, read-only: the sheet's notes cell and the 3-way
// base learn the new description, so no later diff takes the file out again.

import type { BasecampClient } from '@naf-sheets/basecamp'
import type { RemoteTodo, TodoWrite } from '@naf-sheets/shared'
import { appendAttachment, composeDescription, removeAttachment, splitDescription } from '@naf-sheets/sync-engine'
import type { Env } from '../env'
import type { SyncDeps } from '../sync/deps'
import { loadWorkbookState } from '../sync/state'
import { acquireLease, getTask, releaseLease, runBatches, syncLogStatement } from '../sync/store'
import type { WorkbookSyncRow } from '../sync/store'
import { syncTask } from '../sync/task-sync'
import { Phase5Failure } from './errors'

export type DescriptionChange = { kind: 'add'; sgid: string } | { kind: 'remove'; sgid: string }

const LEASE_TRIES = 6
const LEASE_WAIT_MS = 500

async function withLease<T>(env: Env, deps: SyncDeps, uid: string, fn: () => Promise<T>): Promise<T> {
  const leaseId = crypto.randomUUID()
  let held = false
  for (let i = 0; i < LEASE_TRIES && !held; i++) {
    held = await acquireLease(env.DB, uid, leaseId, deps.now())
    if (!held && i < LEASE_TRIES - 1) await (deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(LEASE_WAIT_MS)
  }
  if (!held) throw new Phase5Failure('task_busy')
  try {
    return await fn()
  } finally {
    await releaseLease(env.DB, uid, leaseId)
  }
}

export interface DescriptionStep {
  env: Env
  deps: SyncDeps
  client: BasecampClient
  /** The acting person's own token (§3). */
  token: string
  /** members.user_id of the acting person, for sync_log. */
  actor: string
  wb: WorkbookSyncRow
  uid: string
  change: DescriptionChange
  /** Runs after Basecamp accepted the PUT (or when nothing had to change), before the sheet catches up. */
  onWritten?: () => Promise<void>
}

/**
 * Sends the to-do's description again with `change`. Returns `unchanged` when
 * the file was already in it (add) or already gone (remove): nothing is sent.
 * Basecamp errors are thrown as they are (the caller decides what they mean).
 */
export async function changeTodoDescription(step: DescriptionStep): Promise<'changed' | 'unchanged'> {
  const { env, deps, client, token, actor, wb, uid, change } = step
  const now = () => new Date(deps.now()).toISOString()
  return withLease(env, deps, uid, async () => {
    const task = await getTask(env.DB, uid)
    if (!task || task.level !== 0 || task.bc_recording_id === null) throw new Phase5Failure('task_not_in_basecamp')
    const todoId = task.bc_recording_id
    const current: RemoteTodo = await client.todos.get(token, todoId)
    if (current.status !== 'active') throw new Phase5Failure('task_deleted_remotely')
    const { human, block } = splitDescription(current.descriptionHtml)
    const nextHuman = change.kind === 'add' ? appendAttachment(human, change.sgid) : removeAttachment(human, change.sgid).html
    let record: RemoteTodo = current
    let outcome: 'changed' | 'unchanged' = 'unchanged'
    if (nextHuman !== human) {
      // §9.2.4: every field, from the record just read; only the person's part of the description changes.
      const write: TodoWrite = {
        content: current.content,
        descriptionHtml: composeDescription(nextHuman, block),
        assigneeIds: [...current.assigneeIds],
        completionSubscriberIds: [...current.completionSubscriberIds],
        dueOn: current.dueOn,
        startsOn: current.startsOn,
        notify: false,
      }
      record = await client.todos.update(token, todoId, write)
      outcome = 'changed'
      await runBatches(env.DB, [
        syncLogStatement(
          env.DB,
          { workbookId: wb.id, taskUid: uid, direction: 'out', action: change.kind === 'add' ? 'attach_file' : 'detach_file', newValue: { sgid: change.sgid }, actor, status: 'ok' },
          now(),
        ),
      ])
    }
    await step.onWritten?.()
    // The sheet and the base learn Basecamp's description (read-only: no other change goes out here).
    const state = await loadWorkbookState(env, wb)
    if (state) {
      const result = await syncTask({ env, state, uid, client, readToken: token, readAs: 'user', remote: record, policy: { kind: 'read_only' }, now })
      if (result.status === 'held' || result.status === 'contended') {
        console.warn(`phase5: the sheet did not take the new description of a task in workbook ${wb.id} (${result.status}); the next read retries`)
      }
    }
    return outcome
  })
}
