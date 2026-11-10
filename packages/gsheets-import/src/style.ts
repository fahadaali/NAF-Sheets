// Google CellFormat / TextFormat → Univer IStyleData, and the registry that
// deduplicates identical styles into `IWorkbookData.styles` (spec §7.2:
// "توحيد الأنماط المتكررة").
//
// Field mapping (Google → Univer, see univer-constants.ts for the values):
//   textFormat.fontFamily → ff          textFormat.fontSize (pt) → fs (pt)
//   textFormat.bold → bl                textFormat.italic → it
//   textFormat.strikethrough → st.s     textFormat.underline → ul.s
//   textFormat.foregroundColor(Style) → cl.rgb
//   backgroundColor(Style) → bg.rgb     borders.top/bottom/left/right → bd.t/b/l/r
//   padding → pd                        horizontalAlignment → ht (rtl-open.ts)
//   verticalAlignment → vt              wrapStrategy → tb
//   textDirection → td                  textRotation → tr
//   numberFormat.pattern → n.pattern
// `false` flags are omitted: they equal Univer's defaults, and rich-text runs
// are written fully resolved (rich-text.ts), so nothing inherits them.

import type { IBorderData, IBorderStyleData, IStyleBase, IStyleData, ITextRotation } from '@univerjs/core'
import type { ColorResolver } from './color'
import type { GsBorder, GsCellFormat, GsNumberFormat, GsTextFormat, GsVerticalAlign, GsWrapStrategy } from './google-types'
import { mapHorizontalAlignment, mapLeftRightSides } from './rtl-open'
import { BOOL, BORDER_STYLE, TEXT_DIRECTION, V_ALIGN, WRAP } from './univer-constants'

export interface StyleContext {
  colors: ColorResolver
  sheetIsRtl: boolean
}

export function textFormatToStyle(tf: GsTextFormat | undefined, colors: ColorResolver): IStyleBase {
  const style: IStyleBase = {}
  if (!tf) return style
  // OPEN: OPEN_QUESTIONS.md §2 — font families are copied as given (spec §4.1 uses Thmanyah).
  if (tf.fontFamily) style.ff = tf.fontFamily
  if (typeof tf.fontSize === 'number' && tf.fontSize > 0) style.fs = tf.fontSize
  if (tf.bold) style.bl = BOOL.TRUE
  if (tf.italic) style.it = BOOL.TRUE
  if (tf.strikethrough) style.st = { s: BOOL.TRUE }
  if (tf.underline) style.ul = { s: BOOL.TRUE }
  const fg = colors.resolve(tf.foregroundColorStyle, tf.foregroundColor)
  if (fg) style.cl = { rgb: fg }
  return style
}

/** Merges a run's text format over the cell's: absent run fields inherit (TextFormatRun.format). */
export function mergeTextFormats(cell: GsTextFormat | undefined, run: GsTextFormat | undefined): GsTextFormat {
  const merged: GsTextFormat = { ...(cell ?? {}) }
  if (!run) return merged
  for (const [key, value] of Object.entries(run) as Array<[keyof GsTextFormat, unknown]>) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  // A run that sets either colour field replaces both of the cell's.
  if (run.foregroundColorStyle !== undefined || run.foregroundColor !== undefined) {
    merged.foregroundColorStyle = run.foregroundColorStyle
    merged.foregroundColor = run.foregroundColor
  }
  return merged
}

function mapBorder(border: GsBorder | undefined, colors: ColorResolver): IBorderStyleData | undefined {
  if (!border?.style) return undefined
  const s = (() => {
    switch (border.style) {
      case 'DOTTED':
        return BORDER_STYLE.DOTTED
      case 'DASHED':
        return BORDER_STYLE.DASHED
      case 'SOLID':
        return BORDER_STYLE.THIN
      case 'SOLID_MEDIUM':
        return BORDER_STYLE.MEDIUM
      case 'SOLID_THICK':
        return BORDER_STYLE.THICK
      case 'DOUBLE':
        return BORDER_STYLE.DOUBLE
      default:
        return undefined // NONE, STYLE_UNSPECIFIED
    }
  })()
  if (s === undefined) return undefined
  // No colour at all means black: an omitted Color is all-zero (proto3).
  const rgb = colors.resolve(border.colorStyle, border.color) ?? '#000000'
  return { s, cl: { rgb } }
}

function mapVertical(v: GsVerticalAlign | undefined) {
  switch (v) {
    case 'TOP':
      return V_ALIGN.TOP
    case 'MIDDLE':
      return V_ALIGN.MIDDLE
    case 'BOTTOM':
      return V_ALIGN.BOTTOM
    default:
      return undefined
  }
}

