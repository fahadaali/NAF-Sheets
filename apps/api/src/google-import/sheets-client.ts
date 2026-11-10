// Reads one spreadsheet with spreadsheets.get, read-only: GET requests with
// the importing user's access token, never a write method.
//
// Large files (spec §7.2 "مع التقسيم إن كان الملف كبيراً"):
//   1. one metadata request — every sheet-level object, no cells
//      (METADATA_MASK, no `ranges`);
//   2. the cells in row bands of at most `cellsPerRequest` declared cells
//      (GRID_MASK + `ranges=<'sheet'!A1:…>`; several bands of small sheets
//      share one request). Google's usage-limits page recommends "a 2 MB
//      maximum payload"; the band size targets that.
//   The bands are merged back into the metadata response as extra GridData
//   blocks, which the converter already reads by startRow/startColumn.
// Hard stops, checked before anything is stored:
//   - the declared grid above `maxDeclaredCells`  → 413 (before fetching cells);
//   - decoded response bytes above `maxResponseBytes` in total → 413.
// Nothing is retried here: a 429 or 5xx is answered to the user with retry
// guidance, so an import never multiplies its own quota use.
// OPEN: OPEN_QUESTIONS.md "Google import" G4, G5.

import { sheetRef } from '@naf-sheets/gsheets-import'
import type { GsSheet, GsSpreadsheet } from '@naf-sheets/gsheets-import'
import type { FetchLike, GoogleImportLimits } from './config'
import { SHEETS_API_BASE } from './config'
import { GoogleImportFailure } from './errors'
import { GRID_MASK, METADATA_MASK } from './fields'

/** The access token was refused (revoked or expired early): the caller must relink. */
export class GoogleTokenRejected extends Error {
  constructor() {
    super('google_token_rejected')
  }
}

export interface SheetsReadContext {
  fetch: FetchLike
  accessToken: string
  limits: GoogleImportLimits
}

export interface ReadResult {
  spreadsheet: GsSpreadsheet
  /** Number of spreadsheets.get calls made (metadata + grid). */
  requests: number
}

/** Sheets whose cells are fetched: grid and data-source sheets with a declared grid. */
function gridSheets(spreadsheet: GsSpreadsheet): Array<{ sheet: GsSheet; title: string; rowCount: number; columnCount: number }> {
  const out: Array<{ sheet: GsSheet; title: string; rowCount: number; columnCount: number }> = []
  for (const sheet of spreadsheet.sheets ?? []) {
    const p = sheet.properties
    // OBJECT sheets hold a chart and no grid; the converter reports them.
    if (!p || p.sheetType === 'OBJECT' || typeof p.title !== 'string') continue
    const rowCount = p.gridProperties?.rowCount ?? 0
    const columnCount = p.gridProperties?.columnCount ?? 0
    // OPEN: a DATA_SOURCE sheet without gridProperties is imported without cells (G9).
    if (rowCount <= 0 || columnCount <= 0) continue
    out.push({ sheet, title: p.title, rowCount, columnCount })
  }
  return out
}

/** Σ rowCount × columnCount of the sheets whose cells would be fetched. */
export function declaredCells(spreadsheet: GsSpreadsheet): number {
  return gridSheets(spreadsheet).reduce((sum, s) => sum + s.rowCount * s.columnCount, 0)
}

/**
 * A1 ranges grouped into requests: each sheet is cut into bands of whole rows
 * holding at most `cellsPerRequest` declared cells (at least one row), and
 * consecutive bands share a request while their total stays within the budget.
 */
export function planGridRequests(spreadsheet: GsSpreadsheet, cellsPerRequest: number): string[][] {
  const requests: string[][] = []
  let current: string[] = []
  let currentCells = 0
  for (const { title, rowCount, columnCount } of gridSheets(spreadsheet)) {
    const rowsPerBand = Math.max(1, Math.floor(cellsPerRequest / columnCount))
    for (let startRow = 0; startRow < rowCount; startRow += rowsPerBand) {
      const endRow = Math.min(rowCount, startRow + rowsPerBand) - 1
      const cells = (endRow - startRow + 1) * columnCount
      if (current.length > 0 && currentCells + cells > cellsPerRequest) {
        requests.push(current)
        current = []
        currentCells = 0
      }
      current.push(sheetRef(title, { startRow, endRow, startColumn: 0, endColumn: columnCount - 1 }))
      currentCells += cells
    }
  }
  if (current.length > 0) requests.push(current)
  return requests
}

