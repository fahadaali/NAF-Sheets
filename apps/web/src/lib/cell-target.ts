// A1 notation for the editor's target (spec §7.2: the import report links to
// each item's location) and for column keys of the linking wizard (§7.3:
// `ColumnPlan.columnKey` is the column letter). Pure, unit-tested.
//
// Ranges are 0-based and inclusive on both ends, like Univer's `IRange`
// (`{0,0,1,1}` is A1:B2) and the import report's `ImportLocation.range`.

export interface CellRange {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

/** Where the editor should land after loading: a sheet, and optionally a range in it. */
export interface EditorTarget {
  /** Univer sheet id (`SheetMeta.univerSheetId`, `ImportLocation.sheetId`). */
  sheet: string
  range: CellRange | null
}

// Univer 1.4.0's own limits are far larger; these keep a hand-edited address
// from asking the grid to scroll to an absurd place. ZZZ = 18278 columns.
const MAX_COLUMN = 18_277
const MAX_ROW = 9_999_999

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(column: number): string {
  let n = Math.floor(column) + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** A → 0, AA → 26; null for anything that is not 1–3 capital letters. */
export function columnIndex(letters: string): number | null {
  if (!/^[A-Z]{1,3}$/.test(letters)) return null
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const isIndex = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max

/** True when every corner is a valid 0-based index and the range is not inverted. */
export function isCellRange(value: unknown): value is CellRange {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    isIndex(r.startRow, MAX_ROW) &&
    isIndex(r.endRow, MAX_ROW) &&
    isIndex(r.startColumn, MAX_COLUMN) &&
    isIndex(r.endColumn, MAX_COLUMN) &&
    r.startRow <= r.endRow &&
    r.startColumn <= r.endColumn
  )
}

/** `B4` for a single cell, `B4:C10` otherwise. */
export function rangeToA1(range: CellRange): string {
  const cell = (row: number, column: number) => `${columnLetters(column)}${row + 1}`
  const start = cell(range.startRow, range.startColumn)
  if (range.startRow === range.endRow && range.startColumn === range.endColumn) return start
  return `${start}:${cell(range.endRow, range.endColumn)}`
}

const CELL = /^([A-Z]{1,3})([1-9]\d{0,6})$/

function parseCell(text: string): { row: number; column: number } | null {
  const match = CELL.exec(text)
  if (!match?.[1] || !match[2]) return null
  const column = columnIndex(match[1])
  const row = Number(match[2]) - 1
  if (column === null || column > MAX_COLUMN || row > MAX_ROW) return null
  return { row, column }
}

/**
 * `B4` or `B4:C10` (capital letters, no sheet name, no `$`) to a range;
 * a reversed pair (`C10:B4`) is normalised. Null for anything else.
 */
export function parseA1Range(text: string): CellRange | null {
  const parts = text.split(':')
  if (parts.length > 2) return null
  const a = parseCell(parts[0] ?? '')
  const b = parts.length === 2 ? parseCell(parts[1] ?? '') : a
  if (!a || !b) return null
  return {
    startRow: Math.min(a.row, b.row),
    startColumn: Math.min(a.column, b.column),
    endRow: Math.max(a.row, b.row),
    endColumn: Math.max(a.column, b.column),
  }
}
