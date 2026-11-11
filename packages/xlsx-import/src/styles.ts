// styles.xml (ECMA-376 Part 1 §18.8) → the Google CellFormat of the
// intermediate model, one per cell style (`cellXfs` index), and the
// differential formats (`dxfs`) that conditional formats and table styles use.
//
// Defaults, normalised by origin the way the Google API reports a cell: the
// API's `userEnteredFormat` holds only what a person set, so the reader drops
// what equals the workbook's default font (the `Normal` style's font: Calibri
// 11 or Aptos Narrow 11 in Excel, Arial 10 in a Google export) — family, size
// and colour — and keeps every difference. Unformatted cells then look the
// same whatever program wrote the file, and the grid's own font applies.
// The default font is recorded in the import report.
//
// Alignment is written as given (logical; CLAUDE.md §2): `left` stays LEFT,
// which the platform shows at the start of the line (the right on an RTL
// sheet), exactly as the Google path does (gsheets-import rtl-open.ts).

import type { GsBorder, GsBorderStyle, GsCellFormat, GsNumberFormat, GsTextFormat } from '@naf-sheets/gsheets-import'
import type { XlsxColors } from './colors'
import { numberFormatFor } from './numfmt'
import { child, children, type XmlNode } from './xml'

export interface DefaultFont {
  family: string | null
  size: number | null
  color: string | null
}

export interface CellStyle {
  /** Null when the style sets nothing beyond the defaults. */
  format: GsCellFormat | null
  numberFormat: GsNumberFormat | null
  /** For the 1904 shift and date detection: the code the cell is shown with. */
  numberPattern: string | null
  /** `quotePrefix="1"`: the value was typed with a leading apostrophe. */
  quotePrefix: boolean
}

export interface StyleSheet {
  cellStyles: CellStyle[]
  dxfs: Array<GsCellFormat | null>
  defaultFont: DefaultFont
  /** Custom table styles by name: header and stripe fills (Google writes one per table). */
  tableStyles: Map<string, { header: string | null; first: string | null; second: string | null }>
  /** Patterned fills (other than solid) that were written as their foreground colour. */
  patternFills: number
}

const BORDER_STYLES: Record<string, GsBorderStyle> = {
  thin: 'SOLID',
  hair: 'DOTTED',
  dotted: 'DOTTED',
  dashed: 'DASHED',
  dashDot: 'DASHED',
  dashDotDot: 'DASHED',
  medium: 'SOLID_MEDIUM',
  mediumDashed: 'DASHED',
  mediumDashDot: 'DASHED',
  mediumDashDotDot: 'DASHED',
  slantDashDot: 'DASHED',
  thick: 'SOLID_THICK',
  double: 'DOUBLE',
}

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 }
}

/** A boolean element such as <b/>, <b val="1"/>, <b val="0"/>. */
function flag(node: XmlNode | undefined): boolean | undefined {
  if (!node) return undefined
  const v = node.attrs.val
  return v === undefined || v === '1' || v === 'true'
}

interface FontInfo {
  family?: string
  size?: number
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  color: string | null
}

export function readFont(font: XmlNode | undefined, colors: XlsxColors): FontInfo {
  const info: FontInfo = { color: colors.resolve(child(font, 'color')) }
  const name = child(font, 'name')?.attrs.val ?? child(font, 'rFont')?.attrs.val
  if (name) info.family = name
  const sz = Number(child(font, 'sz')?.attrs.val)
  if (Number.isFinite(sz) && sz > 0) info.size = sz
  const b = flag(child(font, 'b'))
  if (b !== undefined) info.bold = b
  const i = flag(child(font, 'i'))
  if (i !== undefined) info.italic = i
  const s = flag(child(font, 'strike'))
  if (s !== undefined) info.strike = s
  const u = child(font, 'u')
  if (u) info.underline = (u.attrs.val ?? 'single') !== 'none'
  return info
}

/** A font as a Google TextFormat, without what equals the default font. */
export function fontToTextFormat(font: FontInfo, defaults: DefaultFont): GsTextFormat | undefined {
  const tf: GsTextFormat = {}
  if (font.family && font.family !== defaults.family) tf.fontFamily = font.family
  if (font.size !== undefined && font.size !== defaults.size) tf.fontSize = font.size
  if (font.bold) tf.bold = true
  if (font.italic) tf.italic = true
  if (font.strike) tf.strikethrough = true
  if (font.underline) tf.underline = true
  if (font.color && font.color !== defaults.color) tf.foregroundColorStyle = { rgbColor: rgb(font.color) }
  return Object.keys(tf).length > 0 ? tf : undefined
}

