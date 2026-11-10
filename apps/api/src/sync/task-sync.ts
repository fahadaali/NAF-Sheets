// One sync step for one task row (spec §9.1–§9.3), shared by the outbound
// consumer, the webhook consumer and reconciliation. The executor contract of
// @naf-sheets/sync-engine (its index.ts) is followed item by item:
//
// 1. The Basecamp record is passed when at hand, else fetched here.
// 2. `inbound` is applied to the sheet first; only when every action was
//    applied is `baseFromRemote(record)` stored (a refused action keeps the
//    old base, so the remote change is not lost and nothing is pushed over
//    it). Then `outbound` runs in order, the base after each write is stored,
//    and a created record's id is saved right after the create (§9.1).
// 3. A record without a position keeps the last known one.
// 4. `rewrite_managed_block` is logged only.
// 5. `update_row.fields.assignMode` is stored like any other field.
// 7. Positions are 1-based; one row's reposition at a time.
//
// Writes go out only under the policy given: a person's own token (the
// outbound consumer), never (webhooks and reconciliation read with the
// service token and leave local changes to the actor's own message), or the
// automatic assignment of §8.1 alone.

import { NotFoundError } from '@naf-sheets/basecamp'
import type { BasecampClient } from '@naf-sheets/basecamp'
import type { Assignee, FieldConflict, LocalTask, OutboundAction, RemoteSubtask, RemoteTask, RemoteTodo, SyncedBase } from '@naf-sheets/shared'
import { baseAfterSubtaskWrite, baseAfterTodoWrite, baseFromRemote, baseWith, diffTask, isEcho } from '@naf-sheets/sync-engine'
import type { DiffContext, DiffResult, RemoteState } from '@naf-sheets/sync-engine'
import type { Env } from '../env'
import { syncAttachmentsFromTodo } from '../phase5/attachments-sync'
import { SYSTEM_ACTOR } from './messages'
import { applyToSheet, diffContextFor, diffLocal, readSheet, refusal } from './state'
import type { WorkbookState } from './state'
import type { SheetRow } from './store'
import {
  baseOfRow,
  baseStatement,
  isSyncedSheet,
  markSynced,
  rowErrorStatement,
  runBatches,
  syncLogStatement,
  touchWorkbookSuccess,
} from './store'

/** Who may write to Basecamp in this step. */
export type WritePolicy =
  /** The acting person's own token (§3). */
  | { kind: 'write'; token: string; actor: string }
  /** Read only: local changes stay for the actor's outbound message. */
  | { kind: 'read_only' }
  /**
   * §8.1: only an automatic re-assignment of a to-do from its subtasks may be
   * written; `writer` gives the token (the person who changed the subtask, or
   * the service token as the documented exception) and the logged actor.
   */
  | { kind: 'auto_only'; writer: () => Promise<{ token: string; actor: string } | null> }

export interface TaskStep {
  env: Env
  state: WorkbookState
  uid: string
  client: BasecampClient
  /** Token the record is fetched with. */
  readToken: string
  /** `service`: a 404 means the record is gone. `user`: it may only mean no access (§3), so the row is held instead. */
  readAs: 'user' | 'service'
  /** The record when the caller already has it (webhook, reconciliation); `undefined` to fetch it here. */
  remote?: RemoteState
  policy: WritePolicy
  now: () => string
}

export type StepResult =
  | { status: 'synced'; wroteBasecamp: boolean; created: boolean; assigneesChanged: boolean; level: 0 | 1; parentUid: string | null }
  | { status: 'held'; code: string; message: string }
  /** Local changes remain; they go out with the actor's own message. */
  | { status: 'local_pending' }
  /** The row is not in a synced sheet of the latest snapshot. */
  | { status: 'absent' }
  /** The snapshot write lost every race: try again later. */
  | { status: 'contended' }

/** Thrown when a 404 on a user-token read cannot tell "deleted" from "no access". */
export class RecordUnreachable extends Error {
  override readonly name = 'RecordUnreachable'
}

/** diffTask warnings that hold a row back: nothing is sent and the row shows the message. */
const HOLDING = new Set(['hierarchy_change_unsupported', 'invalid_local_assignees', 'remote_required'])

