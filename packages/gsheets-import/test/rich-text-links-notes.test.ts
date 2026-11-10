import { describe, expect, it } from 'vitest'
import { convertSpreadsheet, RESOURCE, rewriteSheetLink } from '../src'
import { buildCellDocument, documentPlainText } from '../src/rich-text'
import type { UniverSheetNote } from '../src/univer-constants'
import { cellOf, gridSheet, num, oneSheet, resourceOf, spreadsheet, str } from './helpers/build'

describe('textFormatRuns → rich text (ICellData.p)', () => {
  // "نُشر على X" — the damma makes "نُشر" four UTF-16 units: X is at index 9.
  const value = 'نُشر على X'
  const { workbook, report } = convertSpreadsheet(
    oneSheet([
      [
        str(value, {
          userEnteredFormat: { textFormat: { fontSize: 11, foregroundColor: { red: 1 } } },
          textFormatRuns: [{ format: {} }, { startIndex: 9, format: { bold: true, foregroundColorStyle: { rgbColor: { blue: 1 } } } }],
        }),
      ],
    ]),
  )
  const cell = cellOf(workbook, 'sheet-0', 0, 0)

  it('builds the document stream, paragraph and section break', () => {
    expect(cell?.p?.body?.dataStream).toBe(`${value}\r\n`)
    expect(cell?.p?.body?.paragraphs).toEqual([{ startIndex: 10, paragraphId: 'p0' }])
    expect(cell?.p?.body?.sectionBreaks).toEqual([{ sectionId: 's0', startIndex: 11 }])
    expect(cell?.v).toBe(value)
  })

  it('writes each run with the cell format resolved into it (UTF-16 indexes, exclusive end)', () => {
    expect(cell?.p?.body?.textRuns).toEqual([
      { st: 0, ed: 9, ts: { fs: 11, cl: { rgb: '#ff0000' } } },
      { st: 9, ed: 10, ts: { fs: 11, bl: 1, cl: { rgb: '#0000ff' } } },
    ])
    expect(report.counts.richTextCells).toBe(1)
  })
})

describe('multi-line text', () => {
  it('becomes paragraphs, because Univer drops line breaks from a plain value', () => {
    const { workbook } = convertSpreadsheet(oneSheet([[str('السطر الأول\nالسطر الثاني')]]))
    const p = cellOf(workbook, 'sheet-0', 0, 0)?.p
    expect(p?.body?.dataStream).toBe('السطر الأول\rالسطر الثاني\r\n')
    expect(p?.body?.paragraphs?.map((x) => x.startIndex)).toEqual([11, 24])
    expect(p && documentPlainText(p)).toBe('السطر الأول\nالسطر الثاني')
  })
})