function readBorder(side: XmlNode | undefined, colors: XlsxColors): GsBorder | undefined {
  const style = side?.attrs.style
  if (!style || style === 'none') return undefined
  const mapped = BORDER_STYLES[style]
  if (!mapped) return undefined
  const color = colors.resolve(child(side, 'color')) ?? '#000000'
  return { style: mapped, colorStyle: { rgbColor: rgb(color) } }
}

/** Fill colour of a <fill>. In a dxf a solid fill's colour is in bgColor (§18.8.32 note); elsewhere fgColor. */
function readFill(fill: XmlNode | undefined, colors: XlsxColors, differential: boolean): { color: string | null; patterned: boolean } {
  const pattern = child(fill, 'patternFill')
  if (pattern) {
    const type = pattern.attrs.patternType ?? (differential ? 'solid' : 'none')
    if (type === 'none') return { color: null, patterned: false }
    const fg = colors.resolve(child(pattern, 'fgColor'))
    const bg = colors.resolve(child(pattern, 'bgColor'))
    const color = differential ? (bg ?? fg) : (fg ?? bg)
    return { color, patterned: type !== 'solid' && color !== null }
  }
  const gradient = child(fill, 'gradientFill')
  if (gradient) {
    // OPEN: G26 — a gradient becomes its first stop's colour.
    const stop = child(gradient, 'stop')
    return { color: colors.resolve(child(stop, 'color')), patterned: true }
  }
  return { color: null, patterned: false }
}

function alignmentInto(format: GsCellFormat, alignment: XmlNode | undefined): void {
  if (!alignment) return
  const a = alignment.attrs
  switch (a.horizontal) {
    case 'left':
      format.horizontalAlignment = 'LEFT'
      break
    case 'center':
    case 'centerContinuous':
      format.horizontalAlignment = 'CENTER'
      break
    case 'right':
      format.horizontalAlignment = 'RIGHT'
      break
    default:
      // general, fill, justify, distributed: the default alignment (by value type).
      break
  }
  switch (a.vertical) {
    case 'top':
      format.verticalAlignment = 'TOP'
      break
    case 'center':
    case 'justify':
    case 'distributed':
      format.verticalAlignment = 'MIDDLE'
      break
    case 'bottom':
      format.verticalAlignment = 'BOTTOM'
      break
    default:
      break
  }
  if (a.wrapText === '1' || a.wrapText === 'true') format.wrapStrategy = 'WRAP'
  if (a.readingOrder === '1') format.textDirection = 'LEFT_TO_RIGHT'
  else if (a.readingOrder === '2') format.textDirection = 'RIGHT_TO_LEFT'
  const rotation = Number(a.textRotation)
  if (rotation === 255) format.textRotation = { vertical: true }
  else if (Number.isFinite(rotation) && rotation > 0 && rotation <= 90) format.textRotation = { angle: rotation }
  else if (Number.isFinite(rotation) && rotation > 90 && rotation <= 180) format.textRotation = { angle: 90 - rotation }
}