export function spreadsheetUrl(spreadsheetId: string, params: { fields: string; includeGridData: boolean; ranges?: string[] }): string {
  const query = new URLSearchParams()
  query.set('fields', params.fields)
  query.set('includeGridData', String(params.includeGridData))
  for (const range of params.ranges ?? []) query.append('ranges', range)
  return `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?${query.toString()}`
}

/** Seconds from a `Retry-After` header holding a number, bounded to 1..600; else `fallback`. */
function retryAfterSeconds(response: Response, fallback: number): number {
  const raw = response.headers.get('retry-after')
  const n = raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 600) : fallback
}

/** Maps a non-2xx Google answer to the user-facing failure. */
function failureFor(response: Response): Error {
  switch (response.status) {
    case 401:
      return new GoogleTokenRejected()
    case 403:
      // OPEN: a 403 can also mean the Sheets API is disabled for the project
      // (G10); the user-facing case is a file not shared with them.
      return new GoogleImportFailure(403, 'google_file_forbidden')
    case 404:
      return new GoogleImportFailure(404, 'google_file_not_found')
    case 429:
      return new GoogleImportFailure(429, 'google_rate_limited', { retryAfter: retryAfterSeconds(response, 60) })
    default:
      if (response.status >= 500) return new GoogleImportFailure(503, 'google_unavailable')
      return new GoogleImportFailure(502, 'google_bad_response')
  }
}

/** Reads a body as text, failing as "too large" once `budget.remaining` bytes are exceeded. */
async function readCapped(response: Response, budget: { remaining: number }): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > budget.remaining) {
    await response.body?.cancel()
    throw new GoogleImportFailure(413, 'google_file_too_large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > budget.remaining) {
      await reader.cancel()
      throw new GoogleImportFailure(413, 'google_file_too_large')
    }
    chunks.push(value)
  }
  budget.remaining -= size
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function getSpreadsheet(ctx: SheetsReadContext, url: string, budget: { remaining: number }): Promise<GsSpreadsheet> {
  let response: Response
  try {
    response = await ctx.fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${ctx.accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(ctx.limits.requestTimeoutMs),
    })
  } catch {
    // Network failure or timeout. Never log the URL's token-free parts either:
    // the spreadsheet id and sheet names are user data.
    throw new GoogleImportFailure(503, 'google_unavailable')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw failureFor(response)
  }
  let text: string
  try {
    text = await readCapped(response, budget)
  } catch (error) {
    if (error instanceof GoogleImportFailure) throw error
    // The connection dropped or timed out while the body was streaming.
    throw new GoogleImportFailure(503, 'google_unavailable')
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as GsSpreadsheet
  } catch {
    throw new GoogleImportFailure(502, 'google_bad_response')
  }
}

/**
 * Metadata, then cells in bands, merged into one `spreadsheets.get`-shaped
 * object for `convertSpreadsheet`.
 */
export async function readSpreadsheet(ctx: SheetsReadContext, spreadsheetId: string): Promise<ReadResult> {
  const budget = { remaining: ctx.limits.maxResponseBytes }
  const metadata = await getSpreadsheet(ctx, spreadsheetUrl(spreadsheetId, { fields: METADATA_MASK, includeGridData: false }), budget)
  let requests = 1

  if (gridSheets(metadata).length === 0) throw new GoogleImportFailure(422, 'google_no_sheets')
  if (declaredCells(metadata) > ctx.limits.maxDeclaredCells) throw new GoogleImportFailure(413, 'google_file_too_large')

  const bySheetId = new Map<number, GsSheet>()
  for (const sheet of metadata.sheets ?? []) {
    const id = sheet.properties?.sheetId
    // proto3 omits 0: a sheet without `sheetId` in the response has id 0.
    bySheetId.set(typeof id === 'number' ? id : 0, sheet)
  }

  for (const ranges of planGridRequests(metadata, ctx.limits.cellsPerRequest)) {
    const part = await getSpreadsheet(ctx, spreadsheetUrl(spreadsheetId, { fields: GRID_MASK, includeGridData: true, ranges }), budget)
    requests++
    for (const sheet of part.sheets ?? []) {
      if (!sheet.data || sheet.data.length === 0) continue
      const id = sheet.properties?.sheetId
      const target = bySheetId.get(typeof id === 'number' ? id : 0)
      // A sheet added after the metadata request is not imported.
      if (!target) continue
      target.data = [...(target.data ?? []), ...sheet.data]
    }
  }
  return { spreadsheet: metadata, requests }
}
