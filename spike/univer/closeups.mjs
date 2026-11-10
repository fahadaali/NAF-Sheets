// 2x close-ups of the grid cells cited in docs/phase-0-report.md (§2.3, §9).
// Crops are computed from the cells themselves (Univer's own geometry at the
// default scroll and zoom), so they stay right when row heights change.
// Run while `npm run preview` is serving on :4173.
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const BASE = process.env.SPIKE_URL ?? 'http://localhost:4173/'
const OUT = new URL('./results/', import.meta.url).pathname

// `from`..`to` are A1 cells spanning the crop; `mirrored` grids put column A on the right.
const shots = [
  { file: 'univer-cells-2x.png', query: '?dir=rtl&align=1&selftest=0', from: 'A1', to: 'G6' },
  { file: 'isolate-0-2x.png', query: '?dir=rtl&align=1&isolate=0&selftest=0', from: 'A1', to: 'G6' },
  { file: 'isolate-1-2x.png', query: '?dir=rtl&align=1&isolate=1&selftest=0', from: 'A1', to: 'G6' },
  { file: 'bidi-marks-probe-2x.png', query: '?dir=rtl&align=1&marks=1&selftest=0', from: 'A11', to: 'G16' },
  { file: 'mirror-cells-2x.png', query: '?dir=rtl&grid=mirror&selftest=0', from: 'A1', to: 'G6', mirrored: true, headers: true },
  { file: 'mirror-wrapped-2x.png', query: '?dir=rtl&grid=mirror&selftest=0', from: 'A8', to: 'A8', mirrored: true },
  { file: 'plain-wrapped-2x.png', query: '?dir=rtl&align=1&selftest=0', from: 'A8', to: 'A8' },
]

const browser = await chromium.launch()
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })
  await page.goto(BASE + s.query)
  await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 90000 })
  await page.waitForTimeout(1200)
  const clip = await page.evaluate(({ from, to, mirrored, headers }) => {
    const ws = window.univerAPI.getActiveWorkbook().getActiveSheet()
    const a = ws.getRange(from).getCellRect()
    const b = ws.getRange(to).getCellRect()
    const c = document.querySelector('canvas[id^=univer-sheet-main-canvas]').getBoundingClientRect()
    const left = Math.min(a.left, b.left)
    const right = Math.max(a.right, b.right) + (mirrored ? 46 : 0) // include the row header beside column A
    const top = headers ? 0 : Math.min(a.top, b.top)
    const bottom = Math.max(a.bottom, b.bottom)
    const x = mirrored ? c.left + c.width - right : c.left + (headers ? 0 : left - 46) + (headers ? 0 : 0)
    return { x: Math.max(0, x), y: c.top + top, width: right - (mirrored ? left : left - 46), height: bottom - top }
  }, s)
  await page.screenshot({ path: OUT + s.file, clip })
  await page.close()
}
await browser.close()
console.log(shots.map((s) => s.file).join('\n'))
