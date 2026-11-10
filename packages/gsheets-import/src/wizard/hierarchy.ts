// Task hierarchy in an imported sheet (spec §7.3 step 5): subtasks are found
// from a numbering column (1, 1.1, 1.2) or from leading indentation of the
// title; otherwise every row is a main task (level 0). Basecamp 5 has one
// level of subtasks (spec §8), so deeper rows are flagged.
//
// Only rows with a non-empty title are tasks.

import { latinDigits } from './normalize'
import { cellText, columnCount, type TextGrid } from './text-grid'

export type HierarchyLevel = 0 | 1

export interface HierarchyRow {
  row: number
  level: HierarchyLevel
  /** Row of the parent task, for level 1. */
  parentRow: number | null
}

export interface HierarchyWarning {
  row: number
  /**
   * too_deep: a third level (1.1.1, or a deeper indent); kept at level 1 under its top-level ancestor.
   * orphan: looks like a subtask but no main task precedes it; kept at level 0.
   * OPEN: OPEN_QUESTIONS.md §11.
   */
  kind: 'too_deep' | 'orphan'
}

export interface HierarchyDetection {
  source: 'numbering' | 'indentation' | 'none'
  numberingColumn: number | null
  rows: HierarchyRow[]
  warnings: HierarchyWarning[]
}

export interface HierarchyOptions {
  headerRow: number
  titleColumn: number
  /** Skip auto-detection and use this column (or none, with null). */
  numberingColumn?: number | null
}

const NUMBERING = /^\d+(\.\d+)*\.?$/

function numberingParts(text: string): string[] | null {
  const t = latinDigits(text).trim()
  if (!NUMBERING.test(t)) return null
  return t.replace(/\.$/, '').split('.')
}

/** A column where every non-empty data cell is a numbering and at least one is dotted (1.1). */
export function detectNumberingColumn(grid: TextGrid, dataRows: number[]): number | null {
  const width = columnCount(grid)
  for (let c = 0; c < width; c++) {
    let values = 0
    let dotted = false
    let ok = true
    for (const r of dataRows) {
      const text = cellText(grid, r, c).trim()
      if (text === '') continue
      const parts = numberingParts(text)
      if (!parts) {
        ok = false
        break
      }
      values++
      if (parts.length > 1) dotted = true
    }
    if (ok && dotted && values >= 2) return c
  }
  return null
}

const LEADING_SPACE = /^[\s 　]+/

export function detectHierarchy(grid: TextGrid, options: HierarchyOptions): HierarchyDetection {
  const taskRows: number[] = []
  for (let r = options.headerRow + 1; r < grid.length; r++) {
    if (cellText(grid, r, options.titleColumn).trim() !== '') taskRows.push(r)
  }
  const flat: HierarchyDetection = {
    source: 'none',
    numberingColumn: null,
    rows: taskRows.map((row) => ({ row, level: 0, parentRow: null })),
    warnings: [],
  }

  const numberingColumn = options.numberingColumn === undefined ? detectNumberingColumn(grid, taskRows) : options.numberingColumn
  if (numberingColumn !== null) {
    const rows: HierarchyRow[] = []
    const warnings: HierarchyWarning[] = []
    const topByNumber = new Map<string, number>()
    for (const row of taskRows) {
      const parts = numberingParts(cellText(grid, row, numberingColumn))
      if (!parts || parts.length === 1) {
        rows.push({ row, level: 0, parentRow: null })
        if (parts) topByNumber.set(String(Number(parts[0])), row)
        continue
      }
      const parent = topByNumber.get(String(Number(parts[0])))
      if (parent === undefined) {
        rows.push({ row, level: 0, parentRow: null })
        warnings.push({ row, kind: 'orphan' })
        continue
      }
      rows.push({ row, level: 1, parentRow: parent })
      if (parts.length > 2) warnings.push({ row, kind: 'too_deep' })
    }
    return { source: 'numbering', numberingColumn, rows, warnings }
  }

  const indents = taskRows.map((row) => LEADING_SPACE.exec(cellText(grid, row, options.titleColumn))?.[0].length ?? 0)
  const widths = [...new Set(indents)].sort((a, b) => a - b)
  if (widths.length < 2 || widths[0] !== 0) return flat

  const rows: HierarchyRow[] = []
  const warnings: HierarchyWarning[] = []
  let lastTop: number | null = null
  taskRows.forEach((row, i) => {
    const indent = indents[i] as number
    if (indent === 0) {
      rows.push({ row, level: 0, parentRow: null })
      lastTop = row
      return
    }
    if (lastTop === null) {
      rows.push({ row, level: 0, parentRow: null })
      warnings.push({ row, kind: 'orphan' })
      return
    }
    rows.push({ row, level: 1, parentRow: lastTop })
    if (indent > (widths[1] as number)) warnings.push({ row, kind: 'too_deep' })
  })
  return { source: 'indentation', numberingColumn: null, rows, warnings }
}