export function readStyleSheet(styles: XmlNode | null, colors: XlsxColors): StyleSheet {
  const root = styles ?? undefined
  const customFormats = new Map<number, string>()
  for (const nf of children(child(root, 'numFmts'), 'numFmt')) {
    const id = Number(nf.attrs.numFmtId)
    if (Number.isInteger(id) && nf.attrs.formatCode !== undefined) customFormats.set(id, nf.attrs.formatCode)
  }
  const fontNodes = children(child(root, 'fonts'), 'font')
  const fillNodes = children(child(root, 'fills'), 'fill')
  const borderNodes = children(child(root, 'borders'), 'border')
  const styleXfs = children(child(root, 'cellStyleXfs'), 'xf')
  const normalFontId = Number(styleXfs[0]?.attrs.fontId ?? 0)
  const normal = readFont(fontNodes[normalFontId] ?? fontNodes[0], colors)
  const defaultFont: DefaultFont = { family: normal.family ?? null, size: normal.size ?? null, color: normal.color ?? '#000000' }

  let patternFills = 0
  const fontCache = new Map<number, GsTextFormat | undefined>()
  const fontFormat = (id: number) => {
    if (!fontCache.has(id)) {
      const node = fontNodes[id]
      // Google writes empty <font/> elements: they mean the default font.
      fontCache.set(id, node ? fontToTextFormat(readFont(node, colors), defaultFont) : undefined)
    }
    return fontCache.get(id)
  }

  const cellStyles: CellStyle[] = children(child(root, 'cellXfs'), 'xf').map((xf) => {
    const a = xf.attrs
    const format: GsCellFormat = {}
    const tf = fontFormat(Number(a.fontId ?? 0))
    if (tf) format.textFormat = { ...tf }
    const fill = readFill(fillNodes[Number(a.fillId ?? 0)], colors, false)
    if (fill.color) {
      format.backgroundColorStyle = { rgbColor: rgb(fill.color) }
      if (fill.patterned) patternFills++
    }
    const border = borderNodes[Number(a.borderId ?? 0)]
    if (border) {
      const borders: NonNullable<GsCellFormat['borders']> = {}
      const top = readBorder(child(border, 'top'), colors)
      const bottom = readBorder(child(border, 'bottom'), colors)
      // `start`/`end` are the strict-schema names of left/right.
      const left = readBorder(child(border, 'left') ?? child(border, 'start'), colors)
      const right = readBorder(child(border, 'right') ?? child(border, 'end'), colors)
      if (top) borders.top = top
      if (bottom) borders.bottom = bottom
      if (left) borders.left = left
      if (right) borders.right = right
      if (Object.keys(borders).length > 0) format.borders = borders
    }
    alignmentInto(format, child(xf, 'alignment'))
    const numberFormat = numberFormatFor(Number(a.numFmtId ?? 0), customFormats)
    if (numberFormat) format.numberFormat = numberFormat
    return {
      format: Object.keys(format).length > 0 ? format : null,
      numberFormat,
      numberPattern: numberFormat?.pattern ?? null,
      quotePrefix: a.quotePrefix === '1' || a.quotePrefix === 'true',
    }
  })

  const dxfs = children(child(root, 'dxfs'), 'dxf').map((dxf): GsCellFormat | null => {
    const format: GsCellFormat = {}
    const fontNode = child(dxf, 'font')
    if (fontNode) {
      // A dxf font states only what the rule changes: nothing is dropped as a default.
      const f = readFont(fontNode, colors)
      const tf: GsTextFormat = {}
      if (f.bold) tf.bold = true
      if (f.italic) tf.italic = true
      if (f.strike) tf.strikethrough = true
      if (f.underline) tf.underline = true
      if (f.color) tf.foregroundColorStyle = { rgbColor: rgb(f.color) }
      if (Object.keys(tf).length > 0) format.textFormat = tf
    }
    const fill = readFill(child(dxf, 'fill'), colors, true)
    if (fill.color) format.backgroundColorStyle = { rgbColor: rgb(fill.color) }
    const nf = child(dxf, 'numFmt')
    if (nf?.attrs.formatCode) format.numberFormat = { pattern: nf.attrs.formatCode }
    return Object.keys(format).length > 0 ? format : null
  })

  const tableStyles = new Map<string, { header: string | null; first: string | null; second: string | null }>()
  for (const ts of children(child(root, 'tableStyles'), 'tableStyle')) {
    const name = ts.attrs.name
    if (!name) continue
    const fillOf = (type: string) => {
      const el = children(ts, 'tableStyleElement').find((e) => e.attrs.type === type)
      const dxf = el ? dxfs[Number(el.attrs.dxfId)] : null
      const c = dxf?.backgroundColorStyle?.rgbColor
      if (!c) return null
      const h = (v: number | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0')
      return `#${h(c.red)}${h(c.green)}${h(c.blue)}`
    }
    tableStyles.set(name, { header: fillOf('headerRow'), first: fillOf('firstRowStripe'), second: fillOf('secondRowStripe') })
  }

  return { cellStyles, dxfs, defaultFont, tableStyles, patternFills }
}

export { rgb as hexToGsColor }
