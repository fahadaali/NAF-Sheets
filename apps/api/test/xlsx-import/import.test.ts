// POST /api/import/xlsx and POST /api/import/gsheets-link (owner decision
// 2026-11-11: no Google OAuth secret). Files come from the generators of
// @naf-sheets/xlsx-import (a synthesised Excel file and a file shaped like
// Google's real export); Google is a fake fetch serving what Google was
// observed to answer on 2026-11-11 (307 to doc-…-sheets.googleusercontent.com,
// then 200 with the file), plus every way a private or missing file can answer.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { ImportReportResponse, ImportXlsxResponse } from '@naf-sheets/shared'
import { DASHBOARD_SHEET_ID } from '@naf-sheets/shared'
import type { ImportReport } from '@naf-sheets/gsheets-import'
import { buildExcelFixture, buildGoogleStyleFixture } from '../../../../packages/xlsx-import/test/fixtures/excel-fixture'
import { buildZip } from '../../../../packages/xlsx-import/test/helpers/zip-writer'
import { registerGoogleImportRoutes } from '../../src/google-import'
import { registerXlsxImportRoutes, titleFromDisposition, type XlsxImportOptions } from '../../src/xlsx-import'
import { call, isArabic, json, seedMember, TEST_USER_HEADER, testApp } from '../helpers'

const ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
const LINK = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`
const EXPORT = `https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx`
const DOWNLOAD = `https://doc-08-4o-sheets.googleusercontent.com/export/abc/def/1794400970000/100630705629414352418/*/${ID}?format=xlsx`
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const HTMLVIEW = `https://docs.google.com/spreadsheets/d/${ID}/htmlview`
const HTMLVIEW_SHEET = `${HTMLVIEW}/sheet?headers=true&gid=0`
const HTML = { 'content-type': 'text/html; charset=utf-8' }
// Google's rendering, shaped like the real pages (packages/xlsx-import/test/fixtures/htmlview/):
// the index lists the sheet with JavaScript escapes («المهام»); the sheet page draws the
// dropdown cells C2:C3 of the Google-style fixture as chips, C2 coloured.
const INDEX_PAGE = `<script>var items = [];items.push({name: "\\u0627\\u0644\\u0645\\u0647\\u0627\\u0645", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/${ID}\\/htmlview\\/sheet?headers\\x3dtrue&gid=0", gid: "0"});</script>`
const chip = (bg: string, fg: string, text: string) => `<td class="s3"><span class="s4" style="background-color: ${bg}; color: ${fg}; width: 90.0px; max-width: 90.0px; margin-left: 6.0px;  padding: 1.0px 5.0px 1.0px 5.0px ; ">${text}</span></td>`
const SHEET_PAGE = `<table class="waffle" cellspacing="0" cellpadding="0"><thead><tr><th class="row-header freezebar-origin-ltr"></th><th id="0C0">A</th><th id="0C1">B</th><th id="0C2">C</th></tr></thead><tbody><tr><th id="0R0"><div>1</div></th><td>المهمة</td><td>منجزة</td><td>الحالة</td></tr><tr><th id="0R1"><div>2</div></th><td>إعداد الخطة</td><td></td>${chip('#bfe1f6', '#0a53a8', 'قيد التنفيذ')}</tr><tr><th id="0R2"><div>3</div></th><td>تصميم الهوية</td><td></td>${chip('#e8eaed', '#000000', 'منجز')}</tr></tbody></table>`

interface FakeCall {
  url: string
  init: RequestInit | undefined
}

type Answer = (url: string) => Response | Promise<Response>

function fakeGoogle(answers: Record<string, Answer>) {
  const calls: FakeCall[] = []
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init })
    const answer = answers[input]
    if (!answer) throw new Error(`unexpected fetch ${input}`)
    return answer(input)
  }
  return { fetch, calls }
}

