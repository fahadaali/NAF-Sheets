// Pictures of an imported file → the converted Univer workbook (owner,
// 2026-11-11; apps/api OPEN_QUESTIONS.md "Images" I10–I14).
//
// The Sheets API has no pictures, so only the .xlsx reader
// (@naf-sheets/xlsx-import) produces them. The caller stores each picture
// first (the API: R2, `imagePath`) and passes its URL as `source`; nothing
// here sees bytes. Two kinds:
//
// - floating: over the grid, anchored to cells (Excel / Google "over cells"),
//   written to the resource SHEET_DRAWING_PLUGIN as Univer's `ISheetImage`
//   (@univerjs/sheets-drawing 1.4.0: `sheetTransform` from/to, `transform`,
//   `axisAlignSheetTransform`, `anchorType`);
// - in a cell (Excel "Place in cell"): the cell becomes the document Univer's
//   own cell-image command writes (sheets-drawing-ui `_insertCellImage`): one
//   `\b` placeholder per picture with a custom block, the picture in
//   `p.drawings`, laid out inline.
//
// Anchors: twoCell (editAs twoCell → moves and sizes with cells, `Both`;
// oneCell → moves only, `Position`; absolute → `None`), oneCell (`Position`,
// size from its extent), absolute (`None`, position in pixels). Univer
// recomputes `transform` from `sheetTransform` when the sheet is drawn
// (sheets-drawing-ui SheetsDrawingRenderController → refreshSheetDrawingPlacement),
// except for `None`, whose `transform` is used as written.

import type { IWorkbookData, IWorksheetData } from '@univerjs/core'
import { location, MESSAGES, type ImportReport, type ImportReportItem } from './report'

/** Resource name of @univerjs/sheets-drawing 1.4.0 (`SHEET_DRAWING_PLUGIN`; checked in test/univer-contract). */
export const SHEET_DRAWING_RESOURCE = 'SHEET_DRAWING_PLUGIN'

/** Univer's defaults when a sheet does not set them (core `DEFAULT_WORKSHEET_*`; header sizes of sheets-ui). */
const DEFAULT_COLUMN_WIDTH = 88
const DEFAULT_ROW_HEIGHT = 24
const ROW_HEADER_WIDTH = 46
const COLUMN_HEADER_HEIGHT = 20

export interface CellOffset {
  row: number
  column: number
  /** Offsets inside the cell, in pixels. */
  rowOffset: number
  columnOffset: number
}

export type ImageAnchor =
  | { type: 'twoCell'; from: CellOffset; to: CellOffset; editAs: 'twoCell' | 'oneCell' | 'absolute' }
  | { type: 'oneCell'; from: CellOffset; width: number; height: number }
  | { type: 'absolute'; x: number; y: number; width: number; height: number }

interface ImageBase {
  /** Google sheetId of the intermediate model (`univerSheetId(gid)` in the workbook). */
  sheetGid: number
  /** Where the stored picture is read from (the API's `imagePath`). */
  source: string
  /** Alternative text / name from the file. */
  title?: string
  description?: string
}

export type ImportedImage =
  | (ImageBase & { kind: 'floating'; anchor: ImageAnchor })
  | (ImageBase & { kind: 'in_cell'; row: number; column: number; width: number | null; height: number | null })

/** A picture of the file that could not be stored (type, size), reported where it was. */
export interface SkippedImage {
  sheetGid: number
  kind: 'floating' | 'in_cell'
  row: number
  column: number
  reason: 'type' | 'size' | 'missing' | 'external' | 'limit'
  detail?: string
}

export interface ApplyImagesResult {
  floating: number
  inCell: number
}

type Sheet = Partial<IWorksheetData> & { id: string; name?: string }

function columnWidth(sheet: Sheet, c: number): number {
  const col = (sheet.columnData as Record<number, { w?: number; hd?: number } | undefined> | undefined)?.[c]
  if (col?.hd === 1) return 0
  return col?.w ?? sheet.defaultColumnWidth ?? DEFAULT_COLUMN_WIDTH
}

