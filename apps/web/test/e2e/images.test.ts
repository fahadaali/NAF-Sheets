// Pictures in the editor (owner, 2026-11-11; apps/web OPEN_QUESTIONS.md I1–I8),
// in the real app on the mirrored grid, the API mocked:
// - a picture inserted over the cells through Univer's own «صورة» menu is
//   uploaded to the platform (POST /api/workbooks/:id/images), saved as a URL
//   (never base64), moved by dragging it, and still there after a reload;
// - an imported workbook with a picture over the grid and one inside a cell
//   shows both, read from the platform's image route.
//
// Screenshots: test/e2e/screenshots/images-*.png at 1280 px and 375 px.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cellImageDocument, sheetImageOf } from '@naf-sheets/gsheets-import'
import { BASE_URL } from './global-setup'
import { openFirstSheet } from './editor-tabs'
import { MockApi, sheetMeta, summary, taskSnapshot } from './mock-api'
import type { Recorded } from './mock-api'

const SHOTS = process.env.E2E_SCREENSHOTS ?? fileURLToPath(new URL('./screenshots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

/** A 120 × 60 PNG: a solid band (test data, not interface colour) so the picture is easy to find on screen. */
async function makePng(lab: Page): Promise<Buffer> {
  const b64 = await lab.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 120
    c.height = 60
    const ctx = c.getContext('2d')!
    ctx.fillStyle = 'rgb(250, 200, 40)'
    ctx.fillRect(0, 0, 120, 60)
    ctx.fillStyle = 'rgb(20, 60, 200)'
    ctx.fillRect(80, 10, 30, 40)
    return c.toDataURL('image/png').split(',')[1]!
  })
  return Buffer.from(b64, 'base64')
}

/** Image routes of the mock API: uploads are kept and served back. */
function withImages(api: MockApi, workbookId: string): { stored: Map<string, Buffer>; uploads: Recorded[] } {
  const stored = new Map<string, Buffer>()
  const uploads: Recorded[] = []
  let n = 0
  const previous = api.override
  api.override = (req) => {
    const path = req.path.split('?')[0]!
    if (req.method === 'POST' && path === `/api/workbooks/${workbookId}/images`) {
      uploads.push(req)
      const imageId = String(++n).padStart(32, 'a')
      stored.set(imageId, png)
      return { status: 201, body: { imageId, url: `/api/workbooks/${workbookId}/images/${imageId}`, contentType: 'image/png', size: png.length } }
    }
    const get = new RegExp(`^/api/workbooks/${workbookId}/images/([0-9a-f]{32})$`).exec(path)
    if (req.method === 'GET' && get) {
      const data = stored.get(get[1]!)
      if (!data) return { status: 404, body: { ok: false, error: 'image_not_found', message: 'لم يُعثر على هذه الصورة.' } }
      return { status: 200, body: undefined, raw: { contentType: 'image/png', data, headers: { 'x-content-type-options': 'nosniff' } } }
    }
    return previous?.(req)
  }
  return { stored, uploads }
}

let browser: Browser
let lab: Page
let png: Buffer
const pageErrors: string[] = []

beforeAll(async () => {
  browser = await chromium.launch()
  lab = await (await browser.newContext()).newPage()
  png = await makePng(lab)
})
afterAll(async () => {
  await browser?.close()
})

async function openEditor(api: MockApi, id: string, width = 1280): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
  await context.route((url) => !url.href.startsWith(BASE_URL), (route) => route.abort())
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  await api.install(page)
  await page.goto(`${BASE_URL}/workbooks/${id}?sheet=sheet-1`)
  await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
  await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 30_000 })
  await openFirstSheet(page)
  try {
    await page.locator('[data-testid="univer-host"][data-rtl-mirrored="true"]').waitFor({ timeout: 15_000 })
  } catch (error) {
    const state = await page.evaluate(() => ({ mirrored: document.querySelector('[data-testid="univer-host"]')?.getAttribute('data-rtl-mirrored'), reason: [...document.querySelectorAll('bdi[dir=ltr]')].map((b) => b.textContent).join(' | ') }))
    throw new Error(`RTL grid not mirrored: ${JSON.stringify(state)}`, { cause: error })
  }
  return { page, close: () => context.close() }
}

type Drawing = { source: string; imageSourceType: string; sheetTransform: { from: { column: number; row: number; columnOffset: number } } }
function drawingsIn(snapshot: unknown, sheet = 'sheet-1'): Drawing[] {
  const res = (snapshot as { resources?: Array<{ name: string; data: string }> }).resources?.find((r) => r.name === 'SHEET_DRAWING_PLUGIN')
  if (!res) return []
  const data = JSON.parse(res.data) as Record<string, { data: Record<string, Drawing>; order: string[] }>
  const entry = data[sheet]
  return entry ? entry.order.map((id) => entry.data[id]!).filter(Boolean) : []
}

/** Box of the picture on screen: the pixels of its yellow band. */
async function pictureBox(page: Page): Promise<{ left: number; right: number; top: number; bottom: number } | null> {
  const canvas = (await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox())!
  const clip = { x: Math.round(canvas.x), y: Math.round(canvas.y), width: Math.round(canvas.width), height: Math.round(Math.min(canvas.height, 600)) }
  const shot = (await page.screenshot({ clip })).toString('base64')
  return lab.evaluate(async ({ shot, clip }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${shot}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (Math.abs(data[i]! - 250) < 12 && Math.abs(data[i + 1]! - 200) < 12 && Math.abs(data[i + 2]! - 40) < 12) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
    }
    return minX === Infinity ? null : { left: clip.x + minX, right: clip.x + maxX, top: clip.y + minY, bottom: clip.y + maxY }
  }, { shot, clip })
}

