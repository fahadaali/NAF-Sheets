// The formula colours (@naf-sheets/univer-rtl formula-colours.ts) from the
// theme: src/styles/theme.css defines them (--formula-*), nothing here holds a
// colour. The reference colours are Excel's and are not editable in «المظهر»
// (apps/web/OPEN_QUESTIONS.md F1–F4).

import type { FormulaPalette } from '@naf-sheets/univer-rtl'
import { readTokens } from '../lib/theme-colors'

export const FORMULA_REFERENCE_TOKENS = ['--formula-ref-1', '--formula-ref-2', '--formula-ref-3', '--formula-ref-4', '--formula-ref-5', '--formula-ref-6', '--formula-ref-7'] as const

export const FORMULA_CATEGORY_TOKENS = {
  plain: '--formula-text',
  function: '--formula-function',
  sheet: '--formula-sheet',
  string: '--formula-string',
  number: '--formula-number',
  boolean: '--formula-boolean',
  comparison: '--formula-comparison',
  operator: '--formula-operator',
  error: '--formula-error',
} as const satisfies Record<Exclude<keyof FormulaPalette, 'references'>, string>

const HEX = /^#[0-9a-f]{6}$/i

/** The palette as the theme defines it now, or null when a token is missing (theme.css not loaded). */
export function formulaPalette(read: typeof readTokens = readTokens): FormulaPalette | null {
  const names = [...FORMULA_REFERENCE_TOKENS, ...Object.values(FORMULA_CATEGORY_TOKENS)]
  const values = read(names)
  if (names.some((n) => !HEX.test(values[n] ?? ''))) return null
  const category = Object.fromEntries(Object.entries(FORMULA_CATEGORY_TOKENS).map(([k, token]) => [k, values[token]!])) as Omit<FormulaPalette, 'references'>
  return { references: FORMULA_REFERENCE_TOKENS.map((t) => values[t]!), ...category }
}
