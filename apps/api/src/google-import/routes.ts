// Google Sheets import routes (spec §7.2, §12.1 item 7) — contract:
// packages/shared/src/api-integrations.ts, "Google Sheets import".
//
//   GET  /auth/google/start?next=          navigation → 302 to Google consent
//   GET  /auth/google/callback             navigation → 302 to `next`
//   GET  /api/google/link                  GoogleLinkResponse
//   POST /api/import/gsheets               ImportGsheetsRequest → 201 ImportGsheetsResponse
//   GET  /api/workbooks/:id/import-report  ImportReportResponse
//
// Every route sits behind naf-auth (none is public): the OAuth state is bound
// to the signed-in user, and the callback checks it is the same user.

import type { Context, Hono } from 'hono'
import { convertSpreadsheet } from '@naf-sheets/gsheets-import'
import type { GoogleLinkResponse, ImportGsheetsResponse, ImportReportResponse } from '@naf-sheets/shared'
import type { AppEnv } from '../auth'
import { canCreateWorkbooks, resolveAccess } from '../access'
import { auditStatement } from '../audit'
import { getWorkbookRow } from '../db'
import { ApiFailure } from '../errors'
import { callerOf, isPlainObject, nowIso, readJson } from '../request'
import type { GoogleConfig, GoogleImportLimits, GoogleImportOptions } from './config'
import { DEFAULT_LIMITS, googleConfig, redirectUri } from './config'
import { GoogleImportFailure, googleErrorBody, googleErrorResponse } from './errors'
import { authorizationUrl, consumeState, createState, discardToken, exchangeCode, loadLink, nextWithError, storeToken } from './oauth'
import { GoogleTokenRejected, readSpreadsheet } from './sheets-client'
import { parseSpreadsheetSource } from './source'
import { latestImportReport, persistImport } from './store'

// Same limits as POST /api/workbooks (routes/workbooks.ts; OPEN_QUESTIONS.md #10).
const MAX_TITLE_LENGTH = 200
const MAX_ID_LENGTH = 128

type Ctx = Context<AppEnv>

/** Runs a handler; a GoogleImportFailure becomes its JSON answer, anything else goes to app.onError. */
function guarded(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx): Promise<Response> => {
    try {
      return await handler(c)
    } catch (error) {
      if (error instanceof GoogleImportFailure) return googleErrorResponse(error)
      throw error
    }
  }
}

function requireConfig(c: Ctx): GoogleConfig {
  const config = googleConfig(c.env)
  if (!config) throw new GoogleImportFailure(503, 'google_not_configured')
  return config
}

/** A navigation answer: never cached, never leaking the URL as a referrer. */
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}

/** `title` of the request, the spreadsheet's own title otherwise; 400 when neither is usable. */
function resolveTitle(requested: unknown, googleTitle: string | undefined): string {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string') throw new ApiFailure(400, 'invalid_title')
    const title = requested.trim()
    if (title.length === 0 || title.length > MAX_TITLE_LENGTH) throw new ApiFailure(400, 'invalid_title')
    return title
  }
  // OPEN: a Google title over 200 characters is cut to 200 (G13).
  const title = Array.from((googleTitle ?? '').trim()).slice(0, MAX_TITLE_LENGTH).join('').trim()
  if (title.length === 0) throw new ApiFailure(400, 'invalid_title')
  return title
}

/** The request's `title` before anything is fetched, so a bad one costs no Google call. */
function precheckTitle(requested: unknown): void {
  if (requested !== undefined && requested !== null) resolveTitle(requested, undefined)
}

