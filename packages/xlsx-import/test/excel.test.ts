// SYNTHESISED Excel file (test/fixtures/excel-fixture.ts): every structure
// Excel writes that a Google export does not, normalised and converted; then
// the result loaded into a headless Univer 1.4.0.

import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import type { ICellData } from '@univerjs/core'
import { importXlsx, type ImportXlsxResult } from '../src'
import { loadHeadless, waitFor, type HeadlessUniver } from '../../gsheets-import/test/helpers/headless-univer'
import { buildExcelFixture, serial } from './fixtures/excel-fixture'

const TASKS = 'sheet-1'
const LISTS = 'sheet-2'

let r: ImportXlsxResult
const res = (name: string) => JSON.parse(r.workbook.resources?.find((x) => x.name === name)?.data ?? 'null')
const cell = (sheet: string, row: number, col: number) => r.workbook.sheets[sheet]?.cellData?.[row]?.[col] as ICellData | undefined
const style = (c: ICellData | undefined) => (c?.s ? r.workbook.styles[c.s as string] : undefined)

beforeAll(async () => {
  r = await importXlsx(await buildExcelFixture(), { workbookId: 'wb', via: 'upload', fileName: 'خطة.xlsx' })
})

describe('Excel origin', () => {
  it('is detected from docProps/app.xml and recorded with the default font', () => {
    expect(r.read.origin).toMatchObject({ kind: 'excel', application: 'Microsoft Excel' })
    expect(r.report.source).toMatchObject({
      title: 'خطة الحملة',
      origin: { kind: 'excel', via: 'upload', application: 'Microsoft Excel', fileName: 'خطة.xlsx', defaultFont: { family: 'Aptos Narrow', size: 11 }, dateSystem: 'date1900', alignment: 'as_given' },
    })
  })

  it('keeps sheet order, hidden sheets, RTL, frozen panes, tab colour (theme + tint) and reports the chart sheet', () => {
    expect(r.workbook.sheetOrder).toEqual([TASKS, LISTS, 'sheet-3'])
    expect(r.workbook.sheets['sheet-3']?.hidden).toBe(1)
    const tasks = r.workbook.sheets[TASKS]
    expect(tasks?.rightToLeft).toBe(1)
    expect(tasks?.freeze).toMatchObject({ ySplit: 1, xSplit: 0, startRow: 1 })
    // accent2 E97132, darker 25%.
    expect(tasks?.tabColor).toBe('#c04f15')
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'object_sheet', detail: 'مخطط' }))
  })

  it('converts widths with the Excel formula and points to pixels, and hides the hidden column', () => {
    const tasks = r.workbook.sheets[TASKS]
    expect(tasks?.defaultColumnWidth).toBe(64)
    expect(tasks?.defaultRowHeight).toBe(20)
    expect(tasks?.columnData).toMatchObject({ 0: { w: 215 }, 1: { w: 110 }, 2: { w: 110 }, 6: { hd: 1 } })
    expect(tasks?.rowData?.[0]).toMatchObject({ h: 40 })
  })

  it('resolves theme colours with tint and indexed colours to RGB', () => {
    const header = style(cell(TASKS, 0, 0))
    expect(header).toMatchObject({ bl: 1, cl: { rgb: '#ffffff' }, bg: { rgb: '#156082' }, ht: 2, vt: 2, tb: 3 })
    expect(style(cell(TASKS, 1, 3))?.bg?.rgb).toBe('#fbe3d6')
    const indexed = style(cell(TASKS, 11, 4))
    expect(indexed).toMatchObject({ ff: 'Arial', fs: 14, it: 1, cl: { rgb: '#ff0000' }, bg: { rgb: '#ffff00' }, tr: { a: -45 } })
    const rotated = style(cell(TASKS, 6, 0))
    expect(rotated).toMatchObject({ cl: { rgb: '#104862' }, ht: 1, td: 2, tr: { a: 45 } })
    expect(rotated?.bd).toMatchObject({ l: { s: 1 }, r: { s: 8, cl: { rgb: '#156082' } }, t: { s: 4 }, b: { s: 7, cl: { rgb: '#ff0000' } } })
  })

  it('drops the default font (Aptos Narrow 11, theme text colour) from every cell', () => {
    for (const st of Object.values(r.workbook.styles)) {
      expect(st?.ff).not.toBe('Aptos Narrow')
      expect(st?.fs).not.toBe(11)
    }
  })

  it('writes built-in number formats that have no <numFmt>, and reports the locale-dependent one', () => {
    expect(style(cell(TASKS, 1, 2))?.n?.pattern).toBe('yyyy-mm-dd')
    expect(cell(TASKS, 1, 2)?.v).toBe(serial('2026-01-15'))
    expect(style(cell(TASKS, 7, 1))?.n?.pattern).toBe('yyyy-mm-dd h:mm')
    expect(style(cell(TASKS, 7, 4))?.n?.pattern).toBe('0.00%')
    expect(style(cell(TASKS, 1, 3))?.n?.pattern).toBe('#,##0.00\\ "ر.س"')
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'number_format', outcome: 'not_transferred', location: expect.objectContaining({ ref: "'المهام'!C8" }) }))
  })

  it('expands shared formulas, strips _xlfn., keeps array formulas spilling', () => {
    expect(cell(TASKS, 1, 7)).toMatchObject({ f: '=D2*1.15', v: 1380 })
    expect(cell(TASKS, 5, 7)?.f).toBe('=D6*1.15')
    expect(cell(TASKS, 7, 0)).toMatchObject({ f: '=XLOOKUP("أحمد",B2:B6,A2:A6)' })
    // The dynamic array anchor keeps no cached value (Univer spills it); its members stay empty.
    expect(cell(TASKS, 8, 0)?.f).toBe('=SORT(D2:D4)')
    expect(cell(TASKS, 8, 0)?.v).toBeUndefined()
    expect(cell(TASKS, 9, 0)).toBeUndefined()
    expect(cell(TASKS, 8, 1)).toMatchObject({ f: '=SUM(D2:D6*1)' })
  })

  it('keeps values for _xludf., structured and external references, with the original formula in a note', () => {
    const items = r.report.items.filter((i) => i.kind === 'unsupported_formula')
    expect(items.map((i) => [i.location?.ref, i.detail])).toEqual([
      ["'المهام'!C9", '=_xludf.MYFUNC(D2)'],
      ["'المهام'!D9", '=SUM(Table1[المبلغ])'],
      ["'المهام'!E9", '=[1]Sheet1!$A$1'],
    ])
    expect(items[1]?.message).toContain('Table1[…]')
    expect(items[0]?.message).toContain('Excel')
    expect(cell(TASKS, 8, 3)).toMatchObject({ v: 1500 })
    expect(res('SHEET_NOTE_PLUGIN')[TASKS][8][2].note).toContain('المعادلة الأصلية من Excel')
  })

  it('keeps literal and formula errors', () => {
    expect(cell(TASKS, 8, 5)).toMatchObject({ v: '#N/A', t: 1 })
    expect(cell(TASKS, 8, 6)).toMatchObject({ f: '=1/0' })
  })

  it('keeps rich text, quote-prefixed numbers, inline strings and links (external and to another sheet)', () => {
    const rich = cell(TASKS, 11, 0)
    expect(rich?.p?.body?.dataStream).toBe('مهم: مراجعة العقد\r\n')
    expect(cell(TASKS, 11, 1)).toMatchObject({ v: '00123', t: 4 })
    expect(cell(TASKS, 11, 2)).toMatchObject({ v: 'نص مضمّن' })
    const link = cell(TASKS, 11, 3)?.p?.body?.customRanges?.[0]
    expect(link?.properties?.url).toBe('https://naflaw.sa')
    const internal = cell(TASKS, 5, 1)?.p?.body?.customRanges?.[0]
    expect(internal?.properties?.url).toBe(`#gid=${LISTS}&range=A1`)
  })

  it('maps data validation, including the x14 rule in <extLst>, and reports what has no counterpart', () => {
    const dv = res('SHEET_DATA_VALIDATION_PLUGIN')[TASKS] as Array<Record<string, unknown>>
    expect(dv).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'list', formula1: JSON.stringify(['قيد التنفيذ', 'منجز', 'متأخر']), prompt: 'اختر الحالة', errorStyle: 1 }),
        expect.objectContaining({ type: 'list', formula1: "='القوائم'!$A$1:$A$3" }),
        expect.objectContaining({ type: 'decimal', operator: 'greaterThanOrEqual', formula1: '0' }),
        expect.objectContaining({ type: 'date', operator: 'between', formula1: String(serial('2026-01-01')), formula2: String(serial('2026-12-31')), errorStyle: 2 }),
      ]),
    )
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'data_validation', detail: 'textLength', location: expect.objectContaining({ ref: "'المهام'!A2:A6" }) }))
  })

  it('orders conditional formats by priority, turns formula operands into custom formulas, colour scales into gradients', () => {
    const cf = res('SHEET_CONDITIONAL_FORMATTING_PLUGIN')[TASKS] as Array<{ rule: Record<string, unknown> }>
    expect(cf.map((c) => [c.rule.type, c.rule.subType, c.rule.value ?? null])).toEqual([
      ['highlightCell', 'formula', '=$F2=TRUE'],
      ['highlightCell', 'number', 1000],
      ['highlightCell', 'formula', '=D2<$D$7/10'],
      ['colorScale', undefined, null],
      ['highlightCell', 'text', 'قيد'],
    ])
    expect(cf[1]?.rule.style).toMatchObject({ bl: 1, cl: { rgb: '#9c0006' }, bg: { rgb: '#ffc7ce' } })
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'conditional_format', detail: 'dataBar' }))
  })

  it('transfers the filter range, reports its criteria, and shows the rows it hid', () => {
    expect(res('SHEET_FILTER_PLUGIN')[TASKS].ref).toEqual({ startRow: 0, startColumn: 0, endRow: 5, endColumn: 5 })
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'filter_criteria', location: expect.objectContaining({ ref: "'المهام'!E1:E6" }) }))
    expect(r.workbook.sheets[TASKS]?.rowData?.[4]?.hd).toBeUndefined()
  })

  it('reads notes, skips the legacy copy of a threaded comment and reports the thread', () => {
    const notes = res('SHEET_NOTE_PLUGIN')[LISTS]
    expect(notes[1][0].note).toBe('سارة:\nملاحظة على البند')
    expect(notes[0]).toBeUndefined()
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'comment', location: expect.objectContaining({ ref: "'القوائم'!A1" }) }))
  })

  it('reports what the platform has no place for — never silently', () => {
    const got = r.report.items.map((i) => `${i.kind}:${i.outcome}:${i.location?.ref ?? '-'}`)
    expect(got).toEqual(
      expect.arrayContaining([
        "chart:not_transferred:'المهام'!J8",
        "drawing_image:not_transferred:'المهام'!J2",
        "drawing_shape:not_transferred:'المهام'!J23",
        "unsupported_feature:not_transferred:'المهام'",
        "table:converted:'القوائم'!C1:D4",
        "table:not_transferred:'القوائم'!C1:D4",
        "pivot_table:not_transferred:'القوائم'!F1:G4",
        "protected_range:not_transferred:'القوائم'",
        "row_group:not_transferred:'القوائم'!A6:Z7",
        'named_range:not_transferred:-',
        'unsupported_feature:not_transferred:-',
        'cell_format:converted:-',
      ]),
    )
    expect(r.report.items.filter((i) => i.kind === 'unsupported_feature' && !i.location).map((i) => i.message)).toHaveLength(2)
    for (const item of r.report.items) expect(item.message).toMatch(/[؀-ۿ]/)
  })

  it('keeps a plain named range and skips Excel’s own filter bookkeeping', () => {
    expect(res('SHEET_DEFINED_NAME_PLUGIN')).toEqual({ 'nr-xlsx-0': expect.objectContaining({ name: 'المبالغ', formulaOrRefString: "'المهام'!$D$2:$D$6" }) })
    expect(r.report.items.some((i) => i.detail === '_xlnm._FilterDatabase')).toBe(false)
  })

  it('leaves booleans as values in an Excel file (only Google exports lose their checkboxes)', () => {
    expect(cell(TASKS, 1, 5)).toMatchObject({ v: 1, t: 3 })
    expect(r.report.items.some((i) => i.kind === 'checkbox')).toBe(false)
  })
})

