// Dropdowns and validation in the converter (apps/api OPEN_QUESTIONS.md
// "Google import" G32): the Sheets API path (google_api) and the extras an
// .xlsx reader adds (`GsDataValidationRule.naf`). Hand-made `spreadsheets.get`
// responses (synthesised); the real files are tested in @naf-sheets/xlsx-import.

import type { ISheetDataValidationRule } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { convertSpreadsheet, looksLikeMultipleSelection, RESOURCE, type ImportOrigin } from '../src'
import { parseListReference } from '../src/a1'
import type { GsCellData, GsDataValidationRule, GsSpreadsheet } from '../src/google-types'
import { gridSheet, resourceOf, spreadsheet, str } from './helpers/build'

const v = (...values: string[]) => values.map((userEnteredValue) => ({ userEnteredValue }))
const EXCEL: ImportOrigin = { kind: 'excel', via: 'upload', application: 'Microsoft Excel', alignment: 'as_given' }
const GOOGLE_EXPORT: ImportOrigin = { kind: 'google_export', via: 'google_link', application: null, alignment: 'as_given' }

/** A column A of `values` under a header, every value cell carrying `rule`; a list sheet «القوائم» beside it. */
function column(rule: GsDataValidationRule, values: string[], origin?: ImportOrigin, lists: string[] = []): { rules: ISheetDataValidationRule[]; items: ReturnType<typeof convertSpreadsheet>['report']['items'] } {
  const cells: GsCellData[][] = [[str('الحالة')], ...values.map((x) => [x === '' ? { dataValidation: rule } : str(x, { dataValidation: rule })])]
  const sheets = [gridSheet(cells)]
  if (lists.length > 0) sheets.push(gridSheet(lists.map((x) => [str(x)]), {}, { sheetId: 7, title: 'القوائم', index: 1 }))
  const doc: GsSpreadsheet = spreadsheet(sheets, { namedRanges: [{ namedRangeId: 'n1', name: 'Statuses', range: { sheetId: 7, startRowIndex: 0, endRowIndex: lists.length, startColumnIndex: 0, endColumnIndex: 1 } }] })
  const { workbook, report } = convertSpreadsheet(doc, origin ? { origin } : {})
  return { rules: resourceOf<Record<string, ISheetDataValidationRule[]>>(workbook, RESOURCE.DATA_VALIDATION)?.['sheet-0'] ?? [], items: report.items }
}
const dvItems = (items: ReturnType<typeof column>['items']) => items.filter((i) => i.kind === 'data_validation')

describe('multiple selection (Google "Allow multiple selections")', () => {
  const rule: GsDataValidationRule = { condition: { type: 'ONE_OF_LIST', values: v('منجز', 'متأخر', 'قيد التنفيذ') }, showCustomUi: true }

  it('becomes listMultiple when a cell joins two items with a comma (Sheets API values)', () => {
    const { rules, items } = column(rule, ['منجز', 'منجز, متأخر', ''])
    expect(rules[0]).toMatchObject({ type: 'listMultiple', renderMode: 2, formula1: JSON.stringify(['منجز', 'متأخر', 'قيد التنفيذ']) })
    expect(dvItems(items).map((i) => [i.outcome, i.location?.ref ?? null])).toEqual([
      ['converted', "'ورقة1'!A2:A4"],
      ['not_transferred', null], // the API has no colours or display style
    ])
    expect(dvItems(items)[0]?.message).toContain('["خيار 1","خيار 2"]')
  })

  it('detects it in a range list too, reading the items from the source sheet', () => {
    const range: GsDataValidationRule = { condition: { type: 'ONE_OF_RANGE', values: v("='القوائم'!$A$1:$A$3") }, showCustomUi: true }
    expect(column(range, ['أ, ب'], GOOGLE_EXPORT, ['أ', 'ب', 'ج']).rules[0]?.type).toBe('listMultiple')
    const named: GsDataValidationRule = { condition: { type: 'ONE_OF_RANGE', values: v('=Statuses') }, showCustomUi: true }
    expect(column(named, ['أ, ج'], GOOGLE_EXPORT, ['أ', 'ب', 'ج']).rules[0]?.type).toBe('listMultiple')
  })

  it('stays a single list when no cell holds a combination, when a part is not an item, and for Excel', () => {
    expect(column(rule, ['منجز', 'متأخر']).rules[0]?.type).toBe('list')
    expect(column(rule, ['منجز, غيره']).rules[0]?.type).toBe('list')
    expect(column(rule, ['منجز, متأخر'], EXCEL).rules[0]?.type).toBe('list')
  })

  it('an item that itself contains a comma is not a combination', () => {
    expect(looksLikeMultipleSelection(['Smith, John'], ['Smith, John', 'Doe'])).toBe(false)
    expect(looksLikeMultipleSelection(['Doe, Smith, John'], ['Smith, John', 'Doe'])).toBe(false)
    expect(looksLikeMultipleSelection(['Doe ,  Roe'], ['Roe', 'Doe'])).toBe(true)
  })
})

