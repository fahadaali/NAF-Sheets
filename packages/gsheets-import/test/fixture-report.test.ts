// End to end on the synthetic Arabic workbook (test/fixtures/naf-comms-plan.ts):
// counts, and every not-transferred / value-only / converted item with the
// location the report screen links to (spec §7.2 "تقرير الاستيراد").

import { describe, expect, it } from 'vitest'
import { convertSpreadsheet } from '../src'
import { nafCommsPlan } from './fixtures/naf-comms-plan'

const { workbook, report } = convertSpreadsheet(nafCommsPlan)

describe('import report for the synthetic NAF workbook', () => {
  it('counts what was transferred', () => {
    expect(report.source).toEqual({
      spreadsheetId: '1SyNtHeTiCfIxTuReNaFcOmMs2026',
      title: 'خطة الاتصال المؤسسي 2026',
      locale: 'ar',
      origin: { kind: 'google_api', via: 'google_api', application: null, alignment: 'as_given' },
    })
    expect(report.counts).toMatchObject({
      sheets: 4,
      // Kept: IF, SUM (المهام); COUNTIF, SUM(Costs), UNIQUE (الملخص).
      formulas: 5,
      // GOOGLEFINANCE, IMPORTRANGE, IMAGE, SPARKLINE, QUERY, FILTER with two conditions.
      valueOnlyFormulas: 6,
      merges: 1,
      conditionalFormatRules: 3,
      dataValidationRules: 4,
      filters: 1,
      hyperlinks: 3,
      definedNames: 2,
      // One note in the source, plus one per value-only formula.
      notes: 7,
    })
    expect(report.counts.cells).toBeGreaterThan(80)
    expect(report.counts.styles).toBe(Object.keys(workbook.styles).length)
  })

  it('lists every item that was not transferred, kept as a value or converted, with its location', () => {
    expect(report.items.map((i) => [i.kind, i.outcome, i.location?.ref ?? null])).toEqual([
      ['conditional_format', 'not_transferred', "'المهام'!E2:E6"],
      ['filter_view', 'not_transferred', "'المهام'!A1:I6"],
      ['protected_range', 'not_transferred', "'المهام'!A1:I1"],
      ['banded_range', 'converted', "'الملخص'!A2:D8"],
      ['unsupported_formula', 'value_only', "'الملخص'!B5"],
      ['unsupported_formula', 'value_only', "'الملخص'!B6"],
      ['image', 'value_only', "'الملخص'!B7"],
      ['unsupported_formula', 'value_only', "'الملخص'!B8"],
      ['unsupported_formula', 'value_only', "'الملخص'!A11:A12"],
      ['unsupported_formula', 'value_only', "'الملخص'!E11"],
      ['chart', 'not_transferred', "'الملخص'!F2"],
      ['pivot_table', 'not_transferred', "'تحليل'!A1:B6"],
      ['smart_chip', 'not_transferred', "'تحليل'!A8"],
      ['slicer', 'not_transferred', "'تحليل'!D1"],
      ['row_group', 'not_transferred', "'تحليل'!A2:F5"],
      ['comment', 'not_transferred', "'تحليل'!B6"],
      ['object_sheet', 'not_transferred', "'مخطط'"],
    ])
  })

  it('gives each item an Arabic message and a location the UI can open', () => {
    for (const item of report.items) {
      expect(item.message).toMatch(/[؀-ۿ]/)
      if (item.kind === 'object_sheet') continue // its sheet is not in the workbook
      expect(item.location).not.toBeNull()
      expect(workbook.sheets[item.location?.sheetId ?? '']?.name).toBe(item.location?.sheetName)
      expect(item.location?.range).not.toBeNull()
    }
  })

  it('keeps the original formula of value-only cells as the item detail', () => {
    const details = report.items.filter((i) => i.outcome === 'value_only').map((i) => i.detail)
    expect(details).toEqual([
      '=GOOGLEFINANCE("TADAWUL:2222","price")',
      '=IMPORTRANGE("https://docs.google.com/spreadsheets/d/1BrAnCh/edit","الفرع!B2")',
      '=IMAGE("https://naflaw.sa/logo.png")',
      "=SPARKLINE('المهام'!H2:H6)",
      "=QUERY('المهام'!B2:F6,\"select B where F = 'متأخر'\",0)",
      "=FILTER('المهام'!B2:B6,'المهام'!F2:F6=\"متأخر\",'المهام'!H2:H6>5000)",
    ])
  })

  it('names the not-transferred kinds spec §7.2 lists', () => {
    const kinds = new Set(report.items.map((i) => i.kind))
    for (const kind of ['filter_view', 'chart', 'pivot_table', 'slicer', 'protected_range', 'image', 'banded_range', 'unsupported_formula'] as const) {
      expect(kinds.has(kind), kind).toBe(true)
    }
  })
})