/** applyInbound issues that leave a Basecamp value out of the sheet. */
export const BLOCKING_ISSUES = new Set(['formula_cell', 'checkbox_formula', 'assignee_name_unknown'])

export async function syncTask(step: TaskStep): Promise<StepResult> {
  const { env, state, uid } = step
  const db = env.DB
  let remote: RemoteState | undefined = step.remote
  let wroteBasecamp = false
  let created = false
  let assigneesChanged = false
  let last: LocalTask | null = null
  /** Phase 5: the files of a to-do record are read once per step. */
  let filesRead = false

  for (let round = 0; round < 3; round++) {
    const row = state.taskRows.get(uid)
    if (!row) return { status: 'absent' }
    const sheet = state.sheetsById.get(row.sheet_id)
    if (!sheet || !isSyncedSheet(sheet) || !state.plans.has(sheet.id)) return { status: 'absent' }
    const read = readSheet(state, sheet)
    if (!read.ok) return hold(db, uid, `sheet:${read.error.code}`, read.error.message)
    const found = read.value.tasks.find((t) => t.uid === uid)
    if (!found) return { status: 'absent' }
    last = found
    const issue = read.value.issues.find((i) => i.uid === uid)
    if (issue) return hold(db, uid, `sheet:${issue.code}`, issue.message)

    const base = baseOfRow(row)
    const local = diffLocal(state, sheet, found, base)
    if (remote === undefined) remote = local.bcId !== null ? await fetchRemote(step, local) : null
    const ctx = diffContextFor(state, sheet, local, read.value.tasks)
    const result = diffTask(local, base, remote, ctx)
    const holding = result.warnings.find((w) => HOLDING.has(w.code))
    if (holding) return hold(db, uid, `engine:${holding.code}`, holding.message)
    for (const w of result.warnings) console.warn(`sync: ${w.code} on a task of workbook ${state.wb.id}`)

    // --- Basecamp's values into the sheet (§9.3.4).
    const at = step.now()
    const statements: D1PreparedStatement[] = []
    if (result.inbound.length > 0) {
      const apply = await applyToSheet(env, state, sheet, result.inbound, SYSTEM_ACTOR, at)
      if (apply.status === 'contended' || apply.status === 'not_found') return { status: 'contended' }
      const moved = state.taskRows.get(uid)
      if (moved && moved.sheet_id !== sheet.id && !isSyncedSheet(state.sheetsById.get(moved.sheet_id) as SheetRow)) {
        // Moved to «غير مصنّف»: no longer synced; nothing else to do for it.
        return { status: 'absent' }
      }
      const refused = refusal(apply)
      // OPEN: a value the sheet could not take (a formula in the cell, a name it does not know):
      // the base is not moved, so the next push cannot revert Basecamp; the row waits (S9).
      const blocked = apply.issues.find((i) => i.uid === uid && BLOCKING_ISSUES.has(i.code))
      if (!refused && blocked) {
        await runBatches(db, [
          rowErrorStatement(db, uid, `inbound:${blocked.code}`, blocked.message),
          syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'in', action: 'apply_blocked', actor: SYSTEM_ACTOR, status: 'error', error: blocked.code }, at),
        ])
        return { status: 'held', code: `inbound:${blocked.code}`, message: blocked.message }
      }
      if (refused) {
        await runBatches(db, [
          rowErrorStatement(db, uid, `sheet:${refused.code}`, refused.message),
          syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'in', action: 'apply_refused', actor: SYSTEM_ACTOR, status: 'error', error: refused.code }, at),
        ])
        return { status: 'held', code: `sheet:${refused.code}`, message: refused.message }
      }
      for (const action of result.inbound) {
        if (action.type === 'update_row' && action.fields.assignees) assigneesChanged = true
        if (action.type === 'rewrite_managed_block') continue
        statements.push(
          syncLogStatement(
            db,
            { workbookId: state.wb.id, taskUid: uid, direction: 'in', action: action.type, newValue: action.type === 'update_row' ? action.fields : action, actor: SYSTEM_ACTOR, status: 'ok' },
            at,
          ),
        )
      }
    }

    // --- The base from the record, once its changes are in the sheet.
    let current: SyncedBase | null = base
    // The list is not part of the echo hash (sync-engine hash.ts): a record that only moved
    // list is an "echo" by hash, yet its base must learn the new list, or a later move back in
    // Basecamp would read as a move made here and be undone.
    const listMovedRemotely = base !== null && remote !== null && remote.type === 'todo' && base.listId !== remote.listId
    if (remote !== null && remote.type !== 'deleted' && (listMovedRemotely || !(base !== null && isEcho(remote, base)))) {
      const changedList = base === null || (remote.type === 'todo' && base.listId !== remote.listId)
      // The row's own position when there is no base or the record changed list (engine
      // contract item 3) — read after the inbound actions, which may have moved the row.
      const lastKnown = changedList ? (positionNow(state, uid) ?? local.position) : base.position
      current = baseFromRemote(uid, remote, lastKnown)
      statements.push(baseStatement(db, uid, current))
      row.last_synced_base_json = JSON.stringify(current)
      row.bc_recording_id = current.bcId
      row.bc_type = current.bcType
    }
    if (remote !== null && remote.type !== 'deleted') {
      // Also on an echo: what reconciliation compares to decide whether to read a to-do again (§9.4).
      statements.push(db.prepare(`UPDATE tasks SET last_remote_change_at = ?2 WHERE task_uid = ?1`).bind(uid, remote.updatedAt))
      row.last_remote_change_at = remote.updatedAt
      if (remote.type === 'todo') {
        statements.push(
          db
            .prepare(`UPDATE tasks SET bc_subtasks_count = ?2, bc_subtasks_completed_count = ?3 WHERE task_uid = ?1`)
            .bind(uid, remote.subtasksCount, remote.subtasksCompletedCount),
        )
        row.bc_subtasks_count = remote.subtasksCount
        row.bc_subtasks_completed_count = remote.subtasksCompletedCount
        // Phase 5: the comment counter (§9.3.5 `comment_created`, §9.4), when Basecamp sent it.
        if (typeof remote.commentsCount === 'number') {
          statements.push(db.prepare(`UPDATE tasks SET bc_comments_count = ?2, bc_comments_seen_at = ?3 WHERE task_uid = ?1`).bind(uid, remote.commentsCount, at))
          row.bc_comments_count = remote.commentsCount
        }
      }
    }
    statements.push(...conflictStatements(db, state, sheet.id, result.conflicts, at))
    for (const action of result.inbound) {
      if (action.type !== 'rewrite_managed_block') continue
      // §8.2: the block edited in Basecamp is rewritten by the update_todo of this same result.
      statements.push(
        syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'in', action: 'rewrite_managed_block', oldValue: action.editedBlockHtml, actor: SYSTEM_ACTOR, status: 'ok' }, at),
      )
    }
    await runBatches(db, statements)

    // --- Phase 5: the files in the to-do's description become chips (§10, inbound).
    if (!filesRead && remote !== null && remote.type === 'todo') {
      filesRead = true
      try {
        await syncAttachmentsFromTodo(env, state, uid, remote, at)
      } catch (error) {
        // Files are not a synced field: they never hold the row's sync back.
        console.error(`sync: attachments of a task in workbook ${state.wb.id} were not read (${error instanceof Error ? error.name : 'unknown'})`)
      }
    }

    // --- Platform → Basecamp.
    const outbound = orderOutbound(result.outbound)
    if (outbound.length === 0) break
    let writer: { token: string; actor: string } | null = null
    if (step.policy.kind === 'read_only') return { status: 'local_pending' }
    if (step.policy.kind === 'auto_only') {
      // Against the base just stored: an untracked notes part follows it (diffLocal).
      if (!isAutoAssignmentOnly(diffLocal(state, sheet, found, current), current, remote, ctx)) return { status: 'local_pending' }
      writer = await step.policy.writer()
      if (writer === null) return { status: 'local_pending' }
    } else {
      writer = { token: step.policy.token, actor: step.policy.actor }
    }

    let createdRecord: RemoteTask | null = null
    for (const action of outbound) {
      const out = await execute(step, writer, action, current)
      current = out.base
      wroteBasecamp = true
      if (out.created) createdRecord = out.created
    }
    if (createdRecord === null) break
    // A created record: completion and position follow in the next diff (engine contract).
    created = true
    remote = createdRecord
  }

  const at = step.now()
  await markSynced(db, uid, at, { completed: last?.completed, clearActor: step.policy.kind === 'write' })
  await touchWorkbookSuccess(db, state.wb.id, at)
  const row = state.taskRows.get(uid)
  if (row) {
    row.sync_state = 'synced'
    row.last_error = null
    row.last_error_code = null
  }
  return { status: 'synced', wroteBasecamp, created, assigneesChanged, level: last?.level ?? 0, parentUid: last?.parentUid ?? null }
}