async function publicFile(bytes?: Uint8Array, disposition = `attachment; filename="Plan.xlsx"; filename*=UTF-8''${encodeURIComponent('خطة الحملة')}.xlsx`) {
  const body = bytes ?? (await buildGoogleStyleFixture())
  return fakeGoogle({
    [EXPORT]: () => new Response(null, { status: 307, headers: { location: DOWNLOAD } }),
    [DOWNLOAD]: () => new Response(body, { status: 200, headers: { 'content-type': XLSX_TYPE, 'content-disposition': disposition, 'content-length': String(body.byteLength) } }),
    [HTMLVIEW]: () => new Response(INDEX_PAGE, { status: 200, headers: HTML }),
    [HTMLVIEW_SHEET]: () => new Response(SHEET_PAGE, { status: 200, headers: HTML }),
  })
}

function setup(options: XlsxImportOptions = {}) {
  const app = testApp()
  registerGoogleImportRoutes(app)
  registerXlsxImportRoutes(app, options)
  return app
}

async function upload(app: ReturnType<typeof setup>, user: { id: string } | null, bytes: Uint8Array | null, query = '', headers: Record<string, string> = {}) {
  const h = new Headers(headers)
  if (user) h.set(TEST_USER_HEADER, user.id)
  if (bytes && !h.has('content-length')) h.set('content-length', String(bytes.byteLength))
  h.set('content-type', 'application/octet-stream')
  return app.request(`/api/import/xlsx${query}`, { method: 'POST', headers: h, body: bytes }, env)
}

function linkImport(app: ReturnType<typeof setup>, user: { id: string }, body: unknown) {
  return call(app, 'POST', '/api/import/gsheets-link', { user, body })
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  const body = await json(res)
  expect(body).toMatchObject({ ok: false, error })
  expect(isArabic(body.message)).toBe(true)
  return body
}

async function workbookCount(userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM workbooks WHERE owner_id = ?1').bind(userId).first<{ n: number }>()
  return row?.n ?? 0
}

async function reportOf(app: ReturnType<typeof setup>, user: { id: string }, workbookId: string) {
  const res = await call(app, 'GET', `/api/workbooks/${workbookId}/import-report`, { user })
  expect(res.status).toBe(200)
  return (await json<ImportReportResponse>(res)).report as ImportReport
}

