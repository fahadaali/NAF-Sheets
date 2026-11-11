// Browser smoke test of the wave 2 screens (Basecamp account link, «ملف جديد»
// import, import report, linking wizard, people matching) against the built
// app, with the API mocked by route interception (mock-api.ts). Same harness
// as smoke.test.ts: vite preview on :4174, headless Chromium, hermetic.
//
// Page navigations to /auth/basecamp/start and /auth/google/start are
// answered with a stub page, so the test sees where the browser was sent.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ImportReport } from '@naf-sheets/gsheets-import'
import type { LinkPlan, SheetMeta } from '@naf-sheets/shared'
import { BASE_URL } from './global-setup'
import { openFirstSheet } from './editor-tabs'
import { error, MockApi, sheetMeta, summary, taskSnapshot } from './mock-api'

const SHOTS = process.env.E2E_SCREENSHOTS ?? fileURLToPath(new URL('./screenshots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

let browser: Browser
const pageErrors: string[] = []
const blockedRequests: string[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})

async function openPage(api: MockApi, path: string, viewport = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
  await context.route(
    (url) => !url.href.startsWith(BASE_URL),
    (route) => {
      blockedRequests.push(route.request().url())
      return route.abort()
    },
  )
  // The OAuth starts are server redirects; here they land on a stub.
  await context.route(`${BASE_URL}/auth/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>oauth</title>' }))
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${String(e).slice(0, 300)}`))
  await api.install(page)
  await page.goto(BASE_URL + path)
  return { context, page }
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })

async function waitForEditor(page: Page): Promise<void> {
  await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
  // The realtime room has answered (the mock API has none: the editor falls back to PUT).
  await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 30_000 })
  // A workbook opens on «اللوحة»; these tests are about the grid.
  await openFirstSheet(page)
}

const GRID = { rowHeaderWidth: 46, columnHeaderHeight: 20, columnWidth: 88, rowHeight: 24 }
async function typeIntoCell(page: Page, column: number, row: number, text: string): Promise<void> {
  const box = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!box) throw new Error('sheet canvas not found')
  const x = box.x + box.width - GRID.rowHeaderWidth - GRID.columnWidth * column - GRID.columnWidth / 2
  const y = box.y + GRID.columnHeaderHeight + GRID.rowHeight * row + GRID.rowHeight / 2
  await page.mouse.dblclick(x, y)
  await page.waitForTimeout(300)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const meta = (univerSheetId: string, title: string, position: number, over: Partial<SheetMeta> = {}): SheetMeta => ({
  ...sheetMeta(univerSheetId, title),
  position,
  ...over,
})

// ---------------------------------------------------------------------------

