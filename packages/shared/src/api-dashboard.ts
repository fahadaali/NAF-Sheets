// The platform's appearance («المظهر»): palette overrides, contrast checks.
// Implemented by apps/api/src/appearance/. Every error body is `ApiError` (./api.ts).

import type { IsoDate, IsoDateTime, SyncState, TaskLevel } from './domain'

// ---------------------------------------------------------------------------
// Appearance («المظهر»): palette overrides, admin only
// ---------------------------------------------------------------------------

/**
 * The editable palette: each name maps to one CSS custom property of
 * apps/web/src/styles/theme.css, where the defaults live. The values here are
 * overrides only; an empty palette means the defaults.
 */
export const APPEARANCE_TOKENS = {
  accent: '--color-accent',
  accentContrast: '--color-accent-contrast',
  page: '--color-page',
  surface: '--color-surface',
  surfaceMuted: '--color-surface-muted',
  border: '--color-border',
  text: '--color-text',
  textMuted: '--color-text-muted',
  series1: '--chart-1',
  series2: '--chart-2',
  series3: '--chart-3',
  series4: '--chart-4',
  series5: '--chart-5',
  series6: '--chart-6',
  series7: '--chart-7',
  series8: '--chart-8',
} as const

export type AppearanceToken = keyof typeof APPEARANCE_TOKENS
export type AppearancePalette = Partial<Record<AppearanceToken, string>>

export const APPEARANCE_TOKEN_NAMES = Object.keys(APPEARANCE_TOKENS) as AppearanceToken[]
export const SERIES_TOKENS: readonly AppearanceToken[] = ['series1', 'series2', 'series3', 'series4', 'series5', 'series6', 'series7', 'series8']

/** `#rrggbb` only (lower or upper case). */
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/

/** GET /api/appearance (everyone signed in) and the answer of PUT /api/admin/appearance. */
export interface AppearanceResponse {
  palette: AppearancePalette
  updatedAt: IsoDateTime | null
  /** Warnings for the stored palette (contrast below WCAG AA); they never block a save. */
  warnings: ContrastWarning[]
}

export interface ContrastCheck {
  foreground: AppearanceToken
  background: AppearanceToken
  /** WCAG 2.1: 4.5 for text, 3 for graphical objects and large text. */
  minimum: number
  use: 'text' | 'graphic'
}

/** The pairs the platform draws on each other. */
export const CONTRAST_CHECKS: readonly ContrastCheck[] = [
  { foreground: 'text', background: 'surface', minimum: 4.5, use: 'text' },
  { foreground: 'text', background: 'page', minimum: 4.5, use: 'text' },
  { foreground: 'text', background: 'surfaceMuted', minimum: 4.5, use: 'text' },
  { foreground: 'textMuted', background: 'surface', minimum: 4.5, use: 'text' },
  { foreground: 'textMuted', background: 'page', minimum: 4.5, use: 'text' },
  { foreground: 'accent', background: 'surface', minimum: 4.5, use: 'text' },
  { foreground: 'accentContrast', background: 'accent', minimum: 4.5, use: 'text' },
  ...SERIES_TOKENS.map((t): ContrastCheck => ({ foreground: t, background: 'surface', minimum: 3, use: 'graphic' })),
]

export interface ContrastWarning {
  foreground: AppearanceToken
  background: AppearanceToken
  /** Rounded to two decimals. */
  ratio: number
  minimum: number
}

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.1 relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

/** WCAG 2.1 contrast ratio of two `#rrggbb` colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Every check whose two colours are both in `palette` and fall below the minimum. */
export function contrastWarnings(palette: AppearancePalette): ContrastWarning[] {
  const out: ContrastWarning[] = []
  for (const check of CONTRAST_CHECKS) {
    const fg = palette[check.foreground]
    const bg = palette[check.background]
    if (!fg || !bg || !HEX_COLOUR.test(fg) || !HEX_COLOUR.test(bg)) continue
    const ratio = contrastRatio(fg, bg)
    if (ratio < check.minimum) out.push({ foreground: check.foreground, background: check.background, ratio: Math.round(ratio * 100) / 100, minimum: check.minimum })
  }
  return out
}

/**
 * The palette as stored (names known, values `#rrggbb` lower-cased), or null
 * when anything in it is not: an unknown name or a value that is not hex.
 */
export function normalizePalette(value: unknown): AppearancePalette | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const out: AppearancePalette = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in APPEARANCE_TOKENS)) return null
    if (typeof raw !== 'string' || !HEX_COLOUR.test(raw)) return null
    out[key as AppearanceToken] = raw.toLowerCase()
  }
  return out
}
