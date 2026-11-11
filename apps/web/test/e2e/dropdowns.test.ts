// Imported dropdowns in the editor (apps/api OPEN_QUESTIONS.md "Google import"
// G32): a workbook is imported from a public Google link, its report lists the
// dropdown notes, and the dropdowns look and work right in the mirrored (RTL)
// grid: chips in their colours with readable Arabic, the list opening under
// its cell and aligned with its right edge, a single and a multiple pick, and
// the help text Univer stores but does not show.
//
// The workbooks are the converter's own output, built here in Node:
//   «خطة الاتصال» — synthesised: what @naf-sheets/xlsx-import produces for a
//     Google export plus Google's rendering (chip colours, a multiple
//     selection, a range list on another sheet, help text), Arabic, RTL.
//   «قوائم منسدلة» — REAL: packages/xlsx-import/test/fixtures/google-dropdowns-advanced.xlsx
//     with its real htmlview pages, through importXlsx.
// Screenshots: test/e2e/screenshots/dropdown-*.png (desktop and 375 px).

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { convertSpreadsheet, type GsCellData, type GsDataValidationRule, type GsSpreadsheet, type ImportReport } from '@naf-sheets/gsheets-import'
import type { SheetMeta } from '@naf-sheets/shared'
import { importXlsx, parseGoogleSheetChips, parseGoogleSheetIndex } from '../../../../packages/xlsx-import/src'
import { BASE_URL } from './global-setup'
import { MockApi, sheetMeta, summary } from './mock-api'

const SHOTS = process.env.E2E_SCREENSHOTS ?? fileURLToPath(new URL('./screenshots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })
const FIXTURES = new URL('../../../../packages/xlsx-import/test/fixtures/', import.meta.url)
const SPREADSHEET_ID = '1dUjG8hNj9BAT42xRucaXUmuJzbl6pxefz-8QQFcDdgU'

// ---------------------------------------------------------------------------
// «خطة الاتصال»: the intermediate model a Google export + rendering gives.

const COL_WIDTH = 140
const ROW_HEIGHT = 34
const STATUS: GsDataValidationRule = {
  condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'قيد التنفيذ' }, { userEnteredValue: 'منجز' }, { userEnteredValue: 'متأخر' }] },
  strict: true,
  showCustomUi: true,
  naf: { displayStyle: 'CHIP', itemColors: { 'قيد التنفيذ': '#bfe1f6', منجز: '#d4edbc', متأخر: '#ffcfc9' } },
}
const TEAM: GsDataValidationRule = {
  condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='القوائم'!$A$1:$A$3" }] },
  strict: true,
  showCustomUi: true,
  naf: { displayStyle: 'CHIP', itemColors: { التصميم: '#e6cff2', المحتوى: '#ffe5a0', 'التصميم, المحتوى': '#e8eaed' } },
}
const PRIORITY: GsDataValidationRule = {
  condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'عالية' }, { userEnteredValue: 'متوسطة' }, { userEnteredValue: 'منخفضة' }] },
  showCustomUi: true,
  inputMessage: 'اختر أولوية المهمة قبل موعد التسليم',
  naf: { inputTitle: 'الأولوية' },
}
const s = (v: string, rule?: GsDataValidationRule): GsCellData => ({ userEnteredValue: { stringValue: v }, effectiveValue: { stringValue: v }, formattedValue: v, ...(rule ? { dataValidation: rule } : {}) })
const blank = (rule: GsDataValidationRule): GsCellData => ({ dataValidation: rule })

function planSpreadsheet(): GsSpreadsheet {
  const rows: GsCellData[][] = [
    [s('المهمة'), s('الحالة'), s('الفريق'), s('الأولوية')],
    [s('إعداد الخطة'), s('منجز', STATUS), s('التصميم, المحتوى', TEAM), s('عالية', PRIORITY)],
    [s('تصميم الهوية'), s('قيد التنفيذ', STATUS), s('التصميم', TEAM), s('متوسطة', PRIORITY)],
    [s('كتابة المحتوى'), s('متأخر', STATUS), blank(TEAM), blank(PRIORITY)],
  ]
  const size = { rowMetadata: Array.from({ length: 30 }, () => ({ pixelSize: ROW_HEIGHT })), columnMetadata: Array.from({ length: 8 }, () => ({ pixelSize: COL_WIDTH })) }
  return {
    spreadsheetId: 'synthetic-plan',
    properties: { title: 'خطة الاتصال', locale: 'ar_SA' },
    sheets: [
      { properties: { sheetId: 0, title: 'المهام', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 30, columnCount: 8 }, rightToLeft: true }, data: [{ rowData: rows.map((values) => ({ values })), ...size }] },
      { properties: { sheetId: 1, title: 'القوائم', index: 1, sheetType: 'GRID', gridProperties: { rowCount: 30, columnCount: 4 }, rightToLeft: true }, data: [{ rowData: ['التصميم', 'المحتوى', 'النشر'].map((v) => ({ values: [s(v)] })) }] },
    ],
  }
}

