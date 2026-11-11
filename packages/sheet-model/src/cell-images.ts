// Images inside a cell (Univer 1.4.0 "cell image", @univerjs/sheets-drawing-ui
// `InsertCellImageCommand`; the .xlsx import's in-cell pictures): the cell
// holds a rich-text document (`ICellData.p`) whose body has one placeholder
// character per picture (`\b`, core `DataStreamTreeTokenType.CUSTOM_BLOCK`)
// with a `customBlocks` entry naming it, and the picture itself in
// `p.drawings[id]`, ordered by `p.drawingsOrder`.
//
// Rules of the platform (owner, 2026-11-11; apps/api OPEN_QUESTIONS.md
// "Images"):
// - a picture is never text: every reading of a cell (`cellText`) leaves the
//   placeholders out, so a picture in a title, assignee, date or status cell
//   changes nothing that is sent to Basecamp, and is never an error;
// - an inbound write (Basecamp → cell) never removes a picture: the cell keeps
//   its pictures and only its text changes (`withImagesKept`).

import type { ICellData } from './univer'

/** core `DataStreamTreeTokenType.CUSTOM_BLOCK`: where a picture sits in the text. */
export const IMAGE_PLACEHOLDER = '\b'

/** core `createDocumentModelWithStyle`'s document style, which Univer's cell renderer needs. */
export const CELL_DOCUMENT_STYLE = {
  pageSize: { width: null, height: null },
  documentFlavor: 0,
  marginTop: 0,
  marginBottom: 2,
  marginRight: 2,
  marginLeft: 2,
  renderConfig: { horizontalAlign: 0, verticalAlign: 0, centerAngle: 0, vertexAngle: 0, wrapStrategy: 0 },
}

/** One picture inside a cell, as the platform reads it. */
export interface CellImage {
  drawingId: string
  /** `imagePath(...)` of a stored picture, a data URL, or an external URL. */
  source: string
  imageSourceType: string
  width: number | null
  height: number | null
}

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The pictures of a cell, in the document's order. Empty for any other cell. */
export function cellImages(cell: ICellData | undefined | null): CellImage[] {
  const p = cell?.p as unknown
  if (!isObject(p) || !isObject(p.drawings)) return []
  const drawings = p.drawings
  const order = Array.isArray(p.drawingsOrder) ? (p.drawingsOrder as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const ids = [...order, ...Object.keys(drawings).filter((k) => !order.includes(k))]
  const out: CellImage[] = []
  for (const id of ids) {
    const d = drawings[id]
    if (!isObject(d) || typeof d.source !== 'string' || d.source === '') continue
    const size = isObject(d.docTransform) && isObject(d.docTransform.size) ? d.docTransform.size : isObject(d.transform) ? d.transform : {}
    out.push({
      drawingId: id,
      source: d.source,
      imageSourceType: typeof d.imageSourceType === 'string' ? d.imageSourceType : 'URL',
      width: typeof size.width === 'number' ? size.width : null,
      height: typeof size.height === 'number' ? size.height : null,
    })
  }
  return out
}

export function hasCellImages(cell: ICellData | undefined | null): boolean {
  return cellImages(cell).length > 0
}

/**
 * The text of a rich-text data stream without its picture placeholders. A
 * cell holding pictures also loses the empty lines around them (Univer puts
 * a picture in a paragraph of its own).
 */
export function textWithoutImages(stream: string, hadImages: boolean): string {
  if (!stream.includes(IMAGE_PLACEHOLDER)) return stream
  const text = stream.split(IMAGE_PLACEHOLDER).join('')
  return hadImages ? text.replace(/^\n+/, '').replace(/\n+$/, '') : text
}

/**
 * A copy of `next` (a cell an inbound write produced, without `p`) that keeps
 * the pictures of `current`: a document with the pictures first, then
 * `text` (the value as the cell shows it). `next.v` / `next.t` are kept, so a
 * reader of the value (a checkbox, a formula) still sees it.
 * Returns `next` unchanged when `current` has no picture.
 */
export function withImagesKept(current: ICellData | undefined, next: ICellData, text: string): ICellData {
  const p = current?.p as unknown
  if (!isObject(p) || cellImages(current).length === 0) return next
  const images = cellImages(current)
  const drawings: Obj = {}
  for (const image of images) drawings[image.drawingId] = (p.drawings as Obj)[image.drawingId]
  const lines = text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n')
  let stream = IMAGE_PLACEHOLDER.repeat(images.length) + '\r'
  const paragraphs: Array<{ startIndex: number }> = [{ startIndex: images.length }]
  for (const line of lines) {
    stream += line + '\r'
    paragraphs.push({ startIndex: stream.length - 1 })
  }
  stream += '\n'
  const body = {
    dataStream: stream,
    textRuns: [],
    paragraphs,
    sectionBreaks: [{ startIndex: stream.length - 1 }],
    customBlocks: images.map((image, i) => ({ startIndex: i, blockId: image.drawingId })),
  }
  const doc: Obj = { id: typeof p.id === 'string' ? p.id : 'd', body, drawings, drawingsOrder: images.map((i) => i.drawingId) }
  // Univer's cell renderer needs the page size, margins and render config (a cell document without them blanks the grid).
  doc.documentStyle = isObject(p.documentStyle) && isObject(p.documentStyle.pageSize) ? p.documentStyle : { ...CELL_DOCUMENT_STYLE, ...(isObject(p.documentStyle) ? p.documentStyle : {}), pageSize: { width: null, height: null } }
  return { ...next, p: doc as unknown as ICellData['p'] }
}
