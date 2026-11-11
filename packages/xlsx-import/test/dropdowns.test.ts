// Dropdowns and validation per origin (apps/api OPEN_QUESTIONS.md "Google import" G32).
//
// REAL files (downloaded 2026-11-11 with `curl -L …/export?format=xlsx`, and
// Google's own rendering with `curl -L …/htmlview` and
// `…/htmlview/sheet?headers=true&gid=<gid>`, from public sheets):
//   google-dropdowns-advanced.xlsx  1dUjG8hNj9BAT42xRucaXUmuJzbl6pxefz-8QQFcDdgU
//       (benlcollins.com "Sheets Insiders" dropdowns template: a native
//       multiple-selection dropdown, dependent dropdowns, a range list fed by a
//       spilling formula)
//   google-colored-dropdowns.xlsx   1lL8K942Vj67ESDgeqOKvCED3yo6IOqerSoP9fbG8JJc
//       (ablebits.com sample: dropdown chips coloured green / amber / red)
//   google-table-dropdowns.xlsx     1L6tJGLG2S1qrRY1n11RYgfnFnA0LLAox8PmfrBEBaD0
//       (infoinspired.com assignment tracker: dropdowns fed by Google tables)
//   htmlview/*.html                 Google's rendering of those sheets
// SYNTHESISED: fixtures/excel-dropdowns.ts (every Excel option; no Excel here).

import { readFileSync } from 'node:fs'
import { DataValidationStatus } from '@univerjs/core'
import { DataValidationListCacheService, SheetDataValidationModel, SheetsDataValidationValidatorService } from '@univerjs/sheets-data-validation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadHeadless, type HeadlessUniver } from '../../gsheets-import/test/helpers/headless-univer'
import { DEPENDENT_LIST_CELL_LIMIT, importXlsx, parseGoogleSheetChips, parseGoogleSheetIndex, type GoogleRendering, type ImportXlsxResult } from '../src'
import { buildExcelDropdownFixture } from './fixtures/excel-dropdowns'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const page = (name: string) => readFileSync(new URL(`./fixtures/htmlview/${name}`, import.meta.url), 'utf8')
type Rule = { type: string; formula1?: string; formula2?: string; renderMode?: number; errorStyle?: number; error?: string; errorTitle?: string; prompt?: string; promptTitle?: string; showErrorMessage?: boolean; operator?: string; ranges: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }> }
const rules = (r: ImportXlsxResult, sheetName: string): Rule[] => {
  const id = Object.entries(r.workbook.sheets).find(([, s]) => s.name === sheetName)?.[0] as string
  return (JSON.parse(r.workbook.resources?.find((x) => x.name === 'SHEET_DATA_VALIDATION_PLUGIN')?.data ?? '{}')[id] ?? []) as Rule[]
}
const at = (list: Rule[], row: number, col: number) => list.filter((x) => x.ranges.some((g) => row >= g.startRow && row <= g.endRow && col >= g.startColumn && col <= g.endColumn))
/** The rendering apps/api reads, from the saved pages. */
function rendering(base: string): GoogleRendering {
  const map = new Map<string, ReturnType<typeof parseGoogleSheetChips>>()
  for (const s of parseGoogleSheetIndex(page(`${base}.index.html`))) {
    try {
      map.set(s.name, parseGoogleSheetChips(page(`${base}.gid-${s.gid}.html`)))
    } catch {
      // page not saved: that sheet holds no dropdown
    }
  }
  return map
}