export function registerGoogleImportRoutes(app: Hono<AppEnv>, options: GoogleImportOptions = {}): void {
  const fetcher = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const limits: GoogleImportLimits = { ...DEFAULT_LIMITS, ...options.limits }

  // ── GET /auth/google/start?next=/path
  // Editors and admins only: viewers cannot import, so they have nothing to link.
  // OPEN: OPEN_QUESTIONS.md "Google import" G15.
  app.get(
    '/auth/google/start',
    guarded(async (c) => {
      const caller = callerOf(c)
      if (!canCreateWorkbooks(caller)) throw new ApiFailure(403, 'forbidden_create')
      const config = requireConfig(c)
      const state = await createState(c.env, caller.id, c.req.query('next'))
      return redirect(authorizationUrl(config, redirectUri(c.req.url), state))
    }),
  )

  // ── GET /auth/google/callback?state=…&code=… | &error=…
  app.get(
    '/auth/google/callback',
    guarded(async (c) => {
      const caller = callerOf(c)
      const config = requireConfig(c)
      const pending = await consumeState(c.env, c.req.query('state'))
      // Unknown, expired, replayed, or started by someone else: there is no
      // trusted `next` to go back to, so the answer is the Arabic error itself.
      if (!pending || pending.userId !== caller.id) throw new GoogleImportFailure(400, 'google_state_invalid')

      const code = c.req.query('code')
      if (c.req.query('error') !== undefined || !code) {
        // "If the user does not approve the request, the response contains an error message."
        return redirect(nextWithError(pending.next, c.req.query('error') !== undefined ? 'denied' : 'failed'))
      }

      const outcome = await exchangeCode(fetcher, config, redirectUri(c.req.url), code, limits.requestTimeoutMs)
      if (!outcome.ok) return redirect(nextWithError(pending.next, outcome.reason))

      await storeToken(c.env, config.encryptionKey, caller.id, outcome.token, outcome.expiresInSeconds)
      // §14: every link is audited. No token, no code.
      await auditStatement(
        c.env.DB,
        {
          actorId: caller.id,
          action: 'google.link',
          entityType: 'member',
          entityId: caller.id,
          workbookId: null,
          details: { scope: outcome.token.scope, expiresAt: new Date(outcome.token.expiresAt).toISOString() },
        },
        nowIso(),
      ).run()
      return redirect(pending.next)
    }),
  )

  // ── GET /api/google/link
  // OPEN: `email` is always null — reading it needs the `email` scope (G14).
  app.get(
    '/api/google/link',
    guarded(async (c) => {
      const caller = callerOf(c)
      const config = requireConfig(c)
      const link = await loadLink(c.env, config.encryptionKey, caller.id)
      return c.json<GoogleLinkResponse>({ state: link.state, email: null })
    }),
  )

  // ── POST /api/import/gsheets {source, title?} → 201 {workbookId, reportId}
  app.post(
    '/api/import/gsheets',
    guarded(async (c) => {
      const caller = callerOf(c)
      if (!canCreateWorkbooks(caller)) throw new ApiFailure(403, 'forbidden_create')
      const config = requireConfig(c)

      const body = await readJson(c)
      if (!isPlainObject(body)) throw new GoogleImportFailure(400, 'invalid_source')
      const spreadsheetId = parseSpreadsheetSource(body.source)
      if (spreadsheetId === null) throw new GoogleImportFailure(400, 'invalid_source')
      precheckTitle(body.title)

      const link = await loadLink(c.env, config.encryptionKey, caller.id)
      if (link.state === 'unlinked') throw new GoogleImportFailure(409, 'google_not_linked')
      if (link.state === 'expired') throw new GoogleImportFailure(409, 'google_link_expired')

      let read
      try {
        read = await readSpreadsheet({ fetch: fetcher, accessToken: link.token.accessToken, limits }, spreadsheetId)
      } catch (error) {
        if (error instanceof GoogleTokenRejected) {
          await discardToken(c.env, caller.id)
          throw new GoogleImportFailure(409, 'google_link_expired')
        }
        throw error
      }

      const title = resolveTitle(body.title, read.spreadsheet.properties?.title)
      const workbookId = crypto.randomUUID()
      const converted = convertSpreadsheet(read.spreadsheet, { workbookId })
      if (converted.workbook.sheetOrder.length === 0) throw new GoogleImportFailure(422, 'google_no_sheets')

      const result = await persistImport(c.env, {
        ownerId: caller.id,
        title,
        spreadsheetId,
        workbook: { ...converted.workbook, id: workbookId, name: title },
        report: converted.report,
        googleRequests: read.requests,
        maxInlineReportBytes: limits.maxInlineReportBytes,
      })
      return c.json<ImportGsheetsResponse>({ workbookId: result.workbookId, reportId: result.reportId }, 201)
    }),
  )

  // ── GET /api/workbooks/:id/import-report — same access as GET /api/workbooks/:id.
  app.get(
    '/api/workbooks/:id/import-report',
    guarded(async (c) => {
      const caller = callerOf(c)
      const id = c.req.param('id') ?? ''
      if (id === '' || id.length > MAX_ID_LENGTH) throw new ApiFailure(404, 'workbook_not_found')
      const row = await getWorkbookRow(c.env.DB, caller.id, id)
      if (!row || resolveAccess(caller, row.owner_id, row.member_role) === null) throw new ApiFailure(404, 'workbook_not_found')

      const stored = await latestImportReport(c.env, row.id)
      if (!stored) return c.json(googleErrorBody('import_report_not_found'), 404)
      return c.json<ImportReportResponse>({ reportId: stored.reportId, createdAt: stored.createdAt, report: stored.report })
    }),
  )
}
