// Downloading a public Google Sheets file as .xlsx, without a Google account
// (owner decision 2026-11-11).
//
//   GET https://docs.google.com/spreadsheets/d/<id>/export?format=xlsx
//
// Observed on 2026-11-11 with public files: Google answers 307 to
// https://doc-XX-YY-sheets.googleusercontent.com/export/…, which answers 200
// with `content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
// and `content-disposition: attachment; filename="…"; filename*=UTF-8''<title>.xlsx`.
// An unknown id answers 404 and a deleted file 410, both with an HTML page.
// A file that is not shared by link is not readable without signing in;
// Google is known to answer that with a redirect to accounts.google.com, a
// sign-in page (HTML with 200), 401 or 403. All of them read as "private".
// OPEN: no private file was available to observe which one (G19).
//
// Not an SSRF: the first URL is built from a validated id (letters, digits,
// `-`, `_`), redirects are followed by hand (`redirect: 'manual'`), at most
// MAX_REDIRECTS, and only to https on docs.google.com (same spreadsheet path)
// or to Google's own download hosts `doc-…-sheets.googleusercontent.com`;
// anything else stops the download. No credentials or cookies are sent.

import { XlsxRouteFailure } from './errors'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GoogleExportLimits {
  maxBytes: number
  /** Per request (each redirect hop has its own). */
  timeoutMs: number
}

export const MAX_REDIRECTS = 3
/** Google's download hosts, e.g. doc-08-4o-sheets.googleusercontent.com (observed 2026-11-11). */
const DOWNLOAD_HOST = /^doc-[a-z0-9]{1,8}-[a-z0-9]{1,8}-sheets\.googleusercontent\.com$/
const SIGN_IN_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])

export function exportUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`
}

export interface GoogleExport {
  bytes: Uint8Array
  /** The file's title from Content-Disposition, without `.xlsx`; null when absent. */
  title: string | null
  /** Requests made, redirects included (for the audit). */
  requests: number
}

/** `filename*=UTF-8''…` (RFC 6266/5987), else `filename="…"`, minus the extension. */
export function titleFromDisposition(header: string | null): string | null {
  if (!header) return null
  let name: string | null = null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      name = decodeURIComponent((star[1] as string).trim())
    } catch {
      name = null
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header)
    name = plain ? (plain[1] as string).trim() : null
  }
  if (!name) return null
  const title = name.replace(/\.xlsx$/i, '').trim()
  return title === '' ? null : title
}

function allowedRedirect(target: URL, spreadsheetId: string): 'download' | 'sign_in' | 'refused' {
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '' || target.port !== '') return 'refused'
  const host = target.hostname.toLowerCase()
  if (SIGN_IN_HOSTS.has(host)) return 'sign_in'
  if (host === 'docs.google.com') {
    if (/\/ServiceLogin|\/accounts\//i.test(target.pathname)) return 'sign_in'
    return target.pathname.startsWith(`/spreadsheets/d/${spreadsheetId}/`) ? 'download' : 'refused'
  }
  return DOWNLOAD_HOST.test(host) ? 'download' : 'refused'
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new XlsxRouteFailure(413, 'gsheets_link_too_large')
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new XlsxRouteFailure(413, 'gsheets_link_too_large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

function retryAfterSeconds(value: string | null): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 && n <= 600 ? Math.round(n) : 60
}

export async function downloadGoogleExport(fetcher: FetchLike, spreadsheetId: string, limits: GoogleExportLimits): Promise<GoogleExport> {
  let url = exportUrl(spreadsheetId)
  let requests = 0
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response
    requests++
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        signal: AbortSignal.timeout(limits.timeoutMs),
      })
    } catch {
      throw new XlsxRouteFailure(503, 'gsheets_link_unavailable')
    }
    const status = response.status
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (!location) throw new XlsxRouteFailure(502, 'gsheets_link_unavailable')
      let target: URL
      try {
        target = new URL(location, url)
      } catch {
        throw new XlsxRouteFailure(502, 'gsheets_link_unavailable')
      }
      const verdict = allowedRedirect(target, spreadsheetId)
      if (verdict === 'sign_in') throw new XlsxRouteFailure(403, 'gsheets_link_private')
      if (verdict === 'refused') {
        console.error(`gsheets link: redirect to an unexpected host refused (${target.hostname})`)
        throw new XlsxRouteFailure(502, 'gsheets_link_unavailable')
      }
      url = target.toString()
      continue
    }
    if (status === 401 || status === 403) {
      await response.body?.cancel().catch(() => undefined)
      throw new XlsxRouteFailure(403, 'gsheets_link_private')
    }
    if (status === 404 || status === 410) {
      await response.body?.cancel().catch(() => undefined)
      throw new XlsxRouteFailure(404, 'gsheets_link_not_found')
    }
    if (status === 429) {
      await response.body?.cancel().catch(() => undefined)
      throw new XlsxRouteFailure(429, 'gsheets_link_rate_limited', retryAfterSeconds(response.headers.get('retry-after')))
    }
    if (status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new XlsxRouteFailure(status >= 500 ? 503 : 502, 'gsheets_link_unavailable')
    }
    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (type.startsWith('text/html')) {
      // A page instead of the file: Google's sign-in page (the file is not shared by link).
      await response.body?.cancel().catch(() => undefined)
      throw new XlsxRouteFailure(403, 'gsheets_link_private')
    }
    const bytes = await readLimited(response, limits.maxBytes)
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) throw new XlsxRouteFailure(403, 'gsheets_link_private')
    return { bytes, title: titleFromDisposition(response.headers.get('content-disposition')), requests }
  }
  throw new XlsxRouteFailure(502, 'gsheets_link_unavailable')
}
