// The task table of a synced sheet: its task rows in order, and how a new
// order of tasks is laid onto the sheet's rows.
//
// The rows that hold tasks are "slots". A new order assigns tasks to the same
// slots, top to bottom (a reorder, like a sort). A new task takes the first
// row under the last task, which must be empty (nothing is ever written over
// data), and is then sorted into place: exactly what a person does when they
// add a row at the bottom and sort. Rows between tasks that are not tasks
// (blank separators, notes) keep their place.

import type { SheetPlan, TaskLevel, TaskUid } from '@naf-sheets/shared'
import { isBlankCell, rowCells, type SheetSnapshot, type WorkbookSnapshot } from './cells'
import { engineMoveRow, type EngineErrorCode } from './engine'
import { fail, ok, type Result, type SheetIssue } from './errors'
import { fieldColumns, type FieldColumns } from './fields'
import { readNotes } from './resources'
import { reorderRows, type ReorderResult, type RowMove } from './rows'
import { headerIndex, readSystemRows, requireSystemColumns, type SystemColumns, type SystemRow } from './system-columns'

export interface TaskTable {
  sheetId: string
  sheet: SheetSnapshot
  header: number
  system: SystemColumns
  fields: FieldColumns
  /** Task rows with a sound identity, in sheet order. */
  rows: SystemRow[]
  /** Rows the read left out (duplicated uid, invalid level, no uid). */
  issues: SheetIssue[]
}

export function openTable(workbook: WorkbookSnapshot, sheetId: string, plan: Pick<SheetPlan, 'headerRow' | 'columns'>): Result<TaskTable> {
  const sheet = workbook.sheets[sheetId]
  if (sheet === undefined) return fail('sheet_not_found')
  const header = headerIndex(plan)
  if (header === null) return fail('invalid_header_row')
  const fields = fieldColumns(plan)
  if (!fields.ok) return fields
  const system = requireSystemColumns(sheet, header)
  if (!system.ok) return system
  const read = readSystemRows(sheet, sheetId, header, system.value, fields.value.title)
  return ok({ sheetId, sheet, header, system: system.value, fields: fields.value, rows: read.rows, issues: read.issues })
}

/** A row holds nothing a person wrote: no value, no formula, no merge, no note. Styles alone are allowed. */
export function isFreeRow(workbook: WorkbookSnapshot, sheetId: string, row: number): boolean {
  const sheet = workbook.sheets[sheetId]
  if (sheet === undefined) return false
  for (const cell of Object.values(rowCells(sheet, row))) if (!isBlankCell(cell)) return false
  for (const m of sheet.mergeData ?? []) if (row >= m.startRow && row <= m.endRow) return false
  const notes = readNotes(workbook, sheetId)
  return notes[String(row)] === undefined || Object.keys(notes[String(row)] ?? {}).length === 0
}

/**
 * The `count` rows right under the last task row (under the header when there
 * are none). Refused when one of them is not free.
 * OPEN: a total right under the table blocks new rows (OPEN_QUESTIONS.md #4).
 */
export function freeRowsBelow(workbook: WorkbookSnapshot, table: TaskTable, count: number): Result<number[]> {
  let last = table.header
  for (const r of table.rows) last = Math.max(last, r.row)
  // Rows the read left out (a duplicated uid…) are still rows with content.
  for (const i of table.issues) last = Math.max(last, i.row)
  const rows = Array.from({ length: count }, (_, i) => last + 1 + i)
  for (const r of rows) if (!isFreeRow(workbook, table.sheetId, r)) return fail('no_free_row', `row ${r + 1}`)
  return ok(rows)
}

/** A task in a planned order: where its content is now (`row`), and its place in the hierarchy. */
export interface OrderRow {
  uid: TaskUid
  parentUid: TaskUid | null
  level: TaskLevel
  position: number
  row: number
}

export function orderRowsOf(table: TaskTable): OrderRow[] {
  return table.rows.map((r) => ({ uid: r.uid, parentUid: r.parentUid, level: r.level, position: 0, row: r.row }))
}

/**
 * Lays `order` onto `slots` (ascending rows): the k-th task goes to the k-th
 * slot. Slots beyond the order are emptied (their content leaves the sheet).
 */
export function applyOrder(workbook: WorkbookSnapshot, sheetId: string, order: readonly OrderRow[], slots: readonly number[]): Result<ReorderResult> {
  const sorted = [...slots].sort((a, b) => a - b)
  if (order.length > sorted.length) throw new Error('applyOrder: more tasks than slots')
  const moves: RowMove[] = sorted.map((to, k) => ({ to, from: order[k]?.row ?? null }))
  return reorderRows(workbook, sheetId, moves)
}

/** The engine's refusal as this package's (same codes and messages for the hierarchy rules). */
export function engineFail<T>(code: EngineErrorCode): Result<T> {
  switch (code) {
    case 'third_level_not_allowed':
    case 'parent_has_subtasks':
    case 'no_parent_above':
    case 'row_not_found':
      return fail(code)
    default:
      return fail('row_not_found', code)
  }
}

/**
 * `rows` with the task `uid` moved to 1-based `position` among its siblings
 * (`null`: last). A to-do moves with its subtasks; a subtask stays in its
 * to-do. Uses the engine's `moveRow`.
 */
export function placeAt(rows: readonly OrderRow[], uid: TaskUid, position: number | null): Result<OrderRow[]> {
  const row = rows.find((r) => r.uid === uid)
  if (row === undefined) return fail('row_not_found')
  let before: TaskUid | null = null
  if (row.level === 0) {
    const others = rows.filter((r) => r.level === 0 && r.uid !== uid)
    before = position !== null && position >= 1 ? (others[position - 1]?.uid ?? null) : null
  } else {
    const parent = row.parentUid
    const siblings = rows.filter((r) => r.level === 1 && r.parentUid === parent && r.uid !== uid)
    const target = position !== null && position >= 1 ? siblings[position - 1] : undefined
    if (target !== undefined) before = target.uid
    else {
      // After the to-do's last remaining subtask: before the next to-do below it.
      const parentIndex = rows.findIndex((r) => r.uid === parent)
      if (parentIndex < 0) return fail('parent_not_found')
      before = rows.slice(parentIndex + 1).find((r) => r.level === 0 && r.uid !== uid)?.uid ?? null
    }
  }
  const moved = engineMoveRow(rows, uid, before)
  if (!moved.ok) return engineFail(moved.error.code)
  return ok(moved.value)
}