describe('chip colours and display style (naf extras from an .xlsx reader)', () => {
  const coloured = (extra: GsDataValidationRule['naf'], type: 'ONE_OF_LIST' | 'ONE_OF_RANGE' = 'ONE_OF_LIST', values = v('أ', 'ب', 'ج')): GsDataValidationRule => ({
    condition: { type, values },
    showCustomUi: true,
    ...(extra ? { naf: extra } : {}),
  })

  it('writes the colours into formula2 in the order of the items, the default grey as none', () => {
    const { rules, items } = column(coloured({ displayStyle: 'CHIP', itemColors: { ج: '#FFCFC9', أ: '#d4edbc', ب: '#e8eaed' } }), ['أ'], GOOGLE_EXPORT)
    expect(rules[0]).toMatchObject({ type: 'list', renderMode: 2, formula2: '#d4edbc,,#ffcfc9' })
    expect(dvItems(items)).toEqual([expect.objectContaining({ outcome: 'converted', message: expect.stringContaining('لون نص الشريحة') })])
  })

  it('aligns the colours of a range list with the items Univer will list (unique, in reading order)', () => {
    const rule = coloured({ displayStyle: 'CHIP', itemColors: { ب: '#bfe1f6', أ: '#e8eaed', ج: '#e8eaed' } }, 'ONE_OF_RANGE', v("='القوائم'!$A$1:$A$5"))
    const { rules, items } = column(rule, ['ب'], GOOGLE_EXPORT, ['أ', 'ب', 'أ', '', 'ج'])
    expect(rules[0]?.formula2).toBe(',#bfe1f6,')
    expect(dvItems(items)[0]?.message).toContain('بترتيب الخيارات')
  })

  it('says which items no cell showed, and that a computed list cannot be coloured', () => {
    const partial = column(coloured({ displayStyle: 'CHIP', itemColors: { أ: '#d4edbc' } }), ['أ'], GOOGLE_EXPORT)
    expect(dvItems(partial.items).map((i) => i.outcome)).toEqual(['converted', 'not_transferred'])
    expect(dvItems(partial.items)[1]?.message).toContain('ب، ج')
    const computed = column(coloured({ displayStyle: 'CHIP', itemColors: { أ: '#d4edbc' } }, 'ONE_OF_RANGE', v('=INDIRECT("Statuses")')), ['أ'], GOOGLE_EXPORT, ['أ'])
    expect(computed.rules[0]?.formula2).toBeUndefined()
    expect(dvItems(computed.items)).toEqual([expect.objectContaining({ outcome: 'not_transferred', message: expect.stringContaining('تُحسب بمعادلة') })])
  })

  it('maps chip, arrow and plain text; without a style the arrow follows showCustomUi', () => {
    expect(column(coloured({ displayStyle: 'CHIP' }), ['أ']).rules[0]?.renderMode).toBe(2)
    expect(column(coloured({ displayStyle: 'ARROW' }), ['أ']).rules[0]?.renderMode).toBe(1)
    expect(column(coloured({ displayStyle: 'PLAIN_TEXT' }), ['أ']).rules[0]?.renderMode).toBe(0)
    expect(column(coloured(undefined), ['أ']).rules[0]?.renderMode).toBe(1)
    expect(column({ ...coloured(undefined), showCustomUi: false }, ['أ']).rules[0]?.renderMode).toBe(0)
  })
})

