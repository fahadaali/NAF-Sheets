// Formula colours while editing (owner, 2026-11-11; OPEN_QUESTIONS.md F1–F4):
// Excel's reference colours and outlines, plus the theme's colours for the
// other tokens, in the real app on the mirrored grid. A formula with two
// references, two functions, a string, a condition and a sheet name is typed
// into a cell; the colours actually on screen are read back from the pixels
// of the cell editor, the formula bar and the grid.
//
// Screenshots: test/e2e/screenshots/formula-colours-*.png (desktop width).

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
const C = {
  ref1: token('--formula-ref-1'),
  ref2: token('--formula-ref-2'),
  function: token('--formula-function'),
  string: token('--formula-string'),
  comparison: token('--formula-comparison'),
  sheet: token('--formula-sheet'),
  number: token('--formula-number'),
}

// Two references (B2:C3 and B2, inside the first: two colours), IF and SUM, a
// string, a condition, and a reference to the other sheet «ملخص» (its name in
// the sheet colour, the address left plain as Excel does).
const FORMULA = `=IF(SUM(B2:C3,B2)>=10,"نعم",'ملخص'!A1)`

function snapshot(unitId: string): Record<string, unknown> {
  return {
    id: unitId,
    name: 'ألوان الصيغ',
    appVersion: '1.4.0',
    styles: {},
    sheetOrder: ['sheet-1', 'sheet-2'],
    sheets: {
      'sheet-1': {
        id: 'sheet-1',
        name: 'المهام',
        rightToLeft: 1,
        defaultStyle: { ff: 'Thmanyah Sans' },
        cellData: { 0: { 0: { v: 'المهمة' } }, 1: { 1: { v: 4 }, 2: { v: 6 } }, 2: { 1: { v: 1 }, 2: { v: 2 } } },
      },
      'sheet-2': { id: 'sheet-2', name: 'ملخص', rightToLeft: 1, cellData: { 0: { 0: { v: 'الإجمالي' } } } },
    },
  }
}

// Univer 1.4.0 defaults (as in smoke.test.ts): the snapshot sets no sizes.
const GRID = { rowHeaderWidth: 46, columnHeaderHeight: 20, columnWidth: 88, rowHeight: 24 }
type Box = { left: number; right: number; top: number; bottom: number }

/** On-screen box of a cell (0-based) on the mirrored grid: column A at the visual right. */
async function cellBox(page: Page, column: number, row: number): Promise<Box> {
  const box = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!box) throw new Error('sheet canvas not found')
  const right = box.x + box.width - GRID.rowHeaderWidth - GRID.columnWidth * column
  const top = box.y + GRID.columnHeaderHeight + GRID.rowHeight * row
  return { left: right - GRID.columnWidth, right, top, bottom: top + GRID.rowHeight }
}

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

interface Ink { left: number; right: number; top: number; bottom: number; meanX: number; count: number }

/** Pixels of `page` inside `clip` within `tolerance` of `hex`, as a box in page coordinates (null when none). */
async function ink(page: Page, clip: { x: number; y: number; width: number; height: number }, hex: string, tolerance = 18): Promise<Ink | null> {
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
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0, sumX = 0
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (Math.abs(data[i]! - r0!) > tolerance || Math.abs(data[i + 1]! - g0!) > tolerance || Math.abs(data[i + 2]! - b0!) > tolerance) continue
      count++
      sumX += x
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const s = c.width / clip.width
    return count ? { left: clip.x + minX / s, right: clip.x + maxX / s, top: clip.y + minY / s, bottom: clip.y + maxY / s, meanX: clip.x + sumX / count / s, count } : null
  }, { png, clip, hex, tolerance })
}

const clipOf = (b: { x: number; y: number; width: number; height: number }) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })

