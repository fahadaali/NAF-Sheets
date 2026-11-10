// Frame cost of the sheet scene with and without the RTL mirror (../src/rtl-grid.ts).
// Copied from the phase 0 spike (spike/univer/rtl-perf.mjs); only the paths,
// the port and the results directory differ.
// A 500 x 8 sheet of mixed Arabic/Latin/number cells is scrolled in steps;
// every scene.render call is timed by the same wrapper in both modes.
// Run while `npm run harness:preview` is serving on :4175. Writes results/rtl-perf.json.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

const { chromium } = createRequire(import.meta.url)('playwright')
const BASE = process.env.SPIKE_URL ?? 'http://localhost:4175/'
const OUT = new URL('../results/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

async function measure(query) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(BASE + query)
  await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 90000 })
  const result = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    const wb = window.univerAPI.getActiveWorkbook()
    const ws = wb.insertSheet('perf')
    const words = ['متابعة القضية', 'إعداد خطة', 'LinkedIn', 'مراجعة البيان الصحفي', 'v2 معتمدة', 'تقرير Basecamp']
    const rows = Array.from({ length: 500 }, (_, r) => Array.from({ length: 8 }, (_, c) => (c % 3 === 2 ? r * 10 + c : `${words[(r + c) % words.length]} ${r + 1}`)))
    ws.getRange(0, 0, 500, 8).setValues(rows)
    ws.activate()
    for (let i = 0; i < 20; i++) await frame()
    const scene = window.__sheetScene
    const original = scene.render
    const times = []
    scene.render = function (...a) {
      const t = performance.now()
      try { return original.apply(this, a) } finally { times.push(performance.now() - t) }
    }
    for (let step = 0; step < 60; step++) {
      ws.scrollToCell((step * 7) % 480, 0)
      await frame(); await frame()
    }
    scene.render = original
    const busy = times.filter((t) => t > 0.05).sort((a, b) => a - b)
    const mean = busy.reduce((s, t) => s + t, 0) / busy.length
    return { frames: busy.length, meanMs: +mean.toFixed(2), p50Ms: +busy[Math.floor(busy.length * 0.5)].toFixed(2), p95Ms: +busy[Math.floor(busy.length * 0.95)].toFixed(2), maxMs: +busy[busy.length - 1].toFixed(2) }
  })
  await browser.close()
  return result
}

const runs = 3
const out = { plain: [], mirrored: [] }
for (let i = 0; i < runs; i++) {
  out.plain.push(await measure('?dir=rtl&selftest=0'))
  out.mirrored.push(await measure('?dir=rtl&grid=mirror&selftest=0'))
}
const avg = (xs, k) => +(xs.reduce((s, x) => s + x[k], 0) / xs.length).toFixed(2)
const summary = {
  runs,
  plain: { meanMs: avg(out.plain, 'meanMs'), p95Ms: avg(out.plain, 'p95Ms') },
  mirrored: { meanMs: avg(out.mirrored, 'meanMs'), p95Ms: avg(out.mirrored, 'p95Ms') },
  detail: out,
}
summary.overheadMeanPct = +(((summary.mirrored.meanMs - summary.plain.meanMs) / summary.plain.meanMs) * 100).toFixed(1)
writeFileSync(OUT + 'rtl-perf.json', JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ plain: summary.plain, mirrored: summary.mirrored, overheadMeanPct: summary.overheadMeanPct }))
