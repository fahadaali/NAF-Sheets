// Frame cost of the sheet scene with and without the RTL mirror (../src/rtl-grid.ts).
// Copied from the phase 0 spike (spike/univer/rtl-perf.mjs); only the paths,
// the port and the results directory differ.
// A 500 x 8 sheet of mixed Arabic/Latin/number cells is scrolled in steps;
// every scene.render call is timed by the same wrapper in both modes.
// The cell editor (document text, src/rtl-text.ts) is measured too: the time
// from the double click to the editor's first paint, and for every keystroke
// of Arabic typing the time from the key (keydown or beforeinput) to the
// editor's next paint, with the
// layout and paint work it took.
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

// Cell editor latency. Timers wrap Univer's document layout and paint (outside
// the layer, so its own work is included) and listen for keydown.
async function measureEditor(query) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(BASE + query)
  await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 90000 })
  await page.evaluate(async () => {
    window.univerAPI.getActiveWorkbook().getSheetBySheetId('bidi').activate()
    await new Promise((r) => setTimeout(r, 600))
    const rm = window.__renderManager
    const editor = () => rm.getRenderUnitById('__INTERNAL_EDITOR__DOCS_NORMAL')?.mainComponent
    const Docs = Object.getPrototypeOf(editor())
    const Skeleton = Object.getPrototypeOf(editor().getSkeleton())
    const log = { input: 0, firstPaint: [], keys: [], work: 0 }
    window.__editorPerf = log
    const draw = Docs.draw
    Docs.draw = function (...a) {
      const t = performance.now()
      try { return draw.apply(this, a) } finally {
        if (this === editor()) {
          const end = performance.now()
          log.work += end - t
          if (log.input) { log.keys.push({ latency: end - log.input, work: log.work }); log.input = 0; log.work = 0 }
          if (log.openAt) { log.firstPaint.push(end - log.openAt); log.openAt = 0 }
        }
      }
    }
    const calc = Skeleton.calculate
    Skeleton.calculate = function (...a) {
      const t = performance.now()
      try { return calc.apply(this, a) } finally { if (this === editor()?.getSkeleton()) log.work += performance.now() - t }
    }
    // Typed Arabic arrives as text input with no keydown (an IME or Playwright's insertText): time from whichever comes first.
    const startInput = () => { if (!log.input) { log.input = performance.now(); log.work = 0 } }
    document.addEventListener('keydown', startInput, true)
    document.addEventListener('beforeinput', startInput, true)
    document.addEventListener('mousedown', (e) => { if (e.detail === 2) log.openAt = performance.now() }, true)
  })
  const opens = []
  for (const row of [1, 2, 3, 5, 8]) {
    const box = await page.evaluate(({ row, mirrored }) => {
      const r = window.univerAPI.getActiveWorkbook().getActiveSheet().getRange(`A${row}`).getCellRect()
      const c = document.querySelector('canvas[id^=univer-sheet-main-canvas]').getBoundingClientRect()
      return { x: (mirrored ? c.left + c.width - (r.left + r.width) : c.left + r.left) + r.width / 2, y: c.top + r.top + r.height / 2 }
    }, { row, mirrored: query.includes('mirror') })
    await page.mouse.dblclick(box.x, box.y)
    await page.waitForTimeout(400)
    opens.push(...(await page.evaluate(() => window.__editorPerf.firstPaint.splice(0))))
    if (row === 8) {
      // Arabic typing at the end of an Arabic line, one key at a time.
      await page.keyboard.press('End')
      await page.waitForTimeout(200)
      await page.evaluate(() => { window.__editorPerf.keys.length = 0 })
      for (const ch of 'وفق الخطة المعتمدة للربع الأول من العام') {
        await page.keyboard.type(ch)
        await page.waitForTimeout(60)
      }
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  const keys = await page.evaluate(() => window.__editorPerf.keys)
  await browser.close()
  const stats = (xs) => {
    const v = [...xs].sort((a, b) => a - b)
    return { n: v.length, meanMs: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2), p95Ms: +v[Math.min(v.length - 1, Math.floor(v.length * 0.95))].toFixed(2) }
  }
  return { open: stats(opens), keystrokeLatency: stats(keys.map((k) => k.latency)), keystrokeWork: stats(keys.map((k) => k.work)) }
}

const runs = 3
const out = { plain: [], mirrored: [], editorPlain: [], editorMirrored: [] }
for (let i = 0; i < runs; i++) {
  out.plain.push(await measure('?dir=rtl&selftest=0'))
  out.mirrored.push(await measure('?dir=rtl&grid=mirror&selftest=0'))
  out.editorPlain.push(await measureEditor('?dir=rtl&selftest=0'))
  out.editorMirrored.push(await measureEditor('?dir=rtl&grid=mirror&selftest=0'))
}
const avg = (xs, k) => +(xs.reduce((s, x) => s + x[k], 0) / xs.length).toFixed(2)
const summary = {
  runs,
  plain: { meanMs: avg(out.plain, 'meanMs'), p95Ms: avg(out.plain, 'p95Ms') },
  mirrored: { meanMs: avg(out.mirrored, 'meanMs'), p95Ms: avg(out.mirrored, 'p95Ms') },
  detail: out,
}
summary.overheadMeanPct = +(((summary.mirrored.meanMs - summary.plain.meanMs) / summary.plain.meanMs) * 100).toFixed(1)
const editorAvg = (xs) => Object.fromEntries(['open', 'keystrokeLatency', 'keystrokeWork'].map((k) => [k, { meanMs: +(xs.reduce((s, x) => s + x[k].meanMs, 0) / xs.length).toFixed(2), p95Ms: +(xs.reduce((s, x) => s + x[k].p95Ms, 0) / xs.length).toFixed(2) }]))
summary.editor = { stock: editorAvg(out.editorPlain), layered: editorAvg(out.editorMirrored) }
writeFileSync(OUT + 'rtl-perf.json', JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ plain: summary.plain, mirrored: summary.mirrored, overheadMeanPct: summary.overheadMeanPct, editor: summary.editor }))
