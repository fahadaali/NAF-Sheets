// A fake Google for the import tests: the OAuth token endpoint and
// spreadsheets.get. No request ever leaves the test; an unexpected URL throws.
//
// spreadsheets.get is simulated from a full `spreadsheets.get` fixture the way
// the REST reference describes it:
//   - `fields` is applied as a field mask (a request without one fails the test);
//   - `ranges` limit the cells to the requested rectangles, one GridData per range;
//   - comments and comment anchors are left out (commentsViewMode defaults to OMITTED).
// Because the mask is applied, converting what the fake returns equals
// converting the whole fixture only if the import's masks ask for every field
// the converter reads.

import { env } from 'cloudflare:workers'
import type { GsGridData, GsSheet, GsSpreadsheet } from '@naf-sheets/gsheets-import'
import type { GoogleImportEnv } from '../../src/google-import'
import { call } from '../helpers'
import type { createApp } from '../../src/app'

export const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
export const ACCESS_TOKEN = 'ya29.fake-access-token-for-tests'

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** Worker bindings plus the three Google settings (fake values; secrets never live in files). */
export const googleEnv: GoogleImportEnv = {
  ...env,
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  TOKEN_ENCRYPTION_KEY: randomKey(),
}

// ---------------------------------------------------------------------------
// Field masks: parse and apply
// ---------------------------------------------------------------------------

export interface ParsedMask {
  [field: string]: true | ParsedMask
}

/**
 * Parses `a.b(c,d),e` — comma-separated paths, dot-separated subfields,
 * parenthesised subfield lists (nesting accepted here, though the import
 * never nests). Throws on anything else.
 */
export function parseMask(text: string): ParsedMask {
  let i = 0
  const name = (): string => {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))
    if (!m) throw new Error(`mask: name expected at ${i} in ${text}`)
    i += m[0].length
    return m[0]
  }
  const merge = (into: ParsedMask, path: string[], sub: true | ParsedMask) => {
    let node = into
    path.forEach((segment, k) => {
      const last = k === path.length - 1
      const existing = node[segment]
      if (existing === true) return
      if (last) {
        if (sub === true || existing === undefined) node[segment] = sub
        else Object.entries(sub).forEach(([key, value]) => merge(existing as ParsedMask, [key], value))
        return
      }
      if (existing === undefined) node[segment] = {}
      node = node[segment] as ParsedMask
    })
  }
  const list = (): ParsedMask => {
    const tree: ParsedMask = {}
    for (;;) {
      const path = [name()]
      while (text[i] === '.') {
        i++
        path.push(name())
      }
      if (text[i] === '(') {
        i++
        const sub = list()
        if (text[i] !== ')') throw new Error(`mask: ')' expected at ${i}`)
        i++
        merge(tree, path, sub)
      } else merge(tree, path, true)
      if (text[i] !== ',') return tree
      i++
    }
  }
  const tree = list()
  if (i !== text.length) throw new Error(`mask: unexpected '${text[i]}' at ${i}`)
  return tree
}

export function applyMask(value: unknown, mask: true | ParsedMask): unknown {
  if (mask === true) return value
  if (Array.isArray(value)) return value.map((v) => applyMask(v, mask))
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, sub] of Object.entries(mask)) {
    const v = (value as Record<string, unknown>)[key]
    if (v !== undefined) out[key] = applyMask(v, sub)
  }
  return out
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export interface A1 {
  title: string
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

/** `'name'!A1:J30` or `'name'!A1` (the forms the import writes). */
export function parseA1(range: string): A1 {
  const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range)
  if (!m) throw new Error(`unexpected range ${range}`)
  const [, quoted, c0, r0, c1, r1] = m as unknown as [string, string, string, string, string | undefined, string | undefined]
  return {
    title: quoted.replace(/''/g, "'"),
    startRow: Number(r0) - 1,
    endRow: Number(r1 ?? r0) - 1,
    startColumn: columnIndex(c0),
    endColumn: columnIndex(c1 ?? c0),
  }
}

