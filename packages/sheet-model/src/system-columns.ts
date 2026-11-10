// The hidden system columns of a synced sheet (spec §6.1, §8): `__uid` (the
// row's stable identity), `__parent_uid` and `__level`.
//
// Where they live: in three columns right after the last column the sheet
// uses, each named by its header text in the sheet's header row. Nothing is
// inserted, so no user column, formula, validation or format moves. They are
// found again by their header text, which moves with the columns if a person
// inserts columns before them. OPEN: whole-row references (OPEN_QUESTIONS.md #2).
//
// Hidden: `columnData[c].hd = 1` (Univer's own hidden-column flag).
// Protected: NOT written into the snapshot. Univer 1.4.0 can store a range
// protection rule (`SHEET_RANGE_PROTECTION_PLUGIN`), but an enforced rule
// also blocks sorting and moving whole rows (sheets-sort-ui and
// SheetPermissionCheckController check the rows' range protection), and rows
// must move with their identity. OPEN: OPEN_QUESTIONS.md #1.

import type { TaskLevel, TaskUid } from '@naf-sheets/shared'
import type { SheetPlan } from '@naf-sheets/shared'
import { columnIndex } from './a1'
import { cellText, cloneWorkbook, getCell, lastUsedColumn, rowIndexes, setCell, type SheetSnapshot } from './cells'
import { fail, issue, ok, type Result, type SheetIssue } from './errors'
import { BOOL, CELL_TYPE } from './univer'

export const SYSTEM_HEADERS = { uid: '__uid', parentUid: '__parent_uid', level: '__level' } as const

export interface SystemColumns {
  uid: number
  parentUid: number
  level: number
}

/** A task row as the system columns describe it. `row` is 0-based. */
export interface SystemRow {
  row: number
  uid: TaskUid
  parentUid: TaskUid | null
  level: TaskLevel
}

/** 0-based index of the header row, or null when `headerRow` (1-based) is not a positive integer. */
export function headerIndex(plan: Pick<SheetPlan, 'headerRow'>): number | null {
  return Number.isInteger(plan.headerRow) && plan.headerRow >= 1 ? plan.headerRow - 1 : null
}

/** The title column of a plan, 0-based. */
export function titleColumn(plan: Pick<SheetPlan, 'columns'>): Result<number> {
  const mapping = plan.columns.find((c) => c.field === 'title')
  if (mapping === undefined) return fail('title_column_missing')
  const index = columnIndex(mapping.columnKey)
  return index === null ? fail('invalid_column_key', mapping.columnKey) : ok(index)
}

/**
 * The system columns in the header row. `null` when the sheet has none yet.
 * Refused when only some are there, or one appears twice: rows cannot be read
 * safely then.
 */
export function findSystemColumns(sheet: SheetSnapshot, headerRow: number): Result<SystemColumns | null> {
  const found: Partial<Record<keyof SystemColumns, number>> = {}
  const line = (sheet.cellData?.[headerRow] ?? {}) as Record<number, unknown>
  for (const key of Object.keys(line)) {
    const column = Number(key)
    const text = cellText(getCell(sheet, headerRow, column)).trim()
    for (const name of Object.keys(SYSTEM_HEADERS) as Array<keyof SystemColumns>) {
      if (text !== SYSTEM_HEADERS[name]) continue
      if (found[name] !== undefined) return fail('system_columns_duplicated', SYSTEM_HEADERS[name])
      found[name] = column
    }
  }
  const { uid, parentUid, level } = found
  if (uid === undefined && parentUid === undefined && level === undefined) return ok(null)
  if (uid === undefined || parentUid === undefined || level === undefined) return fail('system_columns_missing')
  return ok({ uid, parentUid, level })
}

/** `findSystemColumns`, refusing a sheet that has none. */
export function requireSystemColumns(sheet: SheetSnapshot, headerRow: number): Result<SystemColumns> {
  const found = findSystemColumns(sheet, headerRow)
  if (!found.ok) return found
  return found.value === null ? fail('system_columns_missing') : ok(found.value)
}

function levelOf(value: unknown): TaskLevel | null {
  if (value === 0 || value === '0') return 0
  if (value === 1 || value === '1') return 1
  return null
}

export interface SystemRowsRead {
  /** Task rows in sheet order, each with a unique uid and a valid level. */
  rows: SystemRow[]
  /** Rows left out (duplicated uid, invalid level) or not tracked yet (a title without a uid). */
  issues: SheetIssue[]
}

/** Every row below the header that carries a uid. */
export function readSystemRows(
  sheet: SheetSnapshot,
  sheetId: string,
  headerRow: number,
  columns: SystemColumns,
  title?: number,
): SystemRowsRead {
  const issues: SheetIssue[] = []
  const candidates: SystemRow[] = []
  const seen = new Map<TaskUid, number>()
  for (const r of rowIndexes(sheet)) {
    if (r <= headerRow) continue
    const uid = cellText(getCell(sheet, r, columns.uid)).trim()
    if (uid === '') {
      if (title !== undefined && cellText(getCell(sheet, r, title)).trim() !== '') issues.push(issue('untracked_row', { sheetId, row: r }))
      continue
    }
    seen.set(uid, (seen.get(uid) ?? 0) + 1)
    const level = levelOf(getCell(sheet, r, columns.level)?.v)
    if (level === null) {
      issues.push(issue('invalid_level', { sheetId, row: r, uid, column: columns.level }))
      continue
    }
    const parent = cellText(getCell(sheet, r, columns.parentUid)).trim()
    candidates.push({ row: r, uid, level, parentUid: level === 1 && parent !== '' ? parent : null })
  }
  // OPEN: every copy of a duplicated uid is left out; which one keeps the identity is undecided (OPEN_QUESTIONS.md #5).
  const rows: SystemRow[] = []
  for (const row of candidates) {
    if ((seen.get(row.uid) ?? 0) > 1) issues.push(issue('duplicate_uid', { sheetId, row: row.row, uid: row.uid, detail: row.uid }))
    else rows.push(row)
  }
  return { rows, issues }
}