describe('error styles, messages, prompts, blanks (naf extras)', () => {
  const list = (naf: GsDataValidationRule['naf'], strict = true, inputMessage?: string): GsDataValidationRule => ({
    condition: { type: 'ONE_OF_LIST', values: v('أ', 'ب') },
    strict,
    showCustomUi: true,
    ...(inputMessage ? { inputMessage } : {}),
    ...(naf ? { naf } : {}),
  })

  it('keeps Excel stop / warning / information, and reports the two that Univer accepts silently', () => {
    expect(column(list({ errorStyle: 'STOP' }), ['أ'], EXCEL).rules[0]?.errorStyle).toBe(1)
    const warning = column(list({ errorStyle: 'WARNING' }, false), ['أ'], EXCEL)
    expect(warning.rules[0]?.errorStyle).toBe(2)
    expect(dvItems(warning.items)[0]?.message).toContain('«تحذير»')
    const info = column(list({ errorStyle: 'INFORMATION' }, false), ['أ'], EXCEL)
    expect(info.rules[0]?.errorStyle).toBe(0)
    expect(dvItems(info.items)[0]?.message).toContain('«معلومة»')
  })

  it('shows the error title and message as one text (Univer shows only `error`)', () => {
    expect(column(list({ errorStyle: 'STOP', errorTitle: 'خطأ', errorMessage: 'اختر من القائمة' }), ['أ'], EXCEL).rules[0]).toMatchObject({
      showErrorMessage: true,
      error: 'خطأ: اختر من القائمة',
      errorTitle: 'خطأ',
    })
    expect(column(list({ errorMessage: 'اختر من القائمة' }), ['أ'], EXCEL).rules[0]).toMatchObject({ error: 'اختر من القائمة' })
  })

  it('keeps the input message and its title', () => {
    expect(column(list({ inputTitle: 'الحالة' }, true, 'اختر الحالة'), ['أ']).rules[0]).toMatchObject({ prompt: 'اختر الحالة', promptTitle: 'الحالة', showInputMessage: true })
  })

  it('reports an Excel rule without any alert, and one that did not ignore blanks', () => {
    expect(dvItems(column(list({ showErrorMessage: false }, false), ['أ'], EXCEL).items)[0]?.message).toContain('دون أي تنبيه')
    const blank = column(list({ errorStyle: 'STOP', rejectBlank: true }), ['أ'], EXCEL)
    expect(blank.rules[0]?.allowBlank).toBe(true)
    expect(dvItems(blank.items)[0]?.message).toContain('الخلايا الفارغة')
  })
})

describe('number kinds and broken sources', () => {
  it('maps whole numbers and text length to their own validators', () => {
    expect(column({ condition: { type: 'NUMBER_BETWEEN', values: v('1', '10') }, naf: { numberKind: 'WHOLE' } }, ['3'], EXCEL).rules[0]).toMatchObject({ type: 'whole', operator: 'between' })
    expect(column({ condition: { type: 'NUMBER_LESS_THAN_EQ', values: v('5') }, naf: { numberKind: 'TEXT_LENGTH' } }, ['أب'], EXCEL).rules[0]).toMatchObject({ type: 'textLength', operator: 'lessThanOrEqual', formula1: '5' })
  })

  it('refuses a #REF! list source, saying where it comes from', () => {
    const { rules, items } = column({ condition: { type: 'ONE_OF_RANGE', values: v('=#REF!') }, showCustomUi: true }, ['أ'], GOOGLE_EXPORT)
    expect(rules).toEqual([])
    expect(dvItems(items)).toEqual([expect.objectContaining({ outcome: 'not_transferred', message: expect.stringContaining('عمود جدول') })])
  })
})

describe('parseListReference', () => {
  it('reads plain references, other sheets, open-ended and whole ranges, and names', () => {
    expect(parseListReference('=A2:A9')).toEqual({ kind: 'range', sheet: null, range: { startRow: 1, startColumn: 0, endRow: 8, endColumn: 0 } })
    expect(parseListReference("='القوائم'!$B$2:$B$6")).toEqual({ kind: 'range', sheet: 'القوائم', range: { startRow: 1, startColumn: 1, endRow: 5, endColumn: 1 } })
    expect(parseListReference("='It''s'!$A:$A")).toEqual({ kind: 'range', sheet: "It's", range: { startRow: 0, startColumn: 0, endRow: null, endColumn: 0 } })
    expect(parseListReference('=Sheet1!$I$6:$I')).toEqual({ kind: 'range', sheet: 'Sheet1', range: { startRow: 5, startColumn: 8, endRow: null, endColumn: 8 } })
    expect(parseListReference('=Statuses')).toEqual({ kind: 'name', name: 'Statuses' })
    expect(parseListReference('=الحالات')).toEqual({ kind: 'name', name: 'الحالات' })
  })

  it('leaves formulas and constants to Univer', () => {
    expect(parseListReference('=INDIRECT($A2)')).toBeNull()
    expect(parseListReference('=OFFSET(A1,0,0,3,1)')).toBeNull()
    expect(parseListReference('=TRUE')).toBeNull()
    expect(parseListReference('=#REF!')).toBeNull()
  })
})