/** The cells of `range` from a sheet whose fixture holds one GridData starting at A1. */
function slice(sheet: GsSheet, range: A1): GsGridData {
  const blocks = sheet.data ?? []
  if (blocks.length > 1 || blocks[0]?.startRow || blocks[0]?.startColumn) throw new Error('fake: fixture sheets must hold one block at A1')
  const block = blocks[0] ?? {}
  const out: GsGridData = {}
  if (range.startRow > 0) out.startRow = range.startRow
  if (range.startColumn > 0) out.startColumn = range.startColumn
  const rows = (block.rowData ?? []).slice(range.startRow, range.endRow + 1).map((row) => {
    const values = row.values?.slice(range.startColumn, range.endColumn + 1)
    return values ? { values } : {}
  })
  if (rows.length > 0) out.rowData = rows
  const rowMetadata = (block.rowMetadata ?? []).slice(range.startRow, range.endRow + 1)
  if (rowMetadata.length > 0) out.rowMetadata = rowMetadata
  const columnMetadata = (block.columnMetadata ?? []).slice(range.startColumn, range.endColumn + 1)
  if (columnMetadata.length > 0) out.columnMetadata = columnMetadata
  return out
}

/** What `commentsViewMode` OMITTED returns: no comments, no anchors. */
export function withoutComments(spreadsheet: GsSpreadsheet): GsSpreadsheet {
  const copy = structuredClone(spreadsheet)
  delete copy.comments
  for (const sheet of copy.sheets ?? []) delete sheet.commentAnchors
  return copy
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export interface FakeCall {
  method: string
  url: URL
  headers: Headers
  body: string | null
}

export interface FakeGoogleOptions {
  spreadsheet?: GsSpreadsheet
  /** Token endpoint answer. Default: a valid read-only Bearer token for one hour. */
  token?: { status?: number; body?: unknown }
  /**
   * Overrides the answer to the n-th spreadsheets.get call (0-based):
   * return a Response to send it, or 'network' to throw like a dropped connection.
   */
  sheets?: (n: number) => Response | 'network' | null
}

export function defaultTokenBody(): Record<string, unknown> {
  return { access_token: ACCESS_TOKEN, expires_in: 3599, scope: SCOPE, token_type: 'Bearer' }
}

export function googleJsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code: status, message, status: 'ERROR' } }), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
  })
}

export function fakeGoogle(options: FakeGoogleOptions = {}) {
  const calls: FakeCall[] = []
  let sheetsCalls = 0

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : null
    calls.push({ method, url, headers: new Headers(init.headers), body })

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token' && method === 'POST') {
      const status = options.token?.status ?? 200
      return new Response(JSON.stringify(options.token?.body ?? defaultTokenBody()), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
    }

    const match = /^\/v4\/spreadsheets\/([^/]+)$/.exec(url.pathname)
    if (url.origin === 'https://sheets.googleapis.com' && match && method === 'GET') {
      const n = sheetsCalls++
      const override = options.sheets?.(n)
      if (override === 'network') throw new TypeError('fake network failure')
      if (override) return override

      const fixture = options.spreadsheet
      if (!fixture || decodeURIComponent(match[1] ?? '') !== fixture.spreadsheetId) return googleJsonError(404, 'Requested entity was not found.')
      const fields = url.searchParams.get('fields')
      if (!fields) throw new Error('fake: spreadsheets.get without a fields mask')

      let doc = withoutComments(fixture)
      const ranges = url.searchParams.getAll('ranges').map(parseA1)
      if (ranges.length > 0) {
        doc = {
          ...doc,
          sheets: (doc.sheets ?? [])
            .filter((sheet) => ranges.some((r) => r.title === sheet.properties?.title))
            .map((sheet) => ({ ...sheet, data: ranges.filter((r) => r.title === sheet.properties?.title).map((r) => slice(sheet, r)) })),
        }
      }
      return new Response(JSON.stringify(applyMask(doc, parseMask(fields))), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } })
    }

    throw new Error(`fake google: unexpected ${method} ${url.origin}${url.pathname}`)
  }

  return {
    fetch,
    calls,
    sheetsCallsOf: () => calls.filter((c) => c.url.origin === 'https://sheets.googleapis.com'),
  }
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

type App = ReturnType<typeof createApp>

/** Runs start → callback for `user` and returns the callback response. */
export async function linkGoogle(app: App, user: { id: string }, next = '/files/new'): Promise<Response> {
  const start = await call(app, 'GET', `/auth/google/start?next=${encodeURIComponent(next)}`, { user, env: googleEnv })
  if (start.status !== 302) throw new Error(`start: ${start.status} ${await start.text()}`)
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')
  return call(app, 'GET', `/auth/google/callback?state=${state}&code=4%2Ffake-code`, { user, env: googleEnv })
}
