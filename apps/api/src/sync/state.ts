// A linked workbook as one sync step sees it: the latest snapshot, its sheets
// and their plans, the names directory and the tasks' D1 rows. Reading a row
// goes through sheet-model's `readTasks`; writing Basecamp's values into the
// sheet goes through `applyInbound` inside `updateLatestSnapshot`, the only
// way the server writes a snapshot.

import type { Assignee, InboundAction, LocalTask, SheetPlan, SyncedBase } from '@naf-sheets/shared'
import { applyInbound, readTasks } from '@naf-sheets/sheet-model'
import type { ActionOutcome, ApplyInboundOptions, ReadTasksResult, Result, SheetError, SheetIssue, WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { DEFAULT_AUTO_ASSIGN_SETTINGS } from '@naf-sheets/sync-engine'
import type { DiffContext } from '@naf-sheets/sync-engine'
import type { Env } from '../env'
import { readSnapshot } from '../snapshot'
import { loadDirectory } from './directory'
import type { SyncDirectory } from './directory'
import { localFingerprint } from './fingerprint'
import { assigneeStatements, assigneesOf, isSyncedSheet, mappingsOf, planOf, sheetsOf, tasksOfWorkbook } from './store'
import type { SheetRow, TaskRow, WorkbookSyncRow } from './store'
import { updateLatestSnapshot } from './workbook-writer'

export interface WorkbookState {
  wb: WorkbookSyncRow
  version: number
  snapshot: WorkbookSnapshot
  sheets: SheetRow[]
  sheetsById: Map<string, SheetRow>
  /** Plans of every sheet that has column mappings (synced sheets, «غير مصنّف»). */
  plans: Map<string, SheetPlan>
  directory: SyncDirectory
  taskRows: Map<string, TaskRow>
  assignees: Map<string, Assignee[]>
}

/**
 * Null when the workbook is gone or its snapshot cannot be read. `given`: the
 * snapshot the caller just committed (a browser save, the room), instead of
 * reading the latest from R2.
 */
export async function loadWorkbookState(env: Env, wb: WorkbookSyncRow, given?: { snapshot: unknown; version: number }): Promise<WorkbookState | null> {
  const fresh = given
    ? { v: given.version }
    : await env.DB.prepare(`SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1 AND archived_at IS NULL`)
        .bind(wb.id)
        .first<{ v: number }>()
  if (!fresh) return null
  const snapshot = (given ? given.snapshot : await readSnapshot(env, wb.id, fresh.v)) as WorkbookSnapshot | null
  if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.sheets !== 'object' || snapshot.sheets === null) return null
  const sheets = await sheetsOf(env.DB, wb.id)
  const mappings = await mappingsOf(
    env.DB,
    sheets.map((s) => s.id),
  )
  const plans = new Map<string, SheetPlan>()
  for (const sheet of sheets) {
    const m = mappings.get(sheet.id)
    if (m && m.length > 0) plans.set(sheet.id, planOf(sheet, m))
  }
  const rows = await tasksOfWorkbook(env.DB, wb.id)
  const taskRows = new Map(rows.map((r) => [r.task_uid, r]))
  const assignees = await assigneesOf(
    env.DB,
    rows.map((r) => r.task_uid),
  )
  return {
    wb,
    version: fresh.v,
    snapshot,
    sheets,
    sheetsById: new Map(sheets.map((s) => [s.id, s])),
    plans,
    directory: await loadDirectory(env.DB, wb.bc_project_id),
    taskRows,
    assignees,
  }
}

/**
 * Re-reads the snapshot when a save moved the workbook on since `state` was
 * loaded, so a step never diffs a row against content the person replaced.
 */
export async function refreshSnapshotIfStale(env: Env, state: WorkbookState): Promise<boolean> {
  const fresh = await env.DB.prepare(`SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1 AND archived_at IS NULL`)
    .bind(state.wb.id)
    .first<{ v: number }>()
  if (!fresh) return false
  if (fresh.v === state.version) return true
  const snapshot = (await readSnapshot(env, state.wb.id, fresh.v)) as WorkbookSnapshot | null
  if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.sheets !== 'object' || snapshot.sheets === null) return false
  state.snapshot = snapshot
  state.version = fresh.v
  return true
}