describe("Google's rendering (htmlview), real pages", () => {
  it('lists the sheets with their gid, JavaScript escapes decoded', () => {
    expect(parseGoogleSheetIndex(page('google-colored-dropdowns.index.html'))).toEqual([
      { name: 'Colored dropdown- examples', gid: '1587532597' },
      { name: 'Colored dropdown', gid: '750877212' },
      { name: 'Color coded dropdown', gid: '1094567806' },
    ])
  })

  it('reads every chip with its cell and colours; an uncoloured chip is #e8eaed', () => {
    const chips = parseGoogleSheetChips(page('google-colored-dropdowns.gid-750877212.html'))
    expect(chips).toEqual([
      { row: 2, column: 1, text: 'Yes', background: '#d4edbc', color: '#11734b' },
      { row: 4, column: 1, text: 'Yes', background: '#d4edbc', color: '#11734b' },
      { row: 6, column: 1, text: 'Not sure', background: '#ffe5a0', color: '#473821' },
      { row: 8, column: 1, text: 'No', background: '#ffcfc9', color: '#b10202' },
    ])
    const multi = parseGoogleSheetChips(page('google-dropdowns-advanced.gid-796228108.html'))
    expect(multi[0]).toEqual({ row: 5, column: 3, text: 'Product B, Product D, Product C', background: '#e8eaed', color: '#000000' })
    // A merged title cell (colspan) before the chips does not shift their columns.
    const dependent = parseGoogleSheetChips(page('google-dropdowns-advanced.gid-1149121057.html'))
    expect(dependent.slice(0, 3)).toEqual([
      { row: 5, column: 9, text: 'Antarctic', background: '#bfe1f6', color: '#0a53a8' },
      { row: 5, column: 10, text: 'Scientific Exploration', background: '#e8eaed', color: '#000000' },
      { row: 5, column: 11, text: 'Success', background: '#e8eaed', color: '#000000' },
    ])
  })

  it('yields nothing, never an error, for a page that is not a sheet', () => {
    expect(parseGoogleSheetChips('<html><body>Sign in</body></html>')).toEqual([])
    expect(parseGoogleSheetIndex('<html></html>')).toEqual([])
  })
})

describe('coloured chips (real Google file + its rendering)', () => {
  it('turns the chips into Univer chips with the item colours, aligned with the items', async () => {
    const r = await importXlsx(fixture('google-colored-dropdowns.xlsx'), { workbookId: 'wb', via: 'google_link', googleRendering: async () => rendering('google-colored-dropdowns') })
    const [rule] = rules(r, 'Colored dropdown')
    expect(rule).toMatchObject({ type: 'list', formula1: JSON.stringify(['Yes', 'No', 'Not sure']), renderMode: 2, formula2: '#d4edbc,#ffcfc9,#ffe5a0', errorStyle: 1 })
    expect(rules(r, 'Color coded dropdown')[0]).toMatchObject({ renderMode: 2, formula2: '#d4edbc,#ffcfc9,#ffe5a0' })
    const notes = r.report.items.filter((i) => i.kind === 'data_validation')
    // Chip text colour has no per-item place in Univer: said, per rule. Nothing workbook-wide.
    expect(notes.map((i) => [i.outcome, i.location?.ref])).toEqual([
      ['converted', "'Colored dropdown'!B3"],
      ['converted', "'Colored dropdown'!B5"],
      ['converted', "'Colored dropdown'!B7"],
      ['converted', "'Colored dropdown'!B9"],
      ['converted', "'Colored dropdown'!B11"],
      ['converted', "'Colored dropdown'!B13"],
      ['converted', "'Colored dropdown'!B15"],
      ['converted', "'Colored dropdown'!B17"],
      ['converted', "'Color coded dropdown'!B3"],
      ['converted', "'Color coded dropdown'!B5"],
      ['converted', "'Color coded dropdown'!B7"],
      ['converted', "'Color coded dropdown'!B9"],
      ['converted', "'Color coded dropdown'!B11"],
      ['converted', "'Color coded dropdown'!B13"],
      ['converted', "'Color coded dropdown'!B15"],
      ['converted', "'Color coded dropdown'!B17"],
    ])
    expect(notes[0]?.message).toContain('لون نص الشريحة')
  })

  it('without the rendering (an uploaded export) keeps the list, shows an arrow and says colours are not in the file', async () => {
    const r = await importXlsx(fixture('google-colored-dropdowns.xlsx'), { workbookId: 'wb', via: 'upload' })
    expect(rules(r, 'Colored dropdown')[0]).toMatchObject({ type: 'list', renderMode: 1 })
    expect(rules(r, 'Colored dropdown')[0]?.formula2).toBeUndefined()
    const notes = r.report.items.filter((i) => i.kind === 'data_validation')
    expect(notes).toEqual([expect.objectContaining({ outcome: 'not_transferred', location: null, message: expect.stringContaining('لا يحفظ ألوان') })])
  })

  it('a rendering that failed is reported with the sheets it concerns', async () => {
    const r = await importXlsx(fixture('google-colored-dropdowns.xlsx'), { workbookId: 'wb', via: 'google_link', googleRendering: async () => null })
    const notes = r.report.items.filter((i) => i.kind === 'data_validation')
    expect(notes).toEqual([expect.objectContaining({ location: null, message: expect.stringContaining('تعذّرت قراءة'), detail: 'Colored dropdown، Color coded dropdown' })])
  })
})

