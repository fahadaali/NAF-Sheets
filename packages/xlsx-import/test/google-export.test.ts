// REAL fixtures: files Google Sheets wrote, downloaded on 2026-11-11 with
// `curl -L https://docs.google.com/spreadsheets/d/<id>/export?format=xlsx`
// from public ("anyone with the link") sheets:
//   google-class-data.xlsx   1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
//                            (Google's own "Class Data" sample of the Sheets API docs)
//   google-checkboxes.xlsx   1LuAeR1PfGjZzFWGH5sXMXsOQwCB05R2-QTbTLM_QFpE
//                            (benlcollins.com checkbox template: checkboxes, QUERY,
//                            shared formulas, conditional formats, a Google table,
//                            a chart, an image, a link)
//   google-dropdowns.xlsx    14NIxjd6aoYxNgcCcLeJAjseUldcUNWKv3ECbIt5oZng
//                            (benlcollins.com dropdown template: list rules, range rules)
//   google-gantt.xlsx        1dFBSFQ2SLqRGBvzSmTC2C7dWWaMd3kBix5Q0EmdHPFc
//                            (a Gantt sheet: table with its own colours, cellIs rules, charts)
//   libreoffice-from-google.xlsx  google-checkboxes.xlsx opened and saved as .xlsx by
//                            LibreOffice 24.2 here: a real file from a third program.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ICellData } from '@univerjs/core'
import { importXlsx, readXlsx } from '../src'

const load = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const run = (name: string) => importXlsx(load(name), { workbookId: 'wb', via: 'google_link' })
const resource = (r: Awaited<ReturnType<typeof run>>, name: string) => JSON.parse(r.workbook.resources?.find((x) => x.name === name)?.data ?? 'null')
const sheetByName = (r: Awaited<ReturnType<typeof run>>, name: string) => Object.values(r.workbook.sheets).find((s) => s.name === name)