function rowHeight(sheet: Sheet, r: number): number {
  const row = (sheet.rowData as Record<number, { h?: number; hd?: number } | undefined> | undefined)?.[r]
  if (row?.hd === 1) return 0
  return row?.h ?? sheet.defaultRowHeight ?? DEFAULT_ROW_HEIGHT
}

/** Left / top of a cell in the sheet's drawing coordinates (headers included, as Univer's skeleton). */
function cellX(sheet: Sheet, c: number): number {
  let x = ROW_HEADER_WIDTH
  for (let i = 0; i < c; i++) x += columnWidth(sheet, i)
  return x
}
function cellY(sheet: Sheet, r: number): number {
  let y = COLUMN_HEADER_HEIGHT
  for (let i = 0; i < r; i++) y += rowHeight(sheet, i)
  return y
}

/** The cell and offset under a point of the drawing coordinates (the walk Univer's skeleton does). */
function cellAt(sheet: Sheet, x: number, y: number): CellOffset {
  const maxColumn = Math.max(0, (sheet.columnCount ?? 26) - 1)
  const maxRow = Math.max(0, (sheet.rowCount ?? 1000) - 1)
  let column = 0
  let left = ROW_HEADER_WIDTH
  while (column < maxColumn && left + columnWidth(sheet, column) <= x) left += columnWidth(sheet, column++)
  let row = 0
  let top = COLUMN_HEADER_HEIGHT
  while (row < maxRow && top + rowHeight(sheet, row) <= y) top += rowHeight(sheet, row++)
  return { column, row, columnOffset: Math.max(0, x - left), rowOffset: Math.max(0, y - top) }
}

const round = (n: number) => Math.round(n * 10) / 10
const marker = (o: CellOffset) => ({ column: o.column, columnOffset: round(o.columnOffset), row: o.row, rowOffset: round(o.rowOffset) })
const NO_TURN = { angle: 0, flipX: false, flipY: false, skewX: 0, skewY: 0 }

/** Univer's `ISheetImage` for a floating picture. */
export function sheetImageOf(unitId: string, sheet: Sheet, drawingId: string, image: Extract<ImportedImage, { kind: 'floating' }>): Record<string, unknown> {
  const a = image.anchor
  let from: CellOffset
  let to: CellOffset
  let left: number
  let top: number
  let width: number
  let height: number
  let anchorType: '0' | '1' | '2'
  if (a.type === 'twoCell') {
    from = a.from
    to = a.to
    left = cellX(sheet, from.column) + from.columnOffset
    top = cellY(sheet, from.row) + from.rowOffset
    width = Math.max(1, cellX(sheet, to.column) + to.columnOffset - left)
    height = Math.max(1, cellY(sheet, to.row) + to.rowOffset - top)
    anchorType = a.editAs === 'oneCell' ? '0' : a.editAs === 'absolute' ? '2' : '1'
  } else if (a.type === 'oneCell') {
    from = a.from
    left = cellX(sheet, from.column) + from.columnOffset
    top = cellY(sheet, from.row) + from.rowOffset
    width = Math.max(1, a.width)
    height = Math.max(1, a.height)
    to = cellAt(sheet, left + width, top + height)
    anchorType = '0'
  } else {
    left = ROW_HEADER_WIDTH + a.x
    top = COLUMN_HEADER_HEIGHT + a.y
    width = Math.max(1, a.width)
    height = Math.max(1, a.height)
    from = cellAt(sheet, left, top)
    to = cellAt(sheet, left + width, top + height)
    anchorType = '2'
  }
  const position = { from: marker(from), to: marker(to), ...NO_TURN }
  const out: Record<string, unknown> = {
    unitId,
    subUnitId: sheet.id,
    drawingId,
    drawingType: 0,
    imageSourceType: 'URL',
    source: image.source,
    transform: { left: round(left), top: round(top), width: round(width), height: round(height), ...NO_TURN },
    sheetTransform: position,
    axisAlignSheetTransform: position,
    anchorType,
  }
  if (image.title) out.title = image.title
  if (image.description) out.description = image.description
  return out
}