describe('Basecamp account link (§3)', () => {
  it('the files screen asks an unlinked editor to link, and the button goes to Launchpad with this page as `next`', async () => {
    const api = new MockApi()
    api.basecampLink = { state: 'unlinked', bcPersonId: null, bcAccountId: null, name: null }
    const { context, page } = await openPage(api, '/')
    const banner = page.getByTestId('basecamp-banner')
    await banner.waitFor()
    expect(await banner.innerText()).toContain('اربط حسابك في Basecamp')
    expect(await banner.innerText()).toContain('باسمك أنت')
    await shot(page, 'files-basecamp-banner')
    await banner.getByRole('link', { name: 'ربط الحساب' }).click()
    await page.waitForURL((url) => url.pathname === '/auth/basecamp/start')
    expect(new URL(page.url()).searchParams.get('next')).toBe('/')
    await context.close()
  })

  it('a platform viewer is not asked to link (and the link is not even read)', async () => {
    const api = new MockApi()
    api.me = { user: { ...api.me.user, role: 'viewer' } }
    api.basecampLink = { state: 'unlinked', bcPersonId: null, bcAccountId: null, name: null }
    const { context, page } = await openPage(api, '/')
    await page.getByTestId('files-empty').waitFor()
    await page.waitForTimeout(300)
    expect(await page.getByTestId('basecamp-banner').count()).toBe(0)
    expect(api.count('GET', '/api/basecamp/link')).toBe(0)
    await context.close()
  })

  it('settings: «إلغاء الربط» asks first, then revokes; expired and revoked states are explained', async () => {
    const api = new MockApi()
    const { context, page } = await openPage(api, '/')
    await page.getByTestId('settings-link').click()
    await page.waitForURL(`${BASE_URL}/settings`)
    const card = page.getByTestId('basecamp-account')
    await card.getByText('مرتبط باسم').waitFor()
    expect(await card.innerText()).toContain('Fahad Alotaibi')
    expect(await card.getByTestId('basecamp-link-state').getAttribute('data-state')).toBe('active')
    await shot(page, 'settings-linked')

    // The safe answer changes nothing.
    await card.getByRole('button', { name: 'إلغاء الربط' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'إلغاء ربط حسابك في Basecamp؟' })
    await dialog.waitFor()
    expect(await dialog.innerText()).toContain('لا يُحذف شيء من Basecamp')
    await shot(page, 'settings-revoke-confirm')
    await dialog.getByRole('button', { name: 'الإبقاء على الربط' }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(api.count('POST', '/api/basecamp/link/revoke')).toBe(0)

    await card.getByRole('button', { name: 'إلغاء الربط' }).click()
    await dialog.getByRole('button', { name: 'إلغاء الربط' }).click()
    await page.getByTestId('basecamp-revoked').waitFor()
    expect(api.count('POST', '/api/basecamp/link/revoke')).toBe(1)
    expect(await card.getByTestId('basecamp-link-state').getAttribute('data-state')).toBe('revoked')
    expect(await card.getByTestId('basecamp-explain').innerText()).toContain('ربط حسابك في Basecamp ملغى')
    expect(await card.getByRole('link', { name: 'إعادة الربط' }).getAttribute('href')).toBe('/auth/basecamp/start?next=%2Fsettings')

    api.basecampLink = { ...api.basecampLink, state: 'expired' }
    await page.reload()
    await card.getByTestId('basecamp-explain').waitFor()
    expect(await card.getByTestId('basecamp-explain').innerText()).toContain('انتهت صلاحية ربط حسابك')
    await context.close()
  })

  it('the editor keeps a synced sheet read-only until the account is linked again', async () => {
    const api = new MockApi()
    api.basecampLink = { ...api.basecampLink, state: 'expired' }
    api.add(summary({ id: 'wb-s', title: 'ملف متزامن', bcProjectId: 4021, syncState: 'synced' }), taskSnapshot('wb-s', 'sheet-1', 'ملف'), 3, [
      meta('sheet-1', 'المهام', 1, { syncMode: 'synced', bcTodolistId: 70 }),
    ])
    const { context, page } = await openPage(api, '/workbooks/wb-s')
    await waitForEditor(page)
    const banner = page.getByTestId('editor-basecamp-link')
    await banner.waitFor()
    const text = await banner.innerText()
    expect(text).toContain('انتهت صلاحية ربط حسابك في Basecamp')
    expect(text).toContain('الأوراق المتزامنة في هذا الملف للقراءة فقط لك')
    expect(await page.getByTestId('univer-host').getAttribute('data-editable')).toBe('false')
    expect(await banner.getByRole('link', { name: 'إعادة الربط' }).getAttribute('href')).toBe('/auth/basecamp/start?next=%2Fworkbooks%2Fwb-s%3Fsheet%3Dsheet-1')
    await shot(page, 'editor-basecamp-locked')
    // Univer refuses the edit with its own "protected" dialog; nothing is saved.
    await typeIntoCell(page, 1, 3, 'تعديل لا يُرسل')
    await page.waitForTimeout(3000)
    expect(api.puts()).toHaveLength(0)
    await context.close()
  })
})

// ---------------------------------------------------------------------------

const SPREADSHEET_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'

function importedSnapshot(unitId: string): Record<string, unknown> {
  const tasks = taskSnapshot(unitId, 'sheet-1', 'خطة الاتصال المستوردة') as { sheets: Record<string, unknown>; sheetOrder: string[] }
  return {
    ...tasks,
    sheetOrder: ['sheet-1', 'sheet-2'],
    sheets: {
      ...tasks.sheets,
      'sheet-2': {
        id: 'sheet-2',
        name: 'الميزانية',
        rightToLeft: 1,
        defaultStyle: { ff: 'Thmanyah Sans' },
        cellData: { 0: { 0: { v: 'البند' }, 2: { v: 'المبلغ' } }, 4: { 0: { v: 'الإعلانات' }, 2: { v: 12400 } } },
      },
    },
  }
}

const REPORT: ImportReport = {
  source: { spreadsheetId: SPREADSHEET_ID, title: 'خطة الاتصال المستوردة', locale: 'ar_SA' },
  counts: {
    sheets: 2,
    cells: 9,
    formulas: 3,
    valueOnlyFormulas: 1,
    styles: 4,
    merges: 0,
    conditionalFormatRules: 1,
    dataValidationRules: 0,
    filters: 1,
    notes: 1,
    hyperlinks: 0,
    richTextCells: 0,
    definedNames: 0,
  },
  sheets: [
    { googleSheetId: 0, sheetId: 'sheet-1', name: 'المهام', hidden: false, rightToLeft: true },
    { googleSheetId: 1, sheetId: 'sheet-2', name: 'الميزانية', hidden: false, rightToLeft: true },
  ],
  items: [
    {
      kind: 'unsupported_formula',
      outcome: 'value_only',
      location: { sheetId: 'sheet-2', sheetName: 'الميزانية', range: { startRow: 4, startColumn: 2, endRow: 4, endColumn: 2 }, ref: "'الميزانية'!C5" },
      message: 'المعادلة تستخدم دالة لا تحسبها المنصة كما يحسبها Google Sheets (GOOGLEFINANCE)، فنُقلت آخر قيمة محسوبة لها.',
      detail: '=GOOGLEFINANCE("TADAWUL:2222")',
    },
    {
      kind: 'chart',
      outcome: 'not_transferred',
      location: { sheetId: 'sheet-1', sheetName: 'المهام', range: null, ref: "'المهام'" },
      message: 'الرسم البياني لم يُنقل؛ الرسوم البيانية خارج الإصدار الأول. راجعه في الملف الأصلي.',
    },
    {
      kind: 'banded_range',
      outcome: 'converted',
      location: { sheetId: 'sheet-1', sheetName: 'المهام', range: { startRow: 0, startColumn: 0, endRow: 2, endColumn: 6 }, ref: "'المهام'!A1:G3" },
      message: 'الألوان المتناوبة حُوّلت إلى تعبئة ثابتة.',
    },
    { kind: 'named_range', outcome: 'not_transferred', location: null, message: 'النطاق المسمّى لم يُنقل: يشير إلى ورقة غير موجودة. أعد تعريفه يدويًا.', detail: 'Budget2026' },
  ],
}

// Owner decision 2026-11-11: no Google OAuth. «رفع ملف Excel» uploads an
// .xlsx; «رابط Google Sheets» has the platform download a public file. Neither
// goes through Google's consent, so /api/google/link and /auth/google/* are never used.
const XLSX_REPORT: ImportReport = {
  ...REPORT,
  source: {
    spreadsheetId: 'upload:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
    title: 'خطة الحملة',
    locale: null,
    origin: { kind: 'excel', via: 'upload', application: 'Microsoft Excel', fileName: 'خطة الحملة.xlsx', defaultFont: { family: 'Aptos Narrow', size: 11 }, dateSystem: 'date1904', alignment: 'as_given' },
  },
  items: [
    ...REPORT.items,
    {
      kind: 'table',
      outcome: 'not_transferred',
      location: { sheetId: 'sheet-1', sheetName: 'المهام', range: { startRow: 0, startColumn: 0, endRow: 5, endColumn: 3 }, ref: "'المهام'!A1:D6" },
      message: 'نمط الجدول TableStyleMedium2 من الأنماط المضمّنة في Excel ولا يحمل الملف ألوانه، فلم يُنقل.',
      detail: 'TableStyleMedium2',
    },
    { kind: 'unsupported_feature', outcome: 'not_transferred', location: null, message: 'وحدات الماكرو (VBA) لا تُنقل ولا تعمل في المنصة.' },
  ],
}

async function openNewFile(page: Page) {
  await page.getByTestId('files-empty').waitFor()
  await page.locator('.toolbar').getByRole('button', { name: 'ملف جديد', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'ملف جديد' })
  await dialog.waitFor()
  return dialog
}

function importedWorkbook(api: MockApi, report: ImportReport) {
  api.add(summary({ id: 'wb-imp', title: report.source.title, sheetCount: 2 }), importedSnapshot('wb-imp'), 1, [meta('sheet-1', 'المهام', 1), meta('sheet-2', 'الميزانية', 2)])
  api.importReports.set('wb-imp', { reportId: 'rep-1', createdAt: '2026-11-10T09:30:00Z', report })
  return { workbookId: 'wb-imp', reportId: 'rep-1' }
}

describe('import: Excel upload and Google Sheets link → report → editor (§7.1–7.2)', () => {
  it('offers four options; a bad link and a private file are explained, without any Google sign-in', async () => {
    const api = new MockApi()
    api.googleLink = { state: 'unlinked', email: null }
    api.onLinkImport = () =>
      error(403, 'gsheets_link_private', 'تعذّر تنزيل الملف لأنه غير مشارك بالرابط، فقد طلبت Google تسجيل الدخول. افتح الملف في Google Sheets واختر «مشاركة» ثم «أي شخص لديه الرابط» بصلاحية «عارض» وأعد المحاولة، أو نزّل الملف بصيغة Excel وارفعه.')
    const { context, page } = await openPage(api, '/')
    const dialog = await openNewFile(page)
    expect(await dialog.getByRole('radio').count()).toBe(4)
    expect(await dialog.getByLabel('رفع ملف Excel').isDisabled()).toBe(false)

    await dialog.getByLabel('رابط Google Sheets').check()
    const source = dialog.getByLabel('رابط ملف Google Sheets أو معرّفه')
    await source.fill('https://drive.google.com/file/d/abc/view')
    await dialog.getByRole('button', { name: 'استيراد' }).click()
    expect(await dialog.getByTestId('new-file-error').innerText()).toContain('لا يقود إلى ملف Google Sheets')
    expect(api.count('POST', '/api/import/gsheets-link')).toBe(0)
    await shot(page, 'new-file-import-invalid')

    await source.fill(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=0`)
    await dialog.getByRole('button', { name: 'استيراد' }).click()
    await expect.poll(() => dialog.getByTestId('new-file-error').innerText().catch(() => '')).toContain('أي شخص لديه الرابط')
    expect(api.bodies('POST', '/api/import/gsheets-link')).toEqual([{ source: SPREADSHEET_ID }])
    await shot(page, 'new-file-import-private')
    // No Google consent anywhere on this path.
    expect(api.count('GET', '/api/google/link')).toBe(0)
    expect(page.url()).toBe(`${BASE_URL}/`)
    await context.close()
  })

  it('a public link imports, the report reads, and «الانتقال إلى الموقع» opens the editor on that cell', async () => {
    const api = new MockApi()
    api.onLinkImport = () =>
      importedWorkbook(api, { ...REPORT, source: { ...REPORT.source, origin: { kind: 'google_export', via: 'google_link', application: null, defaultFont: { family: 'Arial', size: 10 }, dateSystem: 'date1900', alignment: 'as_given' } } })
    const { context, page } = await openPage(api, `/?import=${SPREADSHEET_ID}`)
    const dialog = page.getByRole('dialog', { name: 'ملف جديد' })
    await dialog.waitFor()
    expect(await dialog.getByLabel('رابط Google Sheets').isChecked()).toBe(true)
    expect(await dialog.getByLabel('رابط ملف Google Sheets أو معرّفه').inputValue()).toBe(SPREADSHEET_ID)
    await page.waitForURL(`${BASE_URL}/`) // the `import` parameter leaves the address
    await shot(page, 'new-file-import')
    await page.setViewportSize({ width: 375, height: 812 })
    await shot(page, 'new-file-import-375')
    await page.setViewportSize({ width: 1280, height: 800 })

    await dialog.getByRole('button', { name: 'استيراد' }).click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-imp/import-report`)
    expect(api.bodies('POST', '/api/import/gsheets-link')).toEqual([{ source: SPREADSHEET_ID }])
    expect(api.count('POST', '/api/import/gsheets')).toBe(0)

    // Origin, counts, then the items grouped by sheet, each with its location.
    await page.getByTestId('report-summary').waitFor()
    expect(await page.locator('h1').innerText()).toBe('تقرير الاستيراد')
    const origin = page.getByTestId('report-origin')
    expect(await origin.getAttribute('data-origin')).toBe('google_export')
    expect(await origin.innerText()).toContain('نُزّل من رابط Google Sheets')
    expect(await origin.innerText()).toContain('Arial 10')
    expect(await page.locator('[data-count="formulas"] dd').innerText()).toBe('3')
    expect(await page.getByTestId('report-outcomes').innerText()).toContain('لم يُنقل: 2')
    const groups = page.locator('[data-report-sheet]')
    expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-report-sheet')))).toEqual(['sheet-1', 'sheet-2', ''])
    const formula = page.locator('[data-report-sheet="sheet-2"] .report-item')
    expect(await formula.innerText()).toContain("'الميزانية'!C5")
    expect(await formula.innerText()).toContain('=GOOGLEFINANCE("TADAWUL:2222")')
    expect(await page.locator('[data-report-sheet=""]').getByTestId('report-go-to').count()).toBe(0)
    await shot(page, 'import-report')

    await formula.getByRole('link', { name: 'الانتقال إلى الموقع' }).click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-imp?sheet=sheet-2&range=C5`)
    await waitForEditor(page)
    const host = page.getByTestId('univer-host')
    await expect.poll(() => host.getAttribute('data-selection'), { timeout: 15_000 }).toBe('sheet-2!C5')
    expect(await host.getAttribute('data-active-sheet')).toBe('sheet-2')
    expect(await page.getByTestId('editor-target-missing').count()).toBe(0)
    await shot(page, 'editor-at-report-cell')

    // Back, and a whole-sheet item opens its sheet.
    await page.goBack()
    await page.getByTestId('report-summary').waitFor()
    await page.locator('[data-report-sheet="sheet-1"] [data-kind="chart"]').getByRole('link', { name: 'الانتقال إلى الموقع' }).click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-imp?sheet=sheet-1`)
    await waitForEditor(page)
    await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-active-sheet'), { timeout: 15_000 }).toBe('sheet-1')
    expect(api.count('GET', '/api/google/link')).toBe(0)
    await context.close()
  })

  it('uploads an Excel file (chosen or dropped) and the report shows its origin and losses', async () => {
    const api = new MockApi()
    const uploads: Array<{ size: number; name: string | null; title: string | null }> = []
    api.onXlsxImport = (req) => {
      uploads.push(req)
      return importedWorkbook(api, XLSX_REPORT)
    }
    const { context, page } = await openPage(api, '/')
    const dialog = await openNewFile(page)
    await dialog.getByLabel('رفع ملف Excel').check()
    const input = dialog.locator('input[type="file"]')
    expect(await input.getAttribute('accept')).toContain('.xlsx')

    // Nothing chosen, then a CSV: explained before any upload.
    await dialog.getByRole('button', { name: 'استيراد' }).click()
    expect(await dialog.getByTestId('new-file-error').innerText()).toContain('لم يُختر ملف')
    await input.setInputFiles({ name: 'tasks.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') })
    expect(await dialog.getByTestId('new-file-error').innerText()).toContain('ليس ملف Excel')
    await input.setInputFiles({ name: 'old.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('x') })
    expect(await dialog.getByTestId('new-file-error').innerText()).toContain('بصيغة Excel القديمة')
    expect(api.requests.filter((r) => r.path.startsWith('/api/import/xlsx'))).toHaveLength(0)

    // Dropped onto the zone.
    await page.evaluate(() => {
      const zone = document.querySelector('[data-testid="xlsx-dropzone"]') as HTMLElement
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(2048)], 'خطة الحملة.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    expect(await dialog.getByTestId('xlsx-chosen').innerText()).toContain('خطة الحملة.xlsx')
    expect(await dialog.getByTestId('new-file-error').count()).toBe(0)
    await shot(page, 'new-file-xlsx')
    await page.setViewportSize({ width: 375, height: 812 })
    await shot(page, 'new-file-xlsx-375')
    await page.setViewportSize({ width: 1280, height: 800 })

    await dialog.getByRole('button', { name: 'استيراد' }).click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-imp/import-report`)
    expect(uploads).toEqual([{ size: 2048, name: 'خطة الحملة.xlsx', title: null }])
    const origin = page.getByTestId('report-origin')
    await origin.waitFor()
    expect(await origin.getAttribute('data-origin')).toBe('excel')
    const text = await origin.innerText()
    expect(text).toContain('ملف Microsoft Excel')
    expect(text).toContain('رُفع من جهاز')
    expect(text).toContain('خطة الحملة.xlsx')
    expect(text).toContain('Aptos Narrow 11')
    expect(text).toContain('نظام 1904')
    expect(text).toContain('بداية السطر')
    expect(await page.getByTestId('report-source').innerText()).toContain('ملف Microsoft Excel')
    expect(await page.locator('[data-kind="table"]').innerText()).toContain('TableStyleMedium2')
    expect(await page.locator('[data-kind="unsupported_feature"]').innerText()).toContain('ميزة غير مدعومة')
    await shot(page, 'import-report-xlsx')
    await page.setViewportSize({ width: 375, height: 812 })
    await shot(page, 'import-report-xlsx-375')
    expect(api.count('GET', '/api/google/link')).toBe(0)
    await context.close()
  })

  it('shows the API’s Arabic message when the upload is refused', async () => {
    const api = new MockApi()
    api.onXlsxImport = () => error(415, 'xlsx_legacy_or_encrypted', 'الملف بصيغة Excel القديمة (‎.xls) أو محمي بكلمة مرور، فتعذّرت قراءته. افتحه في Excel، وأزل كلمة المرور إن وُجدت، واحفظه بصيغة ‎.xlsx ثم ارفعه.')
    const { context, page } = await openPage(api, '/')
    const dialog = await openNewFile(page)
    await dialog.getByLabel('رفع ملف Excel').check()
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'محمي.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512) })
    await dialog.getByLabel('عنوان الملف في المنصة (اختياري)').fill('خطة محمية')
    await dialog.getByRole('button', { name: 'استيراد' }).click()
    await expect.poll(() => dialog.getByTestId('new-file-error').innerText().catch(() => '')).toContain('محمي بكلمة مرور')
    expect(api.requests.find((r) => r.path.startsWith('/api/import/xlsx'))?.path).toBe(`/api/import/xlsx?name=${encodeURIComponent('محمي.xlsx').replace(/%20/g, '+')}&title=${encodeURIComponent('خطة محمية').replace(/%20/g, '+')}`)
    await shot(page, 'new-file-xlsx-error')
    await context.close()
  })
})

// ---------------------------------------------------------------------------

describe('linking wizard (§7.3)', () => {
  it('happy path from the editor’s file settings to «بدء المزامنة», with the exact plan in every POST', async () => {
    const api = new MockApi()
    const snapshot = taskSnapshot('wb-link', 'sheet-1', 'خطة الربع الأول') as { sheets: Record<string, unknown>; sheetOrder: string[] }
    snapshot.sheetOrder = ['sheet-1', 'sheet-2']
    snapshot.sheets['sheet-2'] = { id: 'sheet-2', name: 'ملاحظات', rightToLeft: 1, cellData: {} }
    api.add(summary({ id: 'wb-link', title: 'خطة الربع الأول', sheetCount: 2 }), snapshot, 5, [meta('sheet-1', 'المهام', 1), meta('sheet-2', 'ملاحظات', 2)])
    api.projects = [
      { id: 41, name: 'مشروع سابق', description: null },
      { id: 42, name: 'حملة الإطلاق 2026', description: null },
    ]
    api.todolists[42] = [{ id: 7, name: 'المهام الحالية', completedRatio: '1/4' }]
    api.people[42] = [
      { id: 501, name: 'سارة القحطاني', email: null, avatarUrl: null, personableType: 'User', client: false },
      { id: 502, name: 'فهد العتيبي', email: null, avatarUrl: null, personableType: 'User', client: false },
    ]
    api.preview = (plan: LinkPlan) => ({
      sheets: plan.sheets.map((s) => ({
        sheetId: s.sheetId,
        todosToCreate: s.mode === 'local' ? 0 : 1,
        subtasksToCreate: 0,
        proposedMatches: s.existingTasks === 'match_by_title' ? [{ rowNumber: 2, title: 'إعداد خطة الاتصال للربع الأول', todoId: 9001, todoTitle: 'إعداد خطة الاتصال للربع الأول' }] : [],
        unmatchedAssignees: s.columns.some((c) => c.field === 'assignees') ? [{ text: 'سارة', candidates: [{ bcPersonId: 501, name: 'سارة القحطاني', score: 0.72 }] }] : [],
        warnings: [],
      })),
    })
    api.link = (plan) => ({ bcProjectId: 42, sheets: plan.sheets.map((s) => ({ sheetId: s.sheetId, bcTodolistId: s.mode === 'local' ? null : 7, queuedTasks: s.mode === 'local' ? 0 : 1 })) })

    const { context, page } = await openPage(api, '/workbooks/wb-link')
    await waitForEditor(page)
    await page.getByTestId('file-settings-button').click()
    const panel = page.getByTestId('file-settings')
    await panel.waitFor()
    expect(await panel.innerText()).toContain('غير مرتبط بمشروع في Basecamp')
    await shot(page, 'editor-file-settings')
    await panel.getByTestId('start-link-wizard').click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-link/link`)

    const step = (name: string) => page.locator(`[data-step="${name}"]`).waitFor()
    const next = () => page.getByTestId('wizard-next').click()

    // 1. Project: «التالي» without a choice says what is missing.
    await step('project')
    expect(await page.locator('.wizard__never-deletes').innerText()).toContain('لا يحذف هذا المعالج أي شيء من Basecamp')
    await next()
    expect(await page.getByTestId('wizard-errors').innerText()).toContain('اختر طريقة ربط الملف بمشروع')
    await page.getByLabel('مشروع موجود').check()
    await page.getByRole('combobox', { name: 'المشروع', exact: true }).selectOption('42')
    await shot(page, 'wizard-1-project')
    await next()

    // 2. Sheets: the tasks sheet joins an existing list, the empty one stays local.
    await step('sheets')
    const tasksSheet = page.locator('fieldset[data-sheet="meta-sheet-1"]')
    await tasksSheet.getByLabel('مزامنة مع قائمة موجودة').check()
    await tasksSheet.getByLabel('القائمة المرتبطة بورقة المهام').selectOption('7')
    await page.locator('fieldset[data-sheet="meta-sheet-2"]').getByLabel('ورقة محلية (بدون مزامنة)').check()
    await next()

    // 3. Header row: detected as row 1.
    await step('headerRow')
    expect(await page.getByLabel('رقم صف العناوين').inputValue()).toBe('1')
    expect(await page.locator('.wizard__step').innerText()).toContain('اكتُشف تلقائياً')
    await next()

    // 4. Columns: the default columns are suggested.
    await step('columns')
    const fields = await page.locator('[data-testid="wizard-columns"] select').evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value))
    expect(fields).toEqual(['title', 'assignees', 'starts_on', 'due_on', 'completed', 'attachments', 'notes'])
    await shot(page, 'wizard-4-columns')
    await next()

    // 5. Hierarchy: flat (no numbering column, no indentation).
    await step('hierarchy')
    expect(await page.getByLabel('كل الصفوف مهام رئيسية').isChecked()).toBe(true)
    expect(await page.getByTestId('hierarchy-summary').innerText()).toContain('مهام رئيسية: 2')
    await next()

    // 6. Status: the column is empty, so the suggested words are offered, all chosen.
    await step('status')
    for (const value of ['منجز', 'تم', 'Done']) expect(await page.locator(`label[data-value="${value}"] input`).isChecked()).toBe(true)
    await next()

    // 7. Assignees: the preview's unmatched name is confirmed by hand.
    await step('assignees')
    const assignee = page.getByLabel('شخص Basecamp للاسم سارة')
    await assignee.waitFor()
    expect(await assignee.inputValue()).toBe('') // nothing assigned unless chosen
    await assignee.selectOption('501')
    await shot(page, 'wizard-7-assignees')
    await next()

    // 8. Existing tasks: match by title, nothing deleted.
    await step('existingTasks')
    expect(await page.locator('.wizard__step').innerText()).toContain('لا يُحذف أي شيء من Basecamp في هذه المرحلة')
    await page.getByLabel('مطابقة بالعنوان مع مراجعة يدوية قبل الاعتماد').check()
    await next()

    // 9. Preview: counts, proposed matches to review, then «بدء المزامنة».
    await step('preview')
    const preview = page.getByTestId('wizard-preview')
    await preview.waitFor()
    expect(await preview.locator('[data-sheet="meta-sheet-1"]').innerText()).toContain('المهام الحالية')
    expect(await preview.locator('[data-sheet="meta-sheet-1"] [data-testid="preview-todos"]').innerText()).toBe('1')
    expect(await page.getByTestId('proposed-matches').innerText()).toContain('إعداد خطة الاتصال للربع الأول')
    const startButton = page.getByTestId('wizard-start')
    expect(await startButton.isDisabled()).toBe(true)
    await page.getByLabel('راجعتُ المطابقات المقترحة وأعتمدها').check()
    expect(await startButton.isEnabled()).toBe(true)
    await shot(page, 'wizard-9-preview')
    expect(api.count('POST', '/api/workbooks/wb-link/link')).toBe(0)
    await startButton.click()
    await page.getByTestId('wizard-done').waitFor()
    await shot(page, 'wizard-done')

    const expected: LinkPlan = {
      project: { mode: 'existing', projectId: 42 },
      sheets: [
        {
          sheetId: 'meta-sheet-1',
          mode: 'existing',
          todolistId: 7,
          headerRow: 1,
          columns: [
            { columnKey: 'A', field: 'title' },
            { columnKey: 'B', field: 'assignees' },
            { columnKey: 'C', field: 'starts_on' },
            { columnKey: 'D', field: 'due_on' },
            { columnKey: 'E', field: 'completed' },
            { columnKey: 'F', field: 'attachments' },
            { columnKey: 'G', field: 'notes' },
          ],
          completedValues: ['منجز', 'تم', 'Done'],
          hierarchy: { mode: 'flat' },
          existingTasks: 'match_by_title',
          assigneeMatches: { سارة: 501 },
        },
        { sheetId: 'meta-sheet-2', mode: 'local', headerRow: 1, columns: [], hierarchy: { mode: 'flat' }, existingTasks: 'create_all', assigneeMatches: {} },
      ],
    }
    expect(api.bodies('POST', '/api/workbooks/wb-link/link')).toEqual([expected])
    const previews = api.bodies('POST', '/api/workbooks/wb-link/link/preview')
    // One preview on entering «المسؤولون» (before the choices of steps 7–8), the last one for exactly the committed plan.
    expect(previews.length).toBeGreaterThanOrEqual(2)
    expect(previews.at(-1)).toEqual(expected)
    expect((previews[0] as LinkPlan).sheets[0]).toMatchObject({ existingTasks: 'create_all', assigneeMatches: {} })
    // The flow read Basecamp only through the contract and wrote nothing else.
    const writes = api.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`)
    expect(new Set(writes)).toEqual(new Set(['POST /api/workbooks/wb-link/link/preview', 'POST /api/workbooks/wb-link/link']))

    await page.getByTestId('wizard-done').getByRole('link', { name: 'العودة إلى الملف' }).click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-link`)
    await waitForEditor(page)
    await context.close()
  })
})

