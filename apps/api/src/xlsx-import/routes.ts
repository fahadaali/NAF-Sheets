// Import without Google OAuth (owner decision 2026-11-11; contract:
// packages/shared/src/api-integrations.ts ".xlsx import and public Google
// Sheets links"):
//
//   POST /api/import/xlsx?name=&title=   body: the .xlsx bytes  → 201 ImportXlsxResponse
//   POST /api/import/gsheets-link        ImportGsheetsLinkRequest → 201 ImportXlsxResponse
//
// Both read the file with @naf-sheets/xlsx-import (which detects whether
// Excel or Google wrote it and normalises accordingly), convert it with the
// one converter of @naf-sheets/gsheets-import, and store it exactly like the
// Sheets API import (../google-import/store.ts): a new workbook, the import
// report, the dashboard sheet added by withDashboardSheet. The report is read
// with GET /api/workbooks/:id/import-report (../google-import/routes.ts).
//
// Editors and admins only: a viewer is refused here, in the route.

import type { Context, Hono } from 'hono'
import { XLSX_MAX_FILE_BYTES, type ImportXlsxResponse } from '@naf-sheets/shared'
import { importXlsx, XlsxImportError, type XlsxLimits } from '@naf-sheets/xlsx-import'
import type { AppEnv } from '../auth'
import { canCreateWorkbooks } from '../access'
import { ApiFailure } from '../errors'
import { parseSpreadsheetSource } from '../google-import/source'
import { persistImport } from '../google-import/store'
import { DEFAULT_LIMITS as GOOGLE_LIMITS } from '../google-import/config'
import { callerOf, isPlainObject, readJson } from '../request'
import { fromReaderError, XlsxRouteFailure, xlsxErrorResponse } from './errors'
import { downloadGoogleExport, type FetchLike } from './google-export'

const MAX_TITLE_LENGTH = 200
const MAX_FILE_NAME_LENGTH = 255
/** When neither the request, the file name nor the file gives a title. */
const FALLBACK_TITLE = 'ملف مستورد'

export interface XlsxImportOptions {
  /** Outbound fetch to Google (the link path). Tests inject a fake; nothing else should. */
  fetch?: FetchLike
  limits?: Partial<XlsxImportLimits>
}

export interface XlsxImportLimits {
  maxFileBytes: number
  /** Per request to Google, redirects included one by one. */
  downloadTimeoutMs: number
  reader: Partial<XlsxLimits>
  maxInlineReportBytes: number
}

// OPEN: apps/api/OPEN_QUESTIONS.md "Google import" G22 — calibrate.
export const DEFAULT_XLSX_IMPORT_LIMITS: XlsxImportLimits = {
  maxFileBytes: XLSX_MAX_FILE_BYTES,
  downloadTimeoutMs: 30_000,
  reader: {},
  maxInlineReportBytes: GOOGLE_LIMITS.maxInlineReportBytes,
}

type Ctx = Context<AppEnv>

function guarded(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx): Promise<Response> => {
    try {
      return await handler(c)
    } catch (error) {
      if (error instanceof XlsxRouteFailure) return xlsxErrorResponse(error)
      if (error instanceof XlsxImportError) {
        if (error.code === 'corrupt') console.error(`xlsx import: unreadable file (${error.detail.slice(0, 120)})`)
        return xlsxErrorResponse(fromReaderError(error.code))
      }
      throw error
    }
  }
}

/** A title the request gives (1–200 after trimming), or undefined; 400 `invalid_title` when unusable. */
function requestedTitle(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new ApiFailure(400, 'invalid_title')
  const title = raw.trim()
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) throw new ApiFailure(400, 'invalid_title')
  return title
}

/** A title taken from a file: trimmed and cut to 200 characters; null when empty. */
function fileTitle(raw: string | null | undefined): string | null {
  const title = Array.from((raw ?? '').trim()).slice(0, MAX_TITLE_LENGTH).join('').trim()
  return title === '' ? null : title
}

/** The uploaded file's own name, without any path; null when absent or unusable. */
export function cleanUploadName(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const base = raw.normalize('NFC').split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim()
  if (name === '' || name === '.' || name === '..' || [...name].length > MAX_FILE_NAME_LENGTH) return null
  return name
}

