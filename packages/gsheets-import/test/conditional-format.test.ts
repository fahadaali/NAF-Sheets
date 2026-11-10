import { describe, expect, it } from 'vitest'
import { convertSpreadsheet, RESOURCE } from '../src'
import type { GsBooleanCondition, GsCellFormat, GsConditionalFormatRule, GsGridRange } from '../src/google-types'
import type { UniverCfRule } from '../src/univer-constants'
import { oneSheet, resourceOf, str } from './helpers/build'

const F2_F6: GsGridRange = { sheetId: 0, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 5, endColumnIndex: 6 }
const RED_FILL: GsCellFormat = { backgroundColorStyle: { rgbColor: { red: 1 } } }

function convert(rules: GsConditionalFormatRule[]) {
  const { workbook, report } = convertSpreadsheet(oneSheet([[str('x')]], { conditionalFormats: rules }))
  return { rules: resourceOf<Record<string, UniverCfRule[]>>(workbook, RESOURCE.CONDITIONAL_FORMATTING)?.['sheet-0'] ?? [], report }
}
const bool = (condition: GsBooleanCondition, format: GsCellFormat = RED_FILL): GsConditionalFormatRule => ({ ranges: [F2_F6], booleanRule: { condition, format } })
const v = (...values: string[]) => values.map((userEnteredValue) => ({ userEnteredValue }))

describe('booleanRule → highlightCell', () => {
  it('keeps the order and stops at the first true rule, like Google', () => {
    const { rules } = convert([bool({ type: 'TEXT_EQ', values: v('متأخر') }), bool({ type: 'NOT_BLANK' })])
    expect(rules.map((r) => r.cfId)).toEqual(['cf-sheet-0-0', 'cf-sheet-0-1'])
    expect(rules.every((r) => r.stopIfTrue)).toBe(true)
    expect(rules[0]?.ranges).toEqual([{ startRow: 1, endRow: 5, startColumn: 5, endColumn: 5 }])
  })

  it('maps number conditions', () => {
    const cases: Array<[GsBooleanCondition, unknown]> = [
      [{ type: 'NUMBER_GREATER', values: v('10') }, { operator: 'greaterThan', value: 10 }],
      [{ type: 'NUMBER_GREATER_THAN_EQ', values: v('10') }, { operator: 'greaterThanOrEqual', value: 10 }],
      [{ type: 'NUMBER_LESS', values: v('-2.5') }, { operator: 'lessThan', value: -2.5 }],
      [{ type: 'NUMBER_LESS_THAN_EQ', values: v('0') }, { operator: 'lessThanOrEqual', value: 0 }],
      [{ type: 'NUMBER_EQ', values: v('7') }, { operator: 'equal', value: 7 }],
      [{ type: 'NUMBER_NOT_EQ', values: v('7') }, { operator: 'notEqual', value: 7 }],
      [{ type: 'NUMBER_BETWEEN', values: v('1', '5') }, { operator: 'between', value: [1, 5] }],
      [{ type: 'NUMBER_NOT_BETWEEN', values: v('1', '5') }, { operator: 'notBetween', value: [1, 5] }],
    ]
    for (const [condition, expected] of cases) {
      expect(convert([bool(condition)]).rules[0]?.rule).toEqual({ type: 'highlightCell', subType: 'number', style: { bg: { rgb: '#ff0000' } }, ...(expected as object) })
    }
  })

  it('maps text, blank and relative-date conditions', () => {
    const map = (condition: GsBooleanCondition) => convert([bool(condition)]).rules[0]?.rule
    expect(map({ type: 'TEXT_CONTAINS', values: v('تقرير') })).toMatchObject({ subType: 'text', operator: 'containsText', value: 'تقرير' })
    expect(map({ type: 'TEXT_NOT_CONTAINS', values: v('x') })).toMatchObject({ subType: 'text', operator: 'notContainsText' })
    expect(map({ type: 'TEXT_STARTS_WITH', values: v('x') })).toMatchObject({ subType: 'text', operator: 'beginsWith' })
    expect(map({ type: 'TEXT_ENDS_WITH', values: v('x') })).toMatchObject({ subType: 'text', operator: 'endsWith' })
    expect(map({ type: 'TEXT_EQ', values: v('منجز') })).toMatchObject({ subType: 'text', operator: 'equal', value: 'منجز' })
    expect(map({ type: 'BLANK' })).toMatchObject({ subType: 'text', operator: 'containsBlanks' })
    expect(map({ type: 'NOT_BLANK' })).toMatchObject({ subType: 'text', operator: 'notContainsBlanks' })
    expect(map({ type: 'DATE_EQ', values: [{ relativeDate: 'TODAY' }] })).toMatchObject({ subType: 'timePeriod', operator: 'today' })
    expect(map({ type: 'DATE_EQ', values: [{ relativeDate: 'TOMORROW' }] })).toMatchObject({ subType: 'timePeriod', operator: 'tomorrow' })
  })

  it('keeps custom formulas as written (a leading + becomes =)', () => {
    expect(convert([bool({ type: 'CUSTOM_FORMULA', values: v('=$F2="منجز"') })]).rules[0]?.rule).toMatchObject({ subType: 'formula', value: '=$F2="منجز"' })
    expect(convert([bool({ type: 'CUSTOM_FORMULA', values: v('+A2>5') })]).rules[0]?.rule).toMatchObject({ subType: 'formula', value: '=A2>5' })
  })

  it('takes only what Google conditional formats apply: bold, italic, strikethrough, underline, colours', () => {
    const format = {
      backgroundColor: { green: 1 },
      textFormat: { bold: true, italic: true, strikethrough: true, underline: true, fontSize: 20, fontFamily: 'Arial', foregroundColor: { blue: 1 } },
    }
    expect(convert([bool({ type: 'BLANK' }, format)]).rules[0]?.rule).toMatchObject({
      style: { bl: 1, it: 1, st: { s: 1 }, ul: { s: 1 }, cl: { rgb: '#0000ff' }, bg: { rgb: '#00ff00' } },
    })
  })

  it('reports conditions without an equivalent, with their range', () => {
    const { rules, report } = convert([
      bool({ type: 'DATE_BEFORE', values: [{ relativeDate: 'TODAY' }] }),
      bool({ type: 'NUMBER_GREATER', values: v('=MAX(A:A)') }),
      bool({ type: 'CUSTOM_FORMULA', values: v('=REGEXMATCH(A2,"x")+GOOGLEFINANCE("X")') }),
      bool({ type: 'TEXT_EQ', values: v('=A1') }),
    ])
    expect(rules).toEqual([])
    expect(report.items).toHaveLength(4)
    expect(report.items.every((i) => i.kind === 'conditional_format' && i.outcome === 'not_transferred' && i.location?.ref === "'ورقة1'!F2:F6")).toBe(true)
    expect(report.items[2]?.message).toContain('GOOGLEFINANCE')
  })
})

