// Reading a sheet's cells the same way whether they come from a stored
// snapshot (`IWorksheetData`, unit tests and sheet-model calls) or from the
// live Univer worksheet (the editor). Pure: no Univer runtime import.

import type { ICellData, IWorksheetData } from '@univerjs/core'

export interface CellReader {
  /** The stored cell (no interceptors), or nothing. */
  cell(row: number, column: number): ICellData | null | undefined
  /** Last 0-based row holding a cell; -1 when none. */
  lastRow(): number
  /** Last 0-based column holding a cell; -1 when none. */
  lastColumn(): number
}

type CellMatrix = Record<number, Record<number, ICellData | null | undefined> | undefined>

/** A reader over a stored sheet. */
export function snapshotReader(sheet: Partial<IWorksheetData> | undefined): CellReader {
  const data = (sheet?.cellData ?? {}) as CellMatrix
  let lastRow = -1
  let lastColumn = -1
  for (const [r, line] of Object.entries(data)) {
    const row = Number(r)
    if (!Number.isInteger(row) || !line) continue
    for (const c of Object.keys(line)) {
      if (line[Number(c)] == null) continue
      lastRow = Math.max(lastRow, row)
      lastColumn = Math.max(lastColumn, Number(c))
    }
  }
  return {
    cell: (row, column) => data[row]?.[column],
    lastRow: () => lastRow,
    lastColumn: () => lastColumn,
  }
}

/**
 * Display-independent text of a cell: rich text first, else the value
 * (booleans as TRUE / FALSE), '' when empty. Same reading as sheet-model's
 * `cellText`, which the server uses.
 */
export function cellText(cell: ICellData | null | undefined): string {
  if (!cell) return ''
  const stream = cell.p?.body?.dataStream
  if (stream) {
    const text = stream.replace(/\r\n$/, '').replace(/\r/g, '\n')
    // A picture in the cell (`\b`, a custom block) is never text (sheet-model cell-images.ts).
    if (!text.includes('\b')) return text
    const withoutPictures = text.split('\b').join('')
    const drawings = (cell.p as { drawings?: Record<string, unknown> }).drawings
    return drawings && Object.keys(drawings).length > 0 ? withoutPictures.replace(/^\n+/, '').replace(/\n+$/, '') : withoutPictures
  }
  const v = cell.v
  if (v === undefined || v === null) return ''
  if (cell.t === 3 || typeof v === 'boolean') return v === true || v === 1 || String(v).toUpperCase() === 'TRUE' || v === '1' ? 'TRUE' : 'FALSE'
  return String(v)
}