export function syncedSheets(state: WorkbookState): Array<SheetRow & { bc_todolist_id: number }> {
  return state.sheets.filter(isSyncedSheet).filter((s) => state.plans.has(s.id))
}

export function sheetForListId(state: WorkbookState, listId: number): (SheetRow & { bc_todolist_id: number }) | null {
  return syncedSheets(state).find((s) => s.bc_todolist_id === listId) ?? null
}

/** sheet-model's row state from D1 (bcId, assign mode, timestamps, stored assignees, Basecamp status). */
function rowStateOf(state: WorkbookState, overrides?: ReadonlyMap<string, Assignee[]>) {
  return (uid: string) => {
    const row = state.taskRows.get(uid)
    const override = overrides?.get(uid)
    if (!row) return override ? { assignees: override } : undefined
    return {
      bcId: row.bc_recording_id,
      assignMode: row.assign_mode,
      localChangedAt: row.last_local_change_at,
      attachments: [],
      assignees: override ?? state.assignees.get(uid) ?? [],
      deletedRemotely: row.remote_status !== 'active',
    }
  }
}

export function readSheet(
  state: WorkbookState,
  sheet: SheetRow,
  snapshot: WorkbookSnapshot = state.snapshot,
  overrides?: ReadonlyMap<string, Assignee[]>,
): Result<ReadTasksResult> {
  const plan = state.plans.get(sheet.id)
  if (!plan) return { ok: false, error: { code: 'title_column_missing', message: TITLE_MISSING } }
  return readTasks(snapshot, sheet.univer_sheet_id, plan, { directory: state.directory.assignee, rowState: rowStateOf(state, overrides) })
}

const TITLE_MISSING = 'لا يوجد في مطابقة الأعمدة عمود للعنوان، والمزامنة تحتاجه. اختر عمود «المهمة» في مطابقة الأعمدة ثم احفظها.'

/**
 * The row as the engine must diff it. A sheet whose mapping has no notes
 * column does not hold the description's person part, so that part is not a
 * local value at all: it follows Basecamp (the base). Without this the engine
 * read "no notes" as a local edit and sent an empty description, wiping the
 * text a person wrote in Basecamp and its files (found in phase 5; spec §8.2
 * keeps that part verbatim, §16 scenario 8). OPEN (P2): confirm.
 * Fingerprints keep reading the sheet itself (`readSheet`), unchanged.
 */
export function diffLocal(state: WorkbookState, sheet: SheetRow, task: LocalTask, base: SyncedBase | null): LocalTask {
  if (task.level !== 0) return task
  const plan = state.plans.get(sheet.id)
  if (!plan || plan.columns.some((c) => c.field === 'notes')) return task
  return { ...task, notesHtml: base?.notesHtml ?? null }
}