/** The row's 1-based position in the sheet it is in now (after any move), from the current snapshot. */
function positionNow(state: WorkbookState, uid: string): number | null {
  const row = state.taskRows.get(uid)
  const sheet = row ? state.sheetsById.get(row.sheet_id) : undefined
  if (!sheet || !state.plans.has(sheet.id)) return null
  const read = readSheet(state, sheet)
  return read.ok ? (read.value.tasks.find((t) => t.uid === uid)?.position ?? null) : null
}

async function hold(db: D1Database, uid: string, code: string, message: string): Promise<StepResult> {
  await rowErrorStatement(db, uid, code, message).run()
  return { status: 'held', code, message }
}

async function fetchRemote(step: TaskStep, local: LocalTask): Promise<RemoteState> {
  const id = local.bcId as number
  try {
    return local.level === 0 ? await step.client.todos.get(step.readToken, id) : await step.client.subtasks.get(step.readToken, id)
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
    if (step.readAs === 'service') return { type: 'deleted' }
    // OPEN: with a person's token a 404 may be "no access" (§3): the row is held, never marked deleted (S18).
    throw new RecordUnreachable('record not found with the user token')
  }
}

/**
 * Repositions after the other writes, in ascending position (engine contract item 7).
 * OPEN: a row inserted mid-sheet repositions every row after it, one call each (S26).
 */
