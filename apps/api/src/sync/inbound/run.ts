// Basecamp → sheet for one workbook, shared by the webhook consumer and
// reconciliation (spec §9.3, §9.4). Every Basecamp call here is a read with
// the service token; the single write is §8.1's automatic re-assignment of a
// to-do from its subtasks (the person's own token when they linked their
// account, else the service token as the documented exception, logged
// «قاعدة تلقائية»).

import { NormaliseError, NotFoundError, normaliseSubtask } from '@naf-sheets/basecamp'
import type { BasecampClient, RawTodo } from '@naf-sheets/basecamp'
import type { InboundAction, RemoteSubtask, RemoteTodo } from '@naf-sheets/shared'
import { baseFromRemote, inboundCreateRow } from '@naf-sheets/sync-engine'
import type { RemoteState } from '@naf-sheets/sync-engine'
import { refreshAccountPeople, withUserToken } from '../../basecamp-link'
import type { LinkContext } from '../../basecamp-link'
import { storeProjectPeople } from '../../basecamp-link/people'
import type { Env } from '../../env'
import type { SyncDeps } from '../deps'
import { enqueueTasks } from '../detect'
import { loadDirectory } from '../directory'
import { AUTO_RULE_ACTOR, SYSTEM_ACTOR } from '../messages'
import { applyToSheet, readSheet, refreshSnapshotIfStale } from '../state'
import type { WorkbookState } from '../state'
import { acquireLease, assigneeStatements, getTask, releaseLease, runBatches, syncLogStatement } from '../store'
import type { SheetRow, TaskRow } from '../store'
import { BLOCKING_ISSUES, syncTask } from '../task-sync'
import type { StepResult } from '../task-sync'
import type { RunBudget } from './reconcile'

export interface InboundRun {
  env: Env
  deps: SyncDeps
  ctx: LinkContext
  /** The service token. */
  token: string
  client: BasecampClient
  state: WorkbookState
  now: () => string
  /** People caches are refreshed at most once per run. */
  namesRefreshed: boolean
  /** The cron run's budget and counters (reconciliation only). */
  budget?: RunBudget
}

/** Another step holds the task: the webhook message is retried, reconciliation moves on. */
export class TaskBusy extends Error {
  override readonly name = 'TaskBusy'
}

export function rowByBcId(state: WorkbookState, bcId: number): TaskRow | null {
  for (const row of state.taskRows.values()) if (row.bc_recording_id === bcId) return row
  return null
}

/** One leased, read-only step: the row's D1 state and the snapshot are re-read first. */
export async function inboundStep(run: InboundRun, uid: string, remote: RemoteState): Promise<StepResult> {
  const { env, state } = run
  const leaseId = crypto.randomUUID()
  if (!(await acquireLease(env.DB, uid, leaseId, run.deps.now()))) throw new TaskBusy(uid)
  try {
    const fresh = await getTask(env.DB, uid)
    if (!fresh) return { status: 'absent' }
    state.taskRows.set(uid, fresh)
    if (!(await refreshSnapshotIfStale(env, state))) return { status: 'contended' }
    return await syncTask({ env, state, uid, client: run.client, readToken: run.token, readAs: 'service', remote, policy: { kind: 'read_only' }, now: run.now })
  } finally {
    await releaseLease(env.DB, uid, leaseId)
  }
}

/**
 * Makes sure every Basecamp person in `ids` has a name before rows are
 * written: a name the sheet cannot show would leave the cell behind
 * Basecamp. Refreshes the project and account caches once per run.
 */
export async function ensureNames(run: InboundRun, ids: Iterable<number>): Promise<void> {
  const known = run.state.directory.block.personNames
  const missing = [...ids].some((id) => !known.has(id))
  if (!missing || run.namesRefreshed || run.state.wb.bc_project_id === null) return
  run.namesRefreshed = true
  const at = run.now()
  try {
    const people = await run.client.people.listProject(run.token, run.state.wb.bc_project_id).all()
    await storeProjectPeople(run.env.DB, run.state.wb.bc_project_id, people, at)
  } catch (error) {
    console.warn(`sync: project people refresh failed (${error instanceof Error ? error.name : 'unknown'})`)
  }
  try {
    await refreshAccountPeople(run.ctx)
  } catch (error) {
    console.warn(`sync: account people refresh failed (${error instanceof Error ? error.name : 'unknown'})`)
  }
  run.state.directory = await loadDirectory(run.env.DB, run.state.wb.bc_project_id)
}

