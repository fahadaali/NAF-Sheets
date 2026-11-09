// Drives the built spike page in headless Chromium, collects window.__spike and
// takes screenshots for the Phase 0 report. Run after `npm run build` while
// `npm run preview` is serving on :4173.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

// Playwright is resolved via require so a globally installed copy works too.
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.SPIKE_URL ?? 'http://localhost:4173/'
const OUT = new URL('./results/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const cases = [
  { name: 'rtl', query: '?dir=rtl' },
  { name: 'ltr', query: '?dir=ltr' },
  { name: 'rtl-align-right', query: '?dir=rtl&align=1' },
  { name: 'rtl-align-right-isolate', query: '?dir=rtl&align=1&isolate=1' },
  { name: 'rtl-bidi-marks', query: '?dir=rtl&align=1&marks=1' },
]

const browser = await chromium.launch()
const summary = {}
for (const c of cases) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  // Every host the page talks to other than the local preview server.
  const externalHosts = new Set()
  page.on('request', (r) => {
    const host = new URL(r.url()).host
    if (!host.startsWith('localhost')) externalHosts.add(host)
  })
  await page.goto(BASE + c.query)
  await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 60000 })
  await page.waitForTimeout(1500)
  const result = await page.evaluate(() => window.__spike)
  await page.screenshot({ path: `${OUT}${c.name}.png` })
  // Close-up of the grid so glyph joining and bidi order can be inspected.
  await page.screenshot({ path: `${OUT}${c.name}-zoom.png`, clip: { x: 0, y: 90, width: 1280, height: 220 } })
  // Second sheet: the cross-sheet formula results as rendered.
  await page.evaluate(() => window.univerAPI.getActiveWorkbook().getSheetBySheetId('summary').activate())
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}${c.name}-summary.png`, clip: { x: 0, y: 90, width: 1280, height: 220 } })
  summary[c.name] = { ...result, consoleErrors, externalHosts: [...externalHosts] }
  await page.close()
}
await browser.close()
writeFileSync(`${OUT}results.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
