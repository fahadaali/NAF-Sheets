// Ranges: Google GridRange (half open, unbounded sides allowed) to Univer
// IRange (inclusive on both ends: `{0,0,1,1}` is A1:B2 — core
// sheets/typedef.d.ts, and FDefinedNameBuilder.setRefByRange uses
// `endRow = row + numRows - 1`), plus A1 notation for the report.

import type { IRange } from '@univerjs/core'
import type { GsGridRange } from './google-types'

export interface GridSize {
  rowCount: number
  columnCount: number
}

/** Inclusive Univer range, or null when the Google range is empty. Unbounded sides take the sheet's size. */
export function gridRangeToRange(range: GsGridRange | undefined, size: GridSize): IRange | null {
  if (!range) return null
  const startRow = range.startRowIndex ?? 0
  const startColumn = range.startColumnIndex ?? 0
  const endRow = (range.endRowIndex ?? size.rowCount) - 1
  const endColumn = (range.endColumnIndex ?? size.columnCount) - 1
  if (endRow < startRow || endColumn < startColumn) return null
  return { startRow, startColumn, endRow, endColumn }
}

export function cellRange(row: number, column: number): IRange {
  return { startRow: row, startColumn: column, endRow: row, endColumn: column }
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(column: number): string {
  let n = column + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export function a1Cell(row: number, column: number): string {
  return `${columnLetters(column)}${row + 1}`
}

/** `B4` for a single cell, `B4:C10` otherwise. */
export function a1Range(range: IRange): string {
  const start = a1Cell(range.startRow, range.startColumn)
  if (range.startRow === range.endRow && range.startColumn === range.endColumn) return start
  return `${start}:${a1Cell(range.endRow, range.endColumn)}`
}

/** `$B$4:$C$10`. */
export function absoluteA1Range(range: IRange): string {
  const cell = (r: number, c: number) => `$${columnLetters(c)}$${r + 1}`
  const start = cell(range.startRow, range.startColumn)
  if (range.startRow === range.endRow && range.startColumn === range.endColumn) return start
  return `${start}:${cell(range.endRow, range.endColumn)}`
}

/** Always quoted, `'` doubled: valid in both Google and Univer formulas whatever the name contains. */
export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

/** `'المهام'!B4:C10` — what the report shows and the UI can parse back. */
export function sheetRef(sheetName: string, range: IRange): string {
  return `${quoteSheetName(sheetName)}!${a1Range(range)}`
}

/**
 * Groups cells into rectangles: horizontal runs per row, then identical runs
 * on consecutive rows merged. Output sorted by start row, then start column.
 */
export function cellsToRanges(cells: ReadonlyArray<readonly [number, number]>): IRange[] {
  const byRow = new Map<number, number[]>()
  for (const [r, c] of cells) {
    const list = byRow.get(r)
    if (list) list.push(c)
    else byRow.set(r, [c])
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b)
  const open = new Map<string, IRange>()
  const done: IRange[] = []
  for (const r of rows) {
    const cols = [...new Set(byRow.get(r))].sort((a, b) => a - b)
    const runs: Array<[number, number]> = []
    for (const c of cols) {
      const last = runs[runs.length - 1]
      if (last && last[1] === c - 1) last[1] = c
      else runs.push([c, c])
    }
    const seenKeys = new Set<string>()
    for (const [c0, c1] of runs) {
      const key = `${c0}:${c1}`
      seenKeys.add(key)
      const prev = open.get(key)
      if (prev && prev.endRow === r - 1) {
        prev.endRow = r
      } else {
        if (prev) done.push(prev)
        open.set(key, { startRow: r, startColumn: c0, endRow: r, endColumn: c1 })
      }
    }
    for (const [key, range] of open) {
      if (!seenKeys.has(key) && range.endRow < r) {
        done.push(range)
        open.delete(key)
      }
    }
  }
  done.push(...open.values())
  return done.sort((a, b) => a.startRow - b.startRow || a.startColumn - b.startColumn)
}

/** 'A' → 0, 'AA' → 26. */
function columnIndexOf(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** A range a list formula names; open sides (whole columns or rows) are `null`. */
export interface ListReferenceRange {
  startRow: number
  startColumn: number
  endRow: number | null
  endColumn: number | null
}

export type ListReference =
  | { kind: 'range'; sheet: string | null; range: ListReferenceRange }
  | { kind: 'name'; name: string }

const CELL_A1 = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/
const COLS_A1 = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/
const ROWS_A1 = /^\$?(\d{1,7}):\$?(\d{1,7})$/
const NAME = /^[\p{L}_\\][\p{L}\p{N}_.]*$/u

/**
 * A list source that is a plain reference: `=A2:A9`, `='القوائم'!$A:$A`,
 * `=Sheet1!$B$2:$B`, or a defined name `=Statuses`. Anything else (INDIRECT,
 * OFFSET, a constant) is null: its items are only known once computed.
 */
export function parseListReference(formula: string): ListReference | null {
  let text = formula.trim()
  if (text.startsWith('=')) text = text.slice(1).trim()
  if (text === '') return null
  let sheet: string | null = null
  const bang = text.lastIndexOf('!')
  if (bang > 0) {
    const prefix = text.slice(0, bang)
    text = text.slice(bang + 1)
    if (/^'(?:[^']|'')+'$/.test(prefix)) sheet = prefix.slice(1, -1).replace(/''/g, "'")
    else if (/^[^'"!:()\s]+$/.test(prefix)) sheet = prefix
    else return null
  }
  const parts = text.split(':')
  if (parts.length > 2) return null
  const cols = COLS_A1.exec(text)
  if (cols) {
    const a = columnIndexOf(cols[1] as string)
    const b = columnIndexOf(cols[2] as string)
    return { kind: 'range', sheet, range: { startRow: 0, startColumn: Math.min(a, b), endRow: null, endColumn: Math.max(a, b) } }
  }
  const rows = ROWS_A1.exec(text)
  if (rows) {
    const a = Number(rows[1]) - 1
    const b = Number(rows[2]) - 1
    return { kind: 'range', sheet, range: { startRow: Math.min(a, b), startColumn: 0, endRow: Math.max(a, b), endColumn: null } }
  }
  const first = CELL_A1.exec(parts[0] as string)
  if (first) {
    const r1 = Number(first[2]) - 1
    const c1 = columnIndexOf(first[1] as string)
    if (parts.length === 1) return { kind: 'range', sheet, range: { startRow: r1, startColumn: c1, endRow: r1, endColumn: c1 } }
    const second = parts[1] as string
    const cell = CELL_A1.exec(second)
    if (cell) {
      const r2 = Number(cell[2]) - 1
      const c2 = columnIndexOf(cell[1] as string)
      return { kind: 'range', sheet, range: { startRow: Math.min(r1, r2), startColumn: Math.min(c1, c2), endRow: Math.max(r1, r2), endColumn: Math.max(c1, c2) } }
    }
    // Google's open-ended `A2:A` (to the end of the column).
    const col = /^\$?([A-Za-z]{1,3})$/.exec(second)
    if (col) {
      const c2 = columnIndexOf(col[1] as string)
      return { kind: 'range', sheet, range: { startRow: r1, startColumn: Math.min(c1, c2), endRow: null, endColumn: Math.max(c1, c2) } }
    }
    return null
  }
  if (sheet === null && parts.length === 1 && NAME.test(text) && !/^(TRUE|FALSE)$/i.test(text)) return { kind: 'name', name: text }
  return null
}
