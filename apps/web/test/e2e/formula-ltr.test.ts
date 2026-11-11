// Formula mode of the text layer (owner, 2026-11-11, «طبق من اليسار الى اليمين»;
// OPEN_QUESTIONS.md F5): while a formula is edited, the cell editor and the
// formula bar show it left to right, token by token, in the order it was
// typed; an Arabic string or sheet name reads right to left inside its own
// place. A formula with an Arabic string followed by an Arabic sheet name is
// the case plain bidi got wrong (the two traded places): here the string's
// colour must be painted left of the sheet name's, and the formula must start
// at the editor's left edge. The colours are read back from the pixels.
//
// Screenshot: test/e2e/screenshots/formula-ltr.png (desktop width).

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL } from './global-setup'
import { openFirstSheet } from './editor-tabs'
import { MockApi, sheetMeta, summary } from './mock-api'

const SHOTS = process.env.E2E_SCREENSHOTS ?? fileURLToPath(new URL('./screenshots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

// The colours under test, read from the one theme file (no colour is written here).
const THEME = readFileSync(fileURLToPath(new URL('../../src/styles/theme.css', import.meta.url)), 'utf8')
const token = (name: string): string => {
  const m = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(THEME)
  if (!m) throw new Error(`${name} not in theme.css`)
  return m[1]!.toLowerCase()
}
const C = { function: token('--formula-function'), string: token('--formula-string'), sheet: token('--formula-sheet'), number: token('--formula-number') }

// A string «نعم» then a reference to the sheet «ملخص»: with plain bidi the
// two Arabic tokens joined into one right-to-left run and «ملخص» came first.
const FORMULA = `=IF(B2>0,"نعم",'ملخص'!A1)`

function snapshot(unitId: string): Record<string, unknown> {
  return {
    id: unitId,
    name: 'صيغة من اليسار',
    appVersion: '1.4.0',
    styles: {},
    sheetOrder: ['sheet-1', 'sheet-2'],
    sheets: {
      'sheet-1': { id: 'sheet-1', name: 'المهام', rightToLeft: 1, defaultStyle: { ff: 'Thmanyah Sans' }, cellData: { 0: { 0: { v: 'المهمة' } }, 1: { 1: { v: 4 } } } },
      'sheet-2': { id: 'sheet-2', name: 'ملخص', rightToLeft: 1, cellData: { 0: { 0: { v: 'الإجمالي' } } } },
    },
  }
}

// Univer 1.4.0 defaults (as in smoke.test.ts): the snapshot sets no sizes.
const GRID = { rowHeaderWidth: 46, columnHeaderHeight: 20, columnWidth: 88, rowHeight: 24 }

/** On-screen centre of a cell (0-based) on the mirrored grid: column A at the visual right. */
async function cellCentre(page: Page, column: number, row: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!box) throw new Error('sheet canvas not found')
  const right = box.x + box.width - GRID.rowHeaderWidth - GRID.columnWidth * column
  return { x: right - GRID.columnWidth / 2, y: box.y + GRID.columnHeaderHeight + GRID.rowHeight * row + GRID.rowHeight / 2 }
}

/** The document canvases: the cell editor's and the formula bar's (Univer gives both the same id). */
async function editorCanvases(page: Page): Promise<{ cell: Rect | null; bar: Rect | null }> {
  return page.evaluate(() => {
    const out: { cell: Rect | null; bar: Rect | null } = { cell: null, bar: null }
    for (const c of document.querySelectorAll<HTMLCanvasElement>('canvas[id="univer-doc-main-canvas"]')) {
      const r = c.getBoundingClientRect()
      if (r.width === 0) continue
      const rect = { x: r.x, y: r.y, width: r.width, height: r.height }
      if (c.closest('[data-u-comp="formula-bar"]')) out.bar = rect
      else out.cell = rect
    }
    return out
  })
}
type Rect = { x: number; y: number; width: number; height: number }

let browser: Browser
let lab: Page
const pageErrors: string[] = []

beforeAll(async () => {
  browser = await chromium.launch()
  lab = await (await browser.newContext()).newPage()
})
afterAll(async () => {
  await browser?.close()
})

interface Ink { left: number; right: number; meanX: number; count: number }

/** Pixels of `page` inside `clip` within `tolerance` of `hex` (null when none). */
async function ink(page: Page, clip: Rect, hex: string, tolerance = 18): Promise<Ink | null> {
  const png = (await page.screenshot({ clip })).toString('base64')
  return lab.evaluate(async ({ png, clip, hex, tolerance }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    const [r0, g0, b0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    let minX = Infinity, maxX = -Infinity, count = 0, sumX = 0
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (Math.abs(data[i]! - r0!) > tolerance || Math.abs(data[i + 1]! - g0!) > tolerance || Math.abs(data[i + 2]! - b0!) > tolerance) continue
      count++
      sumX += x
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }
    const s = c.width / clip.width
    return count ? { left: clip.x + minX / s, right: clip.x + maxX / s, meanX: clip.x + sumX / count / s, count } : null
  }, { png, clip, hex, tolerance })
}

/** Leftmost dark (text) pixel inside `clip`, in page coordinates, or null. */
async function leftmostText(page: Page, clip: Rect): Promise<number | null> {
  const png = (await page.screenshot({ clip })).toString('base64')
  return lab.evaluate(async ({ png, clip }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    for (let x = 0; x < c.width; x++) for (let y = 0; y < c.height; y++) {
      const i = (y * c.width + x) * 4
      if (data[i]! < 120 && data[i + 1]! < 120 && data[i + 2]! < 120) return clip.x + x * (clip.width / c.width)
    }
    return null
  }, { png, clip })
}

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })

