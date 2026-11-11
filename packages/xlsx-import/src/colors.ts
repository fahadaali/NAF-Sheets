// SpreadsheetML colours (ECMA-376 Part 1 §18.8.19 CT_Color) to `#rrggbb`.
//
//   rgb="AARRGGBB"   explicit (Google's export writes these, and Excel for custom colours)
//   theme="n"        index into the theme's colour scheme, optionally with `tint`
//   indexed="n"      the legacy 64-colour palette, or the file's own <indexedColors>
//   auto="1"         the application's automatic colour: treated as "not set"
//
// Theme index order: Excel maps 0 → lt1, 1 → dk1, 2 → lt2, 3 → dk2 (the dark
// and light pairs swapped relative to <a:clrScheme>'s element order), then
// accent1–6, hlink, folHlink. Verified on a real Google export (font
// `theme="1"` is body text, `theme="0"` white header text; theme part
// `name="Sheets"`, dk1 000000 / lt1 FFFFFF).
//
// Tint (§18.8.19 "tint"): the colour is converted to HLS and its luminance
// moved towards black (tint < 0: L × (1 + tint)) or white
// (tint > 0: L × (1 − tint) + tint), the way Excel applies it.

import { child, type XmlNode } from './xml'

/** The default legacy palette, indexes 0–63 (64 = system foreground, 65 = system background). */
export const DEFAULT_INDEXED_COLORS: readonly string[] = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
]

/** Theme slots in `theme="n"` order. */
const THEME_SLOTS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const

/** The Office default scheme, used when a file references theme colours but carries no theme part. */
const OFFICE_DEFAULT_THEME: readonly string[] = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72']

export interface ThemeInfo {
  /** `#rrggbb` per theme index. */
  colors: string[]
  /** Whether the colours came from the file (false: Office defaults). */
  fromFile: boolean
  /** <a:theme name="…">: "Sheets" for Google exports, "Office Theme" for Excel. */
  name: string | null
  /** Minor (body) Latin font, e.g. Calibri, Aptos Narrow, Arial. */
  minorFont: string | null
}

export function readTheme(theme: XmlNode | null): ThemeInfo {
  const elements = child(theme ?? undefined, 'themeElements')
  const scheme = child(elements, 'clrScheme')
  const colors: string[] = []
  let fromFile = false
  THEME_SLOTS.forEach((slot, i) => {
    const node = child(scheme, slot)
    const srgb = child(node, 'srgbClr')?.attrs.val
    const sys = child(node, 'sysClr')
    const hex = srgb ?? sys?.attrs.lastClr
    if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) {
      colors.push(`#${hex.toLowerCase()}`)
      fromFile = true
    } else colors.push(`#${(OFFICE_DEFAULT_THEME[i] as string).toLowerCase()}`)
  })
  const minor = child(child(child(elements, 'fontScheme'), 'minorFont'), 'latin')?.attrs.typeface ?? null
  return { colors, fromFile, name: theme?.attrs.name ?? null, minorFont: minor }
}

export function readIndexedPalette(styles: XmlNode | null): string[] {
  const custom = child(child(child(styles ?? undefined, 'colors'), 'indexedColors'), 'rgbColor') ? child(child(styles ?? undefined, 'colors'), 'indexedColors') : undefined
  const palette = DEFAULT_INDEXED_COLORS.map((c) => `#${c.toLowerCase()}`)
  if (custom) {
    custom.children
      .filter((c) => c.name === 'rgbColor')
      .forEach((c, i) => {
        const rgb = c.attrs.rgb
        if (rgb && /^[0-9a-fA-F]{8}$/.test(rgb)) palette[i] = `#${rgb.slice(2).toLowerCase()}`
      })
  }
  return palette
}

function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, l, 0]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, l, s]
}

function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
}

/** Applies an Excel tint (−1..1) to `#rrggbb`. */
export function applyTint(hex: string, tint: number): string {
  if (!Number.isFinite(tint) || tint === 0) return hex
  const n = Number.parseInt(hex.slice(1), 16)
  const [h, l, s] = rgbToHls(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
  const t = Math.max(-1, Math.min(1, tint))
  const lum = t < 0 ? l * (1 + t) : l * (1 - t) + t
  const [r, g, b] = hlsToRgb(h, lum, s)
  const ch = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

export class XlsxColors {
  readonly theme: ThemeInfo
  readonly indexed: string[]
  /** Set when a colour referenced the theme but the file had no theme part. */
  usedDefaultTheme = false

  constructor(theme: ThemeInfo, indexed: string[]) {
    this.theme = theme
    this.indexed = indexed
  }

  /** `#rrggbb` for a CT_Color element, or null for none / automatic. */
  resolve(node: XmlNode | undefined): string | null {
    if (!node) return null
    const a = node.attrs
    let hex: string | null = null
    if (a.rgb && /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(a.rgb)) {
      // AARRGGBB; Excel and Google write alpha FF. Alpha is ignored (Univer stores #rrggbb).
      hex = `#${(a.rgb.length === 8 ? a.rgb.slice(2) : a.rgb).toLowerCase()}`
    } else if (a.theme !== undefined && /^\d+$/.test(a.theme)) {
      const i = Number(a.theme)
      hex = this.theme.colors[i] ?? null
      if (hex && !this.theme.fromFile) this.usedDefaultTheme = true
    } else if (a.indexed !== undefined && /^\d+$/.test(a.indexed)) {
      const i = Number(a.indexed)
      if (i === 64) hex = '#000000'
      else if (i === 65) hex = '#ffffff'
      else hex = this.indexed[i] ?? null
    } else if (a.auto === '1' || a.auto === 'true') {
      return null
    }
    if (!hex) return null
    const tint = a.tint !== undefined ? Number(a.tint) : 0
    return applyTint(hex, tint)
  }
}