// ---------------------------------------------------------------------------

describe('people matching (§3, admins only)', () => {
  const people = {
    matches: [
      { userId: 'u-1', name: 'فهد العتيبي', email: 'fahad@example.com', bcPersonId: 502, source: 'email' as const },
      { userId: 'u-2', name: 'سارة القحطاني', email: 'sara@example.com', bcPersonId: null, source: null },
    ],
    people: [
      { id: 501, name: 'Sara Alqahtani', email: 'sara.q@example.com', avatarUrl: null, personableType: 'User', client: false },
      { id: 502, name: 'Fahad Alotaibi', email: 'fahad@example.com', avatarUrl: null, personableType: 'User', client: false },
    ],
  }

  it('is hidden from non-admins: no entry in settings, a refusal on the address, and no request', async () => {
    const api = new MockApi()
    api.peopleMatches = people
    const { context, page } = await openPage(api, '/settings')
    await page.getByTestId('basecamp-account').getByText('مرتبط باسم').waitFor()
    expect(await page.getByTestId('admin-section').count()).toBe(0)
    expect(await page.getByRole('link', { name: 'فتح شاشة المطابقة' }).count()).toBe(0)
    await page.goto(`${BASE_URL}/admin/people-matches`)
    await page.getByTestId('people-admin-only').waitFor()
    expect(await page.getByTestId('people-admin-only').innerText()).toContain('لمسؤولي المنصة فقط')
    expect(api.count('GET', '/api/admin/people-matches')).toBe(0)
    await context.close()
  })

  it('an admin matches a member by hand', async () => {
    const api = new MockApi()
    api.me = { user: { ...api.me.user, role: 'admin' } }
    api.peopleMatches = people
    const { context, page } = await openPage(api, '/settings')
    await page.getByTestId('admin-section').getByRole('link', { name: 'فتح شاشة المطابقة' }).click()
    await page.waitForURL(`${BASE_URL}/admin/people-matches`)
    const row = page.locator('tr[data-user-id="u-2"]')
    await row.waitFor()
    expect(await page.locator('tr[data-user-id="u-1"] [data-source]').innerText()).toBe('بالبريد الإلكتروني')
    expect(await row.locator('[data-source]').innerText()).toBe('غير مطابَق')
    const save = row.getByRole('button', { name: 'حفظ' })
    expect(await save.isDisabled()).toBe(true)
    await row.getByLabel('شخص Basecamp المطابق لـ سارة القحطاني').selectOption('501')
    await save.click()
    await row.getByText('تم الحفظ').waitFor()
    expect(api.bodies('PUT', '/api/admin/people-matches/u-2')).toEqual([{ bcPersonId: 501 }])
    expect(await row.locator('[data-source]').innerText()).toBe('يدوية')
    expect(api.count('GET', '/api/admin/people-matches')).toBe(2)
    await shot(page, 'people-matches')
    await context.close()
  })
})

describe('hermetic', () => {
  it('no uncaught page error and no request left 127.0.0.1 except the blocked CDN font', () => {
    expect(pageErrors).toEqual([])
    expect(blockedRequests.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/'))).toEqual([])
  })
})
