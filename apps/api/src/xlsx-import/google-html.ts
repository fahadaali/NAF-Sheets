// Google's own rendering of a public spreadsheet, for what its .xlsx export
// drops: the chip colour of each dropdown item and the display style
// (OPEN_QUESTIONS.md "Google import" G32; the parsing is
// @naf-sheets/xlsx-import google-rendering.ts).
//
//   GET https://docs.google.com/spreadsheets/d/<id>/htmlview                      → sheet names and gids
//   GET https://docs.google.com/spreadsheets/d/<id>/htmlview/sheet?headers=true&gid=<gid>  → one sheet
//
// Observed on 2026-11-11: a public file answers 200 text/html on both, with no
// redirect; a file that is not shared by link answers 401, an unknown id 404.
// Only the sheets that hold dropdowns are fetched. Anything but a 200 HTML
// page within the limits yields nothing for that page — never an error: the
// import goes on without colours and the report says so. Same access as the
// export (no account, no cookie, no credential); the URLs are built from the
// validated spreadsheet id and the gids Google's own page lists (digits).
// No redirect is followed.

import { parseGoogleSheetChips, parseGoogleSheetIndex, type GoogleRendering, type RenderedChip } from '@naf-sheets/xlsx-import'
import type { FetchLike } from './google-export'

export interface GoogleRenderingLimits {
  /** Per page; a larger page is skipped. */
  maxPageBytes: number
  /** Sheet pages fetched at most (the index page is not counted). */
  maxSheets: number
  /** Per request. */
  timeoutMs: number
}

// OPEN: G32 — calibrate with the real NAF file (a 1,000-row sheet page is about 0.3 MB).
export const DEFAULT_RENDERING_LIMITS: GoogleRenderingLimits = { maxPageBytes: 8 * 1024 * 1024, maxSheets: 20, timeoutMs: 20_000 }

export function htmlviewUrl(spreadsheetId: string, gid?: string): string {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`
  return gid === undefined ? base : `${base}/sheet?headers=true&gid=${gid}`
}

async function fetchPage(fetcher: FetchLike, url: string, limits: GoogleRenderingLimits): Promise<string | null> {
  let response: Response
  try {
    response = await fetcher(url, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(limits.timeoutMs) })
  } catch {
    return null
  }
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  if (response.status !== 200 || !type.startsWith('text/html') || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > limits.maxPageBytes) {
    await response.body.cancel().catch(() => undefined)
    return null
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (done || !value) break
    total += value.byteLength
    if (total > limits.maxPageBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Google writes a sheet name into the .xlsx without the characters Excel
 * forbids (`3. Show/Hide Data` became `3. ShowHide Data`, real export) and
 * Excel names are at most 31 characters: compare names that way.
 */
export function exportedSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, '')
}

export interface RenderingRead {
  rendering: GoogleRendering | null
  /** Requests made, for the audit. */
  requests: number
}

/** Chips of the named sheets (names as in the .xlsx). Sheets that could not be read are left out. */
export async function readGoogleRendering(fetcher: FetchLike, spreadsheetId: string, sheetNames: readonly string[], limits: GoogleRenderingLimits = DEFAULT_RENDERING_LIMITS): Promise<RenderingRead> {
  let requests = 1
  const index = await fetchPage(fetcher, htmlviewUrl(spreadsheetId), limits)
  if (index === null) return { rendering: null, requests }
  const listed = parseGoogleSheetIndex(index)
  const rendering = new Map<string, RenderedChip[]>()
  for (const name of sheetNames.slice(0, limits.maxSheets)) {
    const entry =
      listed.find((s) => s.name === name) ??
      listed.find((s) => exportedSheetName(s.name) === name) ??
      listed.find((s) => Array.from(exportedSheetName(s.name)).slice(0, 31).join('') === name)
    if (!entry) continue
    requests++
    const html = await fetchPage(fetcher, htmlviewUrl(spreadsheetId, entry.gid), limits)
    // Not Google's grid page (a sign-in or error page served as 200): not read, so reported.
    if (html === null || !/<table\b[^>]*class="waffle/.test(html)) continue
    rendering.set(name, parseGoogleSheetChips(html))
  }
  return { rendering, requests }
}
