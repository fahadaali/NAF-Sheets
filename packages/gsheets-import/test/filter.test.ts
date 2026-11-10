import { describe, expect, it } from 'vitest'
import { convertSpreadsheet, RESOURCE } from '../src'
import type { GsBasicFilter, GsCellData } from '../src/google-types'
import type { UniverAutoFilter } from '../src/univer-constants'
import { num, oneSheet, resourceOf, str } from './helpers/build'

const RANGE = { sheetId: 0, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 2 }
const rows: GsCellData[][] = [
  [str('الحالة'), str('التكلفة')],
  [str('منجز'), num(500)],
  [str('متأخر'), num(4000)],
  [{}, num(1500)],
  [str('قيد التنفيذ'), num(30000)],
]

function convert(basicFilter: GsBasicFilter, data = rows) {
  const { workbook, report } = convertSpreadsheet(oneSheet(data, { basicFilter }))
  return { filter: resourceOf<Record<string, UniverAutoFilter>>(workbook, RESOURCE.FILTER)?.['sheet-0'], report }
}

describe('basicFilter → filter resource', () => {
  it('keeps the range (header row included) without criteria', () => {
    const { filter, report } = convert({ range: RANGE })
    expect(filter).toEqual({ ref: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 } })
    expect(report.counts.filters).toBe(1)
  })

  it('turns hidden values into the visible values Univer filters by', () => {
    const { filter } = convert({ range: RANGE, filterSpecs: [{ columnIndex: 0, filterCriteria: { hiddenValues: ['منجز'] } }] })
    expect(filter?.filterColumns).toEqual([{ colId: 0, filters: { filters: ['قيد التنفيذ', 'متأخر'], blank: true } }])
  })

  it('hides blanks when "" is among the hidden values', () => {
    const { filter } = convert({ range: RANGE, filterSpecs: [{ columnIndex: 0, filterCriteria: { hiddenValues: ['', 'منجز'] } }] })
    expect(filter?.filterColumns?.[0]?.filters).toEqual({ filters: ['قيد التنفيذ', 'متأخر'] })
  })

  it('compares with the stored value of a number, not its formatted text', () => {
    const formatted: GsCellData[][] = [[str('h')], [num(0.5, { formattedValue: '50%' })], [num(0.25, { formattedValue: '25%' })]]
    const { filter } = convert({ range: { ...RANGE, endRowIndex: 3, endColumnIndex: 1 }, filterSpecs: [{ columnIndex: 0, filterCriteria: { hiddenValues: ['25%'] } }] }, formatted)
    expect(filter?.filterColumns?.[0]?.filters?.filters).toEqual(['0.5'])
  })

  it('maps number and text conditions to custom filters', () => {
    const condition = (type: string, ...values: string[]) => ({
      range: RANGE,
      filterSpecs: [{ columnIndex: 1, filterCriteria: { condition: { type: type as never, values: values.map((userEnteredValue) => ({ userEnteredValue })) } } }],
    })
    const custom = (f: GsBasicFilter) => convert(f).filter?.filterColumns?.[0]?.customFilters
    expect(custom(condition('NUMBER_GREATER', '1000'))).toEqual({ customFilters: [{ operator: 'greaterThan', val: 1000 }] })
    expect(custom(condition('NUMBER_LESS_THAN_EQ', '10'))).toEqual({ customFilters: [{ operator: 'lessThanOrEqual', val: 10 }] })
    expect(custom(condition('NUMBER_BETWEEN', '1', '5'))).toEqual({ and: 1, customFilters: [{ operator: 'greaterThanOrEqual', val: 1 }, { operator: 'lessThanOrEqual', val: 5 }] })
    expect(custom(condition('NUMBER_NOT_BETWEEN', '1', '5'))).toEqual({ customFilters: [{ operator: 'lessThan', val: 1 }, { operator: 'greaterThan', val: 5 }] })
    expect(custom(condition('TEXT_CONTAINS', 'تقرير'))).toEqual({ customFilters: [{ val: '*تقرير*' }] })
    expect(custom(condition('TEXT_NOT_CONTAINS', 'x'))).toEqual({ customFilters: [{ operator: 'notEqual', val: '*x*' }] })
    expect(custom(condition('TEXT_STARTS_WITH', 'x'))).toEqual({ customFilters: [{ val: 'x*' }] })
    expect(custom(condition('TEXT_ENDS_WITH', 'x'))).toEqual({ customFilters: [{ val: '*x' }] })
    expect(custom(condition('TEXT_EQ', 'منجز'))).toEqual({ customFilters: [{ val: 'منجز' }] })
    expect(custom(condition('BLANK'))).toEqual({ customFilters: [{ val: '' }] })
    expect(custom(condition('NOT_BLANK'))).toEqual({ customFilters: [{ operator: 'notEqual', val: ' ' }] })
  })

  it('maps colour filters to the rgb() form Univer compares', () => {
    const { filter } = convert({
      range: RANGE,
      filterSpecs: [
        { columnIndex: 0, filterCriteria: { visibleBackgroundColorStyle: { rgbColor: { red: 1 } } } },
        { columnIndex: 1, filterCriteria: { visibleForegroundColor: { blue: 1 } } },
      ],
    })
    expect(filter?.filterColumns).toEqual([
      { colId: 0, colorFilters: { cellFillColors: ['rgb(255,0,0)'] } },
      { colId: 1, colorFilters: { cellTextColors: ['rgb(0,0,255)'] } },
    ])
  })

  it('falls back to the deprecated criteria map', () => {
    const { filter } = convert({ range: RANGE, criteria: { '1': { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '1000' }] } } } })
    expect(filter?.filterColumns).toEqual([{ colId: 1, customFilters: { customFilters: [{ operator: 'greaterThan', val: 1000 }] } }])
  })

  it('reports criteria it cannot express and keeps the range', () => {
    const { filter, report } = convert({
      range: RANGE,
      filterSpecs: [
        { columnIndex: 0, filterCriteria: { hiddenValues: ['منجز'], condition: { type: 'NOT_BLANK' } } },
        { columnIndex: 1, filterCriteria: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=B2>A2' }] } } },
      ],
    })
    expect(filter).toEqual({ ref: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 } })
    expect(report.items.map((i) => [i.kind, i.location?.ref])).toEqual([
      ['filter_criteria', "'ورقة1'!A1:A5"],
      ['filter_criteria', "'ورقة1'!B1:B5"],
    ])
  })

  it('reports a filter with no range', () => {
    const { filter, report } = convert({ tableId: 't1' })
    expect(filter).toBeUndefined()
    expect(report.items[0]).toMatchObject({ kind: 'filter', outcome: 'not_transferred' })
  })
})
