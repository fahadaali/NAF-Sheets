// Header-row detection (spec §7.3 step 3: automatic, default row 1, editable).
//
// The row among the first `scanRows` whose cells match the most column
// synonyms is the header, provided at least two of its cells match (one match
// is too weak: a title row like "تقرير الحالة" would win). Otherwise row 1.

import { matchHeader } from './column-mapping'
import { columnCount, type TextGrid } from './text-grid'

export interface HeaderRowDetection {
  /** 0-based row index. */
  row: number
  reason: 'synonyms' | 'default'
  /** Cells of that row matching a synonym. */
  matchedColumns: number
}

export function detectHeaderRow(grid: TextGrid, options: { scanRows?: number } = {}): HeaderRowDetection {
  const scan = Math.min(options.scanRows ?? 10, grid.length)
  const width = columnCount(grid)
  let best = { row: 0, matched: 0 }
  for (let r = 0; r < scan; r++) {
    let matched = 0
    for (let c = 0; c < width; c++) if (matchHeader(grid[r]?.[c] ?? '').length > 0) matched++
    if (matched > best.matched) best = { row: r, matched }
  }
  if (best.matched >= 2) return { row: best.row, reason: 'synonyms', matchedColumns: best.matched }
  return { row: 0, reason: 'default', matchedColumns: best.row === 0 ? best.matched : 0 }
}
