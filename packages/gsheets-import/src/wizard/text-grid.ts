// The wizard works on cell text: one string per cell, '' when empty, leading
// whitespace kept (it carries indentation, spec §7.3 step 5).

import type { ICellData, IWorksheetData } from '@univerjs/core'
import { CELL_TYPE } from '../univer-constants'

export type TextGrid = ReadonlyArray<ReadonlyArray<string>>

/** Display-independent text of each cell of a converted (or any Univer) worksheet. */
export function textGridFromWorksheet(sheet: Partial<IWorksheetData>): string[][] {
  const grid: string[][] = []
  const cellData = sheet.cellData ?? {}
  for (const [rowKey, line] of Object.entries(cellData)) {
    const r = Number(rowKey)
    for (const [colKey, cell] of Object.entries(line ?? {}) as Array<[string, ICellData | undefined]>) {
      const c = Number(colKey)
      let text = ''
      const stream = cell?.p?.body?.dataStream
      if (stream) text = stream.replace(/\r\n$/, '').replace(/\r/g, '\n')
      else if (cell?.v !== undefined && cell?.v !== null) {
        if (cell.t === CELL_TYPE.BOOLEAN) text = cell.v ? 'TRUE' : 'FALSE'
        else text = String(cell.v)
      }
      if (text === '') continue
      while (grid.length <= r) grid.push([])
      const row = grid[r] as string[]
      while (row.length <= c) row.push('')
      row[c] = text
    }
  }
  return grid
}

export function cellText(grid: TextGrid, row: number, column: number): string {
  return grid[row]?.[column] ?? ''
}

export function columnCount(grid: TextGrid): number {
  return grid.reduce((n, row) => Math.max(n, row.length), 0)
}