function mapWrap(w: GsWrapStrategy | undefined) {
  switch (w) {
    case 'OVERFLOW_CELL':
      return WRAP.OVERFLOW
    case 'CLIP':
      return WRAP.CLIP
    // LEGACY_WRAP clips over-long words instead of breaking them; Univer has
    // one wrap mode, and wrapping is closer than clipping the whole line.
    case 'LEGACY_WRAP':
    case 'WRAP':
      return WRAP.WRAP
    default:
      return undefined
  }
}

/**
 * Number format to write: the user-entered one, else the effective one
 * (which carries the computed format of formula cells — CellData.effectiveFormat).
 * A format without a pattern returns `missingPattern`: Google then uses a
 * locale default the response does not state.
 * OPEN: OPEN_QUESTIONS.md §12 — Google patterns are written unchanged.
 */
export function pickNumberFormat(
  userEntered: GsNumberFormat | undefined,
  effective: GsNumberFormat | undefined,
): { pattern: string } | { missingPattern: GsNumberFormat } | null {
  const chosen = userEntered ?? effective
  if (!chosen) return null
  if (chosen.pattern) return { pattern: chosen.pattern }
  if (userEntered && effective?.pattern && (!userEntered.type || userEntered.type === effective.type)) return { pattern: effective.pattern }
  if (!chosen.type || chosen.type === 'NUMBER_FORMAT_TYPE_UNSPECIFIED') return null
  return { missingPattern: chosen }
}

/** Cell format → style; null when nothing is set. `numberPattern` comes from {@link pickNumberFormat}. */
export function cellFormatToStyle(fmt: GsCellFormat | undefined, numberPattern: string | null, ctx: StyleContext): IStyleData | null {
  const style: IStyleData = { ...textFormatToStyle(fmt?.textFormat, ctx.colors) }
  if (fmt) {
    const bg = ctx.colors.resolve(fmt.backgroundColorStyle, fmt.backgroundColor)
    if (bg) style.bg = { rgb: bg }

    if (fmt.borders) {
      const bd: IBorderData = {}
      const t = mapBorder(fmt.borders.top, ctx.colors)
      const b = mapBorder(fmt.borders.bottom, ctx.colors)
      const sides = mapLeftRightSides(mapBorder(fmt.borders.left, ctx.colors), mapBorder(fmt.borders.right, ctx.colors), ctx.sheetIsRtl)
      if (t) bd.t = t
      if (b) bd.b = b
      if (sides.l) bd.l = sides.l
      if (sides.r) bd.r = sides.r
      if (Object.keys(bd).length > 0) style.bd = bd
    }

    if (fmt.padding) {
      const sides = mapLeftRightSides(fmt.padding.left, fmt.padding.right, ctx.sheetIsRtl)
      const pd: NonNullable<IStyleData['pd']> = {}
      if (typeof fmt.padding.top === 'number') pd.t = fmt.padding.top
      if (typeof fmt.padding.bottom === 'number') pd.b = fmt.padding.bottom
      if (typeof sides.l === 'number') pd.l = sides.l
      if (typeof sides.r === 'number') pd.r = sides.r
      if (Object.keys(pd).length > 0) style.pd = pd
    }

    const ht = mapHorizontalAlignment(fmt.horizontalAlignment, ctx.sheetIsRtl)
    if (ht !== undefined) style.ht = ht
    const vt = mapVertical(fmt.verticalAlignment)
    if (vt !== undefined) style.vt = vt
    const tb = mapWrap(fmt.wrapStrategy)
    if (tb !== undefined) style.tb = tb

    if (fmt.textDirection === 'LEFT_TO_RIGHT') style.td = TEXT_DIRECTION.LEFT_TO_RIGHT
    else if (fmt.textDirection === 'RIGHT_TO_LEFT') style.td = TEXT_DIRECTION.RIGHT_TO_LEFT

    if (fmt.textRotation) {
      // OPEN: OPEN_QUESTIONS.md §1 — Google: positive angles turn counter-clockwise
      // for LTR text and clockwise for RTL text. Written as given.
      let tr: ITextRotation | undefined
      if (fmt.textRotation.vertical) tr = { a: 0, v: BOOL.TRUE }
      else if (typeof fmt.textRotation.angle === 'number' && fmt.textRotation.angle !== 0) tr = { a: fmt.textRotation.angle }
      if (tr) style.tr = tr
    }
  }
  if (numberPattern) style.n = { pattern: numberPattern }
  return Object.keys(style).length > 0 ? style : null
}

/** JSON with sorted keys and without undefined values: equal styles give equal keys. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** Deduplicates styles across the workbook; ids are `gs1`, `gs2`… in order of first use. */
export class StyleRegistry {
  private readonly ids = new Map<string, string>()
  readonly styles: Record<string, IStyleData> = {}

  register(style: IStyleData): string {
    const key = stableStringify(style)
    const existing = this.ids.get(key)
    if (existing) return existing
    const id = `gs${this.ids.size + 1}`
    this.ids.set(key, id)
    this.styles[id] = style
    return id
  }

  get size(): number {
    return this.ids.size
  }
}
