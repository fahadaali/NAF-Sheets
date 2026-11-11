// POST /api/import/gsheets and GET /api/workbooks/:id/import-report, against a
// fake Google serving the synthetic fixture of @naf-sheets/gsheets-import.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { convertSpreadsheet } from '@naf-sheets/gsheets-import'
import type { ImportGsheetsResponse, ImportReportResponse } from '@naf-sheets/shared'
import { DASHBOARD_SHEET_ID, withDashboardSheet } from '@naf-sheets/shared'
import { nafCommsPlan } from '../../../../packages/gsheets-import/test/fixtures/naf-comms-plan'
import { registerGoogleImportRoutes } from '../../src/google-import'
import type { GoogleImportLimits } from '../../src/google-import'
import { linkKey, tokenKey } from '../../src/google-import/oauth'
import { importReportKey } from '../../src/google-import/store'
import { addMember, call, createWorkbook, isArabic, json, seedMember, testApp } from '../helpers'
import { ACCESS_TOKEN, fakeGoogle, googleEnv, googleJsonError, linkGoogle, parseA1, withoutComments } from './google-fake'
import type { FakeGoogleOptions } from './google-fake'

const SPREADSHEET_ID = nafCommsPlan.spreadsheetId as string
const URL_SOURCE = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=0`
const GOOGLE_TITLE = 'خطة الاتصال المؤسسي 2026'

function setup(options: FakeGoogleOptions = {}, limits: Partial<GoogleImportLimits> = {}) {
  const fake = fakeGoogle({ spreadsheet: nafCommsPlan, ...options })
  const app = testApp()
  registerGoogleImportRoutes(app, { fetch: fake.fetch, limits })
  return { app, fake }
}

async function linkedEditor(app: ReturnType<typeof testApp>) {
  const editor = await seedMember('editor')
  const res = await linkGoogle(app, editor)
  if (res.status !== 302) throw new Error(`link failed: ${res.status}`)
  return editor
}

async function importFile(app: ReturnType<typeof testApp>, user: { id: string }, body: unknown) {
  return call(app, 'POST', '/api/import/gsheets', { user, body, env: googleEnv })
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  const body = await json(res)
  expect(body).toMatchObject({ ok: false, error })
  expect(isArabic(body.message)).toBe(true)
  return body
}

async function workbooksOwnedBy(userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM workbooks WHERE owner_id = ?1').bind(userId).first<{ n: number }>()
  return row?.n ?? 0
}

describe('POST /api/import/gsheets', () => {
  it('imports the fixture in row bands: workbook, sheets, snapshot v1, report and audit — identical to converting the whole file', async () => {
    // 300 cells per request forces several bands per sheet (المهام: 100 × 10).
    const { app, fake } = setup({}, { cellsPerRequest: 300 })
    const editor = await linkedEditor(app)
    fake.calls.length = 0

    const res = await importFile(app, editor, { source: URL_SOURCE })
    expect(res.status).toBe(201)
    const { workbookId, reportId } = await json<ImportGsheetsResponse>(res)

    // ---- Google: read-only GETs, the user's token, a fields mask on every call.
    const sheetsCalls = fake.sheetsCallsOf()
    expect(fake.calls).toHaveLength(sheetsCalls.length)
    for (const c of sheetsCalls) {
      expect(c.method).toBe('GET')
      expect(c.url.pathname).toBe(`/v4/spreadsheets/${SPREADSHEET_ID}`)
      expect(c.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
      expect(c.url.searchParams.get('fields')).toBeTruthy()
      expect(c.url.searchParams.has('commentsViewMode')).toBe(false)
    }
    const [metadataCall, ...gridCalls] = sheetsCalls
    expect(metadataCall!.url.searchParams.get('includeGridData')).toBe('false')
    expect(metadataCall!.url.searchParams.getAll('ranges')).toEqual([])
    expect(metadataCall!.url.searchParams.get('fields')).not.toContain('sheets.data')
    expect(gridCalls.length).toBeGreaterThan(4)
    const covered = new Map<string, number>()
    for (const c of gridCalls) {
      expect(c.url.searchParams.get('includeGridData')).toBe('true')
      expect(c.url.searchParams.get('fields')).toContain('sheets.data.rowData.values')
      let cells = 0
      for (const r of c.url.searchParams.getAll('ranges').map(parseA1)) {
        cells += (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1)
        covered.set(r.title, (covered.get(r.title) ?? 0) + (r.endRow - r.startRow + 1))
      }
      expect(cells).toBeLessThanOrEqual(300)
    }
    // Every row of every grid sheet, once; the chart sheet has no grid.
    expect(Object.fromEntries(covered)).toEqual({ المهام: 100, الملخص: 50, القوائم: 20, تحليل: 30 })

    // ---- The snapshot equals converting the whole file (comments aside: never requested).
    const expected = convertSpreadsheet(withoutComments(nafCommsPlan), { workbookId })
    const object = await env.SNAPSHOTS.get(`workbooks/${workbookId}/snapshots/1.json`)
    expect(object).not.toBeNull()
    // The converter makes no dashboard sheet; the stored workbook gets the platform's own «اللوحة» first.
    expect(expected.workbook.sheetOrder).not.toContain(DASHBOARD_SHEET_ID)
    const stored = (await object!.json()) as { sheetOrder: string[] }
    expect(stored).toEqual(JSON.parse(JSON.stringify(withDashboardSheet({ ...expected.workbook, id: workbookId, name: GOOGLE_TITLE }))))
    expect(stored.sheetOrder[0]).toBe(DASHBOARD_SHEET_ID)

    // ---- D1: workbook, sheets in tab order, report.
    const workbook = await env.DB.prepare('SELECT * FROM workbooks WHERE id = ?1').bind(workbookId).first<Record<string, unknown>>()
    expect(workbook).toMatchObject({
      title: GOOGLE_TITLE,
      owner_id: editor.id,
      source: 'gsheets',
      source_ref: SPREADSHEET_ID,
      bc_project_id: null,
      current_snapshot_version: 1,
      archived_at: null,
    })
    const { results: sheets } = await env.DB.prepare('SELECT univer_sheet_id, title, position, sync_mode, bc_todolist_id, header_row FROM sheets WHERE workbook_id = ?1 ORDER BY position')
      .bind(workbookId)
      .all<Record<string, unknown>>()
    expect(sheets).toEqual([
      { univer_sheet_id: 'sheet-0', title: 'المهام', position: 1, sync_mode: 'local', bc_todolist_id: null, header_row: 1 },
      { univer_sheet_id: 'sheet-1234', title: 'الملخص', position: 2, sync_mode: 'local', bc_todolist_id: null, header_row: 1 },
      { univer_sheet_id: 'sheet-555', title: 'القوائم', position: 3, sync_mode: 'local', bc_todolist_id: null, header_row: 1 },
      { univer_sheet_id: 'sheet-777', title: 'تحليل', position: 4, sync_mode: 'local', bc_todolist_id: null, header_row: 1 },
    ])
    expect(expected.workbook.sheetOrder).toEqual(sheets.map((s) => s.univer_sheet_id))

    const report = await env.DB.prepare('SELECT * FROM import_reports WHERE id = ?1').bind(reportId).first<Record<string, unknown>>()
    expect(report).toMatchObject({ workbook_id: workbookId, gsheet_id: SPREADSHEET_ID })
    expect(JSON.parse(String(report?.summary_json))).toEqual(JSON.parse(JSON.stringify(expected.report)))
    // The fixture exercises what is not transferred: it must be in the report.
    const kinds = new Set<string>(expected.report.items.map((i) => i.kind))
    for (const kind of ['unsupported_formula', 'chart', 'pivot_table', 'protected_range', 'filter_view', 'object_sheet']) expect(kinds.has(kind), kind).toBe(true)

    // ---- Audit: creation and import, no cell content, no token.
    const { results: audit } = await env.DB.prepare('SELECT action, actor_id, details_json FROM audit_log WHERE entity_id = ?1 ORDER BY id').bind(workbookId).all<Record<string, string>>()
    expect(audit.map((a) => a.action)).toEqual(['workbook.create', 'workbook.import.gsheets'])
    expect(audit.every((a) => a.actor_id === editor.id)).toBe(true)
    const details = JSON.parse(audit[1]!.details_json!)
    expect(details).toMatchObject({ spreadsheetId: SPREADSHEET_ID, reportId, googleRequests: sheetsCalls.length, reportInR2: false })
    expect(audit.map((a) => a.details_json).join('')).not.toContain(ACCESS_TOKEN)

    // ---- Opens like any workbook.
    const opened = await call(app, 'GET', `/api/workbooks/${workbookId}`, { user: editor, env: googleEnv })
    expect(opened.status).toBe(200)
    expect(await json(opened)).toMatchObject({ workbook: { source: 'gsheets', title: GOOGLE_TITLE, sheetCount: 4 }, version: 1 })
  })

  it('makes one metadata and one grid request for a small file, and accepts a bare id and a custom title', async () => {
    const { app, fake } = setup()
    const editor = await linkedEditor(app)
    fake.calls.length = 0
    const res = await importFile(app, editor, { source: `  ${SPREADSHEET_ID} `, title: '  نسخة الاستيراد  ' })
    expect(res.status).toBe(201)
    const { workbookId } = await json<ImportGsheetsResponse>(res)
    expect(fake.sheetsCallsOf()).toHaveLength(2)
    const row = await env.DB.prepare('SELECT title FROM workbooks WHERE id = ?1').bind(workbookId).first<{ title: string }>()
    expect(row?.title).toBe('نسخة الاستيراد')
    const snapshot = (await (await env.SNAPSHOTS.get(`workbooks/${workbookId}/snapshots/1.json`))!.json()) as { id: string; name: string }
    expect(snapshot).toMatchObject({ id: workbookId, name: 'نسخة الاستيراد' })
  })

  it('cuts a Google title longer than 200 characters to 200', async () => {
    const long = { ...nafCommsPlan, properties: { ...nafCommsPlan.properties, title: 'م'.repeat(250) } }
    const { app } = setup({ spreadsheet: long })
    const editor = await linkedEditor(app)
    const res = await importFile(app, editor, { source: SPREADSHEET_ID })
    expect(res.status).toBe(201)
    const { workbookId } = await json<ImportGsheetsResponse>(res)
    const row = await env.DB.prepare('SELECT title FROM workbooks WHERE id = ?1').bind(workbookId).first<{ title: string }>()
    expect(row?.title).toBe('م'.repeat(200))
  })

  it('refuses a viewer with 403 before anything else, and creates nothing', async () => {
    const { app, fake } = setup()
    const viewer = await seedMember('viewer')
    await expectError(await importFile(app, viewer, { source: SPREADSHEET_ID }), 403, 'forbidden')
    expect(fake.calls).toHaveLength(0)
    expect(await workbooksOwnedBy(viewer.id)).toBe(0)
  })

  it('lets an admin import', async () => {
    const { app } = setup()
    const admin = await seedMember('admin')
    expect((await linkGoogle(app, admin)).status).toBe(302)
    expect((await importFile(app, admin, { source: SPREADSHEET_ID })).status).toBe(201)
  })

  it('validates the body before calling Google', async () => {
    const { app, fake } = setup()
    const editor = await linkedEditor(app)
    fake.calls.length = 0
    await expectError(await importFile(app, editor, { source: 'not a link' }), 400, 'invalid_source')
    await expectError(await importFile(app, editor, { source: `https://drive.google.com/file/d/${SPREADSHEET_ID}/view` }), 400, 'invalid_source')
    await expectError(await importFile(app, editor, {}), 400, 'invalid_source')
    await expectError(await importFile(app, editor, [SPREADSHEET_ID]), 400, 'invalid_source')
    await expectError(await importFile(app, editor, { source: SPREADSHEET_ID, title: '   ' }), 400, 'invalid_title')
    await expectError(await importFile(app, editor, { source: SPREADSHEET_ID, title: 'x'.repeat(201) }), 400, 'invalid_title')
    await expectError(await importFile(app, editor, { source: SPREADSHEET_ID, title: 7 }), 400, 'invalid_title')
    const raw = await call(app, 'POST', '/api/import/gsheets', { user: editor, rawBody: '{oops', env: googleEnv })
    await expectError(raw, 400, 'invalid_json')
    expect(fake.calls).toHaveLength(0)
    expect(await workbooksOwnedBy(editor.id)).toBe(0)
  })

  it('answers 409 google_not_linked with the start URL when Google is not linked', async () => {
    const { app, fake } = setup()
    const editor = await seedMember('editor')
    const body = await expectError(await importFile(app, editor, { source: SPREADSHEET_ID }), 409, 'google_not_linked')
    expect(body.link).toBe('/auth/google/start')
    expect(fake.calls).toHaveLength(0)
  })

  it('answers 409 google_link_expired with the start URL when the link has expired', async () => {
    const { app, fake } = setup()
    const editor = await seedMember('editor')
    await env.SETTINGS.put(linkKey(editor.id), JSON.stringify({ linkedAt: new Date().toISOString() }))
    const body = await expectError(await importFile(app, editor, { source: SPREADSHEET_ID }), 409, 'google_link_expired')
    expect(body.link).toBe('/auth/google/start')
    expect(fake.calls).toHaveLength(0)
  })

  it('maps Google failures to Arabic errors and creates nothing', async () => {
    const cases: Array<{ answer: Response | 'network'; status: number; error: string; retryAfter?: string | null }> = [
      { answer: googleJsonError(403, 'The caller does not have permission'), status: 403, error: 'google_file_forbidden' },
      { answer: googleJsonError(404, 'Requested entity was not found.'), status: 404, error: 'google_file_not_found' },
      { answer: googleJsonError(429, 'Quota exceeded', { 'retry-after': '17' }), status: 429, error: 'google_rate_limited', retryAfter: '17' },
      { answer: googleJsonError(429, 'Quota exceeded'), status: 429, error: 'google_rate_limited', retryAfter: '60' },
      { answer: googleJsonError(500, 'Internal error'), status: 503, error: 'google_unavailable' },
      { answer: googleJsonError(503, 'Unavailable'), status: 503, error: 'google_unavailable' },
      { answer: 'network', status: 503, error: 'google_unavailable' },
      { answer: googleJsonError(400, 'Unable to parse range'), status: 502, error: 'google_bad_response' },
      { answer: new Response('<html>not json</html>', { status: 200 }), status: 502, error: 'google_bad_response' },
    ]
    for (const { answer, status, error, retryAfter } of cases) {
      // Fail the metadata call, and separately the first grid call.
      for (const failAt of [0, 1]) {
        const { app } = setup({ sheets: (n) => (n === failAt ? (answer instanceof Response ? answer.clone() : answer) : null) })
        const editor = await linkedEditor(app)
        const res = await importFile(app, editor, { source: SPREADSHEET_ID })
        expect(res.status, `${error} at call ${failAt}`).toBe(status)
        if (retryAfter !== undefined) expect(res.headers.get('retry-after')).toBe(retryAfter)
        await expectError(res, status, error)
        expect(await workbooksOwnedBy(editor.id)).toBe(0)
      }
    }
  })

  it('answers google_file_not_found for a file Google does not know', async () => {
    const { app } = setup()
    const editor = await linkedEditor(app)
    await expectError(await importFile(app, editor, { source: 'Zz9'.repeat(10) }), 404, 'google_file_not_found')
  })

  it('treats a 401 from Google as an expired link: the token is dropped and the user is sent to relink', async () => {
    const { app } = setup({ sheets: () => googleJsonError(401, 'Request had invalid authentication credentials.') })
    const editor = await linkedEditor(app)
    const body = await expectError(await importFile(app, editor, { source: SPREADSHEET_ID }), 409, 'google_link_expired')
    expect(body.link).toBe('/auth/google/start')
    expect(await env.SETTINGS.get(tokenKey(editor.id))).toBeNull()
    const link = await call(app, 'GET', '/api/google/link', { user: editor, env: googleEnv })
    expect(await json(link)).toEqual({ state: 'expired', email: null })
  })

  it('refuses a file whose declared grid is too large before fetching any cell', async () => {
    const { app, fake } = setup({}, { maxDeclaredCells: 1000 })
    const editor = await linkedEditor(app)
    fake.calls.length = 0
    await expectError(await importFile(app, editor, { source: SPREADSHEET_ID }), 413, 'google_file_too_large')
    expect(fake.sheetsCallsOf()).toHaveLength(1)
    expect(await workbooksOwnedBy(editor.id)).toBe(0)
  })

  it('refuses a file whose responses exceed the byte budget', async () => {
    const { app } = setup({}, { maxResponseBytes: 20_000 })
    const editor = await linkedEditor(app)
    await expectError(await importFile(app, editor, { source: SPREADSHEET_ID }), 413, 'google_file_too_large')
    expect(await workbooksOwnedBy(editor.id)).toBe(0)
  })

  it('refuses a file with no grid sheet', async () => {
    const chartsOnly = { ...nafCommsPlan, sheets: (nafCommsPlan.sheets ?? []).filter((s) => s.properties?.sheetType === 'OBJECT') }
    const { app, fake } = setup({ spreadsheet: chartsOnly })
    const editor = await linkedEditor(app)
    fake.calls.length = 0
    await expectError(await importFile(app, editor, { source: SPREADSHEET_ID }), 422, 'google_no_sheets')
    expect(fake.sheetsCallsOf()).toHaveLength(1)
  })

  it('keeps a report too large for D1 in R2 and still serves it', async () => {
    const { app } = setup({}, { maxInlineReportBytes: 100 })
    const editor = await linkedEditor(app)
    const res = await importFile(app, editor, { source: SPREADSHEET_ID })
    expect(res.status).toBe(201)
    const { workbookId, reportId } = await json<ImportGsheetsResponse>(res)
    const row = await env.DB.prepare('SELECT summary_json FROM import_reports WHERE id = ?1').bind(reportId).first<{ summary_json: string }>()
    expect(JSON.parse(row!.summary_json)).toMatchObject({ storage: 'r2', key: importReportKey(workbookId, reportId) })
    expect(await env.SNAPSHOTS.head(importReportKey(workbookId, reportId))).not.toBeNull()

    const report = await call(app, 'GET', `/api/workbooks/${workbookId}/import-report`, { user: editor, env: googleEnv })
    expect(report.status).toBe(200)
    const expected = convertSpreadsheet(withoutComments(nafCommsPlan), { workbookId }).report
    expect((await json<ImportReportResponse>(report)).report).toEqual(JSON.parse(JSON.stringify(expected)))
  })
})

