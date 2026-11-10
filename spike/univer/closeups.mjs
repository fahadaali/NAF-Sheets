// 2x close-ups of the grid cells cited in docs/phase-0-report.md §2.3.
// Run while `npm run preview` is serving on :4173.
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const BASE = process.env.SPIKE_URL ?? 'http://localhost:4173/'
const OUT = new URL('./results/', import.meta.url).pathname
const CELLS = { x: 0, y: 125, width: 1040, height: 145 } // header row + the five task rows
const PROBE_ROWS = { x: 0, y: 408, width: 1040, height: 150 } // rows 11-16 written by ?marks=1 (row 8 is 72px tall)

const shots = [
  { file: 'univer-cells-2x.png', query: '?dir=rtl&align=1', clip: CELLS },
  { file: 'isolate-0-2x.png', query: '?dir=rtl&align=1&isolate=0', clip: CELLS },
  { file: 'isolate-1-2x.png', query: '?dir=rtl&align=1&isolate=1', clip: CELLS },
  { file: 'bidi-marks-probe-2x.png', query: '?dir=rtl&align=1&marks=1', clip: PROBE_ROWS },
  // Mirrored grid (src/rtl-grid.ts): column A sits on the right, so crop the right side.
  { file: 'mirror-cells-2x.png', query: '?dir=rtl&grid=mirror', clip: { x: 240, y: 104, width: 1040, height: 166 } },
  { file: 'mirror-wrapped-2x.png', query: '?dir=rtl&grid=mirror', clip: { x: 940, y: 260, width: 340, height: 90 } },
  { file: 'plain-wrapped-2x.png', query: '?dir=rtl&align=1', clip: { x: 0, y: 260, width: 340, height: 90 } },
]

const browser = await chromium.launch()
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })
  await page.goto(BASE + s.query)
  await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 60000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: OUT + s.file, clip: s.clip })
  await page.close()
}
await browser.close()
console.log(shots.map((s) => s.file).join('\n'))