/**
 * The document style Univer's cell documents carry (core
 * `createDocumentModelWithStyle`). Univer 1.4.0's cell renderer writes into
 * `pageSize` and reads the margins and `renderConfig`: a cell document without
 * them throws while the sheet is drawn and leaves the whole grid blank (found
 * by the apps/web e2e suite).
 */
export const CELL_DOCUMENT_STYLE = {
  pageSize: { width: null, height: null },
  documentFlavor: 0,
  marginTop: 0,
  marginBottom: 2,
  marginRight: 2,
  marginLeft: 2,
  renderConfig: { horizontalAlign: 0, verticalAlign: 0, centerAngle: 0, vertexAngle: 0, wrapStrategy: 0 },
} as const

/** The cell document Univer's cell-image command writes, for `images` (in order) and no text. */
export function cellImageDocument(images: ReadonlyArray<{ drawingId: string; source: string; width: number; height: number; title?: string; description?: string }>): Record<string, unknown> {
  const n = images.length
  const drawings: Record<string, unknown> = {}
  for (const im of images) {
    drawings[im.drawingId] = {
      unitId: 'd',
      subUnitId: 'd',
      drawingId: im.drawingId,
      drawingType: 0,
      imageSourceType: 'URL',
      source: im.source,
      transform: { left: 0, top: 0, width: im.width, height: im.height },
      docTransform: { size: { width: im.width, height: im.height }, positionH: { relativeFrom: 0, posOffset: 0 }, positionV: { relativeFrom: 0, posOffset: 0 }, angle: 0 },
      behindDoc: 0,
      title: im.title ?? '',
      description: im.description ?? '',
      layoutType: 0,
      wrapText: 0,
      distB: 0,
      distL: 0,
      distR: 0,
      distT: 0,
    }
  }
  // Same layout as Univer's own: an empty paragraph, the pictures, then the end of the document.
  const dataStream = `\r${'\b'.repeat(n)}\r\n`
  return {
    id: 'd',
    documentStyle: CELL_DOCUMENT_STYLE,
    drawings,
    drawingsOrder: images.map((i) => i.drawingId),
    body: {
      dataStream,
      textRuns: [],
      paragraphs: [{ startIndex: 0 }, { startIndex: n + 1 }],
      sectionBreaks: [{ startIndex: n + 2 }],
      customBlocks: images.map((im, i) => ({ startIndex: 1 + i, blockId: im.drawingId })),
    },
  }
}

/** Largest picture size Univer gives an in-cell picture: the cell's box less 2 px (sheets-drawing-ui getDrawingSizeByCell). */
function fitInCell(sheet: Sheet, row: number, column: number, width: number | null, height: number | null): { width: number; height: number } {
  const boxW = Math.max(4, columnWidth(sheet, column) - 2)
  const boxH = Math.max(4, rowHeight(sheet, row) - 2)
  const w = width && width > 0 ? width : boxW
  const h = height && height > 0 ? height : boxH
  const scale = Math.min(boxW / w, boxH / h)
  return { width: round(w * scale), height: round(h * scale) }
}

const skipMessage = (s: SkippedImage): string => {
  switch (s.reason) {
    case 'type':
      return MESSAGES.imageTypeNotTransferred(s.detail ?? '')
    case 'size':
      return MESSAGES.imageTooLarge()
    case 'external':
      return MESSAGES.imageExternal()
    case 'limit':
      return MESSAGES.imageLimit()
    default:
      return MESSAGES.imageMissing()
  }
}

/**
 * Writes `images` into the converted `workbook` (mutates it) and records them
 * in `report`: counts `floatingImages` / `cellImages`, one `converted` item per
 * picture whose placement changed (an absolute picture now moves with nothing,
 * as in the file), and a `not_transferred` item per `skipped` picture.
 */