describe('GET /api/workbooks/:id/import-report', () => {
  async function imported() {
    const { app } = setup()
    const owner = await linkedEditor(app)
    const res = await importFile(app, owner, { source: SPREADSHEET_ID })
    const ids = await json<ImportGsheetsResponse>(res)
    return { app, owner, ...ids }
  }

  it('returns the latest report to the owner, members (viewers included) and admins', async () => {
    const { app, owner, workbookId, reportId } = await imported()
    const editor = await seedMember('editor')
    const reader = await seedMember('viewer')
    const admin = await seedMember('admin')
    await addMember(workbookId, editor.id, 'editor', owner.id)
    await addMember(workbookId, reader.id, 'viewer', owner.id)
    const expected = JSON.parse(JSON.stringify(convertSpreadsheet(withoutComments(nafCommsPlan), { workbookId }).report))

    for (const user of [owner, editor, reader, admin]) {
      const res = await call(app, 'GET', `/api/workbooks/${workbookId}/import-report`, { user, env: googleEnv })
      expect(res.status, user.role).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = await json<ImportReportResponse>(res)
      expect(body.reportId).toBe(reportId)
      expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(body.report).toEqual(expected)
    }
  })

  it('answers 404 to non-members, exactly like GET /api/workbooks/:id', async () => {
    const { app, workbookId } = await imported()
    const stranger = await seedMember('editor')
    const report = await call(app, 'GET', `/api/workbooks/${workbookId}/import-report`, { user: stranger, env: googleEnv })
    const workbook = await call(app, 'GET', `/api/workbooks/${workbookId}`, { user: stranger, env: googleEnv })
    expect(report.status).toBe(404)
    expect(await json(report)).toEqual(await json(workbook))
  })

  it('answers 404 for an unknown or archived workbook', async () => {
    const { app, owner, workbookId } = await imported()
    await expectError(await call(app, 'GET', `/api/workbooks/no-such-id/import-report`, { user: owner, env: googleEnv }), 404, 'not_found')
    await env.DB.prepare('UPDATE workbooks SET archived_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), workbookId).run()
    await expectError(await call(app, 'GET', `/api/workbooks/${workbookId}/import-report`, { user: owner, env: googleEnv }), 404, 'not_found')
  })

  it('answers 404 with its own message for a workbook that was not imported', async () => {
    const { app } = setup()
    const owner = await seedMember('editor')
    const workbookId = await createWorkbook(app, owner)
    const body = await expectError(await call(app, 'GET', `/api/workbooks/${workbookId}/import-report`, { user: owner, env: googleEnv }), 404, 'not_found')
    expect(body.message).toContain('تقرير استيراد')
  })
})
