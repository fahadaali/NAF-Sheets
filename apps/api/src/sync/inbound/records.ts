// Basecamp records into the sheet (spec §9.3.5–11, §9.4): one to-do with its
// subtasks, one subtask, one list, a whole list (reconciliation).

import { NotFoundError, normaliseTodo } from '@naf-sheets/basecamp'
import type { RawTodolist } from '@naf-sheets/basecamp'
import { COMPLETED_VALUE_SUGGESTIONS } from '@naf-sheets/gsheets-import'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type { InboundAction, MappedField, RemoteSubtask, RemoteTodo, SheetPlan } from '@naf-sheets/shared'
import { columnLetters, ensureSystemColumns } from '@naf-sheets/sheet-model'
import type { SheetSnapshot, WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { SYSTEM_ACTOR } from '../messages'
import { applyToSheet, mappingStatements, readSheet, sheetForListId } from '../state'
import { isSyncedSheet, mappingsOf, planOf, runBatches, sheetsOf, syncLogStatement } from '../store'
import type { SheetRow, TaskRow } from '../store'
import { updateLatestSnapshot } from '../workbook-writer'
import { autoAssignParent, createRows, ensureNames, fetchSubtask, fetchTodo, inboundStep, rowByBcId, subtasksOf, TaskBusy } from './run'
import type { InboundRun } from './run'

async function ignored(run: InboundRun, action: string, error: string, taskUid: string | null = null): Promise<void> {
  await syncLogStatement(run.env.DB, { workbookId: run.state.wb.id, taskUid, direction: 'in', action, actor: SYSTEM_ACTOR, status: 'ignored', error }, run.now()).run()
}

/** A to-do read from Basecamp (webhook or reconciliation), with its subtasks when they were read too. */
export async function inboundTodo(
  run: InboundRun,
  input: { id: number; remote: RemoteTodo | { type: 'deleted' }; subtasks?: readonly RemoteSubtask[]; creatorBcId?: number | null },
): Promise<void> {
  const { state } = run
  const row = rowByBcId(state, input.id)
  if (input.remote.type === 'deleted') {
    if (row && row.trashed_at === null) await inboundStep(run, row.task_uid, { type: 'deleted' })
    return
  }
  const remote = input.remote
  if (!row) {
    const sheet = sheetForListId(state, remote.listId)
    if (!sheet) return ignored(run, 'todo', 'list_not_linked')
    if (remote.status !== 'active') return
    const subtasks = input.subtasks ?? (await subtasksOf(run, await run.client.todos.getRaw(run.token, remote.id)))
    await createRows(run, sheet, { remote, uid: crypto.randomUUID() }, subtasks)
    return
  }
  // Deleted from the platform: only its undo brings it back.
  if (row.trashed_at !== null) return
  await ensureNames(run, remote.assigneeIds)
  await inboundStep(run, row.task_uid, remote)
  if (input.subtasks) await inboundSubtasksOf(run, row, input.subtasks, input.creatorBcId ?? null)
}

/** The subtasks Basecamp has for one to-do: new ones become rows, gone ones are marked, the rest diffed. */
async function inboundSubtasksOf(run: InboundRun, parent: TaskRow, subtasks: readonly RemoteSubtask[], creatorBcId: number | null): Promise<void> {
  const { state } = run
  const ids = new Set(subtasks.map((s) => s.id))
  await ensureNames(
    run,
    subtasks.flatMap((s) => s.assigneeIds),
  )
  const fresh: RemoteSubtask[] = []
  let changed = false
  for (const st of subtasks) {
    const row = rowByBcId(state, st.id)
    if (!row) {
      fresh.push(st)
      continue
    }
    if (row.trashed_at !== null) continue
    const result = await inboundStep(run, row.task_uid, st)
    if (result.status === 'synced' && result.assigneesChanged) changed = true
  }
  if (fresh.length > 0) {
    const sheet = state.sheetsById.get(parent.sheet_id)
    if (sheet) {
      await createRows(run, sheet, { parentUid: parent.task_uid }, fresh)
      changed = true
    }
  }
  for (const child of [...state.taskRows.values()]) {
    if (child.parent_uid !== parent.task_uid || child.bc_recording_id === null || ids.has(child.bc_recording_id)) continue
    if (child.trashed_at !== null || child.remote_status !== 'active') continue
    const remote = await fetchSubtask(run, child.bc_recording_id)
    await inboundStep(run, child.task_uid, remote)
    changed = true
  }
  if (changed) await autoAssignParent(run, parent.task_uid, creatorBcId)
}

/** One subtask from a webhook. */
export async function inboundSubtask(run: InboundRun, id: number, remote: RemoteSubtask | { type: 'deleted' }, creatorBcId: number | null): Promise<void> {
  const { state } = run
  const row = rowByBcId(state, id)
  if (remote.type === 'deleted') {
    if (!row || row.trashed_at !== null) return
    await inboundStep(run, row.task_uid, { type: 'deleted' })
    if (row.parent_uid !== null) await autoAssignParent(run, row.parent_uid, creatorBcId)
    return
  }
  await ensureNames(run, remote.assigneeIds)
  if (!row) {
    const parent = rowByBcId(state, remote.todoId)
    if (!parent) {
      // Its to-do is not a row yet: read it, which brings its subtasks too.
      return inboundTodo(run, { id: remote.todoId, remote: await fetchTodo(run, remote.todoId), creatorBcId })
    }
    const sheet = state.sheetsById.get(parent.sheet_id)
    if (!sheet || parent.trashed_at !== null) return
    await createRows(run, sheet, { parentUid: parent.task_uid }, [remote])
    await autoAssignParent(run, parent.task_uid, creatorBcId)
    return
  }
  if (row.trashed_at !== null) return
  await inboundStep(run, row.task_uid, remote)
  if (row.parent_uid !== null) await autoAssignParent(run, row.parent_uid, creatorBcId)
}

/**
 * A list event (§9.3.5, §9.3.7, §9.3.9). Archiving or trashing a list sends
 * one event for the list only: every row of its sheet is marked. A list
 * restored is read again in full. A new list follows the workbook's
 * `new_list_behavior`.
 */
export async function inboundList(run: InboundRun, listId: number, kind: string): Promise<void> {
  const { state } = run
  let list: RawTodolist | null = null
  try {
    list = await run.client.todolists.get(run.token, listId)
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
  }
  const status = list ? list.status : 'deleted'
  const sheet = sheetForListId(state, listId)
  if (sheet) {
    if (status !== 'active') {
      const read = readSheet(state, sheet)
      if (!read.ok) return
      const actions: InboundAction[] = read.value.tasks
        .filter((t) => !t.deletedRemotely)
        .map((t) => ({ type: 'mark_deleted_remotely', uid: t.uid, status: status === 'deleted' ? 'deleted' : status }))
      if (actions.length === 0) return
      const apply = await applyToSheet(run.env, state, sheet, actions, SYSTEM_ACTOR, run.now())
      if (apply.status === 'contended') throw new TaskBusy('snapshot contended')
      await syncLogStatement(run.env.DB, { workbookId: state.wb.id, taskUid: null, direction: 'in', action: `list_${status}`, newValue: { listId, rows: actions.length }, actor: SYSTEM_ACTOR, status: 'ok' }, run.now()).run()
      return
    }
    await reconcileList(run, sheet, { force: true })
    return
  }
  if (!list || status !== 'active' || kind !== 'todolist_created') return
  if (list.bucket?.id !== state.wb.bc_project_id) return
  if (state.wb.new_list_behavior !== 'create_sheet') return ignored(run, 'todolist_created', 'new_list_behavior_ignore')
  await createSheetForList(run, list)
}

/** The columns of a sheet the platform creates (spec §7.1 default columns, in order). */
const DEFAULT_FIELDS: readonly MappedField[] = ['title', 'assignees', 'starts_on', 'due_on', 'completed', 'attachments', 'notes']

/** §9.3.9 «أنشئ ورقة جديدة تلقائياً»: a synced sheet with the default columns, then its to-dos as rows. */
async function createSheetForList(run: InboundRun, list: RawTodolist): Promise<void> {
  const { env, state } = run
  const at = run.now()
  const sheetId = crypto.randomUUID()
  const univerSheetId = crypto.randomUUID()
  const plan: SheetPlan = {
    sheetId,
    mode: 'existing',
    todolistId: list.id,
    headerRow: 1,
    columns: DEFAULT_COLUMNS.map((_, i) => ({ columnKey: columnLetters(i), field: DEFAULT_FIELDS[i] as MappedField })),
    // OPEN: the value that means "completed" in the status column of a sheet the platform creates (S14).
    completedValues: [COMPLETED_VALUE_SUGGESTIONS[0] as string],
    hierarchy: { mode: 'flat' },
    existingTasks: 'create_all',
    assigneeMatches: {},
  }
  const baseName = (typeof list.name === 'string' && list.name.trim() !== '' ? list.name : list.title).trim()
  const outcome = await updateLatestSnapshot<{ name: string; workbook: WorkbookSnapshot } | null>(env, state.wb.id, SYSTEM_ACTOR, (latest) => {
    const workbook = structuredClone(latest) as WorkbookSnapshot
    const names = new Set(Object.values(workbook.sheets).map((s) => s?.name))
    let name = baseName
    for (let n = 2; names.has(name); n++) name = `${baseName} (${n})`
    const header: Record<number, unknown> = {}
    DEFAULT_COLUMNS.forEach((value, column) => {
      header[column] = { v: value, s: { bl: 1 } }
    })
    const sheet = { id: univerSheetId, name, rowCount: 1000, columnCount: 26, rightToLeft: 1, cellData: { 0: header } } as unknown as SheetSnapshot
    const ensured = ensureSystemColumns(sheet, plan, () => crypto.randomUUID())
    if (!ensured.ok) return { snapshot: null, result: null }
    workbook.sheets[univerSheetId] = ensured.value.sheet as WorkbookSnapshot['sheets'][string]
    workbook.sheetOrder = [...(workbook.sheetOrder ?? []), univerSheetId]
    return { snapshot: workbook, result: { name, workbook } }
  })
  if (outcome.status === 'contended') throw new TaskBusy('snapshot contended')
  if (outcome.status !== 'written' || outcome.result === null) return
  const position = Math.max(0, ...state.sheets.map((s) => s.position)) + 1
  await runBatches(env.DB, [
    env.DB
      .prepare(
        `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'synced', ?6, 1, ?7)`,
      )
      .bind(sheetId, state.wb.id, univerSheetId, outcome.result.name, position, list.id, at),
    ...mappingStatements(env.DB, sheetId, plan),
    syncLogStatement(env.DB, { workbookId: state.wb.id, taskUid: null, direction: 'in', action: 'create_sheet', newValue: { listId: list.id, name: outcome.result.name }, actor: SYSTEM_ACTOR, status: 'ok' }, at),
  ])
  state.version = outcome.version
  state.snapshot = outcome.result.workbook
  state.sheets = await sheetsOf(env.DB, state.wb.id)
  state.sheetsById = new Map(state.sheets.map((s) => [s.id, s]))
  const mappings = await mappingsOf(env.DB, [sheetId])
  const row = state.sheetsById.get(sheetId)
  if (row) {
    state.plans.set(sheetId, planOf(row, mappings.get(sheetId) ?? []))
    await reconcileList(run, row, { force: true })
  }
}

/**
 * Reconciliation of one linked list (§9.4): the pending and the completed
 * to-dos, with `If-None-Match` and the stored ETag (a 304 on every page costs
 * nothing), following `Link: rel="next"`. Each to-do whose `updated_at` or
 * subtask counters changed is read in full with its subtasks and diffed.
 * Rows whose to-do is in neither list are read one by one (trashed, archived
 * or moved to another list).
 */
export async function reconcileList(run: InboundRun, sheet: SheetRow, options: { force: boolean }): Promise<'not_modified' | 'reconciled'> {
  const { state, client, token } = run
  if (!isSyncedSheet(sheet)) return 'reconciled'
  const listId = sheet.bc_todolist_id
  let pending: RemoteTodo[]
  let done: RemoteTodo[]
  try {
    if (options.force) {
      pending = await client.todos.list(token, listId).all()
      done = await client.todos.list(token, listId, { completed: true }).all()
    } else {
      const a = await client.todos.listIfChanged(token, listId, { cacheScope: 'service' })
      const b = await client.todos.listIfChanged(token, listId, { cacheScope: 'service', completed: true })
      if (a.notModified && b.notModified) return 'not_modified'
      pending = a.data
      done = b.data
    }
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
    // OPEN: the list is gone (the service account sees every project): its rows are marked, never removed (S20).
    await inboundList(run, listId, 'todolist_deleted')
    return 'reconciled'
  }
  // OPEN: whether completed to-dos share one position sequence with pending ones is unknown;
  // their positions are not compared (S5).
  const todos = [...pending, ...done.map((t) => ({ ...t, position: null }))]
  await ensureNames(
    run,
    todos.flatMap((t) => t.assigneeIds),
  )
  const seen = new Set<number>()
  for (const todo of todos) {
    seen.add(todo.id)
    const row = rowByBcId(state, todo.id)
    if (
      row &&
      !options.force &&
      row.sheet_id === sheet.id &&
      row.remote_status === 'active' &&
      row.last_remote_change_at === todo.updatedAt &&
      row.bc_subtasks_count === todo.subtasksCount &&
      row.bc_subtasks_completed_count === todo.subtasksCompletedCount
    ) {
      continue
    }
    try {
      const raw = await client.todos.getRaw(token, todo.id)
      const full = { ...normaliseTodo(raw), position: todo.position }
      const subtasks = await subtasksOf(run, raw)
      await inboundTodo(run, { id: todo.id, remote: full, subtasks })
    } catch (error) {
      if (error instanceof TaskBusy) continue
      if (error instanceof NotFoundError) {
        await inboundTodo(run, { id: todo.id, remote: { type: 'deleted' } })
        continue
      }
      throw error
    }
  }
  for (const row of [...state.taskRows.values()]) {
    if (row.sheet_id !== sheet.id || row.level !== 0 || row.bc_recording_id === null) continue
    if (seen.has(row.bc_recording_id) || row.trashed_at !== null || row.remote_status !== 'active') continue
    try {
      await inboundTodo(run, { id: row.bc_recording_id, remote: await fetchTodo(run, row.bc_recording_id) })
    } catch (error) {
      if (!(error instanceof TaskBusy)) throw error
    }
  }
  return 'reconciled'
}