/** All subtasks of a to-do: `steps` holds the first 100 only (§9.4); more come from `subtasks_url`. */
export async function subtasksOf(run: InboundRun, raw: RawTodo): Promise<RemoteSubtask[]> {
  const steps = Array.isArray(raw.steps) ? raw.steps : []
  const count = typeof raw.subtasks_count === 'number' ? raw.subtasks_count : steps.length
  let source: unknown[] = steps
  if (count > steps.length || raw.steps === undefined) {
    const base = run.client.baseUrl
    const url = typeof raw.subtasks_url === 'string' ? raw.subtasks_url : null
    source =
      url !== null && url.startsWith(`${base}/`)
        ? await run.client.http.paginate(run.token, url.slice(base.length)).all()
        : await run.client.subtasks.list(run.token, raw.id).all()
  }
  const out: RemoteSubtask[] = []
  for (const item of source) {
    try {
      out.push(normaliseSubtask(item))
    } catch (error) {
      if (!(error instanceof NormaliseError)) throw error
    }
  }
  return out.sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER))
}

/** Reads one to-do; `{ type: 'deleted' }` on 404 (service token: the record is gone). */
export async function fetchTodo(run: InboundRun, id: number): Promise<RemoteTodo | { type: 'deleted' }> {
  try {
    return await run.client.todos.get(run.token, id)
  } catch (error) {
    if (error instanceof NotFoundError) return { type: 'deleted' }
    throw error
  }
}

export async function fetchSubtask(run: InboundRun, id: number): Promise<RemoteSubtask | { type: 'deleted' }> {
  try {
    return await run.client.subtasks.get(run.token, id)
  } catch (error) {
    if (error instanceof NotFoundError) return { type: 'deleted' }
    throw error
  }
}

/**
 * New rows for records created in Basecamp (§9.3.8): a to-do with its
 * subtasks, or subtasks under an existing to-do. Rows go to the record's
 * position, or after the last row when Basecamp did not send one.
 */