describe('formula colours while editing', () => {
  it('colours every token in the cell editor and the formula bar, and outlines the references on the mirrored grid', async () => {
    const api = new MockApi()
    api.add(summary({ id: 'wb-fc', title: 'ألوان الصيغ', sheetCount: 2 }), snapshot('wb-fc'), 3, [sheetMeta('sheet-1'), { ...sheetMeta('sheet-2', 'ملخص'), position: 1 }])
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
    await context.route((url) => !url.href.startsWith(BASE_URL), (route) => route.abort())
    const page = await context.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && /formula-colours|formula colours/.test(m.text())) consoleErrors.push(m.text())
    })
    await api.install(page)
    await page.goto(`${BASE_URL}/workbooks/wb-fc?sheet=sheet-1`)
    await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
    await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 30_000 })
    await openFirstSheet(page)
    await page.locator('[data-testid="univer-host"][data-rtl-mirrored="true"]').waitFor({ timeout: 15_000 })

    // Edit E6 (column 4, row 5): far from the references, so the analyses do not overlap.
    const target = await cellBox(page, 4, 5)
    await page.mouse.dblclick((target.left + target.right) / 2, (target.top + target.bottom) / 2)
    await page.waitForTimeout(300)
    await page.keyboard.type(FORMULA)
    await page.waitForTimeout(800)

    // The cell editor: the band of the edited row, across the grid.
    const canvas = (await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox())!
    // The row header (at the visual right) is left out: its digits are grey.
    const editorClip = clipOf({ x: canvas.x, y: target.top - 2, width: canvas.width - GRID.rowHeaderWidth, height: target.bottom - target.top + 4 })
    // The sheet colour is a grey: anti-aliased edges of the plain (dark) text
    // pass near it, so it is matched tightly; the other colours are saturated.
    const inks = async (clip: ReturnType<typeof clipOf>) => {
      const out: Record<string, Ink | null> = {}
      for (const [name, hex] of Object.entries(C)) out[name] = await ink(page, clip, hex, name === 'sheet' ? 4 : 18)
      return out
    }
    const checkOrder = (where: string, f: Record<string, Ink | null>) => {
      for (const name of Object.keys(C)) expect(f[name], `${where}: ${name} colour painted`).not.toBeNull()
      // A formula reads left to right: the functions, the references, the condition,
      // the number, then the string and the sheet name (bidi-ordered Arabic).
      const x = (name: keyof typeof C) => f[name]!.meanX
      expect(x('function'), `${where}: IF, SUM first`).toBeLessThan(x('ref1'))
      expect(x('ref1'), `${where}: B2:C3 before B2`).toBeLessThan(x('ref2'))
      expect(x('ref2'), `${where}: the references before >=`).toBeLessThan(x('comparison'))
      expect(x('comparison'), `${where}: >= before 10`).toBeLessThan(x('number'))
      expect(x('number'), `${where}: 10 before the string and the sheet name`).toBeLessThan(Math.min(x('string'), x('sheet')))
    }
    await page.screenshot({ path: join(SHOTS, 'formula-colours-cell-editor.png'), clip: clipOf({ x: canvas.x, y: canvas.y, width: canvas.width, height: target.bottom - canvas.y + 40 }) })
    checkOrder('cell editor', await inks(editorClip))

    // Outlines on the mirrored grid: B2:C3 in Excel's first colour, B2 in its second.
    const gridClip = clipOf({ x: canvas.x, y: canvas.y + GRID.columnHeaderHeight, width: canvas.width - GRID.rowHeaderWidth, height: target.top - canvas.y - GRID.columnHeaderHeight - 4 })
    const blue = await ink(page, gridClip, C.ref1, 10)
    const red = await ink(page, gridClip, C.ref2, 10)
    const b2 = await cellBox(page, 1, 1)
    const c3 = await cellBox(page, 2, 2)
    await page.screenshot({ path: join(SHOTS, 'formula-colours-outlines.png'), clip: clipOf({ x: c3.left - 60, y: canvas.y, width: b2.right - c3.left + 120, height: c3.bottom - canvas.y + 40 }) })
    const near = (a: number, b: number) => Math.abs(a - b) <= 4
    expect(blue, 'outline of B2:C3').not.toBeNull()
    expect(red, 'outline of B2').not.toBeNull()
    for (const [got, want] of [[blue!, { left: c3.left, right: b2.right, top: b2.top, bottom: c3.bottom }], [red!, b2]] as const) {
      for (const side of ['left', 'right', 'top', 'bottom'] as const) expect(near(got[side], want[side]), `${side}: ${got[side]} vs ${want[side]}`).toBe(true)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // The formula bar: like Excel, the editor in use is the one coloured, so the formula is typed there.
    const other = await cellBox(page, 4, 7)
    await page.mouse.click((other.left + other.right) / 2, (other.top + other.bottom) / 2)
    await page.waitForTimeout(200)
    const barEditor = (await page.locator('[data-u-comp="formula-bar"] canvas').first().boundingBox())!
    await page.mouse.click(barEditor.x + barEditor.width / 2, barEditor.y + barEditor.height / 2)
    await page.waitForTimeout(300)
    await page.keyboard.type(FORMULA)
    await page.waitForTimeout(800)
    const bar = (await page.locator('[data-u-comp="formula-bar"]').first().boundingBox())!
    await page.screenshot({ path: join(SHOTS, 'formula-colours-formula-bar.png'), clip: clipOf({ x: bar.x, y: bar.y - 4, width: bar.width, height: bar.height + 8 }) })
    checkOrder('formula bar', await inks(clipOf(barEditor)))

    // Enter ends the edit with no error from the layer.
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
    await context.close()
  })
})
