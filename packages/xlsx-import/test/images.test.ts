// Pictures of an .xlsx (src/images.ts, src/import-images.ts; apps/api
// OPEN_QUESTIONS.md "Images").
//
// REAL Google exports (downloaded 2026-11-11 with
// `curl -L https://docs.google.com/spreadsheets/d/<id>/export?format=xlsx`):
//   google-floating-image.xlsx  17f0dQawb-s_Fd7DHgmVvJoEGDMH_yoSd8EYigrb0zmM
//                               (the public "Polyglot Gamedev Project" master sheet:
//                               a PNG logo over the grid on its first tab)
//   google-checkboxes.xlsx      (see google-export.test.ts: a JPEG over the grid)
// Of 111 public sheets exported that day, 16 Google exports held pictures; every
// one was a `oneCellAnchor` with `ext`, and none held an in-cell picture or
// `vm` cells, so how Google exports an in-cell picture was not observed (I12).
//
// SYNTHESISED Excel-shaped file (`excelPicturesFixture` below): no Excel was
// available. It follows ECMA-376 (drawingML anchors) and Microsoft's
// [MS-XLSX] rich data parts for "Place in cell" (xl/metadata.xml,
// xl/richData/*), as Excel 365 writes them.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ICellData } from '@univerjs/core'
import { importXlsx, pictureSize, readXlsx, type PictureStore } from '../src'
import { EMF, excelPicturesFixture, PNG } from './fixtures/excel-pictures'

const load = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))


/** A store like the API's: accepts PNG / JPEG only (by their bytes), answers a URL per stored picture. */
function recordingStore() {
  const stored: Array<{ bytes: Uint8Array; name: string | null }> = []
  const store: PictureStore = async (bytes, meta) => {
    const png = bytes[0] === 0x89 && bytes[1] === 0x50
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
    if (!png && !jpeg) return { ok: false, reason: 'type' }
    stored.push({ bytes, name: meta.name })
    return { ok: true, url: `/api/workbooks/wb/images/${String(stored.length).padStart(32, '0')}` }
  }
  return { store, stored }
}

const drawingsOf = (r: { workbook: { resources?: Array<{ name: string; data: string }> } }) =>
  JSON.parse(r.workbook.resources?.find((x) => x.name === 'SHEET_DRAWING_PLUGIN')?.data ?? '{}') as Record<string, { data: Record<string, Record<string, any>>; order: string[] }>

describe('real Google exports', () => {
  it('reads the floating PNG of the Polyglot sheet with its one-cell anchor, offsets and size', async () => {
    const read = await readXlsx(load('google-floating-image.xlsx'))
    expect(read.origin.kind).toBe('google_export')
    expect(read.pictures).toHaveLength(1)
    const p = read.pictures[0]!
    expect(p).toMatchObject({ kind: 'floating', sheet: { name: 'About' }, row: 0, column: 1, part: 'xl/media/image1.png', title: 'Image' })
    expect(p.anchor).toEqual({ type: 'oneCell', from: { column: 1, columnOffset: 62, row: 0, rowOffset: 12 }, width: 122, height: 122 })
    const bytes = await read.readPicture('xl/media/image1.png')
    expect(bytes?.byteLength).toBe(485)
  })

  it('imports it: stored once, written over the grid as a URL, counted, not reported', async () => {
    const { store, stored } = recordingStore()
    const r = await importXlsx(load('google-floating-image.xlsx'), { workbookId: 'wb', via: 'google_link', storePicture: store })
    expect(stored).toHaveLength(1)
    expect(r.pictures).toEqual({ floating: 1, inCell: 0, skipped: 0 })
    expect(r.report.counts).toMatchObject({ floatingImages: 1, cellImages: 0 })
    const sheet = Object.values(r.workbook.sheets).find((s) => s.name === 'About')!
    const entry = drawingsOf(r)[sheet.id as string]!
    expect(entry.order).toHaveLength(1)
    const image = entry.data[entry.order[0]!]!
    expect(image).toMatchObject({
      unitId: 'wb',
      subUnitId: sheet.id,
      drawingType: 0,
      imageSourceType: 'URL',
      source: '/api/workbooks/wb/images/00000000000000000000000000000001',
      anchorType: '0',
      sheetTransform: { from: { column: 1, columnOffset: 62, row: 0, rowOffset: 12 } },
      title: 'Image',
    })
    expect(image.transform).toMatchObject({ width: 122, height: 122 })
    expect(JSON.stringify(r.workbook)).not.toContain('base64')
    expect(r.report.items.filter((i) => i.kind === 'drawing_image' || i.kind === 'cell_image')).toEqual([])
  })

  it('the JPEG of the checkbox template is imported the same way', async () => {
    const { store } = recordingStore()
    const r = await importXlsx(load('google-checkboxes.xlsx'), { workbookId: 'wb', via: 'google_link', storePicture: store })
    expect(r.pictures.floating).toBe(1)
    const info = Object.values(r.workbook.sheets).find((s) => s.name === 'Info')!
    const entry = drawingsOf(r)[info.id as string]!
    expect(entry.data[entry.order[0]!]).toMatchObject({ sheetTransform: { from: { column: 1, row: 1, columnOffset: 0, rowOffset: 0 } }, transform: { width: 84, height: 84 } })
  })

  it('without a store every picture is still reported, as before', async () => {
    const r = await importXlsx(load('google-floating-image.xlsx'), { workbookId: 'wb', via: 'google_link' })
    expect(r.pictures).toEqual({ floating: 0, inCell: 0, skipped: 1 })
    expect(r.report.items.filter((i) => i.kind === 'drawing_image').map((i) => `${i.outcome}:${i.location?.ref}`)).toEqual(["not_transferred:'About'!B1"])
  })
})