describe('multiple selection, dependent and computed lists (real Google file)', () => {
  let r: ImportXlsxResult
  beforeAll(async () => {
    r = await importXlsx(fixture('google-dropdowns-advanced.xlsx'), { workbookId: 'wb', via: 'google_link', googleRendering: async () => rendering('google-dropdowns-advanced') })
  })

  it('recognises "Allow multiple selections" from the cells and keeps their text', () => {
    const [rule] = rules(r, 'DD-Multi-Select')
    expect(rule).toMatchObject({ type: 'listMultiple', formula1: JSON.stringify(['Product A', 'Product B', 'Product C', 'Product D']), renderMode: 2 })
    const sheet = Object.values(r.workbook.sheets).find((s) => s.name === 'DD-Multi-Select')
    expect(sheet?.cellData?.[5]?.[3]?.v).toBe('Product B, Product D, Product C')
    const note = r.report.items.find((i) => i.kind === 'data_validation' && i.location?.ref === "'DD-Multi-Select'!D6:D25")
    expect(note).toMatchObject({ outcome: 'converted', message: expect.stringContaining('متعددة الاختيار') })
  })

  it("keeps Google's range lists as one fixed range (Google does not move them per cell)", () => {
    expect(rules(r, 'DD-Auto')).toEqual([expect.objectContaining({ type: 'list', formula1: '=$I$6:$I20', renderMode: 2, ranges: [{ startRow: 5, startColumn: 3, endRow: 11, endColumn: 3 }] })])
    expect(rules(r, 'DD-Dependent').map((x) => x.formula1).sort()).toEqual(["='DD-Dependent'!$C$6:$C$15", "='DD-Dependent'!$P$6:$P19", "='DD-Dependent'!$Q$6:$Q19"])
  })

  it('colours an item of a range list by its position in the source, and says which items no cell showed', () => {
    const j6 = at(rules(r, 'DD-Dependent'), 5, 9)[0]
    // 'DD-Dependent'!C6:C15 holds Antarctic, then Arctic: only Antarctic is shown (coloured), Arctic never.
    expect(j6?.formula2?.split(',')[0]).toBe('#bfe1f6')
    const partial = r.report.items.find((i) => i.location?.ref === "'DD-Dependent'!J6" && i.outcome === 'not_transferred')
    expect(partial?.message).toContain('Arctic')
    const converted = r.report.items.find((i) => i.location?.ref === "'DD-Dependent'!J6" && i.outcome === 'converted')
    expect(converted?.message).toContain('بترتيب الخيارات في نطاق المصدر')
  })
})

describe('a list fed by a Google table (real file)', () => {
  it("reports the #REF! that Google's export writes instead of the table column, and keeps the cells", async () => {
    const r = await importXlsx(fixture('google-table-dropdowns.xlsx'), { workbookId: 'wb', via: 'upload' })
    const broken = r.report.items.filter((i) => i.kind === 'data_validation' && i.message.includes('#REF!'))
    expect(broken.map((i) => i.location?.ref)).toEqual(["'Assignment'!B6:B105", "'Assignment'!E6:E105", "'Assignment'!G6:G105"])
    expect(broken[0]?.message).toContain('أعد إنشاءها يدويًا')
    const list = rules(r, 'Assignment')
    expect(list.some((x) => x.formula1?.includes('#REF!'))).toBe(false)
    // Its "valid date" rule (custom formula, showDropDown="1") is still a date rule.
    expect(list.some((x) => x.type === 'date')).toBe(true)
  })
})