const plan = convertSpreadsheet(planSpreadsheet(), { workbookId: 'wb-dd', origin: { kind: 'google_export', via: 'google_link', application: null, alignment: 'as_given' } })

function addPlan(api: MockApi): { workbookId: string; reportId: string } {
  const sheets: SheetMeta[] = [{ ...sheetMeta('sheet-0', 'المهام'), position: 1 }, { ...sheetMeta('sheet-1', 'القوائم'), position: 2 }]
  api.add(summary({ id: 'wb-dd', title: 'خطة الاتصال', sheetCount: 2 }), plan.workbook, 1, sheets)
  api.importReports.set('wb-dd', { reportId: 'rep-dd', createdAt: '2026-11-11T09:30:00Z', report: plan.report })
  return { workbookId: 'wb-dd', reportId: 'rep-dd' }
}

// ---------------------------------------------------------------------------

let browser: Browser
const pageErrors: string[] = []
let real: Awaited<ReturnType<typeof importXlsx>>

beforeAll(async () => {
  browser = await chromium.launch()
  const pages = new Map<string, ReturnType<typeof parseGoogleSheetChips>>()
  const page = (name: string) => readFileSync(new URL(`htmlview/${name}`, FIXTURES), 'utf8')
  for (const sheet of parseGoogleSheetIndex(page('google-dropdowns-advanced.index.html'))) {
    try {
      pages.set(sheet.name, parseGoogleSheetChips(page(`google-dropdowns-advanced.gid-${sheet.gid}.html`)))
    } catch {
      // that sheet's page was not saved (it holds no dropdown)
    }
  }
  real = await importXlsx(new Uint8Array(readFileSync(new URL('google-dropdowns-advanced.xlsx', FIXTURES))), { workbookId: 'wb-real', via: 'google_link', googleRendering: async () => pages })
})
afterAll(async () => {
  await browser?.close()
})