describe('synthesised Excel file', () => {
  it('reads every anchor kind, linked pictures and the in-cell pictures of xl/richData', async () => {
    const read = await readXlsx(await excelPicturesFixture())
    expect(read.origin.kind).toBe('excel')
    const floating = read.pictures.filter((p) => p.kind === 'floating')
    expect(floating.map((p) => p.anchor?.type)).toEqual(['twoCell', 'twoCell', 'oneCell', 'absolute', 'oneCell', 'oneCell'])
    expect(floating[0]!.anchor).toEqual({ type: 'twoCell', editAs: 'twoCell', from: { column: 3, columnOffset: 10, row: 1, rowOffset: 4 }, to: { column: 5, columnOffset: 20, row: 4, rowOffset: 8 } })
    expect(floating[0]!.description).toBe('شعار ناف')
    expect(floating[1]!.anchor).toMatchObject({ editAs: 'oneCell' })
    expect(floating[3]!.anchor).toEqual({ type: 'absolute', x: 300, y: 200, width: 40, height: 30 })
    expect(floating[5]).toMatchObject({ part: null, missing: 'external', url: 'https://example.com/linked.png' })
    const inCell = read.pictures.filter((p) => p.kind === 'in_cell')
    expect(inCell).toEqual([
      expect.objectContaining({ row: 2, column: 1, part: 'xl/media/image3.png', description: 'صورة المنتج' }),
      expect.objectContaining({ row: 2, column: 2, part: null, missing: 'external', url: 'https://example.com/photo.png' }),
      expect.objectContaining({ row: 2, column: 3, part: 'xl/media/image2.emf' }),
    ])
  })

  it('imports the floating pictures with Univer anchors, the in-cell picture as Univer’s cell document, and reports the rest', async () => {
    const { store, stored } = recordingStore()
    const r = await importXlsx(await excelPicturesFixture(), { workbookId: 'wb', via: 'upload', storePicture: store })
    // image1.png is stored once for its four uses; image3.png once; the EMF is refused.
    expect(stored).toHaveLength(2)
    expect(r.pictures).toEqual({ floating: 4, inCell: 1, skipped: 4 })
    expect(r.report.counts).toMatchObject({ floatingImages: 4, cellImages: 1 })
    const sheet = Object.values(r.workbook.sheets)[0]!
    const entry = drawingsOf(r)[sheet.id as string]!
    const images = entry.order.map((id: string) => entry.data[id]!)
    expect(images.map((i: Record<string, unknown>) => i.anchorType)).toEqual(['1', '0', '0', '2'])
    // Drawing coordinates include Univer's headers (46 × 20 px). Column A is 20.71 characters
    // (145 px, Excel's formula), the others Excel's default 64 px; rows 15 pt (20 px).
    expect(images[0]!.transform).toMatchObject({ left: 46 + 145 + 64 * 2 + 10, top: 20 + 20 + 4 })
    expect(images[2]!.sheetTransform).toMatchObject({ from: { column: 2, columnOffset: 5, row: 10, rowOffset: 3 } })
    expect(images[2]!.transform).toMatchObject({ width: 100, height: 50 })
    expect(images[3]!.transform).toMatchObject({ left: 346, top: 220, width: 40, height: 30 })

    const b3 = sheet.cellData?.[2]?.[1] as ICellData & { p: any }
    expect(b3.v).toBeUndefined()
    expect(b3.p.body.dataStream).toBe('\r\b\r\n')
    const id = b3.p.drawingsOrder[0]
    expect(b3.p.body.customBlocks).toEqual([{ startIndex: 1, blockId: id }])
    expect(b3.p.drawings[id]).toMatchObject({ imageSourceType: 'URL', source: '/api/workbooks/wb/images/00000000000000000000000000000002', layoutType: 0, description: 'صورة المنتج' })

    const reported = r.report.items.filter((i) => i.kind === 'drawing_image' || i.kind === 'cell_image').map((i) => `${i.kind}:${i.outcome}:${i.location?.ref}:${i.detail ?? ''}`)
    expect(reported.sort()).toEqual(
      [
        "cell_image:not_transferred:'الصور'!C3:https://example.com/photo.png",
        "cell_image:not_transferred:'الصور'!D3:EMF",
        "drawing_image:converted:'الصور'!D11:",
        "drawing_image:not_transferred:'الصور'!H2:EMF",
        "drawing_image:not_transferred:'الصور'!I2:https://example.com/linked.png",
      ].sort(),
    )
  })
})

describe('pictureSize', () => {
  it('reads PNG, GIF and JPEG headers', () => {
    expect(pictureSize(PNG)).toEqual({ width: 1, height: 1 })
    expect(pictureSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0]))).toEqual({ width: 3, height: 2 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 40, 3, 0, 0, 0])
    expect(pictureSize(jpeg)).toEqual({ width: 40, height: 20 })
    expect(pictureSize(EMF)).toBeNull()
  })
})