/** Writes the three system cells of a row. Mutates `sheet`. */
export function writeSystemCells(sheet: SheetSnapshot, row: number, columns: SystemColumns, value: Omit<SystemRow, 'row'>): void {
  setCell(sheet, row, columns.uid, { ...(getCell(sheet, row, columns.uid) ?? {}), v: value.uid, t: CELL_TYPE.STRING })
  const parent = getCell(sheet, row, columns.parentUid)
  if (value.parentUid === null) {
    if (parent !== undefined) {
      const { v: _v, t: _t, p: _p, ...rest } = parent
      setCell(sheet, row, columns.parentUid, Object.keys(rest).length > 0 ? rest : undefined)
    }
  } else {
    setCell(sheet, row, columns.parentUid, { ...(parent ?? {}), v: value.parentUid, t: CELL_TYPE.STRING })
  }
  setCell(sheet, row, columns.level, { ...(getCell(sheet, row, columns.level) ?? {}), v: value.level, t: CELL_TYPE.NUMBER })
}

/** Where a row sits in the hierarchy when it first gets its uid (the import wizard's detection, spec §7.3 step 5). */
export interface InitialLevel {
  /** 0-based row. */
  row: number
  level: TaskLevel
  /** 0-based row of its to-do, for level 1. */
  parentRow: number | null
}

export interface EnsureSystemColumnsOptions {
  /**
   * Levels for rows that get a uid now. Required when `plan.hierarchy` is not
   * `flat`: pass `detectHierarchy(...).rows` from @naf-sheets/gsheets-import
   * (same shape). Rows not listed are to-dos.
   */
  levels?: readonly InitialLevel[]
}

export interface EnsuredSystemColumns {
  sheet: SheetSnapshot
  columns: SystemColumns
  /** Rows that received a uid in this call. */
  assigned: Array<{ row: number; uid: TaskUid }>
}

/**
 * Adds the system columns when missing, and gives every task row below the
 * header (a row whose title is not empty) a uid when it has none. Rows that
 * already have a uid keep it, with their level and parent. Returns a new
 * sheet; `sheet` is not changed.
 */
export function ensureSystemColumns(
  sheet: SheetSnapshot,
  plan: Pick<SheetPlan, 'headerRow' | 'columns' | 'hierarchy'>,
  uidFactory: () => TaskUid,
  options: EnsureSystemColumnsOptions = {},
): Result<EnsuredSystemColumns> {
  const header = headerIndex(plan)
  if (header === null) return fail('invalid_header_row')
  const title = titleColumn(plan)
  if (!title.ok) return title
  const out = cloneWorkbook({ sheets: { s: sheet } }).sheets.s as SheetSnapshot

  const found = findSystemColumns(out, header)
  if (!found.ok) return found
  let columns = found.value
  if (columns === null) {
    const first = lastUsedColumn(out) + 1
    columns = { uid: first, parentUid: first + 1, level: first + 2 }
    out.columnData ??= {}
    for (const name of Object.keys(SYSTEM_HEADERS) as Array<keyof SystemColumns>) {
      const c = columns[name]
      setCell(out, header, c, { v: SYSTEM_HEADERS[name], t: CELL_TYPE.STRING })
      const data = out.columnData as Record<number, Record<string, unknown>>
      data[c] = { ...(data[c] ?? {}), hd: BOOL.TRUE }
    }
    if (out.columnCount !== undefined && out.columnCount < columns.level + 1) out.columnCount = columns.level + 1
  }

  const levelByRow = new Map((options.levels ?? []).map((l) => [l.row, l]))
  const uidByRow = new Map<number, TaskUid>()
  const levelOfRow = new Map<number, TaskLevel>()
  const assigned: Array<{ row: number; uid: TaskUid }> = []
  const pending: number[] = []
  for (const r of rowIndexes(out)) {
    if (r <= header) continue
    const existing = cellText(getCell(out, r, columns.uid)).trim()
    if (existing !== '') {
      uidByRow.set(r, existing)
      const level = levelOf(getCell(out, r, columns.level)?.v)
      if (level !== null) levelOfRow.set(r, level)
      continue
    }
    if (cellText(getCell(out, r, title.value)).trim() === '') continue
    pending.push(r)
  }
  if (pending.length > 0 && plan.hierarchy.mode !== 'flat' && options.levels === undefined) return fail('hierarchy_required')

  for (const r of pending) {
    const uid = uidFactory()
    uidByRow.set(r, uid)
    levelOfRow.set(r, levelByRow.get(r)?.level ?? 0)
    assigned.push({ row: r, uid })
  }
  const isPending = new Set(pending)
  let lastTodo: number | null = null
  for (const r of [...levelOfRow.keys()].sort((a, b) => a - b)) {
    const level = levelOfRow.get(r) as TaskLevel
    if (isPending.has(r)) {
      let parentUid: TaskUid | null = null
      if (level === 1) {
        // A subtask sits right under its to-do (spec §8): its parent is the nearest to-do above.
        const parentRow = levelByRow.get(r)?.parentRow ?? null
        if (parentRow === null || parentRow !== lastTodo) return fail('invalid_hierarchy', `row ${r + 1}`)
        parentUid = uidByRow.get(parentRow) ?? null
      }
      writeSystemCells(out, r, columns, { uid: uidByRow.get(r) as TaskUid, parentUid, level })
    }
    if (level === 0) lastTodo = r
  }
  return ok({ sheet: out, columns, assigned })
}