function orderOutbound(actions: readonly OutboundAction[]): OutboundAction[] {
  const others = actions.filter((a) => a.type !== 'reposition')
  const moves = actions.filter((a): a is Extract<OutboundAction, { type: 'reposition' }> => a.type === 'reposition').sort((a, b) => a.position - b.position)
  return [...others, ...moves]
}

/**
 * §8.1 exception check: with the to-do's own assignees taken as they were at
 * the last sync, nothing would be sent, so the only change is the automatic
 * union of its subtasks' assignees.
 */
export function isAutoAssignmentOnly(local: LocalTask, base: SyncedBase | null, remote: RemoteState, ctx: DiffContext): boolean {
  if (local.level !== 0 || local.assignMode !== 'auto' || base === null) return false
  const assignees: Assignee[] = base.bcAssigneeIds.map((id) => ({ kind: 'bc_person', bcPersonId: id, source: 'manual' }))
  const neutral: LocalTask = { ...local, assignees, assignMode: 'manual' }
  const without: DiffResult = diffTask(neutral, base, remote, { ...ctx, autoAssign: undefined })
  return without.outbound.length === 0
}

/** Executes one outbound action; returns the base to store after it (engine contract item 2). */
async function execute(
  step: TaskStep,
  writer: { token: string; actor: string },
  action: OutboundAction,
  base: SyncedBase | null,
): Promise<{ base: SyncedBase; created: RemoteTask | null }> {
  const { env, state, uid, client } = step
  const db = env.DB
  const token = writer.token
  let next: SyncedBase
  let created: RemoteTask | null = null
  const need = (): SyncedBase => {
    if (base === null) throw new Error(`sync: ${action.type} without a base`)
    return base
  }

  switch (action.type) {
    case 'create_todo':
    case 'create_subtask': {
      // Idempotency (§9.1): never create a row that already has a Basecamp id.
      const fresh = await db.prepare(`SELECT bc_recording_id AS id FROM tasks WHERE task_uid = ?1`).bind(uid).first<{ id: number | null }>()
      if (fresh?.id) throw new Error('sync: create refused, the row already has a Basecamp id')
      if (action.type === 'create_todo') {
        const response: RemoteTodo = await client.todos.create(token, action.listId, action.write)
        next = baseAfterTodoWrite(uid, response, action.write, action.position)
        created = response
      } else {
        const response: RemoteSubtask = await client.subtasks.create(token, action.parentTodoId, action.create)
        next = baseAfterSubtaskWrite(uid, response, action.create, action.position)
        created = response
      }
      // Saved before anything else can fail: a retry must find it (§9.1).
      const saved = await db
        .prepare(
          `UPDATE tasks SET bc_recording_id = ?2, bc_type = ?3, last_synced_base_json = ?4, last_synced_hash = ?5, last_remote_change_at = ?6
           WHERE task_uid = ?1 AND bc_recording_id IS NULL`,
        )
        .bind(uid, next.bcId, next.bcType, JSON.stringify(next), next.hash, next.remoteUpdatedAt)
        .run()
      if (saved.meta.changes !== 1) console.error(`sync: created record ${next.bcId} could not be saved on its row`)
      break
    }
    case 'update_todo': {
      const response = await client.todos.update(token, action.todoId, action.write)
      next = baseAfterTodoWrite(uid, response, action.write, need().position)
      break
    }
    case 'update_subtask': {
      const response = await client.subtasks.update(token, action.subtaskId, action.patch)
      next = baseAfterSubtaskWrite(uid, response, action.patch, need().position)
      break
    }
    case 'set_completion': {
      if (action.bcType === 'todo') await (action.completed ? client.todos.complete(token, action.bcId) : client.todos.uncomplete(token, action.bcId))
      else await (action.completed ? client.subtasks.complete(token, action.bcId) : client.subtasks.uncomplete(token, action.bcId))
      next = baseWith(need(), { completed: action.completed })
      break
    }
    case 'reposition': {
      if (action.bcType === 'todo') await client.todos.reposition(token, action.bcId, action.position, action.listId)
      else await client.subtasks.reposition(token, action.bcId, action.position)
      next = baseWith(need(), action.listId !== undefined ? { position: action.position, listId: action.listId } : { position: action.position })
      break
    }
    case 'trash_todo':
      await client.todos.trash(token, action.todoId)
      next = need()
      break
    case 'untrash_todo':
      await client.todos.untrash(token, action.todoId)
      next = need()
      break
    case 'delete_subtask':
      // Only through the confirmed-deletion path (deletion.ts), which stores the snapshot first.
      throw new Error('sync: delete_subtask outside the deletion path')
  }

  const at = step.now()
  const row = state.taskRows.get(uid)
  if (row) {
    row.last_synced_base_json = JSON.stringify(next)
    row.bc_recording_id = next.bcId
    row.bc_type = next.bcType
  }
  await runBatches(db, [
    baseStatement(db, uid, next),
    syncLogStatement(db, { workbookId: state.wb.id, taskUid: uid, direction: 'out', action: action.type, newValue: logged(action), actor: writer.actor, status: 'ok' }, at),
  ])
  return { base: next, created }
}

