// reorderRows: Univer's sort semantics on a snapshot.

import { describe, expect, it } from 'vitest'
import type { WorkbookSnapshot } from '../src'
import { reorderRows } from '../src/rows'
import { blankWorkbook, cell, putRow } from './helpers'

const S = 'sheet-1'

function fiveRows(): WorkbookSnapshot {
  const wb = blankWorkbook()
  for (let r = 1; r <= 5; r++) putRow(wb, S, r, { A: `r${r}` })
  return wb
}

function resource(wb: WorkbookSnapshot, name: string): Record<string, unknown> {
  return JSON.parse(wb.resources?.find((r) => r.name === name)?.data ?? '{}') as Record<string, unknown>
}

// Rotate rows 1..3: row 1 gets row 3's content, 2 gets 1's, 3 gets 2's.
const rotate = [
  { to: 1, from: 3 },
  { to: 2, from: 1 },
  { to: 3, from: 2 },
]

describe('reorderRows', () => {
  it('moves whole rows with their settings', () => {
    const wb = fiveRows()
    wb.sheets[S]!.rowData = { 3: { h: 40, hd: 1 } }
    const result = reorderRows(wb, S, rotate)
    expect(result.ok && result.value.rows).toEqual([1, 2, 3])
    expect([1, 2, 3, 4].map((r) => cell(wb, S, r, 'A')?.v)).toEqual(['r3', 'r1', 'r2', 'r4'])
    expect(wb.sheets[S]!.rowData).toEqual({ 1: { h: 40, hd: 1 } })
  })

  it('splits validation and format ranges row by row, as Univer does', () => {
    const wb = fiveRows()
    wb.resources = [
      { name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: JSON.stringify({ [S]: [{ cfId: 'c', ranges: [{ startRow: 1, endRow: 2, startColumn: 3, endColumn: 3 }] }] }) },
      { name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ [S]: [{ uid: 'd', type: 'checkbox', ranges: [{ startRow: 0, endRow: 5, startColumn: 4, endColumn: 4 }] }] }) },
      { name: 'SHEET_DEFINED_NAME_PLUGIN', data: JSON.stringify({ x: { id: 'x', name: 'Total', formulaOrRefString: `'المهام'!A2` } }) },
    ]
    const result = reorderRows(wb, S, rotate)
    expect(result.ok).toBe(true)
    // Rows 1 and 2 held the format; their content is now in rows 2 and 3.
    expect((resource(wb, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN')[S] as Array<{ ranges: unknown }>)[0]?.ranges).toEqual([
      { startRow: 2, endRow: 3, startColumn: 3, endColumn: 3 },
    ])
    // A range covering every reordered row stays as it is.
    expect((resource(wb, 'SHEET_DATA_VALIDATION_PLUGIN')[S] as Array<{ ranges: unknown }>)[0]?.ranges).toEqual([
      { startRow: 0, endRow: 5, startColumn: 4, endColumn: 4 },
    ])
    // Defined names keep their addresses (sort semantics).
    expect(resource(wb, 'SHEET_DEFINED_NAME_PLUGIN')).toEqual({ x: { id: 'x', name: 'Total', formulaOrRefString: `'المهام'!A2` } })
  })

  it('keeps a filter range in one piece, or refuses', () => {
    const wb = fiveRows()
    wb.resources = [{ name: 'SHEET_FILTER_PLUGIN', data: JSON.stringify({ [S]: { ref: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 6 }, cachedFilteredOut: [2] } }) }]
    const inside = structuredClone(wb)
    expect(reorderRows(inside, S, rotate).ok).toBe(true)
    expect(resource(inside, 'SHEET_FILTER_PLUGIN')[S]).toEqual({ ref: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 6 }, cachedFilteredOut: [3] })
    const across = structuredClone(wb)
    const result = reorderRows(across, S, [
      { to: 2, from: 5 },
      { to: 5, from: 2 },
    ])
    expect(!result.ok && result.error.code).toBe('range_split')
    expect(across).toEqual(wb)
  })

  it('refuses when another plugin keeps data for the sheet, and ignores row-independent ones', () => {
    const wb = fiveRows()
    wb.resources = [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ [S]: { data: { img: { sheetTransform: { from: { row: 2 } } } } } }) }]
    const refused = reorderRows(wb, S, rotate)
    expect(!refused.ok && refused.error.code).toBe('unsupported_resource')
    expect(!refused.ok && refused.error.detail).toBe('SHEET_DRAWING_PLUGIN')
    const fine = fiveRows()
    fine.resources = [{ name: 'SHEET_WORKSHEET_PROTECTION_PLUGIN', data: JSON.stringify({ [S]: { permissionId: 'p' } }) }]
    expect(reorderRows(fine, S, rotate).ok).toBe(true)
  })

  it('empties rows whose content leaves, and returns their notes', () => {
    const wb = fiveRows()
    wb.resources = [{ name: 'SHEET_NOTE_PLUGIN', data: JSON.stringify({ [S]: { 2: { 0: { id: 'n', row: 2, col: 0, width: 1, height: 1, note: 'x' } } } }) }]
    const result = reorderRows(wb, S, [
      { to: 2, from: 3 },
      { to: 3, from: null },
    ])
    expect(result.ok && result.value.removedNotes).toEqual([{ fromRow: 2, column: 0, note: { id: 'n', row: 2, col: 0, width: 1, height: 1, note: 'x' } }])
    expect([1, 2, 3, 4].map((r) => cell(wb, S, r, 'A')?.v)).toEqual(['r1', 'r3', undefined, 'r4'])
    expect(resource(wb, 'SHEET_NOTE_PLUGIN')).toEqual({})
  })
})