export function applyImportedImages(
  workbook: IWorkbookData,
  report: ImportReport,
  images: readonly ImportedImage[],
  skipped: readonly SkippedImage[] = [],
): ApplyImagesResult {
  const unitId = workbook.id
  const sheetOf = (gid: number): Sheet | undefined => (workbook.sheets as Record<string, Sheet>)[`sheet-${gid}`]
  const resource: Record<string, { data: Record<string, unknown>; order: string[] }> = {}
  const inCell = new Map<string, Array<Extract<ImportedImage, { kind: 'in_cell' }>>>()
  let floating = 0
  let n = 0
  const nextId = () => `img-${(++n).toString(36).padStart(4, '0')}`

  for (const image of images) {
    const sheet = sheetOf(image.sheetGid)
    if (!sheet) continue
    if (image.kind === 'floating') {
      const id = nextId()
      const entry = (resource[sheet.id] ??= { data: {}, order: [] })
      entry.data[id] = sheetImageOf(unitId, sheet, id, image)
      entry.order.push(id)
      floating++
    } else {
      const key = `${sheet.id}\u0000${image.row}\u0000${image.column}`
      const list = inCell.get(key) ?? []
      list.push(image)
      inCell.set(key, list)
    }
  }

  let cellCount = 0
  for (const list of inCell.values()) {
    const first = list[0] as Extract<ImportedImage, { kind: 'in_cell' }>
    const sheet = sheetOf(first.sheetGid) as Sheet
    const docImages = list.map((im) => ({ drawingId: nextId(), source: im.source, ...fitInCell(sheet, im.row, im.column, im.width, im.height), title: im.title, description: im.description }))
    const cells = (sheet.cellData ??= {}) as Record<number, Record<number, Record<string, unknown>>>
    const line = (cells[first.row] ??= {})
    const current = line[first.column] ?? {}
    // The picture replaces the cell's placeholder value (Excel writes #VALUE! for it); its style stays.
    const next: Record<string, unknown> = { p: cellImageDocument(docImages), t: 1 }
    if (current.s !== undefined) next.s = current.s
    if (current.custom !== undefined) next.custom = current.custom
    line[first.column] = next
    cellCount += list.length
    if (sheet.rowCount !== undefined && sheet.rowCount <= first.row) sheet.rowCount = first.row + 1
  }

  if (Object.keys(resource).length > 0) {
    const resources = (workbook.resources ??= [])
    const existing = resources.find((r) => r.name === SHEET_DRAWING_RESOURCE)
    if (existing) {
      const merged = { ...(JSON.parse(existing.data) as Record<string, unknown>), ...resource }
      existing.data = JSON.stringify(merged)
    } else resources.push({ name: SHEET_DRAWING_RESOURCE, data: JSON.stringify(resource) })
  }

  const counts = report.counts as typeof report.counts & { floatingImages?: number; cellImages?: number }
  counts.floatingImages = (counts.floatingImages ?? 0) + floating
  counts.cellImages = (counts.cellImages ?? 0) + cellCount

  for (const image of images) {
    if (image.kind !== 'floating' || image.anchor.type !== 'absolute') continue
    const sheet = sheetOf(image.sheetGid)
    if (!sheet) continue
    const at = cellAt(sheet, ROW_HEADER_WIDTH + image.anchor.x, COLUMN_HEADER_HEIGHT + image.anchor.y)
    report.items.push(item('drawing_image', 'converted', sheet, at.row, at.column, MESSAGES.imageAbsolute()))
  }
  for (const s of skipped) {
    const sheet = sheetOf(s.sheetGid)
    report.items.push(item(s.kind === 'in_cell' ? 'cell_image' : 'drawing_image', 'not_transferred', sheet ?? null, s.row, s.column, skipMessage(s), s.detail))
  }
  return { floating, inCell: cellCount }
}

function item(kind: ImportReportItem['kind'], outcome: ImportReportItem['outcome'], sheet: Sheet | null, row: number, column: number, message: string, detail?: string): ImportReportItem {
  const out: ImportReportItem = {
    kind,
    outcome,
    location: sheet ? location(sheet.id, sheet.name ?? sheet.id, { startRow: row, endRow: row, startColumn: column, endColumn: column }) : null,
    message,
  }
  if (detail) out.detail = detail
  return out
}