describe('origin of real files', () => {
  it.each(['google-class-data.xlsx', 'google-checkboxes.xlsx', 'google-dropdowns.xlsx', 'google-gantt.xlsx'])('%s is a Google export', async (name) => {
    const read = await readXlsx(load(name))
    expect(read.origin.kind).toBe('google_export')
    expect(read.origin.application).toBeNull()
    expect(read.origin.evidence).toEqual(expect.arrayContaining(['no docProps', 'workbook namespaces']))
    expect(read.defaultFont).toMatchObject({ family: 'Arial', size: 10 })
  })

  it('the LibreOffice copy names LibreOffice and is read as "other"', async () => {
    const read = await readXlsx(load('libreoffice-from-google.xlsx'))
    expect(read.origin.kind).toBe('other')
    expect(read.origin.application).toMatch(/^LibreOffice\//)
  })
})

describe('Class Data (Google sample)', () => {
  it('imports values, widths, heights and the frozen header like the Sheets API would', async () => {
    const r = await run('google-class-data.xlsx')
    expect(r.report.source.origin).toMatchObject({ kind: 'google_export', via: 'google_link', application: null, defaultFont: { family: 'Arial', size: 10 }, dateSystem: 'date1900', alignment: 'as_given' })
    expect(r.report.counts).toMatchObject({ sheets: 1, cells: 186, formulas: 0 })
    expect(r.report.items).toEqual([])
    const s = sheetByName(r, 'Class Data')
    expect(s?.cellData?.[0]?.[0]?.v).toBe('Student Name')
    expect(s?.cellData?.[1]?.[0]?.v).toBe('Alexandra')
    // defaultColWidth 15.13 → 120 px, defaultRowHeight 15.75 pt → Google's 21 px.
    expect(s?.defaultColumnWidth).toBe(120)
    expect(s?.defaultRowHeight).toBe(21)
    expect(s?.freeze).toMatchObject({ ySplit: 1, startRow: 1 })
    expect(s?.rowCount).toBe(1000)
    expect(s?.columnCount).toBe(26)
    // Arial 10, the default font, is not written on cells: the grid font applies.
    expect(Object.values(r.workbook.styles).some((st) => st?.ff === 'Arial')).toBe(false)
  })
})

describe('checkbox template (Google export)', () => {
  it('restores Google checkboxes, which the export writes as plain TRUE/FALSE', async () => {
    const r = await run('google-checkboxes.xlsx')
    const todo = sheetByName(r, '1. To-Do List')
    expect(todo?.cellData?.[1]?.[1]).toMatchObject({ v: 1, t: 3 })
    const dv = resource(r, 'SHEET_DATA_VALIDATION_PLUGIN')
    const rules = dv[todo?.id as string] as Array<{ type: string; ranges: unknown[] }>
    expect(rules).toEqual([expect.objectContaining({ type: 'checkbox', ranges: [{ startRow: 1, endRow: 5, startColumn: 1, endColumn: 1 }] })])
    const checkboxItems = r.report.items.filter((i) => i.kind === 'checkbox')
    expect(checkboxItems.map((i) => i.location?.ref)).toEqual(
      expect.arrayContaining(["'1. To-Do List'!B2:B6", "'2. Highlight Data'!F2:F3", "'5. Control Switch'!A2"]),
    )
    expect(checkboxItems.every((i) => i.outcome === 'converted')).toBe(true)
  })

  it('restores the original QUERY formula from DUMMYFUNCTION and keeps its result as values', async () => {
    const r = await run('google-checkboxes.xlsx')
    const chart = sheetByName(r, '4. Dynamic Chart')
    const query = r.report.items.find((i) => i.kind === 'unsupported_formula')
    expect(query).toMatchObject({ outcome: 'value_only', detail: '=QUERY(A1:F6,"where F = TRUE",1)' })
    expect(query?.message).toContain('QUERY')
    expect(query?.message).toContain('Google Sheets')
    expect(query?.location?.ref).toBe("'4. Dynamic Chart'!J1:O4")
    // Anchor and spilled cells hold Google's last values; nothing says DUMMYFUNCTION.
    expect(chart?.cellData?.[0]?.[9]).toMatchObject({ v: 'Customer' })
    expect(chart?.cellData?.[0]?.[10]).toMatchObject({ v: 'North' })
    const formulas = Object.values(chart?.cellData ?? {}).flatMap((row) => Object.values(row ?? {}) as ICellData[]).map((c) => c.f).filter(Boolean)
    expect(formulas.join(' ')).not.toMatch(/DUMMYFUNCTION|COMPUTED_VALUE/i)
    const notes = resource(r, 'SHEET_NOTE_PLUGIN')
    expect(notes[chart?.id as string][0][9].note).toContain('=QUERY(')
  })

  it('expands shared formulas (Google writes them too)', async () => {
    const r = await run('google-checkboxes.xlsx')
    const sw = sheetByName(r, '5. Control Switch')
    expect(sw?.cellData?.[4]?.[1]?.f).toMatch(/^=IF\(\$A\$2,/)
    expect(sw?.cellData?.[10]?.[1]?.f).toBe(sw?.cellData?.[4]?.[1]?.f)
  })

  it('converts conditional formats, keeps sheet colours from the "Sheets" theme, widths in Google pixels', async () => {
    const r = await run('google-checkboxes.xlsx')
    const cf = resource(r, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN')
    const todo = sheetByName(r, '1. To-Do List')
    expect(cf[todo?.id as string][0].rule).toMatchObject({ subType: 'formula', value: '=$B2=TRUE', style: { st: { s: 1 }, cl: { rgb: '#cc0000' }, bg: { rgb: '#ea9999' } } })
    const info = sheetByName(r, 'Info')
    // htmlview pixel widths of the same sheet: 27, 83, 536.
    expect(info?.columnData).toMatchObject({ 0: { w: 27 }, 1: { w: 83 }, 2: { w: 536 } })
    expect(info?.showGridlines).toBe(0)
    expect(info?.rowData?.[1]).toMatchObject({ h: 84 })
  })

  it('turns the Google table colours into fills and reports the table, the chart and the picture', async () => {
    const r = await run('google-checkboxes.xlsx')
    const kinds = r.report.items.map((i) => `${i.kind}:${i.outcome}:${i.location?.ref ?? ''}`)
    expect(kinds).toEqual(
      expect.arrayContaining([
        "banded_range:converted:'1. To-Do List'!A1:B6",
        "table:converted:'1. To-Do List'!A1:B6",
        "chart:not_transferred:'4. Dynamic Chart'!A7",
        "drawing_image:not_transferred:'Info'!B2",
      ]),
    )
    const todo = sheetByName(r, '1. To-Do List')
    const header = todo?.cellData?.[0]?.[0]?.s as string
    expect(r.workbook.styles[header]?.bg?.rgb).toBe('#5b95f9')
  })

  it('keeps the link of the Info sheet', async () => {
    const r = await run('google-checkboxes.xlsx')
    expect(r.report.counts.hyperlinks).toBe(1)
  })
})

describe('dropdown template (Google export)', () => {
  it('turns dropdowns into list rules: literal lists and ranges', async () => {
    const r = await run('google-dropdowns.xlsx')
    const dv = resource(r, 'SHEET_DATA_VALIDATION_PLUGIN')
    const all = Object.values(dv).flat() as Array<{ type: string; formula1: string; renderMode: number }>
    expect(all.map((x) => x.formula1)).toEqual(
      expect.arrayContaining([JSON.stringify(['Lead', 'Schedule Showing', 'Negotiation', 'Closing Phase', 'Deal Done', 'Deal Lost']), "='Range Example'!$A:$A"]),
    )
    expect(all.every((x) => x.type === 'list')).toBe(true)
    // No showDropDown attribute → the arrow shows (Google's dropdown chip).
    expect(all.every((x) => x.renderMode === 1)).toBe(true)
  })
})

describe('Gantt (Google export)', () => {
  it('maps cellIs rules on text to text equality and keeps the merges', async () => {
    const r = await run('google-gantt.xlsx')
    const cf = Object.values(resource(r, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN')).flat() as Array<{ rule: { subType: string; operator: string; value: unknown } }>
    expect(cf).toHaveLength(4)
    expect(cf.every((c) => c.rule.subType === 'text' && c.rule.operator === 'equal' && c.rule.value === 'TRUE')).toBe(true)
    expect(r.report.counts.merges).toBe(12)
  })
})

describe('LibreOffice copy of a Google export (real "other" origin)', () => {
  it('imports with the Excel rules and still restores Google’s QUERY formula', async () => {
    const r = await importXlsx(load('libreoffice-from-google.xlsx'), { workbookId: 'wb', via: 'upload', fileName: 'checkboxes.xlsx' })
    expect(r.report.source.origin).toMatchObject({ kind: 'other', via: 'upload', fileName: 'checkboxes.xlsx' })
    expect(r.report.items.find((i) => i.kind === 'unsupported_formula')?.detail).toBe('=QUERY(A1:F6,"where F = TRUE",1)')
    // Not a Google export: TRUE/FALSE stay values, no checkbox is invented.
    expect(r.report.items.some((i) => i.kind === 'checkbox')).toBe(false)
    expect(r.report.counts.sheets).toBe(6)
  })
})

describe('Google-export structures rebuilt from the real files (synthesised, used by apps/api too)', () => {
  it('restores checkboxes and QUERY, keeps the dropdown, and reads Google’s "valid date" rule as a date rule', async () => {
    const { buildGoogleStyleFixture } = await import('./fixtures/excel-fixture')
    const r = await importXlsx(await buildGoogleStyleFixture(), { workbookId: 'wb', via: 'google_link' })
    expect(r.read.origin.kind).toBe('google_export')
    expect(r.read.origin.evidence).toContain('DUMMYFUNCTION')
    const kinds = r.report.items.map((i) => `${i.kind}:${i.location?.ref}`)
    expect(kinds).toEqual(["unsupported_formula:'المهام'!D1:D3", "checkbox:'المهام'!B2:B3"])
    const dv = Object.values(resource(r, 'SHEET_DATA_VALIDATION_PLUGIN')).flat() as Array<{ type: string; ranges: unknown[] }>
    expect(dv.map((x) => x.type).sort()).toEqual(['checkbox', 'date', 'list'])
  })
})