describe('POST /api/import/xlsx', () => {
  it('imports an Excel file: workbook, sheets, snapshot v1 with the dashboard first, report with the origin, audit', async () => {
    const app = setup()
    const editor = await seedMember('editor')
    const res = await upload(app, editor, await buildExcelFixture(), `?name=${encodeURIComponent('خطة الربع الأول.xlsx')}`)
    expect(res.status).toBe(201)
    const { workbookId, reportId } = await json<ImportXlsxResponse>(res)

    const wb = await env.DB.prepare('SELECT title, source, source_ref, owner_id, current_snapshot_version FROM workbooks WHERE id = ?1').bind(workbookId).first<Record<string, unknown>>()
    expect(wb).toMatchObject({ title: 'خطة الربع الأول', source: 'gsheets', owner_id: editor.id, current_snapshot_version: 1 })
    expect(String(wb?.source_ref)).toMatch(/^upload:[0-9a-f]{64}$/)
    const { results: sheets } = await env.DB.prepare('SELECT univer_sheet_id, title, position, sync_mode FROM sheets WHERE workbook_id = ?1 ORDER BY position').bind(workbookId).all()
    expect(sheets.map((s) => s.title)).toEqual(['المهام', 'القوائم', 'مخفية'])
    expect(sheets.every((s) => s.sync_mode === 'local')).toBe(true)

    const snapshot = (await (await env.SNAPSHOTS.get(`workbooks/${workbookId}/snapshots/1.json`))!.json()) as { sheetOrder: string[]; name: string }
    expect(snapshot.sheetOrder[0]).toBe(DASHBOARD_SHEET_ID)
    expect(snapshot.name).toBe('خطة الربع الأول')

    const report = await reportOf(app, editor, workbookId)
    expect(report.source.origin).toMatchObject({ kind: 'excel', via: 'upload', application: 'Microsoft Excel', fileName: 'خطة الربع الأول.xlsx', alignment: 'as_given' })
    expect(report.items.length).toBeGreaterThan(10)
    const stored = await env.DB.prepare('SELECT id FROM import_reports WHERE workbook_id = ?1').bind(workbookId).first<{ id: string }>()
    expect(stored?.id).toBe(reportId)

    const { results: audit } = await env.DB.prepare('SELECT action, details_json FROM audit_log WHERE entity_id = ?1 ORDER BY id').bind(workbookId).all<Record<string, string>>()
    expect(audit.map((a) => a.action)).toEqual(['workbook.create', 'workbook.import.xlsx'])
    const details = JSON.parse(audit[1]!.details_json!)
    expect(details).toMatchObject({ origin: 'excel', application: 'Microsoft Excel', reportId })
    expect(details.sha256).toMatch(/^[0-9a-f]{64}$/)
    // No cell content in the audit.
    expect(audit.map((a) => a.details_json).join('')).not.toContain('إعداد الخطة')
  })

  it('recognises a Google Sheets file a person downloaded and uploaded', async () => {
    const app = setup()
    const editor = await seedMember('editor')
    const res = await upload(app, editor, await buildGoogleStyleFixture(), '?name=tasks.xlsx&title=%20%D8%AE%D8%B7%D8%A9%20')
    expect(res.status).toBe(201)
    const { workbookId } = await json<ImportXlsxResponse>(res)
    const report = await reportOf(app, editor, workbookId)
    expect(report.source.title).toBe('خطة')
    expect(report.source.origin).toMatchObject({ kind: 'google_export', via: 'upload' })
    // An uploaded export carries no chip colours or display style (G32): said once.
    expect(report.items.map((i) => i.kind)).toEqual(['unsupported_formula', 'checkbox', 'data_validation'])
    expect(report.items[2]).toMatchObject({ outcome: 'not_transferred', location: null })
  })

  it('lets admins import and refuses viewers in the route, before reading the file', async () => {
    const app = setup()
    const admin = await seedMember('admin')
    expect((await upload(app, admin, await buildGoogleStyleFixture(), '?name=a.xlsx')).status).toBe(201)
    const viewer = await seedMember('viewer')
    const res = await upload(app, viewer, await buildGoogleStyleFixture(), '?name=a.xlsx')
    expect(res.status).toBe(403)
    expect(await json(res)).toMatchObject({ error: 'forbidden' })
    expect(await workbookCount(viewer.id)).toBe(0)
    expect((await upload(app, null, await buildGoogleStyleFixture())).status).toBe(401)
  })

  it('refuses a file over the size limit before reading it, and a body larger than declared', async () => {
    const app = setup({ limits: { maxFileBytes: 1000 } })
    const editor = await seedMember('editor')
    await expectError(await upload(app, editor, await buildGoogleStyleFixture()), 413, 'xlsx_file_too_large')
    const lying = await upload(app, editor, new Uint8Array(5000), '', { 'content-length': '900' }).catch(() => null)
    // workerd refuses a body longer than its Content-Length, or the route does.
    if (lying) expect([400, 413]).toContain(lying.status)
    expect(await workbookCount(editor.id)).toBe(0)
  })

  it('requires a length and a non-empty body', async () => {
    const app = setup()
    const editor = await seedMember('editor')
    await expectError(await upload(app, editor, new Uint8Array(), '', { 'content-length': '0' }), 400, 'xlsx_empty')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })
    const res = await app.request('/api/import/xlsx', { method: 'POST', headers: { [TEST_USER_HEADER]: editor.id }, body: stream, duplex: 'half' } as RequestInit, env)
    await expectError(res, 411, 'xlsx_length_required')
  })

  it('says what is wrong with files that are not .xlsx', async () => {
    const app = setup()
    const editor = await seedMember('editor')
    const enc = new TextEncoder()
    await expectError(await upload(app, editor, enc.encode('<!DOCTYPE html><html>Sign in</html>')), 415, 'xlsx_not_xlsx')
    await expectError(await upload(app, editor, enc.encode('a,b\n1,2\n')), 415, 'xlsx_not_xlsx')
    const ole = new Uint8Array(1024)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    await expectError(await upload(app, editor, ole), 415, 'xlsx_legacy_or_encrypted')
    const broken = (await buildGoogleStyleFixture()).slice(0, 2000)
    await expectError(await upload(app, editor, broken), 422, 'xlsx_corrupt')
    const chartsOnly = await buildZip([
      { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets/></workbook>' },
    ])
    await expectError(await upload(app, editor, chartsOnly), 422, 'xlsx_no_sheets')
    expect(await workbookCount(editor.id)).toBe(0)
  })

  it('stops a zip bomb (a part that unpacks far beyond its declared size)', async () => {
    const app = setup({ limits: { reader: { maxPartBytes: 4 * 1024 * 1024 } } })
    const editor = await seedMember('editor')
    const bomb = await buildZip([
      { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: new Uint8Array(32 * 1024 * 1024).fill(32), lieAboutSize: 100 },
    ])
    expect(bomb.byteLength).toBeLessThan(100 * 1024)
    await expectError(await upload(app, editor, bomb), 413, 'xlsx_unpacked_too_large')
  })

  it('refuses too many cells', async () => {
    const app = setup({ limits: { reader: { maxCells: 3 } } })
    const editor = await seedMember('editor')
    await expectError(await upload(app, editor, await buildGoogleStyleFixture()), 413, 'xlsx_unpacked_too_large')
  })

  it('validates the title like POST /api/workbooks', async () => {
    const app = setup()
    const editor = await seedMember('editor')
    await expectError(await upload(app, editor, await buildGoogleStyleFixture(), `?title=${'x'.repeat(201)}`), 400, 'invalid_title')
  })
})

