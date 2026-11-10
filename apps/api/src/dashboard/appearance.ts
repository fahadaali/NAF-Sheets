// The platform's palette overrides («المظهر»), in KV settings. The defaults
// live in apps/web/src/styles/theme.css only; what is stored here replaces
// some of them at app load. An empty palette means the defaults.

import type { AppearancePalette, AppearanceResponse } from '@naf-sheets/shared'
import { contrastWarnings, normalizePalette } from '@naf-sheets/shared'

export const APPEARANCE_KEY = 'settings:appearance'

interface Stored {
  palette: AppearancePalette
  updatedAt: string | null
  updatedBy: string | null
}

/** The stored palette; the defaults (empty) when nothing valid is stored. */
export async function readAppearance(kv: KVNamespace): Promise<AppearanceResponse> {
  let stored: Stored | null = null
  try {
    stored = await kv.get<Stored>(APPEARANCE_KEY, 'json')
  } catch {
    stored = null
  }
  const palette = normalizePalette(stored?.palette) ?? {}
  return { palette, updatedAt: stored?.updatedAt ?? null, warnings: contrastWarnings(palette) }
}

export async function writeAppearance(kv: KVNamespace, palette: AppearancePalette, by: string, at: string): Promise<AppearanceResponse> {
  const stored: Stored = { palette, updatedAt: at, updatedBy: by }
  await kv.put(APPEARANCE_KEY, JSON.stringify(stored))
  return { palette, updatedAt: at, warnings: contrastWarnings(palette) }
}