function logged(action: OutboundAction): unknown {
  switch (action.type) {
    case 'create_todo':
    case 'update_todo':
      return { ...action.write }
    case 'create_subtask':
      return action.create
    case 'update_subtask':
      return action.patch
    default:
      return action
  }
}

/** Conflicts: stored for the conflicts routes and logged (§9.1). */
export function conflictStatements(db: D1Database, state: WorkbookState, sheetId: string, conflicts: readonly FieldConflict[], at: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = []
  for (const c of conflicts) {
    out.push(
      db
        .prepare(
          `INSERT INTO sync_conflicts (id, workbook_id, sheet_id, task_uid, field, local_value_json, remote_value_json, winner, local_changed_at, remote_updated_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .bind(
          crypto.randomUUID(),
          state.wb.id,
          sheetId,
          c.uid,
          c.field,
          JSON.stringify(c.localValue ?? null),
          JSON.stringify(c.remoteValue ?? null),
          c.winner,
          c.localChangedAt,
          c.remoteUpdatedAt,
          at,
        ),
      syncLogStatement(
        db,
        { workbookId: state.wb.id, taskUid: c.uid, direction: 'in', action: 'conflict', field: c.field, oldValue: c.localValue, newValue: c.remoteValue, actor: SYSTEM_ACTOR, status: 'conflict', error: `winner:${c.winner}` },
        at,
      ),
    )
  }
  return out
}