export async function createRows(
  run: InboundRun,
  sheet: SheetRow,
  todo: { remote: RemoteTodo; uid: string } | { parentUid: string },
  subtasks: readonly RemoteSubtask[],
): Promise<void> {
  const { env, state } = run
  const read = readSheet(state, sheet)
  if (!read.ok) return
  const tasks = read.value.tasks
  const actions: Array<Extract<InboundAction, { type: 'create_row' }>> = []
  let parentUid: string
  if ('remote' in todo) {
    parentUid = todo.uid
    const lastPosition = tasks.filter((t) => t.level === 0).length
    actions.push(inboundCreateRow(todo.remote, { uid: todo.uid, sheetId: sheet.id, parentUid: null, position: lastPosition + 1 }) as Extract<InboundAction, { type: 'create_row' }>)
  } else {
    parentUid = todo.parentUid
  }
  let siblings = tasks.filter((t) => t.level === 1 && t.parentUid === parentUid).length
  for (const st of subtasks) {
    siblings += 1
    actions.push(inboundCreateRow(st, { uid: crypto.randomUUID(), sheetId: sheet.id, parentUid, position: siblings }) as Extract<InboundAction, { type: 'create_row' }>)
  }
  if (actions.length === 0) return
  await ensureNames(run, actions.flatMap((a) => a.remote.assigneeIds))

  const at = run.now()
  const apply = await applyToSheet(env, state, sheet, actions, SYSTEM_ACTOR, at)
  const statements: D1PreparedStatement[] = []
  if (apply.status === 'contended' || apply.status === 'not_found') throw new TaskBusy('snapshot contended')
  const whole = apply.error
  for (const [index, action] of actions.entries()) {
    const outcome = apply.outcomes.find((o) => o.index === index)
    const task = action.task
    // OPEN: a refused new row (e.g. no free row under the table) is logged and tried again by the next reconciliation (S25).
    if (whole || !outcome || outcome.status !== 'applied') {
      const error = whole ?? outcome?.error
      statements.push(
        syncLogStatement(
          env.DB,
          { workbookId: state.wb.id, taskUid: null, direction: 'in', action: 'create_row', newValue: { bcId: action.remote.id }, actor: SYSTEM_ACTOR, status: 'error', error: error?.code ?? 'refused' },
          at,
        ),
      )
      continue
    }
    const blocked = apply.issues.find((i) => i.uid === task.uid && BLOCKING_ISSUES.has(i.code))
    const base = baseFromRemote(task.uid, action.remote, task.position)
    const row: TaskRow = {
      task_uid: task.uid,
      sheet_id: sheet.id,
      parent_uid: task.level === 1 ? task.parentUid : null,
      level: task.level,
      bc_recording_id: action.remote.id,
      bc_type: action.remote.type,
      assign_mode: task.assignMode,
      completed: task.completed ? 1 : 0,
      // A value the sheet could not take keeps no base: the next read compares again (S9).
      last_synced_hash: blocked ? null : base.hash,
      last_synced_base_json: blocked ? null : JSON.stringify(base),
      last_local_change_at: null,
      last_remote_change_at: action.remote.updatedAt,
      sync_state: blocked ? 'error' : 'synced',
      last_error: blocked ? blocked.message : null,
      last_error_code: blocked ? `inbound:${blocked.code}` : null,
      remote_status: 'active',
      trashed_at: null,
      local_hash: apply.fingerprints.get(task.uid) ?? null,
      pending_actor_id: null,
      bc_subtasks_count: action.remote.type === 'todo' ? action.remote.subtasksCount : null,
      bc_subtasks_completed_count: action.remote.type === 'todo' ? action.remote.subtasksCompletedCount : null,
      created_at: at,
    }
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO tasks (task_uid, sheet_id, parent_uid, level, bc_recording_id, bc_type, assign_mode, completed, last_synced_hash,
                              last_synced_base_json, last_local_change_at, last_remote_change_at, sync_state, last_error, last_error_code,
                              remote_status, local_hash, bc_subtasks_count, bc_subtasks_completed_count, last_synced_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13, ?14, 'active', ?15, ?16, ?17, ?18, ?18)
           ON CONFLICT (task_uid) DO NOTHING`,
        )
        .bind(
          row.task_uid,
          row.sheet_id,
          row.parent_uid,
          row.level,
          row.bc_recording_id,
          row.bc_type,
          row.assign_mode,
          row.completed,
          row.last_synced_hash,
          row.last_synced_base_json,
          row.last_remote_change_at,
          row.sync_state,
          row.last_error,
          row.last_error_code,
          row.local_hash,
          row.bc_subtasks_count,
          row.bc_subtasks_completed_count,
          at,
        ),
      ...assigneeStatements(env.DB, task.uid, task.assignees, at),
      syncLogStatement(env.DB, { workbookId: state.wb.id, taskUid: task.uid, direction: 'in', action: 'create_row', newValue: { bcId: action.remote.id, title: task.title }, actor: SYSTEM_ACTOR, status: 'ok' }, at),
    )
    state.taskRows.set(task.uid, row)
    state.assignees.set(task.uid, task.assignees)
  }
  await runBatches(env.DB, statements)
}

/**
 * §8.1 after a subtask changed in Basecamp: the to-do in automatic mode
 * takes the union of its subtasks' assignees, in the sheet and in Basecamp
 * (`notify: false`). Written with the token of the person who changed the
 * subtask when they linked their account; otherwise with the service token,
 * the one documented exception to §3, logged «قاعدة تلقائية». A to-do with a
 * person's change still pending is left to that person's own message.
 */
// OPEN: also runs for subtask changes found by reconciliation (no creator known), so the
// read-only reconciliation may write this one automatic update (S19).
export async function autoAssignParent(run: InboundRun, parentUid: string, creatorBcId: number | null): Promise<void> {
  const { env, state } = run
  const parent = await getTask(env.DB, parentUid)
  if (!parent || parent.level !== 0 || parent.trashed_at !== null || parent.assign_mode !== 'auto') return
  if (parent.sync_state === 'pending' && parent.pending_actor_id !== null) {
    await enqueueTasks(env, state.wb.id, [{ uid: parentUid, actor: parent.pending_actor_id }], run.deps.now, 0)
    return
  }
  const leaseId = crypto.randomUUID()
  if (!(await acquireLease(env.DB, parentUid, leaseId, run.deps.now()))) throw new TaskBusy(parentUid)
  try {
    state.taskRows.set(parentUid, parent)
    if (!(await refreshSnapshotIfStale(env, state))) throw new TaskBusy('snapshot contended')
    const writer = async (): Promise<{ token: string; actor: string } | null> => {
      if (creatorBcId !== null) {
        const linked = await env.DB.prepare(
          `SELECT user_id FROM user_basecamp_links WHERE bc_person_id = ?1 AND bc_account_id = ?2 AND status = 'active'`,
        )
          .bind(creatorBcId, run.ctx.config.accountId)
          .first<{ user_id: string }>()
        if (linked) {
          try {
            const token = await withUserToken(run.ctx, linked.user_id, async (t) => t)
            return { token, actor: linked.user_id }
          } catch {
            // Their link cannot be used: the documented exception below.
          }
        }
      }
      return { token: run.token, actor: AUTO_RULE_ACTOR }
    }
    const result = await syncTask({
      env,
      state,
      uid: parentUid,
      client: run.client,
      readToken: run.token,
      readAs: 'service',
      policy: { kind: 'auto_only', writer },
      now: run.now,
    })
    if (result.status === 'local_pending') {
      // Something else than the automatic union differs: a person's change, which only that person may send.
      await env.DB.prepare(`UPDATE tasks SET sync_state = 'pending' WHERE task_uid = ?1 AND sync_state = 'synced'`).bind(parentUid).run()
    }
  } finally {
    await releaseLease(env.DB, parentUid, leaseId)
  }
}

