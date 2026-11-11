// A1 references as SpreadsheetML writes them in attributes (`r`, `ref`,
// `sqref`), to 0-based coordinates and Google GridRanges (half open).

import type { GsGridRange } from '@naf-sheets/gsheets-import'

export interface CellRef {
  row: number
  col: number
}

export interface RangeRef {
  startRow: number
  startCol: number
  /** Inclusive; null = to the end of the sheet. */
  endRow: number | null
  endCol: number | null
}

function colOf(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** `B3` → {row: 2, col: 1}; `$B$3` too. Null when not a cell reference. */
export function parseCell(ref: string): CellRef | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim())
  if (!m) return null
  const row = Number(m[2]) - 1
  const col = colOf(m[1] as string)
  if (row < 0 || col < 0 || col > 16_383 || row > 1_048_575) return null
  return { row, col }
}

/** `A1:C5`, `A1`, `A:C`, `2:4` (with or without `$`). Null when not a range. */
export function parseRange(ref: string): RangeRef | null {
  const text = ref.trim()
  const parts = text.split(':')
  if (parts.length === 1) {
    const c = parseCell(text)
    return c ? { startRow: c.row, startCol: c.col, endRow: c.row, endCol: c.col } : null
  }
  if (parts.length !== 2) return null
  const [a, b] = parts as [string, string]
  const ca = parseCell(a)
  const cb = parseCell(b)
  if (ca && cb) {
    return {
      startRow: Math.min(ca.row, cb.row),
      startCol: Math.min(ca.col, cb.col),
      endRow: Math.max(ca.row, cb.row),
      endCol: Math.max(ca.col, cb.col),
    }
  }
  const cols = /^\$?([A-Za-z]{1,3})$/
  const rows = /^\$?(\d{1,7})$/
  const ma = cols.exec(a)
  const mb = cols.exec(b)
  if (ma && mb) {
    const x = colOf(ma[1] as string)
    const y = colOf(mb[1] as string)
    return { startRow: 0, startCol: Math.min(x, y), endRow: null, endCol: Math.max(x, y) }
  }
  const ra = rows.exec(a)
  const rb = rows.exec(b)
  if (ra && rb) {
    const x = Number(ra[1]) - 1
    const y = Number(rb[1]) - 1
    if (x < 0 || y < 0) return null
    return { startRow: Math.min(x, y), startCol: 0, endRow: Math.max(x, y), endCol: null }
  }
  return null
}

/** `A1:B2 D4` → ranges; unreadable parts are skipped. */
export function parseSqref(sqref: string | undefined): RangeRef[] {
  if (!sqref) return []
  return sqref
    .split(/\s+/)
    .filter(Boolean)
    .map(parseRange)
    .filter((r): r is RangeRef => r !== null)
}

export function toGridRange(range: RangeRef, sheetId: number): GsGridRange {
  const out: GsGridRange = { sheetId, startRowIndex: range.startRow, startColumnIndex: range.startCol }
  if (range.endRow !== null) out.endRowIndex = range.endRow + 1
  if (range.endCol !== null) out.endColumnIndex = range.endCol + 1
  return out
}

/** The range clipped to a sheet of `rows` × `cols`; null when nothing is left. */
export function clip(range: RangeRef, rows: number, cols: number): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  const endRow = Math.min(range.endRow ?? rows - 1, rows - 1)
  const endCol = Math.min(range.endCol ?? cols - 1, cols - 1)
  if (range.startRow > endRow || range.startCol > endCol) return null
  return { startRow: range.startRow, startCol: range.startCol, endRow, endCol }
}

/** `'My sheet'!$A$1:$B$4` or `Sheet1!A1` → sheet name and range; null otherwise. */
export function parseSheetRef(text: string): { sheet: string; range: RangeRef } | null {
  const m = /^\s*(?:'((?:[^']|'')+)'|([^'!:\s()"]+))!(\$?[A-Za-z]{0,3}\$?\d{0,7}(?::\$?[A-Za-z]{0,3}\$?\d{0,7})?)\s*$/.exec(text)
  if (!m) return null
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] as string)
  const range = parseRange(m[3] as string)
  return range ? { sheet, range } : null
}
