import { describe, expect, it } from 'vitest'
import { convertSpreadsheet } from '../src'
import type { GsSheet } from '../src/google-types'
import { spreadsheet, str } from './helpers/build'

describe('row/column metadata → rowData/columnData', () => {
  const sheet: GsSheet = {
    properties: { sheetId: 0, title: 'ورقة1', index: 0, gridProperties: { rowCount: 6, columnCount: 4 }, rightToLeft: true },
    data: [
      {
        rowData: [{ values: [str('أ')] }],
        rowMetadata: [{ pixelSize: 40 }, { pixelSize: 21 }, { pixelSize: 21, hiddenByUser: true }, { pixelSize: 21, hiddenByFilter: true }, { pixelSize: 21 }, { pixelSize: 21 }],
        columnMetadata: [{ pixelSize: 220 }, { pixelSize: 100 }, { pixelSize: 100, hiddenByUser: true }, { pixelSize: 100 }],
      },
    ],
  }
  const ws = convertSpreadsheet(spreadsheet([sheet])).workbook.sheets['sheet-0']

  it('uses the most common size as the default and writes only the exceptions', () => {
    expect(ws?.defaultRowHeight).toBe(21)
    expect(ws?.defaultColumnWidth).toBe(100)
    expect(ws?.rowData).toEqual({ 0: { h: 40 }, 2: { hd: 1 } })
    expect(ws?.columnData).toEqual({ 0: { w: 220 }, 2: { hd: 1 } })
  })

  it('does not hide rows hidden by the filter (the transferred filter does that)', () => {
    expect(ws?.rowData?.[3]).toBeUndefined()
  })
})

describe('several GridData blocks', () => {
  it('places each block at its startRow/startColumn', () => {
    const sheet: GsSheet = {
      properties: { sheetId: 0, title: 'ورقة1', index: 0, gridProperties: { rowCount: 30, columnCount: 10 } },
      data: [
        { startRow: 0, startColumn: 0, rowData: [{ values: [str('A1')] }] },
        { startRow: 14, startColumn: 3, rowData: [{ values: [str('D15'), str('E15')] }], rowMetadata: [{ pixelSize: 50 }], columnMetadata: [{ pixelSize: 30 }, { pixelSize: 30 }] },
      ],
    }
    const ws = convertSpreadsheet(spreadsheet([sheet])).workbook.sheets['sheet-0']
    expect(ws?.cellData?.[0]?.[0]?.v).toBe('A1')
    expect(ws?.cellData?.[14]?.[3]?.v).toBe('D15')
    expect(ws?.cellData?.[14]?.[4]?.v).toBe('E15')
    expect(ws?.defaultRowHeight).toBe(50)
    expect(ws?.defaultColumnWidth).toBe(30)
  })
})

describe('merges → mergeData', () => {
  it('converts half-open ranges to inclusive ones and counts them', () => {
    const sheet: GsSheet = {
      properties: { sheetId: 0, title: 'ورقة1', index: 0, gridProperties: { rowCount: 10, columnCount: 6 } },
      data: [{ rowData: [{ values: [str('عنوان')] }] }],
      merges: [
        { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
        { sheetId: 0, startRowIndex: 3, endRowIndex: 6, startColumnIndex: 2, endColumnIndex: 3 },
      ],
    }
    const { workbook, report } = convertSpreadsheet(spreadsheet([sheet]))
    expect(workbook.sheets['sheet-0']?.mergeData).toEqual([
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 3 },
      { startRow: 3, endRow: 5, startColumn: 2, endColumn: 2 },
    ])
    expect(report.counts.merges).toBe(2)
  })
})
