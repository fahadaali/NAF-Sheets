// Load test of the editor (spec §15 phase 7): every workbook of the load set
// (default 10 × 7 sheets × 500 rows) opened in headless Chromium from the
// built app, the API mocked by route interception (test/e2e/mock-api.ts).
//
// Measured per workbook, from Node (wall clock):
//   openMs   page.goto → the grid engine is ready (`data-engine="ready"`)
//   readyMs  … → the room answered (the mock has none: the editor falls back to PUT)
//   tabMs    clicking the last sheet's tab → that sheet is the active one
//   heapMB   JS heap once open (Chromium's performance.memory)
// The font CDN is blocked (hermetic), so text is measured with the fallback face.

import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type { SheetMeta } from '@naf-sheets/shared'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL } from '../e2e/global-setup'
import { MockApi, summary } from '../e2e/mock-api'

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? '')
  return Number.isInteger(n) && n > 0 ? n : fallback
}

const CONFIG = { workbooks: intFromEnv('LOAD_WORKBOOKS', 10), sheets: intFromEnv('LOAD_SHEETS', 7), rows: intFromEnv('LOAD_ROWS', 500) }
const PEOPLE = ['سارة القحطاني', 'خالد العمري', 'نورة الشهري', 'فهد العتيبي']
const NAMES = ['المحتوى', 'التصميم', 'الإعلام', 'الفعاليات', 'التقارير', 'الميزانية', 'المتابعة']

function date(offset: number): string {
  return new Date(Date.UTC(2026, 10, 1 + (offset % 90))).toISOString().slice(0, 10)
}

function workbook(id: string): { snapshot: Record<string, unknown>; sheets: SheetMeta[] } {
  const sheets: Record<string, unknown> = {}
  const metas: SheetMeta[] = []
  for (let s = 0; s < CONFIG.sheets; s++) {
    const sheetId = `sheet-${s + 1}`
    const name = NAMES[s % NAMES.length]!
    const cellData: Record<number, Record<number, { v: string }>> = { 0: Object.fromEntries(DEFAULT_COLUMNS.map((v, c) => [c, { v }])) }
    for (let r = 1; r <= CONFIG.rows; r++) {
      const line: Record<number, { v: string }> = {
        0: { v: `مهمة ${r} في ${name}: إعداد ومراجعة واعتماد` },
        1: { v: PEOPLE[(r + s) % PEOPLE.length]! },
        2: { v: date(r) },
        3: { v: date(r + 14) },
        4: { v: r % 5 === 0 ? 'منجز' : 'قيد التنفيذ' },
      }
      if (r % 10 === 0) line[6] = { v: 'يحتاج مراجعة قانونية قبل النشر' }
      cellData[r] = line
    }
    sheets[sheetId] = { id: sheetId, name, rowCount: 1000, columnCount: 26, rightToLeft: 1, defaultStyle: { ff: 'Thmanyah Sans' }, cellData }
    metas.push({ id: `meta-${sheetId}`, univerSheetId: sheetId, title: name, position: s + 1, syncMode: 'local', bcTodolistId: null, headerRow: 1 })
  }
  return { snapshot: { id, name: `ملف الحمل ${id}`, appVersion: '1.4.0', styles: {}, sheetOrder: metas.map((m) => m.univerSheetId), sheets }, sheets: metas }
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0
  return { n: sorted.length, min: sorted[0] ?? 0, median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 }
}

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})

describe(`load: the editor opens ${CONFIG.workbooks} workbooks × ${CONFIG.sheets} sheets × ${CONFIG.rows} rows`, () => {
  it('opens each workbook, switches to its last sheet, and stays error-free', async () => {
    const openMs: number[] = []
    const readyMs: number[] = []
    const tabMs: number[] = []
    const heapMB: number[] = []
    const snapshotBytes: number[] = []
    const errors: string[] = []
    for (let w = 0; w < CONFIG.workbooks; w++) {
      const id = `wb-load-${w + 1}`
      const api = new MockApi()
      const data = workbook(id)
      snapshotBytes.push(Buffer.byteLength(JSON.stringify(data.snapshot)))
      api.add(summary({ id, title: `ملف الحمل ${w + 1}`, sheetCount: CONFIG.sheets }), data.snapshot, 1, data.sheets)
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
      await context.route(
        (url) => !url.href.startsWith(BASE_URL),
        (route) => route.abort(),
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => errors.push(`${id}: ${String(e).slice(0, 200)}`))
      await api.install(page)
      const t0 = Date.now()
      await page.goto(`${BASE_URL}/workbooks/${id}`)
      await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 180_000 })
      openMs.push(Date.now() - t0)
      await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 60_000 })
      readyMs.push(Date.now() - t0)
      const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
      heapMB.push(Math.round((heap / 1024 / 1024) * 10) / 10)
      const last = NAMES[(CONFIG.sheets - 1) % NAMES.length]!
      if (CONFIG.sheets > 1) {
        const t1 = Date.now()
        await page.getByText(last, { exact: true }).last().click()
        const host = page.getByTestId('univer-host')
        const target = `sheet-${CONFIG.sheets}`
        for (let i = 0; i < 600 && (await host.getAttribute('data-active-sheet')) !== target; i++) await page.waitForTimeout(50)
        expect(await host.getAttribute('data-active-sheet')).toBe(target)
        tabMs.push(Date.now() - t1)
      }
      await context.close()
    }
    console.log(
      `LOAD_RESULT ${JSON.stringify({ phase: 'editor_open', config: CONFIG, snapshotBytes: stats(snapshotBytes), openMs: stats(openMs), readyMs: stats(readyMs), tabMs: stats(tabMs), heapMB: stats(heapMB), pageErrors: errors.length })}`,
    )
    expect(errors).toEqual([])
  })
})
