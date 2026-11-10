// Browser smoke test of the built app (vite build + vite preview on :4174,
// started by global-setup.ts) in headless Chromium, with the API mocked by
// route interception (mock-api.ts). Nothing leaves 127.0.0.1: the CDN font is
// blocked, so screenshots use the system fallback face.
//
// Screenshots: test/e2e/screenshots/ (override with E2E_SCREENSHOTS).

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL } from './global-setup'
import { error, MockApi, summary, taskSnapshot } from './mock-api'

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

async function openPage(api: MockApi, path: string, before?: (context: BrowserContext) => Promise<void>): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
  // Hermetic: only the preview server is reachable.
  await context.route(
    (url) => !url.href.startsWith(BASE_URL),
    (route) => {
      blockedRequests.push(route.request().url())
      return route.abort()
    },
  )
  await before?.(context)
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${String(e).slice(0, 300)}`))
  await api.install(page)
  await page.goto(BASE_URL + path)
  return { context, page }
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) })

const editorRoot = (page: Page) => page.locator('[data-screen="editor"]')
const host = (page: Page) => page.getByTestId('univer-host')

async function waitForEditor(page: Page): Promise<void> {
  await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
  // The realtime room has answered (the mock API has none: the editor falls back to PUT).
  await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 30_000 })
}

// Univer 1.4.0 defaults (core DEFAULT_WORKSHEET_*): the test snapshots set no sizes.
const GRID = { rowHeaderWidth: 46, columnHeaderHeight: 20, columnWidth: 88, rowHeight: 24 }

/**
 * On-screen centre of a cell (0-based) on the mirrored grid: column A starts at
 * the visual right, just inside the row header.
 */
async function cellCentre(page: Page, column: number, row: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!box) throw new Error('sheet canvas not found')
  return {
    x: box.x + box.width - GRID.rowHeaderWidth - GRID.columnWidth * column - GRID.columnWidth / 2,
    y: box.y + GRID.columnHeaderHeight + GRID.rowHeight * row + GRID.rowHeight / 2,
  }
}

async function typeIntoCell(page: Page, column: number, row: number, text: string): Promise<void> {
  const { x, y } = await cellCentre(page, column, row)
  await page.mouse.dblclick(x, y)
  await page.waitForTimeout(300)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

type Snapshot = { sheets: Record<string, { cellData: Record<number, Record<number, { v?: unknown }>> }> }
const cellValue = (snapshot: unknown, sheetId: string, row: number, column: number) => (snapshot as Snapshot).sheets[sheetId]?.cellData[row]?.[column]?.v

describe('files screen', () => {
  it('renders right-to-left in Arabic, searches, and does not download the editor until a file is opened', async () => {
    const api = new MockApi()
    api.add(summary({ id: 'wb-1', title: 'خطة الاتصال المؤسسي 2026', bcProjectId: 4021, sheetCount: 3, completion: 0.4, syncState: 'synced' }), taskSnapshot('wb-1', 'sheet-1', 'خطة'), 7)
    api.add(summary({ id: 'wb-2', title: 'تقرير الربع الثالث', access: 'viewer', syncState: 'pending', completion: null }), taskSnapshot('wb-2', 'sheet-1', 'تقرير'), 2)
    const scripts: string[] = []
    const { context, page } = await openPage(api, '/', async (ctx) => {
      ctx.on('request', (r) => {
        if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname)
      })
    })
    await page.locator('.files-table tbody tr').nth(1).waitFor()

    // Document direction and language.
    expect(await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir, getComputedStyle(document.body).direction])).toEqual(['ar', 'rtl', 'rtl'])
    expect(await page.locator('h1').innerText()).toBe('الملفات')
    // The first column (العنوان) sits at the visual right, the last (حالة المزامنة) at the left.
    const headers = page.locator('.files-table thead th')
    const first = await headers.first().boundingBox()
    const last = await headers.last().boundingBox()
    expect(await headers.first().innerText()).toBe('العنوان')
    expect(first!.x).toBeGreaterThan(last!.x)

    const row1 = page.locator('tr[data-workbook-id="wb-1"]')
    const text1 = await row1.innerText()
    for (const s of ['خطة الاتصال المؤسسي 2026', 'مشروع رقم', '4021', '3', '40%', '2026-11-10 12:30', 'متزامن']) expect(text1).toContain(s)
    const text2 = await page.locator('tr[data-workbook-id="wb-2"]').innerText()
    for (const s of ['قراءة فقط', 'غير مرتبط', 'لا مهام متزامنة', 'بانتظار المزامنة']) expect(text2).toContain(s)
    expect(await page.locator('.app-bar__user').innerText()).toContain('فهد العتيبي')
    await shot(page, 'files')

    // Only the entry script was downloaded: Univer lives in the lazy editor chunk.
    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts.every((s) => /^\/assets\/index-[\w-]+\.js$/.test(s)), scripts.join(', ')).toBe(true)

    // Search goes to the API and into the address.
    await page.getByRole('searchbox', { name: 'البحث في الملفات' }).fill('تقرير')
    await page.waitForURL((url) => url.searchParams.get('q') === 'تقرير')
    await expect.poll(() => api.requests.some((r) => r.path === `/api/workbooks?q=${encodeURIComponent('تقرير')}`)).toBe(true)
    await expect.poll(() => page.locator('.files-table tbody tr').count()).toBe(1)
    await page.getByRole('searchbox', { name: 'البحث في الملفات' }).fill('لا يوجد')
    await page.getByTestId('files-no-matches').waitFor()
    await page.getByRole('button', { name: 'مسح البحث' }).click()
    await expect.poll(() => page.locator('.files-table tbody tr').count()).toBe(2)

    // Opening a file is what downloads the editor.
    await page.getByRole('link', { name: 'خطة الاتصال المؤسسي 2026' }).click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-1`)
    await waitForEditor(page)
    expect(scripts.some((s) => s.includes('/assets/EditorScreen-'))).toBe(true)
    await context.close()
  })

  it('invites creating the first file when there are none', async () => {
    const api = new MockApi()
    const { context, page } = await openPage(api, '/')
    const empty = page.getByTestId('files-empty')
    await empty.waitFor()
    expect(await empty.innerText()).toContain('ابدأ بأول ملف')
    expect(await empty.getByRole('button', { name: 'ملف جديد' }).isVisible()).toBe(true)
    await shot(page, 'files-empty')
    await context.close()
  })

  it('shows the API’s Arabic error message, and recovers on retry', async () => {
    const api = new MockApi()
    api.add(summary({ id: 'wb-1', title: 'خطة' }), taskSnapshot('wb-1', 'sheet-1', 'خطة'), 1)
    const message = 'تعذّر تحميل قائمة الملفات بسبب عطل في الخادم. أعد المحاولة بعد قليل.'
    api.override = (r) => (r.method === 'GET' && r.path.startsWith('/api/workbooks') ? error(500, 'internal', message) : undefined)
    const { context, page } = await openPage(api, '/')
    const notice = page.getByTestId('files-error')
    await notice.waitFor()
    expect(await notice.innerText()).toContain(message)
    expect(await notice.getAttribute('role')).toBe('alert')
    api.override = null
    await notice.getByRole('button', { name: 'إعادة المحاولة' }).click()
    await page.locator('tr[data-workbook-id="wb-1"]').waitFor()
    await context.close()
  })

  it('a 401 sends the browser to the login URL, with the current page as `next`', async () => {
    const api = new MockApi()
    api.override = () => ({ status: 401, body: { ok: false, error: 'unauthorized', login: `${BASE_URL}/__login` } })
    const { context, page } = await openPage(api, '/workbooks/wb-9', async (ctx) => {
      await ctx.route(`${BASE_URL}/__login**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>login</title>' }))
    })
    await page.waitForURL((url) => url.pathname === '/__login')
    expect(new URL(page.url()).searchParams.get('next')).toBe('/workbooks/wb-9')
    await context.close()
  })
})

describe('new file → editor → autosave', () => {
  const api = new MockApi()
  api.add(summary({ id: 'wb-1', title: 'خطة الاتصال' }), taskSnapshot('wb-1', 'sheet-1', 'خطة'), 7)
  let context: BrowserContext
  let page: Page

  beforeAll(async () => {
    ;({ context, page } = await openPage(api, '/'))
  })
  afterAll(async () => {
    await context?.close()
  })

  it('«ملف جديد» creates a blank workbook and opens it in the editor', async () => {
    await page.getByRole('button', { name: 'ملف جديد', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'ملف جديد' })
    await dialog.waitFor()
    await page.getByLabel('عنوان الملف').fill('خطة إطلاق الهوية')
    await shot(page, 'new-file-dialog')
    await dialog.getByRole('button', { name: 'إنشاء' }).click()

    await page.waitForURL(`${BASE_URL}/workbooks/wb-new-1`)
    expect(api.requests.find((r) => r.method === 'POST')?.body).toEqual({ title: 'خطة إطلاق الهوية', source: 'blank' })
    await waitForEditor(page)
    expect(api.count('GET', '/api/workbooks/wb-new-1')).toBe(1)
    expect(await page.locator('.editor-bar__title').innerText()).toBe('خطة إطلاق الهوية')
    expect(await page.title()).toContain('خطة إطلاق الهوية')
  })

  it('the RTL grid layer reports mirrored=true, and keeps it past its heartbeat', async () => {
    await expect.poll(() => host(page).getAttribute('data-rtl-mirrored'), { timeout: 15_000 }).toBe('true')
    expect(await page.locator('.naf-rtl-grid canvas[id^="univer-sheet-main-canvas"]').count()).toBe(1)
    // The layer withdraws the mirror within 3 s if text stops flowing through it.
    await page.waitForTimeout(3500)
    expect(await host(page).getAttribute('data-rtl-mirrored')).toBe('true')
    expect(await page.getByTestId('editor-rtl-off').count()).toBe(0)
  })

  it('opening a workbook saves nothing by itself', async () => {
    expect(api.puts()).toHaveLength(0)
    expect(await editorRoot(page).getAttribute('data-save-phase')).toBe('saved')
    expect(await page.getByTestId('save-status').innerText()).toBe('محفوظ')
  })

  it('editing a cell PUTs the snapshot with the loaded version as baseVersion', async () => {
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/workbooks/wb-new-1/snapshot'), { timeout: 15_000 })
    await typeIntoCell(page, 1, 2, 'متابعة التصميم 2026') // B3
    await put
    await expect.poll(() => editorRoot(page).getAttribute('data-save-phase')).toBe('saved')
    const puts = api.puts('wb-new-1')
    expect(puts).toHaveLength(1)
    expect(puts[0]?.baseVersion).toBe(1) // the version GET returned
    // The cell clicked at its mirrored position is B3; the header row came from the blank workbook.
    expect(cellValue(puts[0]?.snapshot, 'sheet-1', 2, 1)).toBe('متابعة التصميم 2026')
    expect(cellValue(puts[0]?.snapshot, 'sheet-1', 0, 0)).toBe('المهمة')
    expect(await editorRoot(page).getAttribute('data-save-version')).toBe('2')
    await shot(page, 'editor-mirrored')
  })

  it('the next save builds on the version the server returned', async () => {
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/snapshot'), { timeout: 15_000 })
    await typeIntoCell(page, 0, 3, 'مهمة جديدة') // A4
    await put
    await expect.poll(() => editorRoot(page).getAttribute('data-save-phase')).toBe('saved')
    const puts = api.puts('wb-new-1')
    expect(puts.map((p) => p.baseVersion)).toEqual([1, 2])
    expect(cellValue(puts[1]?.snapshot, 'sheet-1', 3, 0)).toBe('مهمة جديدة')
    expect(cellValue(puts[1]?.snapshot, 'sheet-1', 2, 1)).toBe('متابعة التصميم 2026')
  })
})

describe('editor safety', () => {
  it('a 409 shows the Arabic conflict message with a reload action, and nothing is overwritten', async () => {
    const api = new MockApi()
    api.add(summary({ id: 'wb-c', title: 'ملف يحرره شخصان' }), taskSnapshot('wb-c', 'sheet-1', 'ملف'), 7)
    const { context, page } = await openPage(api, '/workbooks/wb-c')
    await waitForEditor(page)
    // Someone else saves version 8 before this editor does.
    const stored = api.workbooks.get('wb-c')!
    stored.version = 8
    const theirs = stored.snapshot

    await typeIntoCell(page, 1, 3, 'تعديل لن يُحفظ')
    const notice = page.getByTestId('editor-conflict')
    await notice.waitFor({ timeout: 15_000 })
    const text = await notice.innerText()
    expect(text).toContain('حُفظت نسخة أحدث من هذا الملف قبل تعديلك') // the API's own message
    expect(await notice.getAttribute('role')).toBe('alert')
    expect(await editorRoot(page).getAttribute('data-save-phase')).toBe('conflict')
    expect(api.puts('wb-c').map((p) => p.baseVersion)).toEqual([7])
    await shot(page, 'editor-conflict')

    // No retry, no overwrite.
    await page.waitForTimeout(4000)
    expect(api.puts('wb-c')).toHaveLength(1)
    expect(stored.version).toBe(8)
    expect(stored.snapshot).toBe(theirs)

    await notice.getByRole('button', { name: 'إعادة تحميل الملف' }).click()
    await expect.poll(() => api.count('GET', '/api/workbooks/wb-c')).toBe(2)
    await waitForEditor(page)
    expect(await editorRoot(page).getAttribute('data-save-phase')).toBe('saved')
    expect(await editorRoot(page).getAttribute('data-save-version')).toBe('8')
    expect(await page.getByTestId('editor-conflict').count()).toBe(0)
    await expect.poll(() => host(page).getAttribute('data-rtl-mirrored'), { timeout: 15_000 }).toBe('true')
    await context.close()
  })

  it('a workbook viewer gets a read-only editor that never saves', async () => {
    const api = new MockApi()
    api.add(summary({ id: 'wb-v', title: 'ملف للاطلاع', access: 'viewer' }), taskSnapshot('wb-v', 'sheet-1', 'ملف'), 4)
    const { context, page } = await openPage(api, '/workbooks/wb-v')
    await waitForEditor(page)
    expect(await page.getByTestId('editor-read-only').innerText()).toContain('قراءة فقط')
    expect(await page.getByTestId('save-status').count()).toBe(0)
    await typeIntoCell(page, 1, 3, 'محاولة')
    await page.waitForTimeout(3000)
    expect(api.puts()).toHaveLength(0)
    await context.close()
  })

  it('no uncaught page error and no request left 127.0.0.1 except the blocked CDN font', () => {
    expect(pageErrors).toEqual([])
    expect(blockedRequests.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/'))).toEqual([])
  })
})