async function openPage(api: MockApi, path: string, viewport = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
  await context.route((url) => !url.href.startsWith(BASE_URL), (route) => route.abort())
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${String(e).slice(0, 300)}`))
  await api.install(page)
  await page.goto(BASE_URL + path)
  return { context, page }
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false })

async function waitForGrid(page: Page): Promise<void> {
  await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
  await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(800)
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }
/** On-screen box of a cell of «المهام» (0-based) on the mirrored grid: column A at the visual right. */
async function cellBox(page: Page, column: number, row: number): Promise<Box> {
  const canvas = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!canvas) throw new Error('sheet canvas not found')
  const right = canvas.x + canvas.width - 46 - COL_WIDTH * column
  const top = canvas.y + 20 + ROW_HEIGHT * row
  return { left: right - COL_WIDTH, right, top, bottom: top + ROW_HEIGHT, width: COL_WIDTH, height: ROW_HEIGHT }
}

/** The smallest visible DOM box holding every text (the dropdown panel, an alert). */
const domBoxWithText = (page: Page, texts: string[]) =>
  page.evaluate((want) => {
    let best: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null = null
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('canvas') || el.closest('[data-testid="report-summary"]')) continue
      const t = el.textContent ?? ''
      if (!want.every((w) => t.includes(w))) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (!best || r.width * r.height < best.width * best.height) best = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    return best
  }, texts)

/** Share of pixels in a screen box within `tolerance` of a colour (what the person sees, after the CSS mirror). */
async function colourShare(page: Page, box: Box, hex: string, tolerance = 10): Promise<number> {
  const png = (await page.screenshot({ clip: { x: box.left + 2, y: box.top + 2, width: box.width - 4, height: box.height - 4 } })).toString('base64')
  return page.evaluate(
    async ({ data, hex, tolerance }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const c = document.createElement('canvas')
      c.width = image.width
      c.height = image.height
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(image, 0, 0)
      const px = ctx.getImageData(0, 0, c.width, c.height).data
      const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      let hit = 0
      for (let i = 0; i < px.length; i += 4) if (want.every((w, k) => Math.abs((px[i + k] as number) - w) <= tolerance)) hit++
      return hit / (px.length / 4)
    },
    { data: png, hex, tolerance },
  )
}

/** The value of a cell in the last snapshot the editor saved. */
function savedValue(api: MockApi, row: number, column: number): unknown {
  const last = api.puts('wb-dd').at(-1) as unknown as { snapshot?: { sheets?: Record<string, { cellData?: Record<number, Record<number, { v?: unknown }>> }> } } | undefined
  return last?.snapshot?.sheets?.['sheet-0']?.cellData?.[row]?.[column]?.v
}

// ---------------------------------------------------------------------------

describe('imported dropdowns in the editor (G32)', () => {
  it('imports from a public link; the report lists the dropdown notes and opens the multiple-selection cell', async () => {
    const api = new MockApi()
    api.onLinkImport = () => addPlan(api)
    const { context, page } = await openPage(api, `/?import=${SPREADSHEET_ID}`)
    const dialog = page.getByRole('dialog', { name: 'ملف جديد' })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'استيراد' }).click()
    await page.waitForURL(`${BASE_URL}/workbooks/wb-dd/import-report`)
    await page.getByTestId('report-summary').waitFor()
    const notes = page.locator('[data-report-sheet="sheet-0"] [data-kind="data_validation"]')
    const texts = await notes.allInnerTexts()
    expect(texts.some((t) => t.includes('متعددة الاختيار') && t.includes("'المهام'!C2:C4"))).toBe(true)
    expect(texts.some((t) => t.includes('ألوان خيارات القائمة نُقلت'))).toBe(true)
    await shot(page, 'dropdown-report')
    await notes.filter({ hasText: 'متعددة الاختيار' }).getByRole('link', { name: 'الانتقال إلى الموقع' }).click()
    await page.waitForURL((url) => url.pathname === '/workbooks/wb-dd' && url.searchParams.get('sheet') === 'sheet-0' && url.searchParams.get('range') === 'C2:C4')
    await waitForGrid(page)
    await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-selection'), { timeout: 15_000 }).toBe('sheet-0!C2:C4')
    await context.close()
  })

  it('draws chips in the item colours, with readable Arabic, on the mirrored grid', async () => {
    const api = new MockApi()
    addPlan(api)
    const { context, page } = await openPage(api, '/workbooks/wb-dd?sheet=sheet-0')
    await waitForGrid(page)
    await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-rtl-mirrored'), { timeout: 15_000 }).toBe('true')
    await shot(page, 'dropdown-chips')
    // Each status chip in its own colour (B2 منجز green, B3 قيد التنفيذ blue, B4 متأخر red).
    expect(await colourShare(page, await cellBox(page, 1, 1), '#d4edbc')).toBeGreaterThan(0.25)
    expect(await colourShare(page, await cellBox(page, 1, 2), '#bfe1f6')).toBeGreaterThan(0.25)
    expect(await colourShare(page, await cellBox(page, 1, 3), '#ffcfc9')).toBeGreaterThan(0.25)
    // Two chips for the multiple selection in C2: both item colours show.
    const c2 = await cellBox(page, 2, 1)
    expect(await colourShare(page, c2, '#e6cff2')).toBeGreaterThan(0.05)
    expect(await colourShare(page, c2, '#ffe5a0')).toBeGreaterThan(0.05)
    await context.close()
  })

  it('opens the list under its cell, aligned with its right edge, and a pick replaces the value', async () => {
    const api = new MockApi()
    addPlan(api)
    const { context, page } = await openPage(api, '/workbooks/wb-dd?sheet=sheet-0')
    await waitForGrid(page)
    const b3 = await cellBox(page, 1, 2)
    await page.mouse.click(b3.left + b3.width / 2, b3.top + b3.height / 2)
    await page.waitForTimeout(600)
    // The whole panel: the items, its search field and «تحرير».
    const panel = await domBoxWithText(page, ['قيد التنفيذ', 'منجز', 'متأخر', 'تحرير'])
    await shot(page, 'dropdown-open')
    expect(panel).not.toBeNull()
    expect(Math.abs((panel?.right ?? 0) - b3.right)).toBeLessThanOrEqual(8)
    expect(Math.abs((panel?.top ?? 0) - b3.bottom)).toBeLessThanOrEqual(14)
    // The options carry the item colours (Univer's own list, DOM).
    const optionColour = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent === 'متأخر' && !e.closest('canvas'))
      let node: Element | null = el ?? null
      while (node && getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)') node = node.parentElement
      return node ? getComputedStyle(node).backgroundColor : null
    })
    expect(optionColour).toBe('rgb(255, 207, 201)')
    await page.locator('*', { hasText: /^متأخر$/ }).last().click()
    await expect.poll(() => savedValue(api, 2, 1), { timeout: 15_000 }).toBe('متأخر')
    await page.waitForTimeout(400)
    expect(await colourShare(page, b3, '#ffcfc9')).toBeGreaterThan(0.25)
    await context.close()
  })

  it('a multiple selection adds a pick to the cell', async () => {
    const api = new MockApi()
    addPlan(api)
    const { context, page } = await openPage(api, '/workbooks/wb-dd?sheet=sheet-0')
    await waitForGrid(page)
    const c3 = await cellBox(page, 2, 2)
    // A multiple list opens from its arrow only: the cell's end, its visual left on the mirrored grid.
    await page.mouse.click(c3.left + 7, c3.top + c3.height / 2)
    await page.waitForTimeout(600)
    const panel = await domBoxWithText(page, ['التصميم', 'المحتوى', 'النشر', 'تحرير'])
    expect(panel).not.toBeNull()
    expect(Math.abs((panel?.right ?? 0) - c3.right)).toBeLessThanOrEqual(8)
    await page.locator('*', { hasText: /^النشر$/ }).last().click()
    await page.waitForTimeout(300)
    await shot(page, 'dropdown-multi')
    await page.keyboard.press('Escape')
    // Univer stores a multiple pick as its JSON list (reported at import).
    await expect.poll(() => savedValue(api, 2, 2), { timeout: 15_000 }).toBe(JSON.stringify(['التصميم', 'النشر']))
    await context.close()
  })

  it('shows the help text of a rule when its cell is selected, beside the cell', async () => {
    const api = new MockApi()
    addPlan(api)
    const { context, page } = await openPage(api, '/workbooks/wb-dd?sheet=sheet-0')
    await waitForGrid(page)
    const d3 = await cellBox(page, 3, 2)
    // The start of the cell (its visual right), away from the arrow at its end.
    await page.mouse.click(d3.right - 20, d3.top + d3.height / 2)
    const alert = page.getByText('اختر أولوية المهمة قبل موعد التسليم')
    await alert.waitFor({ timeout: 5_000 })
    const box = await domBoxWithText(page, ['الأولوية', 'اختر أولوية المهمة قبل موعد التسليم'])
    await shot(page, 'dropdown-prompt')
    // Mirrored "horizontal": the alert opens on the cell's left (towards the next column).
    expect(box && box.right <= d3.left + 4).toBe(true)
    // A cell without help text closes it.
    const a3 = await cellBox(page, 0, 2)
    await page.mouse.click(a3.left + a3.width / 2, a3.top + a3.height / 2)
    await alert.waitFor({ state: 'hidden', timeout: 5_000 })
    await context.close()
  })

  it('at 375 px: the chips and the open list fit the narrow grid', async () => {
    const api = new MockApi()
    addPlan(api)
    const { context, page } = await openPage(api, '/workbooks/wb-dd?sheet=sheet-0', { width: 375, height: 812 })
    await waitForGrid(page)
    await shot(page, 'dropdown-chips-375')
    const b3 = await cellBox(page, 1, 2)
    await page.mouse.click(b3.left + b3.width / 2, b3.top + b3.height / 2)
    await page.waitForTimeout(600)
    // The whole panel: the items, its search field and «تحرير».
    const panel = await domBoxWithText(page, ['قيد التنفيذ', 'منجز', 'متأخر', 'تحرير'])
    await shot(page, 'dropdown-open-375')
    expect(panel).not.toBeNull()
    expect((panel?.left ?? -1) >= 0 && (panel?.right ?? 9999) <= 375).toBe(true)
    expect(Math.abs((panel?.top ?? 0) - b3.bottom)).toBeLessThanOrEqual(14)
    await context.close()
  })

  it('a real Google file: the multiple selection and the coloured dependent chip', async () => {
    const api = new MockApi()
    const ids = Object.keys(real.workbook.sheets)
    api.add(
      summary({ id: 'wb-real', title: 'قوائم منسدلة', sheetCount: ids.length }),
      real.workbook,
      1,
      ids.map((id, i) => ({ ...sheetMeta(id, real.workbook.sheets[id]?.name ?? id), position: i + 1 })),
    )
    const multi = ids.find((id) => real.workbook.sheets[id]?.name === 'DD-Multi-Select') as string
    const dependent = ids.find((id) => real.workbook.sheets[id]?.name === 'DD-Dependent') as string
    const { context, page } = await openPage(api, `/workbooks/wb-real?sheet=${multi}`)
    await waitForGrid(page)
    await shot(page, 'dropdown-real-multi')
    await page.goto(`${BASE_URL}/workbooks/wb-real?sheet=${dependent}`)
    await waitForGrid(page)
    await shot(page, 'dropdown-real-dependent')
    await context.close()
  })

  it('raised no page error', () => {
    expect(pageErrors).toEqual([])
  })
})

export type { ImportReport }