describe('gradientRule → colorScale', () => {
  it('maps min/mid/max points, value types and colours', () => {
    const { rules } = convert([
      {
        ranges: [F2_F6],
        gradientRule: {
          minpoint: { colorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } }, type: 'MIN' },
          midpoint: { color: { red: 1, green: 0.8392157, blue: 0.4 }, type: 'PERCENT', value: '50' },
          maxpoint: { colorStyle: { rgbColor: { green: 1 } }, type: 'NUMBER', value: '=MAX(H:H)' },
        },
      },
    ])
    expect(rules[0]).toEqual({
      cfId: 'cf-sheet-0-0',
      ranges: [{ startRow: 1, endRow: 5, startColumn: 5, endColumn: 5 }],
      stopIfTrue: true,
      rule: {
        type: 'colorScale',
        config: [
          { index: 0, color: '#ffffff', value: { type: 'min' } },
          { index: 1, color: '#ffd666', value: { type: 'percent', value: 50 } },
          { index: 2, color: '#00ff00', value: { type: 'formula', value: '=MAX(H:H)' } },
        ],
      },
    })
  })

  it('maps two-point scales with numbers and percentiles', () => {
    const { rules } = convert([
      { ranges: [F2_F6], gradientRule: { minpoint: { color: {}, type: 'NUMBER', value: '0' }, maxpoint: { color: { red: 1 }, type: 'PERCENTILE', value: '90' } } },
    ])
    expect(rules[0]?.rule).toEqual({
      type: 'colorScale',
      config: [
        { index: 0, color: '#000000', value: { type: 'num', value: 0 } },
        { index: 1, color: '#ff0000', value: { type: 'percentile', value: 90 } },
      ],
    })
  })

  it('reports a scale whose colour cannot be resolved', () => {
    const { rules, report } = convert([{ ranges: [F2_F6], gradientRule: { minpoint: { colorStyle: { themeColor: 'ACCENT4' }, type: 'MIN' }, maxpoint: { color: {}, type: 'MAX' } } }])
    expect(rules).toEqual([])
    expect(report.items.map((i) => i.kind)).toEqual(['conditional_format', 'theme_color'])
  })
})
