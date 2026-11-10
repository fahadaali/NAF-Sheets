// Google Color / ColorStyle to the `#rrggbb` strings Univer stores
// (`IColorStyle.rgb`; docs.univer.ai sheets/model/cell-data warns against
// rgba). Google components are fractions in [0, 1]; an omitted component is
// 0, so `{}` is black. Alpha is dropped: the API reference says alpha "isn't
// generally supported" for ColorStyle.rgbColor.

import type { GsColor, GsColorStyle, GsSpreadsheetTheme, GsThemeColorType } from './google-types'

export function colorToHex(color: GsColor): string {
  const channel = (v: number | undefined) => {
    // Math.round, not floor: the API returns n/255 as a float (0.8509804 for 217).
    const n = Math.round(Math.min(1, Math.max(0, v ?? 0)) * 255)
    return n.toString(16).padStart(2, '0')
  }
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`
}

/** `#rrggbb` → `rgb(r,g,b)`, the form sheets-filter compares fill and text colours in (ColorKit.toRgbString). */
export function hexToRgbString(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`
}

/** Resolves theme colours through the spreadsheet theme and remembers the ones it could not. */
export class ColorResolver {
  private readonly theme = new Map<GsThemeColorType, string>()
  /** Theme colour types that had no concrete colour in the spreadsheet theme. */
  readonly unresolved = new Set<GsThemeColorType>()

  constructor(theme: GsSpreadsheetTheme | undefined) {
    for (const pair of theme?.themeColors ?? []) {
      if (pair.colorType && pair.color?.rgbColor) this.theme.set(pair.colorType, colorToHex(pair.color.rgbColor))
    }
  }

  /**
   * The `…Style` field takes precedence over the deprecated plain colour
   * (stated for every such pair in the API reference). A theme colour the
   * spreadsheet theme does not define falls back to the plain colour when the
   * response carries one. Returns null when nothing usable is set.
   */
  resolve(style: GsColorStyle | undefined, legacy?: GsColor): string | null {
    if (style?.rgbColor) return colorToHex(style.rgbColor)
    if (style?.themeColor) {
      const hex = this.theme.get(style.themeColor)
      if (hex) return hex
      if (legacy) return colorToHex(legacy)
      this.unresolved.add(style.themeColor)
      return null
    }
    if (legacy) return colorToHex(legacy)
    return null
  }
}
