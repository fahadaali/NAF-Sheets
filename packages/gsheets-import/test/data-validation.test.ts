import type { ISheetDataValidationRule } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { convertSpreadsheet, RESOURCE } from '../src'
import type { GsCellData, GsDataValidationRule } from '../src/google-types'
import { oneSheet, resourceOf, str } from './helpers/build'

function convertColumn(rule: GsDataValidationRule, rows = 3) {
  const cells: GsCellData[][] = [[str('عنوان')], ...Array.from({ length: rows }, () => [{ dataValidation: rule }])]
  const { workbook, report } = convertSpreadsheet(oneSheet(cells))
  return { rules: resourceOf<Record<string, ISheetDataValidationRule[]>>(workbook, RESOURCE.DATA_VALIDATION)?.['sheet-0'] ?? [], report }
}
const v = (...values: string[]) => values.map((userEnteredValue) => ({ userEnteredValue }))
const A2_A4 = [{ startRow: 1, endRow: 3, startColumn: 0, endColumn: 0 }]

describe('dataValidation → Univer rules', () => {
  it('turns a dropdown list into a list rule with the items as a JSON array', () => {
    const { rules, report } = convertColumn({
      condition: { type: 'ONE_OF_LIST', values: v('منجز', 'قيد التنفيذ', 'متأخر، جزئيًا, بانتظار') },
      strict: true,
      showCustomUi: true,
      inputMessage: 'اختر الحالة',
    })
    expect(rules).toEqual([
      {
        uid: 'dv-sheet-0-0',
        type: 'list',
        formula1: JSON.stringify(['منجز', 'قيد التنفيذ', 'متأخر، جزئيًا, بانتظار']),
        renderMode: 1,
        allowBlank: true,
        errorStyle: 1,
        prompt: 'اختر الحالة',
        showInputMessage: true,
        ranges: A2_A4,
      },
    ])
    expect(report.counts.dataValidationRules).toBe(1)
  })

  it('turns a range dropdown into a list formula', () => {
    expect(convertColumn({ condition: { type: 'ONE_OF_RANGE', values: v("='القوائم'!$A$2:$A$6") } }).rules[0]).toMatchObject({
      type: 'list',
      formula1: "='القوائم'!$A$2:$A$6",
      renderMode: 0,
      errorStyle: 2,
    })
    expect(convertColumn({ condition: { type: 'ONE_OF_RANGE', values: v('Lists!A2:A6') } }).rules[0]?.formula1).toBe('=Lists!A2:A6')
  })

  it('maps number and date comparisons', () => {
    expect(convertColumn({ condition: { type: 'NUMBER_BETWEEN', values: v('1', '10') } }).rules[0]).toMatchObject({ type: 'decimal', operator: 'between', formula1: '1', formula2: '10' })
    expect(convertColumn({ condition: { type: 'NUMBER_GREATER', values: v('=B1') } }).rules[0]).toMatchObject({ type: 'decimal', operator: 'greaterThan', formula1: '=B1' })
    expect(convertColumn({ condition: { type: 'DATE_ON_OR_AFTER', values: v('2026-01-01') } }).rules[0]).toMatchObject({ type: 'date', operator: 'greaterThanOrEqual', formula1: '2026-01-01' })
    expect(convertColumn({ condition: { type: 'DATE_BEFORE', values: v('46023') } }).rules[0]).toMatchObject({ type: 'date', operator: 'lessThan', formula1: '46023' })
    expect(convertColumn({ condition: { type: 'DATE_NOT_BETWEEN', values: v('2026-01-01', '2026-12-31') } }).rules[0]).toMatchObject({ operator: 'notBetween', formula2: '2026-12-31' })
    expect(convertColumn({ condition: { type: 'DATE_IS_VALID' } }).rules[0]).toMatchObject({ type: 'date' })
    expect(convertColumn({ condition: { type: 'DATE_IS_VALID' } }).rules[0]?.operator).toBeUndefined()
  })

  it('maps custom formulas and checkboxes', () => {
    expect(convertColumn({ condition: { type: 'CUSTOM_FORMULA', values: v('=LEN(A2)<50') } }).rules[0]).toMatchObject({ type: 'custom', formula1: '=LEN(A2)<50' })
    expect(convertColumn({ condition: { type: 'BOOLEAN' } }).rules[0]).toMatchObject({ type: 'checkbox' })
    expect(convertColumn({ condition: { type: 'BOOLEAN', values: v('نعم', 'لا') } }).rules[0]).toMatchObject({ type: 'checkbox', formula1: 'نعم', formula2: 'لا' })
  })

  it('groups identical rules over non-contiguous cells into one rule with several ranges', () => {
    const rule: GsDataValidationRule = { condition: { type: 'BOOLEAN' } }
    const { workbook } = convertSpreadsheet(oneSheet([[{ dataValidation: rule }, {}, { dataValidation: rule }], [{ dataValidation: rule }]]))
    const rules = resourceOf<Record<string, ISheetDataValidationRule[]>>(workbook, RESOURCE.DATA_VALIDATION)?.['sheet-0']
    expect(rules).toHaveLength(1)
    expect(rules?.[0]?.ranges).toEqual([
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: 0, startColumn: 2, endColumn: 2 },
    ])
  })

  it('reports conditions without a Univer equivalent, per range', () => {
    const cases: GsDataValidationRule[] = [
      { condition: { type: 'TEXT_CONTAINS', values: v('@') } },
      { condition: { type: 'TEXT_IS_EMAIL' } },
      { condition: { type: 'DATE_AFTER', values: v('1/2/2026') } },
      { condition: { type: 'BOOLEAN', values: v('نعم') } },
      { condition: { type: 'CUSTOM_FORMULA', values: v('=GOOGLEFINANCE("X")>1') } },
    ]
    for (const rule of cases) {
      const { rules, report } = convertColumn(rule)
      expect(rules).toEqual([])
      expect(report.items).toEqual([
        expect.objectContaining({ kind: 'data_validation', outcome: 'not_transferred', detail: rule.condition?.type, location: expect.objectContaining({ ref: "'ورقة1'!A2:A4" }) }),
      ])
    }
  })
})