describe('Excel: every list and validation option (synthesised)', () => {
  let r: ImportXlsxResult
  let main: Rule[]
  let u: HeadlessUniver
  beforeAll(async () => {
    r = await importXlsx(await buildExcelDropdownFixture(), { workbookId: 'wb', via: 'upload' })
    main = rules(r, 'Main')
    u = loadHeadless(r.workbook)
    await new Promise((res) => setTimeout(res, 1200))
  })
  afterAll(() => u.dispose())
  const status = (row: number, col: number) => u.get<SheetsDataValidationValidatorService>(SheetsDataValidationValidatorService).validatorCell('wb', 'sheet-1', row, col)

  it('gives a dependent INDIRECT list its own formula per row, so each row lists its own category', async () => {
    expect([1, 2, 3].map((row) => at(main, row, 1).map((x) => x.formula1))).toEqual([['=INDIRECT($A2)'], ['=INDIRECT($A3)'], ['=INDIRECT($A4)']])
    // B3 "Leek" is valid only against Vegetables (row 3's own category).
    expect(await status(1, 1)).toBe(DataValidationStatus.VALID)
    expect(await status(2, 1)).toBe(DataValidationStatus.VALID)
    expect(await status(3, 1)).toBe(DataValidationStatus.VALID)
  })

  it('moves a relative same-sheet range per row; an absolute one stays a single rule', () => {
    expect([1, 2].map((row) => at(main, row, 9)[0]?.formula1)).toEqual(['=K2:K4', '=K3:K5'])
    expect(at(main, 1, 8)).toEqual([expect.objectContaining({ formula1: '=$K$2:$K$4', ranges: [{ startRow: 1, startColumn: 8, endRow: 3, endColumn: 8 }] })])
  })

  it('keeps a named range, the input title and message, and folds the error title into the message Univer shows', async () => {
    expect(at(main, 1, 2)[0]).toMatchObject({
      type: 'list',
      formula1: '=Statuses',
      prompt: 'اختر حالة المهمة',
      promptTitle: 'الحالة',
      errorStyle: 2,
      showErrorMessage: true,
      error: 'قيمة غير معروفة: اختر حالة من القائمة',
      errorTitle: 'قيمة غير معروفة',
    })
    expect(await status(1, 2)).toBe(DataValidationStatus.VALID)
    const list = u.get<DataValidationListCacheService>(DataValidationListCacheService)
    const model = u.get<SheetDataValidationModel>(SheetDataValidationModel)
    const rule = model.getRuleByLocation('wb', 'sheet-1', 1, 2)
    expect(rule && list.getOrCompute('wb', 'sheet-1', rule).list).toEqual(['قيد التنفيذ', 'منجز', 'متأخر'])
  })

  it('splits an inline list on commas, keeps doubled quotes, honours the hidden arrow (showDropDown="1") and the information style', () => {
    expect(at(main, 1, 3)[0]).toMatchObject({ formula1: JSON.stringify(['أ', 'ب "ج"', 'د']), renderMode: 0, errorStyle: 0 })
  })

  it('evaluates an OFFSET list on another sheet (from <extLst>); a comma in an Excel cell is not a multiple selection', async () => {
    expect(at(main, 1, 4)[0]).toMatchObject({ type: 'list', formula1: '=OFFSET(Lists!$A$1,0,0,COUNTA(Lists!$A:$A),1)', errorStyle: 2 })
    expect(await status(2, 4)).toBe(DataValidationStatus.VALID)
    expect(await status(3, 4)).toBe(DataValidationStatus.INVALID) // "Apple, Pear"
  })

  it('maps whole numbers and text length to their own Univer validators', async () => {
    expect(at(main, 1, 5)[0]).toMatchObject({ type: 'whole', operator: 'between', formula1: '1', formula2: '10', errorStyle: 1, error: 'العدد بين 1 و10' })
    expect(at(main, 1, 6)[0]).toMatchObject({ type: 'textLength', operator: 'lessThanOrEqual', formula1: '5' })
    expect(await status(1, 6)).toBe(DataValidationStatus.VALID) // abc
    expect(await status(2, 6)).toBe(DataValidationStatus.INVALID) // abcdef
  })

  it('reports what changes: warning / information styles, no alert, "Ignore blank" off, and the time rule it cannot carry', () => {
    const items = r.report.items.filter((i) => i.kind === 'data_validation').map((i) => [i.outcome, i.location?.ref, i.message])
    expect(items).toEqual([
      ['converted', "'Main'!C2:C4", expect.stringContaining('«تحذير»')],
      ['converted', "'Main'!D2:D4", expect.stringContaining('«معلومة»')],
      ['converted', "'Main'!E2:E4", expect.stringContaining('دون أي تنبيه')],
      ['converted', "'Main'!F2:F4", expect.stringContaining('لا تتجاهل')],
      ['not_transferred', "'Main'!H2:H4", expect.stringContaining('لم تُنقل')],
    ])
  })

})