describe('POST /api/import/gsheets-link', () => {
  it('downloads a public file as .xlsx without any Google account and imports it', async () => {
    const google = await publicFile()
    const app = setup({ fetch: google.fetch })
    const editor = await seedMember('editor')
    const res = await linkImport(app, editor, { source: LINK })
    expect(res.status).toBe(201)
    const { workbookId } = await json<ImportXlsxResponse>(res)

    // The export, then Google's rendering of the one sheet that holds a dropdown (G32).
    expect(google.calls.map((c) => c.url)).toEqual([EXPORT, DOWNLOAD, HTMLVIEW, HTMLVIEW_SHEET])
    for (const c of google.calls) {
      expect(c.init?.redirect).toBe('manual')
      const headers = new Headers(c.init?.headers)
      expect(headers.has('authorization')).toBe(false)
      expect(headers.has('cookie')).toBe(false)
      expect(c.init?.signal).toBeInstanceOf(AbortSignal)
    }
    const wb = await env.DB.prepare('SELECT title, source, source_ref FROM workbooks WHERE id = ?1').bind(workbookId).first<Record<string, unknown>>()
    expect(wb).toMatchObject({ title: 'خطة الحملة', source: 'gsheets', source_ref: ID })
    const report = await reportOf(app, editor, workbookId)
    expect(report.source).toMatchObject({ spreadsheetId: ID, title: 'خطة الحملة', origin: { kind: 'google_export', via: 'google_link' } })
    expect(report.items.find((i) => i.kind === 'unsupported_formula')?.detail).toBe('=QUERY(A1:C3,"select A",1)')
    const { results: audit } = await env.DB.prepare('SELECT action, details_json FROM audit_log WHERE entity_id = ?1 ORDER BY id').bind(workbookId).all<Record<string, string>>()
    expect(audit.map((a) => a.action)).toEqual(['workbook.create', 'workbook.import.gsheets_link'])
    expect(JSON.parse(audit[1]!.details_json!)).toMatchObject({ spreadsheetId: ID, downloadRequests: 2, renderingRequests: 2, origin: 'google_export' })
    // The chip colours Google showed reached the dropdown; nothing says they are missing.
    const snapshot = (await (await env.SNAPSHOTS.get(`workbooks/${workbookId}/snapshots/1.json`))!.json()) as { resources: Array<{ name: string; data: string }> }
    const dv = Object.values(JSON.parse(snapshot.resources.find((r) => r.name === 'SHEET_DATA_VALIDATION_PLUGIN')!.data) as Record<string, Array<{ type: string; renderMode: number; formula2?: string }>>).flat()
    expect(dv.find((r) => r.type === 'list')).toMatchObject({ renderMode: 2, formula2: '#bfe1f6,' })
    expect(report.items.filter((i) => i.kind === 'data_validation' && i.location === null)).toEqual([])
  })

  it("imports without colours, and says so, when Google's rendering cannot be read", async () => {
    const google = await publicFile()
    const app = setup({
      fetch: async (input, init) => (input.startsWith(HTMLVIEW) ? new Response('<html>Sign in</html>', { status: 401, headers: HTML }) : google.fetch(input, init)),
    })
    const editor = await seedMember('editor')
    const res = await linkImport(app, editor, { source: LINK })
    expect(res.status).toBe(201)
    const report = await reportOf(app, editor, (await json<ImportXlsxResponse>(res)).workbookId)
    const note = report.items.find((i) => i.kind === 'data_validation' && i.location === null)
    expect(note).toMatchObject({ outcome: 'not_transferred', detail: 'المهام' })
    expect(isArabic(note?.message ?? '')).toBe(true)
  })

  it('takes the title from the request when given', async () => {
    const google = await publicFile()
    const app = setup({ fetch: google.fetch })
    const editor = await seedMember('editor')
    const res = await linkImport(app, editor, { source: ID, title: 'عنوان آخر' })
    expect(res.status).toBe(201)
    const { workbookId } = await json<ImportXlsxResponse>(res)
    expect((await reportOf(app, editor, workbookId)).source.title).toBe('عنوان آخر')
  })

  const privateAnswers: Array<[string, Record<string, Answer>]> = [
    ['a redirect to Google sign-in', { [EXPORT]: () => new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin?service=wise&continue=x' } }) }],
    ['a sign-in page answered with 200', { [EXPORT]: () => new Response('<!DOCTYPE html><html><title>Sign in</title></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) }],
    ['an HTML page sent as a download', { [EXPORT]: () => new Response('<html><body>Sign in - Google Accounts</body></html>', { status: 200, headers: { 'content-type': 'application/octet-stream' } }) }],
    ['401', { [EXPORT]: () => new Response('no', { status: 401 }) }],
    ['403', { [EXPORT]: () => new Response('no', { status: 403 }) }],
    [
      'a redirect through docs.google.com to sign-in',
      {
        [EXPORT]: () => new Response(null, { status: 307, headers: { location: `/spreadsheets/d/${ID}/export?format=xlsx&x=1` } }),
        [`${EXPORT}&x=1`]: () => new Response(null, { status: 302, headers: { location: 'https://docs.google.com/ServiceLogin?passive=1' } }),
      },
    ],
  ]
  it.each(privateAnswers)('says the file is not shared by link: %s', async (_name, answers) => {
    const google = fakeGoogle(answers)
    const app = setup({ fetch: google.fetch })
    const editor = await seedMember('editor')
    const body = await expectError(await linkImport(app, editor, { source: LINK }), 403, 'gsheets_link_private')
    // What happened and what to do: share by link, or download as Excel and upload.
    expect(body.message).toContain('أي شخص لديه الرابط')
    expect(body.message).toContain('Microsoft Excel')
    expect(await workbookCount(editor.id)).toBe(0)
  })

  it.each([404, 410])('says the file was not found (%i)', async (status) => {
    const google = fakeGoogle({ [EXPORT]: () => new Response('<html></html>', { status, headers: { 'content-type': 'text/html' } }) })
    const app = setup({ fetch: google.fetch })
    await expectError(await linkImport(app, await seedMember('editor'), { source: LINK }), 404, 'gsheets_link_not_found')
  })

  it('refuses a download over the size limit, declared or streamed', async () => {
    const editor = await seedMember('editor')
    const declared = fakeGoogle({ [EXPORT]: () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': XLSX_TYPE, 'content-length': String(50 * 1024 * 1024) } }) })
    await expectError(await linkImport(setup({ fetch: declared.fetch }), editor, { source: LINK }), 413, 'gsheets_link_too_large')
    const streamed = fakeGoogle({
      [EXPORT]: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(1024))
              controller.close()
            },
          }),
          { status: 200, headers: { 'content-type': XLSX_TYPE } },
        ),
    })
    await expectError(await linkImport(setup({ fetch: streamed.fetch, limits: { maxFileBytes: 4096 } }), editor, { source: LINK }), 413, 'gsheets_link_too_large')
  })

  it('says when what Google sent is not a spreadsheet', async () => {
    const google = fakeGoogle({ [EXPORT]: () => new Response(new TextEncoder().encode('%PDF-1.7 ...'), { status: 200, headers: { 'content-type': 'application/pdf' } }) })
    await expectError(await linkImport(setup({ fetch: google.fetch }), await seedMember('editor'), { source: LINK }), 415, 'xlsx_not_xlsx')
  })

  it('passes on rate limits and outages', async () => {
    const editor = await seedMember('editor')
    const limited = fakeGoogle({ [EXPORT]: () => new Response('', { status: 429, headers: { 'retry-after': '30' } }) })
    const res = await linkImport(setup({ fetch: limited.fetch }), editor, { source: LINK })
    await expectError(res, 429, 'gsheets_link_rate_limited')
    expect(res.headers.get('retry-after')).toBe('30')
    const down = fakeGoogle({ [EXPORT]: () => new Response('', { status: 500 }) })
    await expectError(await linkImport(setup({ fetch: down.fetch }), editor, { source: LINK }), 503, 'gsheets_link_unavailable')
    const offline = fakeGoogle({
      [EXPORT]: () => {
        throw new TypeError('network')
      },
    })
    await expectError(await linkImport(setup({ fetch: offline.fetch }), editor, { source: LINK }), 503, 'gsheets_link_unavailable')
  })

  it('follows redirects only to Google’s own hosts (no SSRF), and only a few', async () => {
    const editor = await seedMember('editor')
    for (const location of ['http://doc-08-4o-sheets.googleusercontent.com/x', 'https://evil.example/x', 'https://169.254.169.254/latest', 'https://docs.google.com/document/d/x/export', 'https://user:pw@doc-08-4o-sheets.googleusercontent.com/x', 'https://doc-08-4o-sheets.googleusercontent.com:8443/x']) {
      const google = fakeGoogle({ [EXPORT]: () => new Response(null, { status: 307, headers: { location } }) })
      await expectError(await linkImport(setup({ fetch: google.fetch }), editor, { source: LINK }), 502, 'gsheets_link_unavailable')
      expect(google.calls).toHaveLength(1)
    }
    const loop = fakeGoogle({ [EXPORT]: () => new Response(null, { status: 307, headers: { location: EXPORT } }) })
    await expectError(await linkImport(setup({ fetch: loop.fetch }), editor, { source: LINK }), 502, 'gsheets_link_unavailable')
    expect(loop.calls.length).toBe(4)
  })

  it('accepts only Google Sheets links (G6) and fetches nothing otherwise', async () => {
    const google = await publicFile()
    const app = setup({ fetch: google.fetch })
    const editor = await seedMember('editor')
    for (const source of ['https://drive.google.com/file/d/abc/view', `http://docs.google.com/spreadsheets/d/${ID}/edit`, 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT/pubhtml', 'https://evil.example/spreadsheets/d/x', 'not a link', 42, null]) {
      const body = await expectError(await linkImport(app, editor, { source }), 400, 'invalid_source')
      expect(body.message).toContain('رفع ملف Excel')
    }
    expect(google.calls).toHaveLength(0)
  })

  it('refuses viewers before fetching anything', async () => {
    const google = await publicFile()
    const app = setup({ fetch: google.fetch })
    const res = await linkImport(app, await seedMember('viewer'), { source: LINK })
    expect(res.status).toBe(403)
    expect(google.calls).toHaveLength(0)
  })

  it('works without any Google OAuth configuration', async () => {
    const google = await publicFile()
    const app = setup({ fetch: google.fetch })
    // `env` has no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: the OAuth path answers 503, this one works.
    expect((await call(app, 'GET', '/api/google/link', { user: await seedMember('editor') })).status).toBe(503)
    expect((await linkImport(app, await seedMember('editor'), { source: LINK })).status).toBe(201)
  })
})

describe('Content-Disposition title', () => {
  it('prefers the UTF-8 name and drops the extension', () => {
    expect(titleFromDisposition(`attachment; filename="ExampleSpreadsheet.xlsx"; filename*=UTF-8''Example%20Spreadsheet.xlsx`)).toBe('Example Spreadsheet')
    expect(titleFromDisposition('attachment; filename="Plan.xlsx"')).toBe('Plan')
    expect(titleFromDisposition(null)).toBeNull()
    expect(titleFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`)).toBeNull()
  })
})
