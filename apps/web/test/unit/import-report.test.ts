import { describe, expect, it } from 'vitest'
import type { ImportItemKind, ImportLocation, ImportReport, ImportReportItem } from '@naf-sheets/gsheets-import'
import { COUNT_KEYS, groupReportItems, itemTarget, outcomeCounts, parseImportReport } from '../../src/lib/import-report'
import { pathFor } from '../../src/lib/routes'
import { t } from '../../src/strings'

const counts = Object.fromEntries(COUNT_KEYS.map((k, i) => [k, i])) as unknown as ImportReport['counts']

const item = (over: Partial<ImportReportItem> & Pick<ImportReportItem, 'kind' | 'outcome'>): ImportReportItem => ({
  location: null,
  message: 'رسالة',
  ...over,
})

const at = (sheetId: string, sheetName: string, range: ImportLocation['range'], ref: string): ImportLocation => ({ sheetId, sheetName, range, ref })

function report(items: ImportReportItem[]): ImportReport {
  return {
    source: { spreadsheetId: 'abc', title: 'خطة الاتصال', locale: 'ar' },
    counts,
    sheets: [
      { googleSheetId: 1, sheetId: 's-1', name: 'المهام', hidden: false, rightToLeft: true },
      { googleSheetId: 2, sheetId: 's-2', name: 'الميزانية', hidden: true, rightToLeft: true },
      { googleSheetId: 3, sheetId: 's-3', name: 'فارغة', hidden: false, rightToLeft: true },
    ],
    items,
  }
}

describe('groupReportItems', () => {
  const formula = item({ kind: 'unsupported_formula', outcome: 'value_only', location: at('s-2', 'الميزانية', { startRow: 4, startColumn: 2, endRow: 4, endColumn: 2 }, "'الميزانية'!C5"), detail: '=GOOGLEFINANCE("X")' })
  const chart = item({ kind: 'chart', outcome: 'not_transferred', location: at('s-1', 'المهام', null, "'المهام'") })
  const banded = item({ kind: 'banded_range', outcome: 'converted', location: at('s-1', 'المهام', { startRow: 0, startColumn: 0, endRow: 9, endColumn: 3 }, "'المهام'!A1:D10") })
  const named = item({ kind: 'named_range', outcome: 'not_transferred' })
  const stray = item({ kind: 'comment', outcome: 'not_transferred', location: at('s-9', 'محذوفة', null, "'محذوفة'") })

  it('groups by sheet in the report’s order, then unknown sheets, then the workbook; empty sheets are left out', () => {
    const groups = groupReportItems(report([named, formula, stray, chart, banded]))
    expect(groups.map((g) => g.sheetId)).toEqual(['s-1', 's-2', 's-9', null])
    expect(groups[0]?.items).toEqual([chart, banded])
    expect(groups[1]).toMatchObject({ sheetName: 'الميزانية', hidden: true, items: [formula] })
    expect(groups[2]).toMatchObject({ sheetName: 'محذوفة', hidden: false, items: [stray] })
    expect(groups[3]).toMatchObject({ sheetName: null, items: [named] })
  })

  it('returns nothing when everything was transferred', () => {
    expect(groupReportItems(report([]))).toEqual([])
  })

  it('counts outcomes', () => {
    expect(outcomeCounts([named, formula, chart, banded])).toEqual({ not_transferred: 2, value_only: 1, converted: 1 })
  })

  it('links each located item to the editor at its sheet and range', () => {
    const target = itemTarget(formula)
    expect(target).toEqual({ sheet: 's-2', range: { startRow: 4, startColumn: 2, endRow: 4, endColumn: 2 } })
    expect(pathFor({ name: 'editor', id: 'wb-1', target: target! })).toBe('/workbooks/wb-1?sheet=s-2&range=C5')
    expect(itemTarget(chart)).toEqual({ sheet: 's-1', range: null })
    expect(itemTarget(named)).toBeNull()
  })
})

describe('parseImportReport', () => {
  it('accepts a report as the converter writes it', () => {
    const value = JSON.parse(JSON.stringify(report([item({ kind: 'chart', outcome: 'not_transferred', location: at('s-1', 'المهام', null, "'المهام'") })])))
    expect(parseImportReport(value)).toEqual(value)
  })

  it('keeps unknown item kinds (labelled generically on screen)', () => {
    const value = report([item({ kind: 'future_thing' as ImportReportItem['kind'], outcome: 'not_transferred' })])
    expect(parseImportReport(value)).not.toBeNull()
    expect(t.report.kinds['future_thing']).toBeUndefined()
  })

  it('refuses shapes the screen cannot draw from', () => {
    const good = report([])
    const bad: unknown[] = [
      null,
      'report',
      { ...good, source: null },
      { ...good, counts: { ...counts, cells: 'many' } },
      { ...good, sheets: [{ sheetId: 1, name: 'x', hidden: false }] },
      { ...good, items: [{ kind: 'chart', outcome: 'lost', location: null, message: 'x' }] },
      { ...good, items: [{ kind: 'chart', outcome: 'converted', location: { sheetId: 's', sheetName: 'x', ref: 'x', range: { startRow: 5, startColumn: 0, endRow: 1, endColumn: 0 } }, message: 'x' }] },
      { ...good, items: [{ kind: 'chart', outcome: 'converted', location: null }] },
    ]
    for (const value of bad) expect(parseImportReport(value)).toBeNull()
  })

  it('has an Arabic label for every kind the converter reports today', () => {
    // A Record over the union: a kind added to the package fails to compile here until labelled.
    const kinds: Record<ImportItemKind, true> = {
      unsupported_formula: true, image: true, derived_value: true, pivot_table: true, data_source_table: true, data_source_sheet: true,
      object_sheet: true, chart: true, slicer: true, filter_view: true, protected_range: true, banded_range: true, conditional_format: true,
      data_validation: true, filter: true, filter_criteria: true, hyperlink: true, smart_chip: true, number_format: true, table: true,
      row_group: true, column_group: true, comment: true, named_range: true, theme_color: true,
      checkbox: true, drawing_image: true, drawing_shape: true, unsupported_feature: true, cell_format: true,
    }
    for (const kind of Object.keys(kinds)) expect(t.report.kinds[kind], kind).toMatch(/[؀-ۿ]/)
  })
})
