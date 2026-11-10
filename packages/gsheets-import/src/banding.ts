// Google BandedRange (alternating colours) → static background fills
// (spec §7.2: "bandedRanges تُحوَّل لتعبئة ثابتة إن أمكن").
//
// Colour per cell follows BandingProperties in the API reference:
//   - header colour on the first row/column, footer colour on the last, else
//     first/second band alternating (starting after the header when set);
//   - with both row and column properties: row header/footer > column
//     header/footer > row first band > column first band > row second band >
//     column second band ("the first row color takes priority over the first
//     column color, but the first column color takes priority over the second
//     row color … the column header takes priority over the first row color if
//     the row header is not set").
// A cell's own background wins over the band colour.
// OPEN: OPEN_QUESTIONS.md §5 — that precedence is not stated in the API reference.

import type { IRange } from '@univerjs/core'
import type { ColorResolver } from './color'
import type { GsBandingProperties } from './google-types'

interface ResolvedBanding {
  header: string | null
  first: string | null
  second: string | null
  footer: string | null
}

type BandKind = 'edge' | 'first' | 'second'

function resolveBanding(p: GsBandingProperties | undefined, colors: ColorResolver): ResolvedBanding | null | 'unresolved' {
  if (!p) return null
  const header = colors.resolve(p.headerColorStyle, p.headerColor)
  const first = colors.resolve(p.firstBandColorStyle, p.firstBandColor)
  const second = colors.resolve(p.secondBandColorStyle, p.secondBandColor)
  const footer = colors.resolve(p.footerColorStyle, p.footerColor)
  const declared = (style: unknown, legacy: unknown) => style !== undefined || legacy !== undefined
  // A declared colour that does not resolve (unknown theme colour) makes the banding unusable.
  if (
    (declared(p.headerColorStyle, p.headerColor) && !header) ||
    (declared(p.firstBandColorStyle, p.firstBandColor) && !first) ||
    (declared(p.secondBandColorStyle, p.secondBandColor) && !second) ||
    (declared(p.footerColorStyle, p.footerColor) && !footer)
  ) {
    return 'unresolved'
  }
  return { header, first, second, footer }
}

function bandColor(b: ResolvedBanding, index: number, count: number): { color: string | null; kind: BandKind } {
  if (b.header && index === 0) return { color: b.header, kind: 'edge' }
  if (b.footer && index === count - 1) return { color: b.footer, kind: 'edge' }
  const offset = b.header ? index - 1 : index
  return offset % 2 === 0 ? { color: b.first, kind: 'first' } : { color: b.second, kind: 'second' }
}

const RANK: Record<string, number> = { 'row:edge': 0, 'col:edge': 1, 'row:first': 2, 'col:first': 3, 'row:second': 4, 'col:second': 5 }

/** Static fills for one banded range, or 'unresolved' when a declared colour cannot be read. */
export function bandedFills(
  range: IRange,
  rowProps: GsBandingProperties | undefined,
  columnProps: GsBandingProperties | undefined,
  colors: ColorResolver,
): Map<string, string> | 'unresolved' {
  const rows = resolveBanding(rowProps, colors)
  const cols = resolveBanding(columnProps, colors)
  if (rows === 'unresolved' || cols === 'unresolved') return 'unresolved'
  const fills = new Map<string, string>()
  const rowCount = range.endRow - range.startRow + 1
  const colCount = range.endColumn - range.startColumn + 1
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startColumn; c <= range.endColumn; c++) {
      const candidates: Array<{ color: string; rank: number }> = []
      if (rows) {
        const band = bandColor(rows, r - range.startRow, rowCount)
        if (band.color) candidates.push({ color: band.color, rank: RANK[`row:${band.kind}`] as number })
      }
      if (cols) {
        const band = bandColor(cols, c - range.startColumn, colCount)
        if (band.color) candidates.push({ color: band.color, rank: RANK[`col:${band.kind}`] as number })
      }
      candidates.sort((a, b) => a.rank - b.rank)
      const best = candidates[0]
      if (best) fills.set(`${r}:${c}`, best.color)
    }
  }
  return fills
}