const savedSnapshots = (api: MockApi, id: string) =>
  api.requests.filter((r) => r.method === 'PUT' && r.path === `/api/workbooks/${id}/snapshot`).map((r) => (r.body as { snapshot: unknown }).snapshot)

describe('pictures over the cells', () => {
  it('inserted through Univer’s menu: uploaded, saved as a URL, moved by dragging, kept after a reload', async () => {
    const api = new MockApi()
    const id = 'wb-img'
    api.add(summary({ id, title: 'خطة بالصور' }), taskSnapshot(id, 'sheet-1', 'خطة بالصور'), 3, [sheetMeta('sheet-1')])
    const { uploads } = withImages(api, id)
    const { page, close } = await openEditor(api, id)

    // Univer's own toolbar: the «إدراج» tab, its «صورة» menu → «صورة عائمة», then the file chooser.
    await page.getByText('إدراج', { exact: true }).first().click()
    await page.locator('[data-u-command="sheet.menu.image"]').first().click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByText('صورة عائمة', { exact: true }).first().click()
    await (await chooser).setFiles({ name: 'شعار.png', mimeType: 'image/png', buffer: png })
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => drawingsIn(savedSnapshots(api, id).at(-1) ?? {}).length, { timeout: 20_000 }).toBe(1)
    const inserted = drawingsIn(savedSnapshots(api, id).at(-1))[0]!
    expect(inserted.imageSourceType).toBe('URL')
    expect(inserted.source).toMatch(new RegExp(`^/api/workbooks/${id}/images/[0-9a-f]{32}$`))
    expect(JSON.stringify(savedSnapshots(api, id).at(-1))).not.toContain('data:image')

    // On screen, not mirrored: the blue block sits in the picture's right part.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const before = await pictureBox(page)
    expect(before, 'the picture is drawn').not.toBeNull()
    await page.screenshot({ path: join(SHOTS, 'images-floating-desktop.png') })

    // Drag it 200 px to the visual left: on the mirrored grid that is towards later columns.
    const from = inserted.sheetTransform.from
    const cx = (before!.left + before!.right) / 2
    const cy = (before!.top + before!.bottom) / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - 100, cy + 30, { steps: 8 })
    await page.mouse.move(cx - 200, cy + 60, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(() => drawingsIn(savedSnapshots(api, id).at(-1) ?? {})[0]?.sheetTransform.from.column ?? -1, { timeout: 20_000 })
      .toBeGreaterThan(from.column)
    const moved = drawingsIn(savedSnapshots(api, id).at(-1))[0]!
    expect(moved.sheetTransform.from.row).toBeGreaterThanOrEqual(from.row)
    const after = await pictureBox(page)
    expect(after!.right).toBeLessThan(before!.right - 150)
    // Nothing of it was sent as base64; only the one upload.
    expect(uploads).toHaveLength(1)
    await close()

    // Reload: the saved picture is drawn again from the platform's image route.
    const second = await openEditor(api, id)
    await expect.poll(async () => (await pictureBox(second.page)) !== null, { timeout: 15_000 }).toBe(true)
    expect(api.requests.some((r) => r.method === 'GET' && r.path === moved.source)).toBe(true)
    await second.close()

    // 375 px.
    const narrow = await openEditor(api, id, 375)
    await narrow.page.waitForTimeout(1200)
    await narrow.page.screenshot({ path: join(SHOTS, 'images-floating-375.png') })
    await narrow.close()
    expect(pageErrors).toEqual([])
  })

  it('an imported workbook shows its picture over the grid and its picture inside a cell', async () => {
    const api = new MockApi()
    const id = 'wb-imported'
    const { stored } = withImages(api, id)
    const floatingId = 'f'.repeat(32)
    const cellId = 'e'.repeat(32)
    stored.set(floatingId, png)
    stored.set(cellId, png)
    const snapshot = taskSnapshot(id, 'sheet-1', 'ملف مستورد') as Record<string, any>
    const sheet = snapshot.sheets['sheet-1']
    const floating = sheetImageOf(id, sheet, 'img-1', { kind: 'floating', sheetGid: 1, source: `/api/workbooks/${id}/images/${floatingId}`, anchor: { type: 'oneCell', from: { column: 3, row: 4, columnOffset: 6, rowOffset: 4 }, width: 120, height: 60 } })
    snapshot.resources = [{ name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ 'sheet-1': { data: { 'img-1': floating }, order: ['img-1'] } }) }]
    sheet.cellData[2] = { ...(sheet.cellData[2] ?? {}), 6: { t: 1, p: cellImageDocument([{ drawingId: 'cell-1', source: `/api/workbooks/${id}/images/${cellId}`, width: 80, height: 22 }]) } }
    api.add(summary({ id, title: 'ملف مستورد' }), snapshot, 2, [sheetMeta('sheet-1')])
    const { page, close } = await openEditor(api, id)
    await expect.poll(() => api.requests.filter((r) => r.method === 'GET' && /\/images\//.test(r.path)).map((r) => r.path.split('/').at(-1)).sort(), { timeout: 20_000 }).toEqual([cellId, floatingId].sort())
    await expect.poll(async () => (await pictureBox(page)) !== null, { timeout: 15_000 }).toBe(true)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'images-imported-desktop.png') })
    // Opening it saves nothing.
    expect(savedSnapshots(api, id)).toEqual([])
    await close()
    const narrow = await openEditor(api, id, 375)
    await narrow.page.waitForTimeout(1500)
    await narrow.page.screenshot({ path: join(SHOTS, 'images-imported-375.png') })
    await narrow.close()
    expect(pageErrors).toEqual([])
  })
})