describe('hyperlinks', () => {
  it('turns a run link into a HYPERLINK custom range (inclusive end)', () => {
    const { workbook, report } = convertSpreadsheet(
      oneSheet([[str('الموقع naflaw', { textFormatRuns: [{ format: {} }, { startIndex: 7, format: { link: { uri: 'https://naflaw.sa' } } }] })]]),
    )
    expect(cellOf(workbook, 'sheet-0', 0, 0)?.p?.body?.customRanges).toEqual([
      { startIndex: 7, endIndex: 12, rangeId: 'sheet-0-r0c0-link0', rangeType: 0, properties: { url: 'https://naflaw.sa' } },
    ])
    expect(report.counts.hyperlinks).toBe(1)
  })

  it('links the whole cell for a cell-level link, rewriting links to other sheets', () => {
    const { workbook } = convertSpreadsheet(
      spreadsheet([
        gridSheet([[str('انظر الملخص', { hyperlink: '#gid=1234&range=B2', userEnteredFormat: { textFormat: { link: { uri: '#gid=1234&range=B2' } } } })]]),
        gridSheet([], {}, { sheetId: 1234, title: 'الملخص', index: 1 }),
      ]),
    )
    expect(cellOf(workbook, 'sheet-0', 0, 0)?.p?.body?.customRanges).toEqual([
      { startIndex: 0, endIndex: 10, rangeId: 'sheet-0-r0c0-link0', rangeType: 0, properties: { url: '#gid=sheet-1234&range=B2' } },
    ])
  })

  it('uses CellData.hyperlink when the format carries no link', () => {
    const { workbook } = convertSpreadsheet(oneSheet([[str('naflaw.sa', { hyperlink: 'https://naflaw.sa' })]]))
    expect(cellOf(workbook, 'sheet-0', 0, 0)?.p?.body?.customRanges?.[0]?.properties).toEqual({ url: 'https://naflaw.sa' })
  })

  it('leaves unknown gids, named-range links and URLs untouched', () => {
    const ids = new Map([[0, 'sheet-0']])
    expect(rewriteSheetLink('#gid=0', ids)).toBe('#gid=sheet-0')
    expect(rewriteSheetLink('#gid=77', ids)).toBe('#gid=77')
    expect(rewriteSheetLink('#rangeid=abc', ids)).toBe('#rangeid=abc')
    expect(rewriteSheetLink('https://docs.google.com/spreadsheets/d/x/edit#gid=0', ids)).toBe('https://docs.google.com/spreadsheets/d/x/edit#gid=0')
  })

  it('reports a link on a number and a link shown as plain text', () => {
    const { workbook, report } = convertSpreadsheet(
      oneSheet([[num(5, { hyperlink: 'https://naflaw.sa' }), str('x', { hyperlink: 'https://a.sa', userEnteredFormat: { hyperlinkDisplayType: 'PLAIN_TEXT' } })]]),
    )
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ v: 5, t: 2 })
    expect(cellOf(workbook, 'sheet-0', 0, 1)?.p).toBeUndefined()
    expect(report.items.map((i) => [i.kind, i.location?.ref, i.detail])).toEqual([
      ['hyperlink', "'ورقة1'!A1", 'https://naflaw.sa'],
      ['hyperlink', "'ورقة1'!B1", 'https://a.sa'],
    ])
  })

  it('merges adjacent segments with the same link into one range', () => {
    const doc = buildCellDocument('abcd', [
      { start: 0, end: 2, style: { bl: 1 }, link: 'u' },
      { start: 2, end: 4, style: {}, link: 'u' },
    ], 'x')
    expect(doc.body?.customRanges).toEqual([{ startIndex: 0, endIndex: 3, rangeId: 'x-link0', rangeType: 0, properties: { url: 'u' } }])
    expect(doc.body?.textRuns).toEqual([{ st: 0, ed: 2, ts: { bl: 1 } }])
  })
})

describe('notes and smart chips', () => {
  it('writes notes to the SHEET_NOTE_PLUGIN resource', () => {
    const { workbook, report } = convertSpreadsheet(oneSheet([[], [str('مهمة', { note: 'يحتاج موافقة' })]]))
    expect(resourceOf<Record<string, Record<number, Record<number, UniverSheetNote>>>>(workbook, RESOURCE.NOTE)).toEqual({
      'sheet-0': { 1: { 0: { id: 'note-sheet-0-1-0', row: 1, col: 0, width: 160, height: 72, note: 'يحتاج موافقة' } } },
    })
    expect(report.counts.notes).toBe(1)
  })

  it('reports a person chip and keeps the text', () => {
    const { workbook, report } = convertSpreadsheet(
      oneSheet([[str('المتابعة: @', { chipRuns: [{ startIndex: 0 }, { startIndex: 10, chip: { personProperties: { email: 'sara@naflaw.sa' } } }] })]]),
    )
    expect(cellOf(workbook, 'sheet-0', 0, 0)).toEqual({ v: 'المتابعة: @', t: 1 })
    expect(report.items).toEqual([expect.objectContaining({ kind: 'smart_chip', outcome: 'not_transferred', detail: 'sara@naflaw.sa' })])
  })
})
