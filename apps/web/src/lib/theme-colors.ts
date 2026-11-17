// The palette at run time (CLAUDE.md §0: colours are defined once, in
// src/styles/theme.css).
//
// - Admins' overrides («المظهر», GET /api/appearance) are applied at load as
//   inline custom properties on <html>, which win over theme.css's :root.
//   No colour value is written here: they come from the API or from the CSS.
// - The appearance screen reads the palette in use with getComputedStyle
//   (`currentPalette`).

import { APPEARANCE_TOKENS, APPEARANCE_TOKEN_NAMES, HEX_COLOUR } from '@naf-sheets/shared'
import type { AppearancePalette, AppearanceToken } from '@naf-sheets/shared'

function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/** Replaces the overrides on <html> with `palette` (an empty palette: theme.css alone). */
export function applyPalette(palette: AppearancePalette): void {
  const el = root()
  if (!el) return
  for (const name of APPEARANCE_TOKEN_NAMES) {
    const value = palette[name]
    const property = APPEARANCE_TOKENS[name]
    if (value && HEX_COLOUR.test(value)) el.style.setProperty(property, value)
    else el.style.removeProperty(property)
  }
}

let probe: CanvasRenderingContext2D | null | undefined

/** Any CSS colour the browser understands → `#rrggbb` (the canvas normalises it); null otherwise. */
export function toHex(value: string): string | null {
  const v = value.trim()
  if (HEX_COLOUR.test(v)) return v.toLowerCase()
  if (probe === undefined) probe = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!probe || v === '' || typeof CSS === 'undefined' || !CSS.supports('color', v)) return null
  probe.fillStyle = v
  const out = String(probe.fillStyle)
  // An opaque colour reads back as #rrggbb; one with transparency as rgba(…), which is not offered.
  return HEX_COLOUR.test(out) ? out.toLowerCase() : null
}

/** The editable palette as theme.css defines it, ignoring any override in force. */
export function defaultPalette(): AppearancePalette {
  const el = root()
  if (!el) return {}
  const saved = APPEARANCE_TOKEN_NAMES.map((name) => [name, el.style.getPropertyValue(APPEARANCE_TOKENS[name])] as const)
  for (const name of APPEARANCE_TOKEN_NAMES) el.style.removeProperty(APPEARANCE_TOKENS[name])
  const out = currentPalette()
  for (const [name, value] of saved) if (value) el.style.setProperty(APPEARANCE_TOKENS[name], value)
  return out
}

/** The editable palette as it is in force now (defaults and overrides). */
export function currentPalette(): AppearancePalette {
  const el = root()
  if (!el) return {}
  const style = getComputedStyle(el)
  const out: AppearancePalette = {}
  for (const name of APPEARANCE_TOKEN_NAMES) {
    const hex = toHex(style.getPropertyValue(APPEARANCE_TOKENS[name]))
    if (hex) out[name as AppearanceToken] = hex
  }
  return out
}
