import { describe, expect, it } from 'vitest'
import { convertSpreadsheet, RESOURCE } from '../src'
import { cellOf, formula, num, oneSheet, produced, resourceOf, str } from './helpers/build'
import type { UniverSheetNote } from '../src/univer-constants'

type Notes = Record<string, Record<number, Record<number, UniverSheetNote>>>

describe('userEnteredValue → v / t', () => {
  const { workbook, report } = convertSpreadsheet(
    oneSheet([
      [
        str('نص'),
        num(46266),
        { userEnteredValue: { boolValue: true }, effectiveValue: { boolValue: true } },
        { userEnteredValue: { boolValue: false }, effectiveValue: { boolValue: false } },
        str('0123'), // typed as '0123: the API drops the apostrophe
        str(''),
      ],
    ]),
  )
  const at = (c: number) => cellOf(workbook, 'sheet-0', 0, c)

  it('stores strings, numbers and booleans the way Univer does', () => {
    expect(at(0)).toEqual({ v: 'نص', t: 1 })
    expect(at(1)).toEqual({ v: 46266, t: 2 })
    expect(at(2)).toEqual({ v: 1, t: 3 })
    expect(at(3)).toEqual({ v: 0, t: 3 })
  })

  it('keeps numeric-looking strings as forced text', () => {
    expect(at(4)).toEqual({ v: '0123', t: 4 })
  })

  it('writes nothing for an empty string and counts only cells with content', () => {
    expect(at(5)).toBeUndefined()
    expect(report.counts.cells).toBe(5)
  })
})

describe('formulas', () => {
  it('keeps a supported formula exactly as written, with its last value cached', () => {
    const f = "=SUM('المهام'!H2:H6)"
    const { workbook, report } = convertSpreadsheet(oneSheet([[formula(f, { numberValue: 50000 }, '50,000')]]))
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ f, v: 50000, t: 2 })
    expect(report.counts.formulas).toBe(1)
    expect(report.counts.valueOnlyFormulas).toBe(0)
  })

  it('does not cache an error result, so Univer computes it', () => {
    const { workbook } = convertSpreadsheet(oneSheet([[formula('=1/0', { errorValue: { type: 'DIVIDE_BY_ZERO' } }, '#DIV/0!')]]))
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ f: '=1/0' })
  })

  it('keeps an unsupported formula as its last value, adds a note with the formula, and reports it', () => {
    const f = '=GOOGLEFINANCE("TADAWUL:2222","price")'
    const { workbook, report } = convertSpreadsheet(oneSheet([[formula(f, { numberValue: 27.45 }, '27.45', { note: 'سعر اليوم' })]]))
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ v: 27.45, t: 2 })
    const notes = resourceOf<Notes>(workbook, RESOURCE.NOTE)
    expect(notes?.['sheet-0']?.[0]?.[0]?.note).toBe(`سعر اليوم\n\nالمعادلة الأصلية من Google Sheets (غير مدعومة في المنصة، ونُقلت قيمتها فقط): ${f}`)
    expect(report.counts).toMatchObject({ formulas: 0, valueOnlyFormulas: 1, notes: 1 })
    expect(report.items).toEqual([
      expect.objectContaining({
        kind: 'unsupported_formula',
        outcome: 'value_only',
        detail: f,
        location: { sheetId: 'sheet-0', sheetName: 'ورقة1', range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }, ref: "'ورقة1'!A1" },
      }),
    ])
    expect(report.items[0]?.message).toContain('GOOGLEFINANCE')
  })

  it('keeps an error value of an unsupported formula as text', () => {
    const { workbook } = convertSpreadsheet(oneSheet([[formula('=IMPORTRANGE("u","A1")', { errorValue: { type: 'REF', message: 'x' } }, '#REF!')]]))
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ v: '#REF!', t: 1 })
  })

  it('reports IMAGE() as an image, value-only', () => {
    const { workbook, report } = convertSpreadsheet(oneSheet([[formula('=IMAGE("https://naflaw.sa/logo.png")')]]))
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toBeUndefined()
    expect(report.items[0]).toMatchObject({ kind: 'image', outcome: 'value_only' })
  })

  it('honours a custom supported-function set', () => {
    const { workbook } = convertSpreadsheet(oneSheet([[formula('=MYFN(1)', { numberValue: 1 })]]), { supportedFunctions: new Set(['MYFN']) })
    expect(cellOf(workbook, 'sheet-0', 0, 0)?.f).toBe('=MYFN(1)')
  })
})

describe('spilled results (OPEN_QUESTIONS.md §4)', () => {
  it('leaves the spill of a kept formula empty and writes the anchor without a cached value', () => {
    const { workbook, report } = convertSpreadsheet(
      oneSheet([
        [formula('=UNIQUE(B1:B9)', { stringValue: 'أ' }, 'أ')],
        [produced({ stringValue: 'ب' }, 'ب')],
        [produced({ stringValue: 'ج' }, 'ج')],
      ]),
    )
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ f: '=UNIQUE(B1:B9)' })
    expect(cellOf(workbook, 'sheet-0', 1, 0)).toBeUndefined()
    expect(cellOf(workbook, 'sheet-0', 2, 0)).toBeUndefined()
    expect(report.items).toEqual([])
  })

  it('keeps the spill of an unsupported formula as static values, reported as one range', () => {
    const { workbook, report } = convertSpreadsheet(
      oneSheet([
        [formula('=QUERY(A1:B9,"select A")', { stringValue: 'أ' }, 'أ'), produced({ numberValue: 1 }, '1')],
        [produced({ stringValue: 'ب' }, 'ب'), produced({ numberValue: 2 }, '2')],
      ]),
    )
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ v: 'أ', t: 1 })
    expect(cellOf(workbook, 'sheet-0', 1, 1)).toEqual({ v: 2, t: 2 })
    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ kind: 'unsupported_formula', location: { ref: "'ورقة1'!A1:B2" } })
  })

  it('keeps pivot-table output as static values and reports the pivot with its range', () => {
    const { workbook, report } = convertSpreadsheet(
      oneSheet([
        [{ pivotTable: { source: {} }, effectiveValue: { stringValue: 'المسؤول' }, formattedValue: 'المسؤول' }, produced({ stringValue: 'المجموع' }, 'المجموع')],
        [produced({ stringValue: 'سارة' }, 'سارة'), produced({ numberValue: 14000 }, '14000')],
      ]),
    )
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ v: 'المسؤول', t: 1 })
    expect(cellOf(workbook, 'sheet-0', 1, 1)).toEqual({ v: 14000, t: 2 })
    expect(report.items).toEqual([expect.objectContaining({ kind: 'pivot_table', outcome: 'not_transferred', location: expect.objectContaining({ ref: "'ورقة1'!A1:B2" }) })])
  })

  it('reports produced cells that no anchor claims as static values', () => {
    const { workbook, report } = convertSpreadsheet(oneSheet([[str('x')], [], [produced({ numberValue: 3 }, '3')]]))
    expect(cellOf(workbook, 'sheet-0', 2, 0)).toEqual({ v: 3, t: 2 })
    expect(report.items).toEqual([expect.objectContaining({ kind: 'derived_value', outcome: 'value_only', location: expect.objectContaining({ ref: "'ورقة1'!A3" }) })])
  })
})
