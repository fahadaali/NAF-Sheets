// The formula colours in the theme (src/styles/theme.css, OPEN_QUESTIONS.md F1–F4):
// the reference colours are Excel's sequence, in Excel's order, and are not
// editable in «المظهر»; every category colour is readable on the surface.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { APPEARANCE_TOKENS } from '@naf-sheets/shared'
import { describe, expect, it } from 'vitest'
import { FORMULA_CATEGORY_TOKENS, FORMULA_REFERENCE_TOKENS, formulaPalette } from '../../src/editor/formula-palette'

const THEME = readFileSync(fileURLToPath(new URL('../../src/styles/theme.css', import.meta.url)), 'utf8')

/** A token's value in theme.css's :root, following one level of var(). */
function themeValue(name: string): string {
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(THEME)
  if (!m) return ''
  const v = m[1]!.trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  return ref ? themeValue(ref[1]!) : v.toLowerCase()
}
const read = <K extends string>(names: readonly K[]) => Object.fromEntries(names.map((n) => [n, themeValue(n)])) as Record<K, string>

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('formula palette', () => {
  it('the reference colours are Excel\'s sequence, in Excel\'s order (blue, red, purple, green, magenta, orange, teal)', () => {
    // Observed independently in 2018 (Jan Karel Pieterse, Microsoft Tech
    // Community) and 2026 (CellRefColors): the same seven values.
    expect(formulaPalette(read)?.references).toEqual(['#326ac7', '#c0353e', '#8157b7', '#007c20', '#b03e84', '#b64900', '#267392'])
  })

  it('the reference colours are not editable in «المظهر»', () => {
    const editable = new Set<string>(Object.values(APPEARANCE_TOKENS))
    for (const t of FORMULA_REFERENCE_TOKENS) expect(editable.has(t), t).toBe(false)
  })

  it('every category has its own colour, readable on the surface (≥ 4.5:1)', () => {
    const palette = formulaPalette(read)!
    const surface = themeValue('--color-surface')
    const categories = Object.keys(FORMULA_CATEGORY_TOKENS) as Array<keyof typeof FORMULA_CATEGORY_TOKENS>
    const values = categories.map((k) => palette[k])
    expect(new Set(values).size).toBe(values.length)
    for (const k of categories) expect(contrast(palette[k], surface), k).toBeGreaterThanOrEqual(4.5)
    // …and none of them is one of Excel's reference colours.
    for (const v of values) expect(palette.references).not.toContain(v)
  })

  it('plain formula text follows the theme\'s text colour', () => {
    expect(formulaPalette(read)?.plain).toBe(themeValue('--color-text'))
  })

  it('a missing token gives no palette (Univer\'s own colours stay)', () => {
    expect(formulaPalette((names) => Object.fromEntries(names.map((n) => [n, n === '--formula-error' ? '' : '#000000'])) as never)).toBeNull()
  })
})
