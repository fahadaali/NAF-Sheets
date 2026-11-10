// Tab / Shift+Tab on a snapshot (spec §8): the rules are sync-engine's
// (`indentRow`, `outdentRow`: one level of subtasks, a third level refused);
// this module writes their result into the system columns, reorders rows when
// an outdented subtask moves below its former siblings, and updates the
// level-dependent marks (title indentation, unsynced subtask cells).

import type { SheetPlan, TaskUid } from '@naf-sheets/shared'
import { changedCells, editable, type CellRef } from './changes'
import type { WorkbookSnapshot } from './cells'
import { decorateRow, type DecorationOptions } from './decorate'
import { engineIndentRow, engineOutdentRow, type EngineErrorCode } from './engine'
import { ok, type Result, type SheetIssue } from './errors'
import { writeSystemCells } from './system-columns'
import { applyOrder, engineFail, openTable, orderRowsOf, type OrderRow, type TaskTable } from './table'

export interface SheetEditResult {
  workbook: WorkbookSnapshot
  changedCells: CellRef[]
  issues: SheetIssue[]
}

type PlanColumns = Pick<SheetPlan, 'headerRow' | 'columns'>

/** Writes the new levels and parents into the rows (where they are now), then lays out the new order. */
function commit(
  workbook: WorkbookSnapshot,
  plan: PlanColumns,
  table: TaskTable,
  next: readonly OrderRow[],
  options: DecorationOptions,
  issues: SheetIssue[],
): Result<void> {
  const before = new Map(table.rows.map((r) => [r.uid, r]))
  const changed: TaskUid[] = []
  for (const r of next) {
    const old = before.get(r.uid)
    if (old === undefined || (old.level === r.level && old.parentUid === r.parentUid)) continue
    writeSystemCells(table.sheet, r.row, table.system, { uid: r.uid, parentUid: r.parentUid, level: r.level })
    changed.push(r.uid)
  }
  if (next.some((r, i) => table.rows[i]?.uid !== r.uid)) {
    const done = applyOrder(workbook, table.sheetId, next, table.rows.map((r) => r.row))
    if (!done.ok) return done
  }
  const reopened = openTable(workbook, table.sheetId, plan)
  if (!reopened.ok) return reopened
  for (const uid of changed) {
    const row = reopened.value.rows.find((r) => r.uid === uid)
    if (row !== undefined) decorateRow(workbook, reopened.value, row.row, uid, row.level, options, issues)
  }
  return ok(undefined)
}

type EngineResult = { ok: true; value: OrderRow[] } | { ok: false; error: { code: EngineErrorCode } }

function edit(
  workbook: WorkbookSnapshot,
  sheetId: string,
  plan: PlanColumns,
  operate: (rows: OrderRow[]) => EngineResult,
  options: DecorationOptions,
): Result<SheetEditResult> {
  const draft = editable(workbook, [sheetId])
  const table = openTable(draft, sheetId, plan)
  if (!table.ok) return table
  const next = operate(orderRowsOf(table.value))
  if (!next.ok) return engineFail(next.error.code)
  const issues: SheetIssue[] = []
  const done = commit(draft, plan, table.value, next.value, options, issues)
  if (!done.ok) return done
  return ok({ workbook: draft, changedCells: changedCells(workbook, draft), issues })
}

/** Tab: the row becomes the last subtask of the nearest to-do above it. A third level is refused. */
export function indentTaskRow(
  workbook: WorkbookSnapshot,
  sheetId: string,
  plan: PlanColumns,
  uid: TaskUid,
  options: DecorationOptions = {},
): Result<SheetEditResult> {
  return edit(workbook, sheetId, plan, (rows) => engineIndentRow(rows, uid), options)
}

/** Shift+Tab: the subtask becomes a to-do right after its former to-do's remaining subtasks. */
export function outdentTaskRow(
  workbook: WorkbookSnapshot,
  sheetId: string,
  plan: PlanColumns,
  uid: TaskUid,
  options: DecorationOptions = {},
): Result<SheetEditResult> {
  return edit(workbook, sheetId, plan, (rows) => engineOutdentRow(rows, uid), options)
}

/**
 * (Re)applies the level-dependent marks to every task row of a sheet: after
 * linking a sheet, or when the theme's values or the column mapping change.
 */
export function decorateTaskRows(workbook: WorkbookSnapshot, sheetId: string, plan: PlanColumns, options: DecorationOptions): Result<SheetEditResult> {
  const draft = editable(workbook, [sheetId])
  const table = openTable(draft, sheetId, plan)
  if (!table.ok) return table
  const issues: SheetIssue[] = []
  for (const row of table.value.rows) decorateRow(draft, table.value, row.row, row.uid, row.level, options, issues)
  return ok({ workbook: draft, changedCells: changedCells(workbook, draft), issues })
}
