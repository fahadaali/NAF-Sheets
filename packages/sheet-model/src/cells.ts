// Low-level access to a Univer workbook snapshot (`IWorkbookData`).
//
// Public functions of this package never mutate their input: they clone the
// workbook once (`cloneWorkbook`) and work on the copy with the helpers below,
// which mutate the copy in place.

import { hasCellImages, textWithoutImages } from './cell-images'
import { CELL_TYPE, type ICellData, type IStyleData, type IWorkbookData, type IWorksheetData } from './univer'

/** What the platform stores and the editor saves: `sheets` is always there, the rest may be missing. */
export type WorkbookSnapshot = Partial<IWorkbookData> & { sheets: IWorkbookData['sheets'] }
export type SheetSnapshot = Partial<IWorksheetData>

/** Deep copy; the snapshot is plain JSON. */
export function cloneWorkbook<T extends WorkbookSnapshot>(workbook: T): T {
  return structuredClone(workbook)
}

export function getSheet(workbook: WorkbookSnapshot, sheetId: string): SheetSnapshot | undefined {
  return workbook.sheets[sheetId]
}

export function getCell(sheet: SheetSnapshot, row: number, column: number): ICellData | undefined {
  const line = sheet.cellData?.[row] as Record<number, ICellData | undefined> | undefined
  return line?.[column] ?? undefined
}

/** Cells of one row by column index. Never undefined; empty when the row has no cells. */
export function rowCells(sheet: SheetSnapshot, row: number): Record<number, ICellData> {
  return (sheet.cellData?.[row] as Record<number, ICellData> | undefined) ?? {}
}

/** Sets (or, with `undefined`, removes) a cell. Mutates `sheet`. */
export function setCell(sheet: SheetSnapshot, row: number, column: number, cell: ICellData | undefined): void {
  if (cell === undefined) {
    const line = sheet.cellData?.[row] as Record<number, ICellData> | undefined
    if (line === undefined) return
    delete line[column]
    if (Object.keys(line).length === 0) delete (sheet.cellData as Record<number, unknown>)[row]
    return
  }
  sheet.cellData ??= {}
  const data = sheet.cellData as Record<number, Record<number, ICellData>>
  data[row] ??= {}
  ;(data[row] as Record<number, ICellData>)[column] = cell
  if (sheet.rowCount !== undefined && sheet.rowCount <= row) sheet.rowCount = row + 1
  if (sheet.columnCount !== undefined && sheet.columnCount <= column) sheet.columnCount = column + 1
}

/** Indexes of the rows that have at least one cell, ascending. */
export function rowIndexes(sheet: SheetSnapshot): number[] {
  return Object.keys(sheet.cellData ?? {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)
}

/**
 * Display-independent text of a cell: rich text (`p`) first, else the value.
 * Booleans read TRUE / FALSE. '' when there is nothing (same reading as the
 * import wizard's `textGridFromWorksheet`).
 */
export function cellText(cell: ICellData | undefined): string {
  if (cell === undefined || cell === null) return ''
  const stream = cell.p?.body?.dataStream
  // Pictures in the cell are never text (cell-images.ts).
  if (stream) return textWithoutImages(stream.replace(/\r\n$/, '').replace(/\r/g, '\n'), hasCellImages(cell))
  const v = cell.v
  if (v === undefined || v === null) return ''
  if (cell.t === CELL_TYPE.BOOLEAN || typeof v === 'boolean') return isTruthyBoolean(v) ? 'TRUE' : 'FALSE'
  return String(v)
}

/** Univer stores a boolean as 1 / 0 (or true / false, or the text TRUE / FALSE). */
export function isTruthyBoolean(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === 'string' && (v === '1' || v.toUpperCase() === 'TRUE'))
}

export function hasFormula(cell: ICellData | undefined): boolean {
  return Boolean(cell?.f) || (cell?.si !== undefined && cell?.si !== null && cell?.si !== '')
}

/** No value, no rich text, no formula. A style alone does not make a cell used. */
export function isBlankCell(cell: ICellData | undefined): boolean {
  if (cell === undefined || cell === null) return true
  if (hasFormula(cell)) return false
  return cellText(cell) === ''
}

/** The cell's own style (not row, column or sheet defaults) as an object. */
export function ownStyle(workbook: WorkbookSnapshot, cell: ICellData | undefined): IStyleData {
  const s = cell?.s
  if (s === undefined || s === null) return {}
  if (typeof s === 'string') return { ...(workbook.styles?.[s] ?? {}) }
  return { ...s }
}

/** Last column holding a cell, a merge or column settings; -1 for an empty sheet. */
export function lastUsedColumn(sheet: SheetSnapshot): number {
  let last = -1
  for (const line of Object.values(sheet.cellData ?? {})) {
    for (const key of Object.keys(line ?? {})) last = Math.max(last, Number(key))
  }
  for (const m of sheet.mergeData ?? []) last = Math.max(last, m.endColumn)
  for (const [key, col] of Object.entries(sheet.columnData ?? {})) {
    if (col && Object.keys(col).length > 0) last = Math.max(last, Number(key))
  }
  return last
}

// ---------------------------------------------------------------------------
// The platform's own data on a cell: `ICellData.custom.nafSheets`
// ---------------------------------------------------------------------------

// OPEN: Univer documents `custom` as "not recommended for external use" (OPEN_QUESTIONS.md #18).
export const CUSTOM_KEY = 'nafSheets'

/** A reversible style change and the values it replaced (`null`: the key was absent). */
export type MarkName = 'deleted' | 'unsynced' | 'indent'

export interface MarkRecord {
  /** Style keys the mark set, with the values it set. */
  set: Record<string, unknown>
  /** The value each of those keys had before (`null`: absent). */
  prev: Record<string, unknown>
  /** The cell's style id before the first mark, restored when the style comes back to it. */
  sId?: string
}

export interface NafCellData {
  marks?: Partial<Record<MarkName, MarkRecord>>
  /** Notes column: the description HTML the cell text was rendered from (§8 table, `notesHtml`). */
  notesHtml?: string
  /** `__uid` cell: the record is archived, trashed or deleted in Basecamp (§9.3.10). */
  deletedRemotely?: 'archived' | 'trashed' | 'deleted'
}

export function nafData(cell: ICellData | undefined): NafCellData {
  const custom = cell?.custom as Record<string, unknown> | null | undefined
  const data = custom?.[CUSTOM_KEY]
  return typeof data === 'object' && data !== null ? (data as NafCellData) : {}
}

/** Returns a copy of `cell` with its platform data replaced (removed when empty). */
export function withNafData(cell: ICellData, data: NafCellData): ICellData {
  const clean: NafCellData = {}
  if (data.marks !== undefined && Object.keys(data.marks).length > 0) clean.marks = data.marks
  if (data.notesHtml !== undefined) clean.notesHtml = data.notesHtml
  if (data.deletedRemotely !== undefined) clean.deletedRemotely = data.deletedRemotely
  const custom: Record<string, unknown> = { ...((cell.custom as Record<string, unknown> | null | undefined) ?? {}) }
  if (Object.keys(clean).length > 0) custom[CUSTOM_KEY] = clean
  else delete custom[CUSTOM_KEY]
  const out: ICellData = { ...cell }
  if (Object.keys(custom).length > 0) out.custom = custom
  else delete out.custom
  return out
}

/** JSON with object keys sorted, so equal styles compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b)
}