async function readBody(c: Ctx, maxBytes: number): Promise<Uint8Array> {
  const declared = c.req.header('content-length')
  if (declared === undefined || !/^\d{1,16}$/.test(declared.trim())) throw new XlsxRouteFailure(411, 'xlsx_length_required')
  const length = Number(declared.trim())
  // Refused before a byte is read.
  if (length > maxBytes) throw new XlsxRouteFailure(413, 'xlsx_file_too_large')
  if (length === 0) throw new XlsxRouteFailure(400, 'xlsx_empty')
  const body = c.req.raw.body
  if (!body) throw new XlsxRouteFailure(400, 'xlsx_empty')
  const reader = body.getReader()
  const out = new Uint8Array(length)
  let at = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (at + value.byteLength > length) {
      await reader.cancel().catch(() => undefined)
      throw new XlsxRouteFailure(413, 'xlsx_file_too_large')
    }
    out.set(value, at)
    at += value.byteLength
  }
  if (at === 0) throw new XlsxRouteFailure(400, 'xlsx_empty')
  return at === length ? out : out.subarray(0, at)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function registerXlsxImportRoutes(app: Hono<AppEnv>, options: XlsxImportOptions = {}): void {
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const limits: XlsxImportLimits = { ...DEFAULT_XLSX_IMPORT_LIMITS, ...options.limits }
  const readerLimits = { ...limits.reader, maxFileBytes: limits.maxFileBytes }

  // ── POST /api/import/xlsx?name=&title=
  app.post(
    '/api/import/xlsx',
    guarded(async (c) => {
      const caller = callerOf(c)
      if (!canCreateWorkbooks(caller)) throw new ApiFailure(403, 'forbidden_create')
      const fileName = cleanUploadName(c.req.query('name'))
      const wanted = requestedTitle(c.req.query('title'))
      const bytes = await readBody(c, limits.maxFileBytes)

      const workbookId = crypto.randomUUID()
      const nameTitle = fileTitle(fileName?.replace(/\.(xlsx|xlsm)$/i, ''))
      const result = await importXlsx(bytes, { workbookId, via: 'upload', fileName, limits: readerLimits })
      const title = wanted ?? nameTitle ?? fileTitle(result.read.title) ?? FALLBACK_TITLE
      const digest = await sha256Hex(bytes)
      const stored = await persistImport(c.env, {
        ownerId: caller.id,
        title,
        // workbooks.source stays 'gsheets' (the D1 CHECK allows blank/template/gsheets);
        // the source is recorded as upload:<sha-256>. OPEN: G21.
        spreadsheetId: `upload:${digest}`,
        workbook: { ...result.workbook, id: workbookId, name: title },
        report: { ...result.report, source: { ...result.report.source, title } },
        googleRequests: 0,
        maxInlineReportBytes: limits.maxInlineReportBytes,
        audit: {
          action: 'workbook.import.xlsx',
          details: { sha256: digest, bytes: bytes.byteLength, unpackedBytes: result.read.unpackedBytes, origin: result.read.origin.kind, application: result.read.origin.application, evidence: result.read.origin.evidence },
        },
      })
      return c.json<ImportXlsxResponse>({ workbookId: stored.workbookId, reportId: stored.reportId }, 201)
    }),
  )

  // ── POST /api/import/gsheets-link {source, title?}
  app.post(
    '/api/import/gsheets-link',
    guarded(async (c) => {
      const caller = callerOf(c)
      if (!canCreateWorkbooks(caller)) throw new ApiFailure(403, 'forbidden_create')
      const body = await readJson(c)
      if (!isPlainObject(body)) throw new XlsxRouteFailure(400, 'invalid_source')
      const spreadsheetId = parseSpreadsheetSource(body.source)
      if (spreadsheetId === null) throw new XlsxRouteFailure(400, 'invalid_source')
      const wanted = requestedTitle(body.title)

      const download = await downloadGoogleExport(fetcher, spreadsheetId, { maxBytes: limits.maxFileBytes, timeoutMs: limits.downloadTimeoutMs })
      const workbookId = crypto.randomUUID()
      const result = await importXlsx(download.bytes, { workbookId, via: 'google_link', limits: readerLimits })
      const title = wanted ?? fileTitle(download.title) ?? fileTitle(result.read.title) ?? FALLBACK_TITLE
      const report = { ...result.report, source: { ...result.report.source, spreadsheetId, title } }
      const stored = await persistImport(c.env, {
        ownerId: caller.id,
        title,
        spreadsheetId,
        workbook: { ...result.workbook, id: workbookId, name: title },
        report,
        googleRequests: download.requests,
        maxInlineReportBytes: limits.maxInlineReportBytes,
        audit: {
          action: 'workbook.import.gsheets_link',
          details: { spreadsheetId, downloadRequests: download.requests, bytes: download.bytes.byteLength, unpackedBytes: result.read.unpackedBytes, origin: result.read.origin.kind, evidence: result.read.origin.evidence },
        },
      })
      return c.json<ImportXlsxResponse>({ workbookId: stored.workbookId, reportId: stored.reportId }, 201)
    }),
  )
}