describe('the 1904 date system', () => {
  it('keeps the serials and sets the workbook’s date system, so dates read the same', async () => {
    const mac = await importXlsx(await buildExcelFixture({ date1904: true }), { workbookId: 'wb', via: 'upload' })
    expect(mac.workbook.dateSystem).toBe('date1904')
    expect(mac.report.source.origin?.dateSystem).toBe('date1904')
    expect(mac.workbook.sheets[TASKS]?.cellData?.[1]?.[2]?.v).toBe(serial('2026-01-15', true))
    expect(serial('2026-01-15', true)).toBe(serial('2026-01-15') - 1462)
  })
})

describe('the converted Excel workbook in headless Univer 1.4.0', () => {
  let u: HeadlessUniver
  let mac: HeadlessUniver
  beforeAll(async () => {
    u = loadHeadless(r.workbook, 'forced')
    mac = loadHeadless((await importXlsx(await buildExcelFixture({ date1904: true }), { workbookId: 'wb2', via: 'upload' })).workbook, 'forced')
  })
  afterAll(() => {
    u.dispose()
    mac.dispose()
  })

  it('computes the expanded shared formulas, XLOOKUP and the SORT spill', async () => {
    const tasks = u.workbook.getSheetBySheetId(TASKS)
    await waitFor(() => tasks?.getCell(9, 0)?.v !== undefined && tasks?.getCell(5, 7)?.v !== undefined, 4000)
    expect(tasks?.getCell(5, 7)?.v).toBeCloseTo(345)
    expect(tasks?.getCell(7, 0)?.v).toBe('إعداد الخطة')
    // The anchor shows through its number format (getCell runs the numfmt interceptor).
    expect(String(tasks?.getCell(8, 0)?.v)).toMatch(/^450/)
    expect([9, 10].map((row) => tasks?.getCell(row, 0)?.v)).toEqual([800, 1200])
  })

  it('accepts the resources and reads the 1904 system', () => {
    const loaded = u.resources()
    for (const name of ['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_FILTER_PLUGIN', 'SHEET_NOTE_PLUGIN', 'SHEET_DEFINED_NAME_PLUGIN']) {
      expect(loaded[name], name).toBeTruthy()
    }
    expect(u.workbook.getDateSystem()).toBe('date1900')
    expect(mac.workbook.getDateSystem()).toBe('date1904')
  })
})
