import { describe, expect, it } from 'vitest'
import { convertSpreadsheet } from '../src'
import { gridSheet, spreadsheet, str } from './helpers/build'
import { DASHBOARD_SHEET_TITLE, contentSheetIds, findDashboardSheetId, isDashboardSheet } from '@naf-sheets/shared'

describe('sheets[].properties → worksheet', () => {
  const response = spreadsheet([
    gridSheet([[str('ب')]], {}, { sheetId: 20, title: 'الثانية', index: 1, hidden: true, rightToLeft: false }),
    gridSheet([[str('أ')]], {}, {
      sheetId: 10,
      title: 'الأولى',
      index: 0,
      rightToLeft: true,
      tabColor: { red: 1 },
      tabColorStyle: { rgbColor: { green: 1 } },
      gridProperties: { rowCount: 200, columnCount: 12, frozenRowCount: 2, frozenColumnCount: 1, hideGridlines: true },
    }),
  ])
  const { workbook, report } = convertSpreadsheet(response, { workbookId: 'wb-1' })

  it('orders sheets by index and keeps their titles', () => {
    expect(workbook.sheetOrder).toEqual(['sheet-10', 'sheet-20'])
    expect(workbook.sheets['sheet-10']?.name).toBe('الأولى')
    expect(workbook.sheets['sheet-20']?.name).toBe('الثانية')
  })

  it('maps hidden, tab colour (…Style wins), rightToLeft, frozen rows/columns, size and gridlines', () => {
    const first = workbook.sheets['sheet-10']
    expect(first).toMatchObject({
      id: 'sheet-10',
      hidden: 0,
      tabColor: '#00ff00',
      rightToLeft: 1,
      rowCount: 200,
      columnCount: 12,
      freeze: { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 },
      showGridlines: 0,
    })
    expect(workbook.sheets['sheet-20']).toMatchObject({ hidden: 1, rightToLeft: 0, tabColor: '', freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 } })
  })

  it('fills the workbook header', () => {
    expect(workbook).toMatchObject({ id: 'wb-1', name: 'اختبار', appVersion: '1.4.0', locale: 'arSA' })
    expect(report.sheets).toEqual([
      { googleSheetId: 10, sheetId: 'sheet-10', name: 'الأولى', hidden: false, rightToLeft: true },
      { googleSheetId: 20, sheetId: 'sheet-20', name: 'الثانية', hidden: true, rightToLeft: false },
    ])
    expect(report.counts.sheets).toBe(2)
  })

  it('defaults the workbook id from the spreadsheet id', () => {
    expect(convertSpreadsheet(response).workbook.id).toBe('gsheets-test-id')
  })

  it('grows the grid to hold every cell when gridProperties are smaller', () => {
    const r = convertSpreadsheet(spreadsheet([gridSheet([[str('a'), str('b'), str('c')], [str('d')]], {}, { gridProperties: { rowCount: 1, columnCount: 1 } })]))
    expect(r.workbook.sheets['sheet-0']).toMatchObject({ rowCount: 2, columnCount: 3 })
  })

  it('skips an OBJECT (chart) sheet and reports it', () => {
    const r = convertSpreadsheet(
      spreadsheet([gridSheet([[str('x')]]), { properties: { sheetId: 9, title: 'مخطط', index: 1, sheetType: 'OBJECT' }, charts: [{ chartId: 1, position: { sheetId: 9 } }] }]),
    )
    expect(r.workbook.sheetOrder).toEqual(['sheet-0'])
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'object_sheet', outcome: 'not_transferred', location: expect.objectContaining({ sheetId: 'sheet-9', ref: "'مخطط'" }) }))
  })

  it('keeps a DATA_SOURCE sheet as values and reports it', () => {
    const r = convertSpreadsheet(spreadsheet([gridSheet([[{ effectiveValue: { numberValue: 5 }, formattedValue: '5' }]], {}, { sheetType: 'DATA_SOURCE' })]))
    expect(r.workbook.sheets['sheet-0']?.cellData?.[0]?.[0]).toEqual({ v: 5, t: 2 })
    expect(r.report.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['data_source_sheet', 'derived_value']))
  })

  it('maps iterative calculation settings', () => {
    const r = convertSpreadsheet({ ...spreadsheet([gridSheet([])]), properties: { title: 't', iterativeCalculationSettings: { maxIterations: 50, convergenceThreshold: 0.01 } } })
    expect(r.workbook.calculationSettings).toEqual({ iterativeCalculation: true, maxIterations: 50, maxChange: 0.01 })
    expect(convertSpreadsheet(spreadsheet([gridSheet([])])).workbook.calculationSettings).toBeUndefined()
  })
})

describe('the platform dashboard sheet «اللوحة» (@naf-sheets/shared dashboard-sheet.ts)', () => {
  it('is never created by the import: a Google sheet named «اللوحة» stays an ordinary sheet', () => {
    const response = spreadsheet([
      gridSheet([[str('المؤشر')]], {}, { sheetId: 1, title: DASHBOARD_SHEET_TITLE, index: 0 }),
      gridSheet([[str('المهمة')]], {}, { sheetId: 2, title: 'المهام', index: 1 }),
    ])
    const { workbook } = convertSpreadsheet(response, { workbookId: 'wb-1' })
    expect(workbook.sheetOrder).toEqual(['sheet-1', 'sheet-2'])
    expect(findDashboardSheetId(workbook)).toBeNull()
    expect(contentSheetIds(workbook)).toEqual(['sheet-1', 'sheet-2'])
    expect(Object.values(workbook.sheets).some((s) => isDashboardSheet(s))).toBe(false)
  })
})
