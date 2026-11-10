import { describe, expect, it } from 'vitest'
import { colorToHex, ColorResolver, hexToRgbString } from '../src/color'
import { cellFormatToStyle, mergeTextFormats, pickNumberFormat, stableStringify, StyleRegistry, textFormatToStyle } from '../src/style'
import { convertSpreadsheet } from '../src'
import { cellOf, oneSheet, str, styleOf } from './helpers/build'

const ctx = (theme?: ConstructorParameters<typeof ColorResolver>[0]) => ({ colors: new ColorResolver(theme), sheetIsRtl: true })

describe('colours', () => {
  it('converts fractions to #rrggbb, rounding the API floats', () => {
    expect(colorToHex({ red: 0.8509804, green: 0.91764706, blue: 0.827451 })).toBe('#d9ead3')
    expect(colorToHex({ red: 1, green: 1, blue: 1 })).toBe('#ffffff')
    // Omitted components are 0 (proto3): an empty Color is black.
    expect(colorToHex({})).toBe('#000000')
  })

  it('writes the rgb() form the filter compares', () => {
    expect(hexToRgbString('#1b4b5a')).toBe('rgb(27,75,90)')
  })

  it('prefers the …Style field, resolves theme colours, falls back to the plain colour', () => {
    const colors = new ColorResolver({ themeColors: [{ colorType: 'ACCENT1', color: { rgbColor: { red: 1 } } }] })
    expect(colors.resolve({ rgbColor: { blue: 1 } }, { red: 1 })).toBe('#0000ff')
    expect(colors.resolve({ themeColor: 'ACCENT1' })).toBe('#ff0000')
    expect(colors.resolve({ themeColor: 'ACCENT2' }, { green: 1 })).toBe('#00ff00')
    expect(colors.resolve(undefined, { green: 1 })).toBe('#00ff00')
    expect(colors.unresolved.size).toBe(0)
  })

  it('remembers theme colours it cannot resolve', () => {
    const colors = new ColorResolver(undefined)
    expect(colors.resolve({ themeColor: 'ACCENT3' })).toBeNull()
    expect([...colors.unresolved]).toEqual(['ACCENT3'])
  })
})