/** The engine's context for one row of a synced sheet. */
export function diffContextFor(state: WorkbookState, sheet: SheetRow, task: LocalTask, sheetTasks: readonly LocalTask[]): DiffContext {
  const ctx: DiffContext = { directory: state.directory.block, listId: isSyncedSheet(sheet) ? sheet.bc_todolist_id : null }
  if (task.level === 1) {
    ctx.parentTodoId = task.parentUid !== null ? (state.taskRows.get(task.parentUid)?.bc_recording_id ?? null) : null
  } else {
    ctx.autoAssign = {
      // OPEN: subtasks deleted in Basecamp (row kept, struck through) leave the union (S7).
      subtasks: sheetTasks.filter((s) => s.level === 1 && s.parentUid === task.uid && !s.deletedRemotely),
      settings: {
        enabled: sheet.auto_assign_parents === 1,
        excludeCompletedSubtasks: sheet.exclude_completed_subtask_assignees === 1 ? true : DEFAULT_AUTO_ASSIGN_SETTINGS.excludeCompletedSubtasks,
      },
    }
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Writing Basecamp's values into the sheet
// ---------------------------------------------------------------------------

/**
 * Strikethrough of a row deleted in Basecamp (§9.3.10).
 * OPEN: the grey of the spec needs a colour value in the snapshot, and the
 * platform's theme (CLAUDE.md §0) is not decided; only the strikethrough is
 * written until it is (S8).
 */
export const DELETED_ROW_STYLE = { st: { s: 1 } } as unknown as ApplyInboundOptions['deletedStyle']

export interface SheetApply {
  status: 'written' | 'unchanged' | 'refused' | 'contended' | 'not_found'
  outcomes: ActionOutcome[]
  /** The whole call was refused (the sheet could not be opened). */
  error?: SheetError
  createdSheets: Array<{ univerSheetId: string; name: string; plan: SheetPlan; sheetId: string }>
  /** Fingerprints of the rows touched, read back from the written snapshot. */
  fingerprints: Map<string, string>
  /** Cells left as they were (a formula, a name the directory does not know…). */
  issues: SheetIssue[]
}

/** The first refused outcome's error, if any. */
export function refusal(apply: SheetApply): SheetError | null {
  if (apply.error) return apply.error
  return apply.outcomes.find((o) => o.status === 'refused')?.error ?? null
}

/**
 * Applies `actions` to `sheet` in the latest snapshot. On success
 * `state.snapshot` becomes the written snapshot, and D1 follows for the
 * applied actions (assign mode, completion, assignees, Basecamp status,
 * moved rows, «غير مصنّف»). `create_row` rows are inserted by the caller,
 * which holds their base.
 */
export async function applyToSheet(
  env: Env,
  state: WorkbookState,
  sheet: SheetRow,
  actions: readonly InboundAction[],
  savedBy: string,
  at: string,
): Promise<SheetApply> {
  const plan = state.plans.get(sheet.id)
  const empty: SheetApply = { status: 'unchanged', outcomes: [], createdSheets: [], fingerprints: new Map(), issues: [] }
  if (actions.length === 0) return empty
  if (!plan) return { ...empty, status: 'refused', error: { code: 'title_column_missing', message: TITLE_MISSING } }

  const unclassifiedRow = state.wb.unclassified_sheet_id ? state.sheetsById.get(state.wb.unclassified_sheet_id) : undefined
  const unclassified = unclassifiedRow
    ? { univerSheetId: unclassifiedRow.univer_sheet_id, sheetId: unclassifiedRow.id, plan: state.plans.get(unclassifiedRow.id) }
    : { univerSheetId: crypto.randomUUID(), sheetId: crypto.randomUUID() }
  const overrides = new Map<string, Assignee[]>()
  for (const a of actions) {
    if (a.type === 'update_row' && a.fields.assignees) overrides.set(a.uid, a.fields.assignees)
    if (a.type === 'create_row') overrides.set(a.task.uid, a.task.assignees)
  }
  const options: ApplyInboundOptions = {
    directory: state.directory.assignee,
    deletedStyle: DELETED_ROW_STYLE,
    sheetForList: (listId) => {
      const target = sheetForListId(state, listId)
      const targetPlan = target ? state.plans.get(target.id) : undefined
      return target && targetPlan ? { univerSheetId: target.univer_sheet_id, plan: targetPlan } : null
    },
    unclassified,
  }

  interface Run {
    result: Result<{ outcomes: ActionOutcome[]; createdSheets: SheetApply['createdSheets']; issues: SheetIssue[] }>
    workbook: WorkbookSnapshot | null
    fingerprints: Map<string, string>
  }
  const outcome = await updateLatestSnapshot<Run>(env, state.wb.id, savedBy, (latest) => {
    const applied = applyInbound(latest as WorkbookSnapshot, sheet.univer_sheet_id, plan, actions, options)
    if (!applied.ok) return { snapshot: null, result: { result: applied, workbook: null, fingerprints: new Map() } }
    const v = applied.value
    const createdSheets = v.createdSheets.map((c) => ({ ...c, sheetId: c.plan.sheetId }))
    const changed = v.changedCells.length > 0 || v.changedResources.length > 0 || createdSheets.length > 0
    const fingerprints = changed ? fingerprintsAfter(state, v.workbook, actions, overrides, createdSheets) : new Map<string, string>()
    return {
      snapshot: changed ? v.workbook : null,
      result: { result: { ok: true, value: { outcomes: v.outcomes, createdSheets, issues: v.issues } }, workbook: changed ? v.workbook : null, fingerprints },
    }
  })
  if (outcome.status === 'not_found') return { ...empty, status: 'not_found' }
  if (outcome.status === 'contended') return { ...empty, status: 'contended' }
  const run = outcome.result
  if (!run.result.ok) return { ...empty, status: 'refused', error: run.result.error }
  if (run.workbook !== null && outcome.status === 'written') {
    state.snapshot = run.workbook
    state.version = outcome.version
  }
  const apply: SheetApply = {
    status: outcome.status,
    outcomes: run.result.value.outcomes,
    createdSheets: run.result.value.createdSheets,
    fingerprints: run.fingerprints,
    issues: run.result.value.issues,
  }
  await recordApplied(env.DB, state, sheet, actions, apply, at)
  return apply
}

/** Reads the touched rows back from the new snapshot, for `tasks.local_hash`. */
function fingerprintsAfter(
  state: WorkbookState,
  workbook: WorkbookSnapshot,
  actions: readonly InboundAction[],
  overrides: ReadonlyMap<string, Assignee[]>,
  created: SheetApply['createdSheets'],
): Map<string, string> {
  const touched = new Set<string>()
  for (const a of actions) touched.add(a.type === 'create_row' ? a.task.uid : a.uid)
  const out = new Map<string, string>()
  const sheets: SheetRow[] = [...syncedSheets(state)]
  const probe: WorkbookState = { ...state, plans: new Map(state.plans) }
  for (const c of created) {
    probe.plans.set(c.sheetId, c.plan)
    sheets.push({ ...(sheets[0] as SheetRow), id: c.sheetId, univer_sheet_id: c.univerSheetId, sync_mode: 'local', bc_todolist_id: null })
  }
  if (state.wb.unclassified_sheet_id) {
    const u = state.sheetsById.get(state.wb.unclassified_sheet_id)
    if (u && state.plans.has(u.id)) sheets.push(u)
  }
  for (const sheet of sheets) {
    const read = readSheet(probe, sheet, workbook, overrides)
    if (!read.ok) continue
    for (const task of read.value.tasks) {
      if (touched.has(task.uid) || (task.parentUid !== null && touched.has(task.parentUid))) out.set(task.uid, localFingerprint(task))
    }
  }
  return out
}

async function recordApplied(db: D1Database, state: WorkbookState, sheet: SheetRow, actions: readonly InboundAction[], apply: SheetApply, at: string): Promise<void> {
  const statements: D1PreparedStatement[] = []
  // Sheets created by this call (the «غير مصنّف» sheet): local, with the plan's columns.
  for (const c of apply.createdSheets) {
    const position = Math.max(0, ...state.sheets.map((s) => s.position)) + 1
    statements.push(
      db
        .prepare(
          `INSERT INTO sheets (id, workbook_id, univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row, created_at, assignee_matches_json)
           VALUES (?1, ?2, ?3, ?4, ?5, 'local', NULL, ?6, ?7, ?8)`,
        )
        .bind(c.sheetId, state.wb.id, c.univerSheetId, c.name, position, c.plan.headerRow, at, JSON.stringify(c.plan.assigneeMatches ?? {})),
      ...mappingStatements(db, c.sheetId, c.plan),
      db.prepare(`UPDATE workbooks SET unclassified_sheet_id = ?2 WHERE id = ?1 AND unclassified_sheet_id IS NULL`).bind(state.wb.id, c.sheetId),
    )
    const row: SheetRow = {
      id: c.sheetId,
      workbook_id: state.wb.id,
      univer_sheet_id: c.univerSheetId,
      title: c.name,
      position,
      sync_mode: 'local',
      bc_todolist_id: null,
      header_row: c.plan.headerRow,
      auto_assign_parents: 1,
      exclude_completed_subtask_assignees: 0,
      assignee_matches_json: JSON.stringify(c.plan.assigneeMatches ?? {}),
    }
    state.sheets.push(row)
    state.sheetsById.set(row.id, row)
    state.plans.set(row.id, c.plan)
    state.wb.unclassified_sheet_id ??= row.id
  }
  for (const o of apply.outcomes) {
    if (o.status !== 'applied') continue
    const action = actions[o.index]
    if (!action) continue
    const row = state.taskRows.get(o.uid)
    switch (action.type) {
      case 'update_row': {
        const f = action.fields
        if (f.assignMode !== undefined) {
          statements.push(db.prepare(`UPDATE tasks SET assign_mode = ?2 WHERE task_uid = ?1`).bind(o.uid, f.assignMode))
          if (row) row.assign_mode = f.assignMode
        }
        if (f.completed !== undefined) statements.push(db.prepare(`UPDATE tasks SET completed = ?2 WHERE task_uid = ?1`).bind(o.uid, f.completed ? 1 : 0))
        if (f.assignees !== undefined) {
          statements.push(...assigneeStatements(db, o.uid, f.assignees, at))
          state.assignees.set(o.uid, f.assignees)
        }
        break
      }
      case 'mark_deleted_remotely':
        statements.push(db.prepare(`UPDATE tasks SET remote_status = ?2 WHERE task_uid = ?1`).bind(o.uid, action.status))
        if (row) row.remote_status = action.status
        break
      case 'restore_row':
        statements.push(db.prepare(`UPDATE tasks SET remote_status = 'active' WHERE task_uid = ?1`).bind(o.uid))
        if (row) row.remote_status = 'active'
        break
      case 'move_row': {
        const target = action.toListId === null ? null : sheetForListId(state, action.toListId)
        const targetId = target?.id ?? state.wb.unclassified_sheet_id
        if (!targetId || targetId === sheet.id) break
        // A local sheet («غير مصنّف») does not sync: its rows read `unlinked` (sync-engine OPEN #10).
        const local = target === null
        statements.push(
          db
            .prepare(`UPDATE tasks SET sheet_id = ?2, sync_state = CASE WHEN ?3 = 1 THEN 'unlinked' ELSE sync_state END WHERE task_uid = ?1 OR parent_uid = ?1`)
            .bind(o.uid, targetId, local ? 1 : 0),
        )
        for (const r of state.taskRows.values()) {
          if (r.task_uid !== o.uid && r.parent_uid !== o.uid) continue
          r.sheet_id = targetId
          if (local) r.sync_state = 'unlinked'
        }
        break
      }
      default:
        break
    }
  }
  for (const [uid, fp] of apply.fingerprints) {
    if (!state.taskRows.has(uid)) continue
    statements.push(db.prepare(`UPDATE tasks SET local_hash = ?2 WHERE task_uid = ?1`).bind(uid, fp))
    const row = state.taskRows.get(uid)
    if (row) row.local_hash = fp
  }
  for (let i = 0; i < statements.length; i += 80) await db.batch(statements.slice(i, i + 80))
}

/** column_mappings of a plan. Existing mappings of the sheet become free columns first (never deleted). */
export function mappingStatements(db: D1Database, sheetId: string, plan: Pick<SheetPlan, 'columns' | 'completedValues'>): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(`UPDATE column_mappings SET field = 'free', free_to_description = 0, completed_value = NULL, completed_values_json = NULL WHERE sheet_id = ?1`)
      .bind(sheetId),
  ]
  for (const column of plan.columns) {
    const key = column.columnKey.trim().toUpperCase()
    const free = column.field === 'free' && column.appendToDescription === true ? 1 : 0
    const values = column.field === 'completed' && plan.completedValues && plan.completedValues.length > 0 ? JSON.stringify(plan.completedValues) : null
    const single = column.field === 'completed' && plan.completedValues && plan.completedValues.length > 0 ? (plan.completedValues[0] as string) : null
    statements.push(
      db
        .prepare(
          `INSERT INTO column_mappings (sheet_id, column_key, field, free_to_description, completed_value, completed_values_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (sheet_id, column_key) DO UPDATE SET field = excluded.field, free_to_description = excluded.free_to_description,
             completed_value = excluded.completed_value, completed_values_json = excluded.completed_values_json`,
        )
        .bind(sheetId, key, column.field, free, single, values),
    )
  }
  return statements
}