describe('formulas read left to right while edited', () => {
  it('cell editor and formula bar: the Arabic string stays before the Arabic sheet name, and the formula starts at the left edge', async () => {
    const api = new MockApi()
    api.add(summary({ id: 'wb-fl', title: 'صيغة من اليسار', sheetCount: 2 }), snapshot('wb-fl'), 3, [sheetMeta('sheet-1'), { ...sheetMeta('sheet-2', 'ملخص'), position: 1 }])
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
    await context.route((url) => !url.href.startsWith(BASE_URL), (route) => route.abort())
    const page = await context.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && /rtl-text|rtl-grid|formula-colours/.test(m.text())) consoleErrors.push(m.text())
    })
    await api.install(page)
    await page.goto(`${BASE_URL}/workbooks/wb-fl?sheet=sheet-1`)
    await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
    await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 30_000 })
    await openFirstSheet(page)
    await page.locator('[data-testid="univer-host"][data-rtl-mirrored="true"]').waitFor({ timeout: 15_000 })

    // Like Excel (and Univer), only the editor in use is coloured: the formula
    // is typed once in the cell editor (E6) and once in the formula bar (E8).
    const checkEditor = async (where: string, rect: Rect) => {
      const clip = round(rect)
      const fn = await ink(page, clip, C.function)
      const num = await ink(page, clip, C.number)
      const str = await ink(page, clip, C.string)
      // The sheet colour is a grey: matched tightly (anti-aliased dark text passes near it).
      const sheet = await ink(page, clip, C.sheet, 4)
      for (const [name, got] of [['IF', fn], ['0', num], ['"نعم"', str], ["'ملخص'!", sheet]] as const) expect(got, `${where}: ${name} painted`).not.toBeNull()
      // Left to right in typed order: IF, 0, then the string, then the sheet name.
      expect(fn!.meanX, `${where}: IF before 0`).toBeLessThan(num!.meanX)
      expect(num!.meanX, `${where}: 0 before "نعم"`).toBeLessThan(str!.meanX)
      expect(str!.right, `${where}: "نعم" wholly before 'ملخص'!`).toBeLessThan(sheet!.left)
      // The formula starts at the left edge (the = sign within a few pixels of it).
      const left = await leftmostText(page, clip)
      expect(left, `${where}: text painted`).not.toBeNull()
      expect(left! - rect.x, `${where}: = at the left edge`).toBeLessThan(8)
    }

    const target = await cellCentre(page, 4, 5)
    await page.mouse.dblclick(target.x, target.y)
    await page.waitForTimeout(300)
    await page.keyboard.type(FORMULA)
    await page.waitForTimeout(800)
    const inCell = await editorCanvases(page)
    expect(inCell.cell, 'cell editor canvas').not.toBeNull()
    expect(inCell.bar, 'formula bar canvas').not.toBeNull()
    await page.screenshot({ path: join(SHOTS, 'formula-ltr.png'), clip: round({ x: 0, y: inCell.bar!.y - 8, width: 1280, height: inCell.cell!.y + inCell.cell!.height + 40 - (inCell.bar!.y - 8) }) })
    await checkEditor('cell editor', inCell.cell!)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    const other = await cellCentre(page, 4, 7)
    await page.mouse.click(other.x, other.y)
    await page.waitForTimeout(200)
    const barCanvas = (await editorCanvases(page)).bar!
    await page.mouse.click(barCanvas.x + barCanvas.width / 2, barCanvas.y + barCanvas.height / 2)
    await page.waitForTimeout(300)
    await page.keyboard.type(FORMULA)
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(SHOTS, 'formula-ltr-formula-bar.png'), clip: round({ x: barCanvas.x - 8, y: barCanvas.y - 4, width: barCanvas.width + 16, height: barCanvas.height + 8 }) })
    await checkEditor('formula bar', (await editorCanvases(page)).bar!)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
    await context.close()
  })
})