describe('cell format → IStyleData', () => {
  it('maps every §7.2 format field', () => {
    const style = cellFormatToStyle(
      {
        backgroundColorStyle: { rgbColor: { red: 1, green: 1 } },
        borders: {
          top: { style: 'SOLID', colorStyle: { rgbColor: { red: 1 } } },
          bottom: { style: 'SOLID_THICK' },
          left: { style: 'DASHED', color: { blue: 1 } },
          right: { style: 'NONE' },
        },
        padding: { top: 2, right: 3, bottom: 4, left: 5 },
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'TOP',
        wrapStrategy: 'WRAP',
        textDirection: 'RIGHT_TO_LEFT',
        textRotation: { angle: 45 },
        textFormat: { fontFamily: 'Thmanyah Sans', fontSize: 12, bold: true, italic: true, strikethrough: true, underline: true, foregroundColorStyle: { rgbColor: { green: 0.5 } } },
      },
      '#,##0.00',
      ctx(),
    )
    expect(style).toEqual({
      ff: 'Thmanyah Sans',
      fs: 12,
      bl: 1,
      it: 1,
      st: { s: 1 },
      ul: { s: 1 },
      cl: { rgb: '#008000' },
      bg: { rgb: '#ffff00' },
      bd: { t: { s: 1, cl: { rgb: '#ff0000' } }, b: { s: 13, cl: { rgb: '#000000' } }, l: { s: 4, cl: { rgb: '#0000ff' } } },
      pd: { t: 2, b: 4, l: 5, r: 3 },
      ht: 2,
      vt: 1,
      tb: 3,
      td: 2,
      tr: { a: 45 },
      n: { pattern: '#,##0.00' },
    })
  })

  it('maps every border style and wrap strategy', () => {
    const border = (style: 'DOTTED' | 'DASHED' | 'SOLID' | 'SOLID_MEDIUM' | 'SOLID_THICK' | 'DOUBLE') =>
      cellFormatToStyle({ borders: { top: { style } } }, null, ctx())?.bd?.t?.s
    expect(['DOTTED', 'DASHED', 'SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'DOUBLE'].map((s) => border(s as never))).toEqual([3, 4, 1, 8, 13, 7])
    const wrap = (w: 'OVERFLOW_CELL' | 'CLIP' | 'WRAP' | 'LEGACY_WRAP') => cellFormatToStyle({ wrapStrategy: w }, null, ctx())?.tb
    expect([wrap('OVERFLOW_CELL'), wrap('CLIP'), wrap('WRAP'), wrap('LEGACY_WRAP')]).toEqual([1, 2, 3, 3])
    expect(cellFormatToStyle({ verticalAlignment: 'MIDDLE' }, null, ctx())?.vt).toBe(2)
    expect(cellFormatToStyle({ verticalAlignment: 'BOTTOM' }, null, ctx())?.vt).toBe(3)
    expect(cellFormatToStyle({ textRotation: { vertical: true } }, null, ctx())?.tr).toEqual({ a: 0, v: 1 })
  })

  it('omits false flags and returns null for an empty format', () => {
    expect(cellFormatToStyle({ textFormat: { bold: false, italic: false } }, null, ctx())).toBeNull()
    expect(cellFormatToStyle(undefined, null, ctx())).toBeNull()
  })

  it('merges a run format over the cell format', () => {
    const merged = mergeTextFormats({ bold: true, fontSize: 10, foregroundColor: { red: 1 } }, { italic: true, foregroundColorStyle: { rgbColor: { blue: 1 } } })
    expect(textFormatToStyle(merged, new ColorResolver(undefined))).toEqual({ fs: 10, bl: 1, it: 1, cl: { rgb: '#0000ff' } })
  })
})

describe('number formats', () => {
  it('uses the user-entered pattern, else the effective one', () => {
    expect(pickNumberFormat({ type: 'DATE', pattern: 'yyyy-mm-dd' }, undefined)).toEqual({ pattern: 'yyyy-mm-dd' })
    // Formula cells: the effective format carries the computed number format.
    expect(pickNumberFormat(undefined, { type: 'DATE', pattern: 'dd/mm/yyyy' })).toEqual({ pattern: 'dd/mm/yyyy' })
    expect(pickNumberFormat({ type: 'DATE' }, { type: 'DATE', pattern: 'd mmmm yyyy' })).toEqual({ pattern: 'd mmmm yyyy' })
  })

  it('reports a type without any pattern', () => {
    expect(pickNumberFormat({ type: 'CURRENCY' }, undefined)).toEqual({ missingPattern: { type: 'CURRENCY' } })
    expect(pickNumberFormat(undefined, undefined)).toBeNull()
  })

  it('reports it in the import report with the cell range', () => {
    const { report } = convertSpreadsheet(oneSheet([[str('x', { userEnteredFormat: { numberFormat: { type: 'PERCENT' } } })]]))
    expect(report.items).toContainEqual(expect.objectContaining({ kind: 'number_format', outcome: 'not_transferred', location: expect.objectContaining({ ref: "'ورقة1'!A1" }) }))
  })
})

describe('style deduplication (spec §7.2 "توحيد الأنماط المتكررة")', () => {
  it('gives equal styles one id regardless of key order', () => {
    const registry = new StyleRegistry()
    const a = registry.register({ bl: 1, bg: { rgb: '#ffffff' } })
    const b = registry.register({ bg: { rgb: '#ffffff' }, bl: 1 })
    const c = registry.register({ bl: 1 })
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(registry.size).toBe(2)
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}')
  })

  it('shares one style across cells in the workbook', () => {
    const bold = { userEnteredFormat: { textFormat: { bold: true } } }
    const { workbook } = convertSpreadsheet(oneSheet([[str('أ', bold), str('ب', bold), str('ج')]]))
    const a = cellOf(workbook, 'sheet-0', 0, 0)
    const b = cellOf(workbook, 'sheet-0', 0, 1)
    expect(a?.s).toBe(b?.s)
    expect(styleOf(workbook, a)).toEqual({ bl: 1 })
    expect(cellOf(workbook, 'sheet-0', 0, 2)?.s).toBeUndefined()
    expect(Object.keys(workbook.styles)).toHaveLength(1)
  })
})
