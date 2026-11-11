// Interaction checks for the mirrored (RTL) grid — ../src/rtl-grid.ts.
// Copied from the phase 0 spike (spike/univer/rtl-interactions.mjs); only the
// paths, the port and the results directory differ.
//
// Each check drives the page the way a user would (real mouse, keyboard and
// touch at the cell's on-screen position) and asserts against Univer's own
// state, or against the pixels actually on screen. Where a mirrored result must
// look exactly like the unmirrored grid (rotated text, images), the two are
// compared pixel by pixel. Document text (cell editor, formula bar, rich-text
// cells) is compared with the browser's own bidi layout of the same string in
// a dir="rtl" element: the order of what the canvas really painted (every
// fillText call, recorded beneath the layer) must equal the order of the same
// units in the browser's layout.
//
// Run while `npm run harness:preview` is serving on :4175.
//   BROWSER=chromium|firefox|webkit   (default chromium; CI runs all three)
//   USER_AGENT=...                    (optional) for every page. With a Mac user
//                                     agent, Univer uses its Mac key map (as it
//                                     does in Playwright's WebKit): a way to run
//                                     that key map in Chromium locally.
// Writes results/rtl-interactions[-browser].json and results/mirror-*.png.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { applyKnownUpstream } from './known-upstream.mjs'

const playwright = createRequire(import.meta.url)('playwright')
const BROWSER = process.env.BROWSER ?? 'chromium'
const BASE = process.env.SPIKE_URL ?? 'http://localhost:4175/'
const OUT = new URL('../results/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const TAG = BROWSER === 'chromium' ? '' : `-${BROWSER}`

const browser = await playwright[BROWSER].launch()
const pageErrors = []
// Installed before the page's own scripts, so it wraps the browser's own
// fillText (beneath the layer): it records what really reaches a canvas, in
// device pixels of that canvas. Inert unless a test turns recording on.
const FILLTEXT_RECORDER = () => {
  const native = CanvasRenderingContext2D.prototype.fillText
  window.__fillTextLog = null
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    const log = window.__fillTextLog
    if (log && (log.canvas === null || log.canvas === this.canvas)) {
      const w = this.measureText(String(text)).width
      const dir = this.direction === 'inherit' ? getComputedStyle(this.canvas).direction : this.direction
      const a = this.textAlign
      const right = a === 'right' || (a === 'end' && dir !== 'rtl') || (a === 'start' && dir === 'rtl')
      const left = a === 'center' ? x - w / 2 : right ? x - w : x
      const t = this.getTransform()
      const xs = [t.a * left + t.c * y + t.e, t.a * (left + w) + t.c * y + t.e]
      log.items.push({ text: String(text), canvas: this.canvas, x0: Math.min(...xs), x1: Math.max(...xs), y: t.b * left + t.d * y + t.f, fill: String(this.fillStyle).toLowerCase() })
    }
    return native.call(this, text, x, y, maxWidth)
  }
}
const openPage = async (query, contextOptions = {}, { record = false } = {}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...(process.env.USER_AGENT ? { userAgent: process.env.USER_AGENT } : {}), ...contextOptions })
  if (record) await context.addInitScript(FILLTEXT_RECORDER)
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${query}: ${String(e).slice(0, 300)}`))
  await page.goto(BASE + query)
  await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 90000 })
  await page.waitForTimeout(1000)
  return page
}
const page = await openPage('?dir=rtl&grid=mirror&selftest=0')
// Univer's key map for this browser (harness/main.ts, from Univer's own
// IPlatformService): with Mac bindings, line start/end are Cmd+Left/Right and
// Home/End are not bound at all. Line moves are pressed the way this platform's
// users press them; the control check below records both.
const KEYS = await page.evaluate(() => window.__univerKeys())
const LINE_START = KEYS.mac ? 'Meta+ArrowLeft' : 'Home' // stock Univer: logical
const LINE_END = KEYS.mac ? 'Meta+ArrowRight' : 'End'
// With the layer, Cmd+Left/Right are visual (owner decision 2026-11-10): in a
// right-to-left line the logical start is the visual right end.
const RTL_START = KEYS.mac ? 'Meta+ArrowRight' : 'Home'
const RTL_END = KEYS.mac ? 'Meta+ArrowLeft' : 'End'
// Pixel analysis runs in a blank page, away from the patched canvas prototype.
const lab = await (await browser.newContext()).newPage()

// --- helpers ---------------------------------------------------------------

// On-screen rectangle of a cell: Univer reports canvas coordinates of the
// unmirrored grid; `mirrored` flips them across the canvas's vertical axis.
const cellBox = (p, a1, mirrored = true) => p.evaluate(({ a1, mirrored }) => {
  const ws = window.univerAPI.getActiveWorkbook().getActiveSheet()
  const r = ws.getRange(a1).getCellRect()
  const c = document.querySelector('canvas[id^=univer-sheet-main-canvas]').getBoundingClientRect()
  const left = mirrored ? c.left + c.width - (r.left + r.width) : c.left + r.left
  return { left, right: left + r.width, top: c.top + r.top, bottom: c.top + r.top + r.height, width: r.width, height: r.height }
}, { a1, mirrored })
const centre = (b) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 })
const canvasBox = (p) => p.evaluate(() => {
  const c = document.querySelector('canvas[id^=univer-sheet-main-canvas]').getBoundingClientRect()
  return { left: c.left, right: c.right, top: c.top, bottom: c.bottom }
})
const active = (p = page) => p.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveRange()?.getA1Notation())
const activeRange = (p = page) => p.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveRange()?.getRange())
const sheet = (p, id) => p.evaluate(async (id) => { window.univerAPI.getActiveWorkbook().getSheetBySheetId(id).activate(); await new Promise((r) => setTimeout(r, 600)) }, id)
const value = (a1, p = page) => p.evaluate((a1) => window.univerAPI.getActiveWorkbook().getActiveSheet().getRange(a1).getValue(), a1)
const formula = (a1, p = page) => p.evaluate((a1) => window.univerAPI.getActiveWorkbook().getActiveSheet().getRange(a1).getFormula(), a1)
const styleHt = (a1, p = page) => p.evaluate((a1) => window.univerAPI.getActiveWorkbook().getActiveSheet().getRange(a1).getCellStyleData()?.ht ?? null, a1)
const colWidth = (i, p = page) => p.evaluate((i) => window.univerAPI.getActiveWorkbook().getActiveSheet().getColumnWidth(i), i)
const near = (a, b, tol) => Math.abs(a - b) <= tol
const clickAway = async (p = page) => { await p.keyboard.press('Escape'); await p.mouse.click(5, 700); await p.waitForTimeout(250) }

// Smallest visible DOM element whose text contains every given string.
const domBoxWithText = (texts, p = page) => p.evaluate((texts) => {
  let best = null
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('canvas')) continue
    const t = el.textContent ?? ''
    if (!texts.every((s) => t.includes(s))) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (!best || r.width * r.height < best.width * best.height) best = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  return best
}, texts)

// Pixels on screen inside `clip` that match `kind`, as a bounding box in page coordinates.
const KINDS = {
  dark: 'r < 110 && g < 110 && b < 110',
  blue: 'b > 150 && r < 90 && g < 130',
  yellow: 'r > 230 && g > 200 && b < 170',
  orange: 'r > 225 && g > 160 && g < 215 && b < 165 && r - b > 90',
  // Excel's first two reference colours (#326ac7, #c0353e): formula outlines.
  refBlue: 'Math.abs(r - 50) < 14 && Math.abs(g - 106) < 14 && Math.abs(b - 199) < 14',
  refRed: 'Math.abs(r - 192) < 14 && Math.abs(g - 53) < 14 && Math.abs(b - 62) < 14',
}
const inkBox = async (p, clip, kind = 'dark') => {
  const png = (await p.screenshot({ clip })).toString('base64')
  return lab.evaluate(async ({ png, clip, test }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    const match = new Function('r', 'g', 'b', `return ${test}`)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0, sumX = 0
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (!match(data[i], data[i + 1], data[i + 2])) continue
      count++; sumX += x
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    const sx = c.width / clip.width
    return count ? { left: clip.x + minX / sx, right: clip.x + maxX / sx, top: clip.y + minY / sx, bottom: clip.y + maxY / sx, meanX: clip.x + sumX / count / sx, count } : null
  }, { png, clip, test: KINDS[kind] })
}
// Mean absolute per-channel difference (0..255) between two same-size screen regions.
const regionDiff = async (pa, clipA, pb, clipB) => {
  const a = (await pa.screenshot({ clip: clipA })).toString('base64')
  const b = (await pb.screenshot({ clip: clipB })).toString('base64')
  return lab.evaluate(async ({ a, b }) => {
    const load = async (s) => { const i = new Image(); i.src = `data:image/png;base64,${s}`; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, c.width, c.height).data }
    const [da, db] = [await load(a), await load(b)]
    let sum = 0
    for (let i = 0; i < Math.min(da.length, db.length); i += 4) sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
    return sum / (Math.min(da.length, db.length) / 4) / 3
  }, { a, b })
}
const clipOf = (b, pad = 0) => ({ x: Math.round(b.left) + pad, y: Math.round(b.top) + pad, width: Math.round(b.width) - 2 * pad, height: Math.round(b.height) - 2 * pad })

// Toolbar horizontal-alignment selector.
const ALIGN = { left: 'يسار', center: 'وسط', right: 'يمين' }
const alignTrigger = (p = page) => p.locator('[data-u-command="sheet.command.set-horizontal-text-align"]:visible').first()
const openAlignMenu = async (p = page) => { await alignTrigger(p).click(); await p.waitForTimeout(300) }
// Label of the option whose icon the toolbar button currently shows.
const shownAlign = async (p = page) => {
  const triggerSvg = await alignTrigger(p).locator('svg').first().innerHTML()
  await openAlignMenu(p)
  const options = await p.evaluate((labels) => {
    const out = {}
    for (const el of document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], li, button')) {
      const label = Object.values(labels).find((l) => (el.textContent ?? '').trim() === l)
      const svg = el.querySelector('svg')
      if (label && svg && el.getBoundingClientRect().width > 0) out[label] = svg.innerHTML
    }
    return out
  }, ALIGN)
  await p.keyboard.press('Escape')
  await p.waitForTimeout(200)
  return Object.entries(options).find(([, svg]) => svg === triggerSvg)?.[0] ?? null
}
const chooseAlign = async (label, p = page) => {
  await openAlignMenu(p)
  await p.getByText(label, { exact: true }).last().click()
  await p.waitForTimeout(300)
}

// --- document text helpers (cell editor, formula bar) --------------------------

const EDITOR_ID = '__INTERNAL_EDITOR__DOCS_NORMAL'
const FORMULA_BAR_ID = '__INTERNAL_EDITOR__DOCS_FORMULA_BAR'
const ARABIC_RUN = '[\\u0600-\\u06FF\\u0750-\\u077F\\u0870-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]+'
// What one document unit's canvas really painted, as units in visual order (left to right, one line).
const paintedUnits = (p, unitId) => p.evaluate(async (unitId) => {
  const unit = window.__renderManager.getRenderUnitById(unitId)
  const canvas = unit.engine.getCanvasElement()
  window.__fillTextLog = { canvas, items: [] }
  unit.mainComponent.makeDirty(true)
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r))
  const items = window.__fillTextLog.items.filter((it) => it.text.trim() && !/^[\u0000-\u001f]+$/.test(it.text))
  window.__fillTextLog = null
  const r = canvas.getBoundingClientRect()
  const s = r.width / canvas.width
  const seen = new Map() // a frame may paint a line twice: keep one of each
  for (const it of items) seen.set(`${it.text}|${Math.round(it.x0)}|${Math.round(it.y)}`, { text: it.text, x0: r.left + it.x0 * s, x1: r.left + it.x1 * s })
  return [...seen.values()].sort((a, b) => a.x0 - b.x0)
}, unitId)
// The browser's own layout of `text` in a dir= element, cut into the same units: whole Arabic runs, single other characters, no spaces.
// By default the paragraph direction is the browser's own first-strong rule (dir="auto"), as in the layer; text without a strong character follows the RTL surface.
const browserUnits = (p, text, dir) => p.evaluate(({ text, dir, run }) => {
  const el = document.createElement('div')
  el.dir = dir ?? (/\p{L}/u.test(text) ? 'auto' : 'rtl')
  el.style.cssText = 'position:fixed;top:0;left:0;white-space:pre;font:11pt "Thmanyah Sans";visibility:hidden'
  el.textContent = text
  document.body.append(el)
  const re = new RegExp(run, 'y')
  const units = []
  for (let i = 0; i < text.length;) {
    re.lastIndex = i
    const m = re.exec(text)
    const len = m ? m[0].length : text.codePointAt(i) > 0xffff ? 2 : 1
    if (text.slice(i, i + len).trim()) {
      const range = document.createRange()
      range.setStart(el.firstChild, i)
      range.setEnd(el.firstChild, i + len)
      const b = range.getBoundingClientRect()
      units.push({ text: text.slice(i, i + len), x0: b.left, x1: b.right, start: i })
    }
    i += len
  }
  el.remove()
  return units.sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1))
}, { text, dir, run: ARABIC_RUN })
// The same, for a formula in formula mode (rtl-text.ts step 7): `marked` is the
// formula with the isolates written out BY HAND as FSI (U+2068) ... PDI (U+2069)
// around each Arabic token, independently of the module; the browser lays it
// out left to right. Units and their `start` refer to the formula without the marks.
const browserFormulaUnits = (p, marked) => p.evaluate(({ marked, run }) => {
  const el = document.createElement('div')
  el.dir = 'ltr'
  el.style.cssText = 'position:fixed;top:0;left:0;white-space:pre;font:11pt "Thmanyah Sans";visibility:hidden'
  el.textContent = marked
  document.body.append(el)
  const re = new RegExp(run, 'y')
  const units = []
  let plain = 0
  for (let i = 0; i < marked.length;) {
    if (marked[i] === '\u2068' || marked[i] === '\u2069') { i++; continue }
    re.lastIndex = i
    const m = re.exec(marked)
    const len = m ? m[0].length : 1
    if (marked.slice(i, i + len).trim()) {
      const range = document.createRange()
      range.setStart(el.firstChild, i)
      range.setEnd(el.firstChild, i + len)
      const b = range.getBoundingClientRect()
      units.push({ text: marked.slice(i, i + len), x0: b.left, x1: b.right, start: plain })
    }
    i += len
    plain += len
  }
  el.remove()
  return units.sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1))
}, { marked, run: ARABIC_RUN })
const unmark = (marked) => marked.replace(/[\u2068\u2069]/g, '')
const sameUnits = (a, b) => JSON.stringify(a.map((u) => u.text)) === JSON.stringify(b.map((u) => u.text))
const docText = (p, unitId = EDITOR_ID) => p.evaluate((id) => window.__renderManager.getRenderUnitById(id).mainComponent.getSkeleton().getViewModel().getDataModel().getBody().dataStream.replace(/\r\n$/, ''), unitId)
// The collapsed caret Univer draws in a document's scene (client x), or null.
const caretX = (p, unitId = EDITOR_ID) => p.evaluate((id) => {
  const unit = window.__renderManager.getRenderUnitById(id)
  const anchor = unit.scene.getAllObjects().find((o) => String(o.oKey).startsWith('__TestSelectionAnchor__') && o.visible !== false)
  if (!anchor) return null
  return unit.engine.getCanvasElement().getBoundingClientRect().left + anchor.left + (anchor.width ?? 0) / 2
}, unitId)
// The selection highlight rectangles drawn in a document's scene (client x ranges).
const selectionRects = (p, unitId = EDITOR_ID) => p.evaluate((id) => {
  const unit = window.__renderManager.getRenderUnitById(id)
  const left = unit.engine.getCanvasElement().getBoundingClientRect().left
  const out = []
  for (const o of unit.scene.getAllObjects()) {
    if (!String(o.oKey).startsWith('__TestSelectionRange__') || o.visible === false) continue
    for (const pts of o.pointsGroup ?? []) out.push({ x0: left + o.left + Math.min(...pts.map((q) => q.x)), x1: left + o.left + Math.max(...pts.map((q) => q.x)) })
  }
  return out.sort((a, b) => a.x0 - b.x0)
}, unitId)
// Where the hidden input that receives keyboard and IME text sits (client coordinates).
const imeBox = (p, unitId = EDITOR_ID) => p.evaluate((id) => {
  const el = document.getElementById(`__editor_${id}`)
  let n = el
  while (n && getComputedStyle(n).position !== 'fixed') n = n.parentElement
  const r = (n ?? el)?.getBoundingClientRect()
  return r ? { left: r.left, top: r.top, focused: document.activeElement === el } : null
}, unitId)
const editorTop = (p) => p.evaluate((id) => window.__renderManager.getRenderUnitById(id).engine.getCanvasElement().getBoundingClientRect().top, EDITOR_ID)
// Type a marker and read where it landed: the caret's logical offset.
const markerOffset = async (p) => {
  await p.keyboard.type('X')
  await p.waitForTimeout(60)
  return (await docText(p)).indexOf('X')
}
const openEditor = async (p, a1) => {
  const { x, y } = centre(await cellBox(p, a1))
  await p.mouse.dblclick(x, y)
  await p.waitForTimeout(350)
}
const cancelEdit = async (p) => {
  await p.keyboard.press('Escape')
  await p.waitForTimeout(200)
}

const checks = []
const check = async (name, fn) => {
  try {
    const detail = await fn()
    checks.push({ name, ok: Boolean(detail.ok), detail })
  } catch (e) {
    checks.push({ name, ok: false, detail: { error: String(e).slice(0, 400) } })
  }
}

// --- layer status ------------------------------------------------------------

await check('layer reports mirrored, verified version, no contract problems', async () => {
  const s = await page.evaluate(() => window.__rtlStatus)
  return { ok: s?.mirrored === true && s.verifiedVersion === true && s.problems.length === 0, status: s }
})

// --- hit testing against the unmirrored grid ---------------------------------
// Oracle independent of any coordinate maths: with identical scroll and zoom,
// a click at x in the unmirrored grid and at the mirror of x in the mirrored
// grid must select the same cell. Runs before any check that mutates the sheet.

// The unmirrored reference grid carries the document-text layer too, so text
// drawn as documents (rotated cells) is compared like for like: only the
// mirror differs between the two pages.
const plain = await openPage('?dir=rtl&selftest=0&textLayer=1')
// Cell area only, below the data header row (its filter buttons open panels
// whose own buttons can sort the data), at any zoom. Consecutive points always
// differ in row, so no two clicks form a double-click.
const samplePoints = async (p) => {
  const c = await canvasBox(p)
  const zoom = await p.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveSheet().getZoom())
  const top = c.top + (20 + 31) * zoom + 12 // column header + data header row
  const pts = []
  for (let x = c.left + 70; x < c.right - 70; x += 95) for (let i = 0; i < 5; i++) pts.push({ x, y: top + i * ((c.bottom - 30 - top) / 4) })
  return pts
}
const hitsMatch = async (label) => {
  const [cm, cp] = [await canvasBox(page), await canvasBox(plain)]
  const mismatches = []
  let n = 0
  for (const { x, y } of await samplePoints(plain)) {
    await plain.mouse.click(x, y)
    await page.mouse.click(cm.left + cm.right - (x - cp.left) - cp.left, y)
    await page.waitForTimeout(80)
    await plain.waitForTimeout(80)
    await plain.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const [a, b] = [await active(plain), await active(page)]
    n++
    if (a !== b) mismatches.push({ x, y, plain: a, mirrored: b })
  }
  const rowsEqual = await page.evaluate(() => { const ws = window.univerAPI.getActiveWorkbook().getActiveSheet(); return Array.from({ length: 20 }, (_, i) => ws.getRange(i, 0).getValue()).join('|') }) ===
    await plain.evaluate(() => { const ws = window.univerAPI.getActiveWorkbook().getActiveSheet(); return Array.from({ length: 20 }, (_, i) => ws.getRange(i, 0).getValue()).join('|') })
  return { ok: mismatches.length === 0 && n > 20 && rowsEqual, label, points: n, rowsEqual, mismatches: mismatches.slice(0, 5) }
}
const sameState = async (fn) => { await page.evaluate(fn); await plain.evaluate(fn); await page.waitForTimeout(500); await plain.waitForTimeout(500) }

await check('hit testing equals the unmirrored grid at the mirrored point (default view)', () => hitsMatch('default'))

await check('hit testing equals the unmirrored grid after scrolling right of the frozen column', async () => {
  await sameState(() => window.univerAPI.getActiveWorkbook().getActiveSheet().scrollToCell(0, 9))
  const states = [await page.evaluate(() => JSON.stringify(window.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState())), await plain.evaluate(() => JSON.stringify(window.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState()))]
  const r = await hitsMatch('scrolled')
  await page.screenshot({ path: `${OUT}mirror-scrolled${TAG}.png` })
  await sameState(() => window.univerAPI.getActiveWorkbook().getActiveSheet().scrollToCell(0, 0))
  return { ...r, ok: r.ok && states[0] === states[1] && JSON.parse(states[0]).offsetX + JSON.parse(states[0]).sheetViewStartColumn > 0, states }
})

await check('hit testing equals the unmirrored grid at 150% zoom', async () => {
  await sameState(() => window.univerAPI.getActiveWorkbook().getActiveSheet().zoom(1.5))
  const r = await hitsMatch('zoom 1.5')
  await page.screenshot({ path: `${OUT}mirror-zoom${TAG}.png` })
  await sameState(() => window.univerAPI.getActiveWorkbook().getActiveSheet().zoom(1))
  return r
})

await check('horizontal swipe scrolls the way it looks', async () => {
  const c = await canvasBox(page)
  await page.mouse.move((c.left + c.right) / 2, c.top + 300)
  const sx = () => page.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveSheet().getScrollState().offsetX)
  const start = await sx()
  await page.mouse.wheel(-400, 0) // physical swipe revealing what lies to the left
  await page.waitForTimeout(400)
  const afterLeftSwipe = await sx()
  await page.mouse.wheel(400, 0)
  await page.waitForTimeout(400)
  const afterRightSwipe = await sx()
  return { ok: afterLeftSwipe > start && afterRightSwipe < afterLeftSwipe, start, afterLeftSwipe, afterRightSwipe }
})

// --- selection and keyboard --------------------------------------------------

await check('click selects the cell under the pointer', async () => {
  const got = []
  for (const a1 of ['B3', 'G4', 'A6']) {
    const { x, y } = centre(await cellBox(page, a1))
    await page.mouse.click(x, y)
    await page.waitForTimeout(150)
    got.push(await active())
  }
  return { ok: got.join() === 'B3,G4,A6', got }
})

await check('ArrowLeft moves to the next column (visually left), ArrowRight back, repeatedly', async () => {
  const { x, y } = centre(await cellBox(page, 'B3'))
  await page.mouse.click(x, y)
  const seen = []
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) {
    await page.keyboard.press(k)
    await page.waitForTimeout(100)
    seen.push(await active())
  }
  return { ok: seen.join() === 'C3,B3,A3,B3,C3', seen }
})

await check('Shift+ArrowLeft extends the selection leftwards on screen', async () => {
  const { x, y } = centre(await cellBox(page, 'B3'))
  await page.mouse.click(x, y)
  await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForTimeout(100)
  const got = await active()
  return { ok: got === 'B3:C3', got }
})

await check('Tab moves to the next column', async () => {
  const { x, y } = centre(await cellBox(page, 'A3'))
  await page.mouse.click(x, y)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(100)
  const got = await active()
  return { ok: got === 'B3', got }
})

await check('drag selects the range between the two cells', async () => {
  const from = centre(await cellBox(page, 'B3'))
  const to = centre(await cellBox(page, 'C5'))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const got = await active()
  return { ok: got === 'B3:C5', got }
})

await check('column header click selects the whole column; row header (on the right) selects the row', async () => {
  const c1 = await cellBox(page, 'C1')
  await page.mouse.click(c1.left + c1.width / 2, c1.top - 10)
  await page.waitForTimeout(150)
  const col = await activeRange()
  const a4 = await cellBox(page, 'A4')
  const canvas = await canvasBox(page)
  await page.mouse.click(canvas.right - 20, a4.top + a4.height / 2) // row header sits right of column A
  await page.waitForTimeout(150)
  const row = await activeRange()
  const ok = col?.startColumn === 2 && col?.endColumn === 2 && col?.startRow === 0 && col?.endRow === 49 &&
    row?.startRow === 3 && row?.endRow === 3 && row?.startColumn === 0 && row?.endColumn === 11
  return { ok, col, row }
})

// --- editing -----------------------------------------------------------------

await check('double-click opens the editor over the cell; typing lands in that cell', async () => {
  const box = await cellBox(page, 'H5')
  const { x, y } = centre(box)
  await page.mouse.dblclick(x, y)
  await page.waitForTimeout(300)
  const typed = 'تجربة RTL 123'
  await page.keyboard.type(typed)
  await page.waitForTimeout(200)
  const editor = await page.evaluate(() => {
    const el = document.querySelector('.naf-rtl-unflip')
    const r = el?.getBoundingClientRect()
    return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null
  })
  await page.screenshot({ path: `${OUT}mirror-editing${TAG}.png` })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  const stored = await value('H5')
  // Text starts at the cell's right edge in RTL; the editor may grow leftwards.
  const editorOnCell = editor && near(editor.right, box.right, 6) && near(editor.top, box.top, 6)
  return { ok: stored === typed && Boolean(editorOnCell), stored, editor, cell: box }
})

await check('column resize: dragging the C|D border leftwards widens column C', async () => {
  // Not A|B: column A is frozen and that border is the freeze handle (same in the unmirrored grid).
  const c = await cellBox(page, 'C1')
  const before = await colWidth(2)
  const headerY = c.top - 10
  const border = c.left
  await page.mouse.move(border + 30, headerY)
  await page.mouse.move(border + 2, headerY, { steps: 3 })
  await page.waitForTimeout(200)
  await page.mouse.down()
  await page.mouse.move(border - 48, headerY, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const after = await colWidth(2)
  return { ok: near(after - before, 50, 4), before, after }
})

// --- toolbar alignment -------------------------------------------------------

await check('toolbar: with no alignment the button shows "right" (where the text sits)', async () => {
  const { x, y } = centre(await cellBox(page, 'G3'))
  await page.mouse.click(x, y)
  await page.waitForTimeout(200)
  const shown = await shownAlign()
  return { ok: shown === ALIGN.right, shown }
})

await check('toolbar "left" puts the text on the left, highlights "left", stores logical RIGHT', async () => {
  const box = await cellBox(page, 'G3')
  await page.mouse.click(centre(box).x, centre(box).y)
  await chooseAlign(ALIGN.left)
  await clickAway()
  const ink = await inkBox(page, clipOf(box, 3))
  await page.mouse.click(centre(box).x, centre(box).y)
  await page.waitForTimeout(200)
  const shown = await shownAlign()
  const ht = await styleHt('G3')
  const ok = ink && ink.left - box.left < 12 && box.right - ink.right > 20 && shown === ALIGN.left && ht === 3
  return { ok, ink, cell: box, shown, ht }
})

await check('toolbar "right" puts the text on the right, highlights "right", stores logical LEFT', async () => {
  const box = await cellBox(page, 'G3')
  await page.mouse.click(centre(box).x, centre(box).y)
  await chooseAlign(ALIGN.right)
  await clickAway()
  const ink = await inkBox(page, clipOf(box, 3))
  await page.mouse.click(centre(box).x, centre(box).y)
  await page.waitForTimeout(200)
  const shown = await shownAlign()
  const ht = await styleHt('G3')
  const ok = ink && box.right - ink.right < 12 && ink.left - box.left > 20 && shown === ALIGN.right && ht === 1
  return { ok, ink, cell: box, shown, ht }
})

await check('programmatic alignment (Facade) is stored as given, not swapped', async () => {
  await page.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveSheet().getRange('G2').setHorizontalAlignment('left'))
  const ht = await styleHt('G2')
  return { ok: ht === 1, ht }
})

// --- popups ------------------------------------------------------------------

await check('data-validation dropdown opens under its cell, aligned to its right edge', async () => {
  const box = await cellBox(page, 'B4')
  await page.mouse.click(box.left + 8, box.top + box.height / 2) // arrow is at the cell's end (left on screen)
  await page.waitForTimeout(500)
  const panel = await domBoxWithText(['فهد', 'نورة', 'تحرير'])
  await page.screenshot({ path: `${OUT}mirror-dropdown${TAG}.png` })
  await clickAway()
  const ok = Boolean(panel) && near(panel.right, box.right, 6) && near(panel.top, box.bottom, 12)
  return { ok, panel, cell: box }
})

await check('filter panel opens on the left of its column, level with the header', async () => {
  const box = await cellBox(page, 'E1')
  await page.mouse.click(box.left + 9, box.top + box.height / 2) // filter button: header cell's end
  await page.waitForTimeout(600)
  const panel = await domBoxWithText(['منجز', 'متأخر', 'إلغاء'])
  await page.screenshot({ path: `${OUT}mirror-filter${TAG}.png` })
  await page.getByText('إلغاء', { exact: true }).click()
  await page.waitForTimeout(300)
  const ok = Boolean(panel) && near(panel.right, box.left, 12) && near(panel.top, box.top, 12)
  return { ok, panel, cell: box }
})

await check('note shows on the left of its cell on hover', async () => {
  const box = await cellBox(page, 'G4')
  await page.mouse.move(box.left + 20, box.top + box.height / 2, { steps: 4 })
  await page.waitForTimeout(800)
  const note = await domBoxWithText(['ملاحظة على الخلية'])
  await page.screenshot({ path: `${OUT}mirror-note${TAG}.png` })
  await page.mouse.move(5, 700)
  await page.waitForTimeout(300)
  const ok = Boolean(note) && near(note.right, box.left, 16) && note.top < box.bottom && note.bottom > box.top
  return { ok, note, cell: box }
})

await check('link popup shows under its cell on hover', async () => {
  const box = await cellBox(page, 'F3')
  // Hover the link text itself: it sits at the cell's start (right edge on screen).
  await page.mouse.move(box.right - 20, box.top + box.height / 2, { steps: 4 })
  await page.waitForTimeout(800)
  const popup = await domBoxWithText(['example.com'])
  await page.screenshot({ path: `${OUT}mirror-link${TAG}.png` })
  await page.mouse.move(5, 700)
  await page.waitForTimeout(300)
  const ok = Boolean(popup) && popup.left < box.right + 40 && popup.right > box.left - 40 && near(popup.top, box.bottom, 16)
  return { ok, popup, cell: box }
})

await check('right-click opens the context menu at the pointer', async () => {
  const { x, y } = centre(await cellBox(page, 'C6'))
  await page.mouse.click(x, y, { button: 'right' })
  await page.waitForTimeout(400)
  const menu = await domBoxWithText(['نسخ', 'لصق'])
  await page.screenshot({ path: `${OUT}mirror-context-menu${TAG}.png` })
  await clickAway()
  const ok = Boolean(menu) && near(menu.top, y, 40) && (near(menu.left, x, 40) || near(menu.right, x, 40))
  return { ok, menu, pointer: { x, y } }
})

await check('find (Ctrl+F): one match, highlighted over its cell', async () => {
  const { x, y } = centre(await cellBox(page, 'A2'))
  await page.mouse.click(x, y)
  await page.keyboard.press('Control+f')
  await page.waitForTimeout(500)
  await page.keyboard.type('متأخر')
  await page.waitForTimeout(800)
  const counter = await domBoxWithText(['1/1'])
  const e4 = await cellBox(page, 'E4')
  // The match highlight is an orange fill drawn on the canvas; look around E4 only
  // (G4's note marker is orange too).
  const orange = await inkBox(page, { x: Math.round(e4.left - 20), y: Math.round(e4.top - 20), width: Math.round(e4.width + 40), height: Math.round(e4.height + 40) }, 'orange')
  await page.screenshot({ path: `${OUT}mirror-find${TAG}.png` })
  await page.keyboard.press('Escape')
  await clickAway()
  const ok = Boolean(counter) && Boolean(orange) && near(orange.left, e4.left, 4) && near(orange.right, e4.right, 4) && near(orange.top, e4.top, 4)
  return { ok, highlight: orange, cell: e4 }
})

// --- special-cases sheet: autofill, formula references, rotation, images -----

await sheet(page, 'extras')

await check('autofill: dragging the fill handle continues the series', async () => {
  const a4 = await cellBox(page, 'A4')
  const a5 = await cellBox(page, 'A5')
  await page.mouse.move(centre(a4).x, centre(a4).y)
  await page.mouse.down()
  await page.mouse.move(centre(a5).x, centre(a5).y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  // The fill handle is the selection's bottom-end corner: bottom-left on screen.
  const a8 = await cellBox(page, 'A8')
  await page.mouse.move(a5.left + 1, a5.bottom - 1)
  await page.waitForTimeout(150)
  await page.mouse.down()
  await page.mouse.move(a5.left + 1, a8.bottom - 3, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const got = [await value('A6'), await value('A7'), await value('A8')]
  return { ok: got.join() === '50,70,90', got }
})

await check('formula reference by dragging over cells while typing =SUM(', async () => {
  const d5 = await cellBox(page, 'D5')
  await page.mouse.dblclick(centre(d5).x, centre(d5).y)
  await page.waitForTimeout(300)
  await page.keyboard.type('=SUM(')
  await page.waitForTimeout(200)
  const a4 = centre(await cellBox(page, 'A4'))
  const b5 = centre(await cellBox(page, 'B5'))
  await page.mouse.move(a4.x, a4.y)
  await page.mouse.down()
  await page.mouse.move(b5.x, b5.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  await page.keyboard.type(')')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  const f = await formula('D5')
  const v = await value('D5')
  return { ok: f === '=SUM(A4:B5)' && v === 100, formula: f, value: v }
})

await sheet(plain, 'extras')

await check('rotated text: same ink position, extent and amount as in the unmirrored grid', async () => {
  // Pixel-identical is too strict: glyphs rasterised under a flipped transform
  // antialias slightly differently. Position, extent and ink amount must match.
  const out = {}
  let ok = true
  for (const a1 of ['A2', 'B2', 'C2']) {
    const m = await inkBox(page, clipOf(await cellBox(page, a1), 2))
    const p = await inkBox(plain, clipOf(await cellBox(plain, a1, false), 2))
    const mc = await cellBox(page, a1)
    const pc = await cellBox(plain, a1, false)
    // Compare relative to each cell's own box.
    const rel = (ink, cell) => ink && { l: ink.left - cell.left, r: ink.right - cell.left, t: ink.top - cell.top, b: ink.bottom - cell.top, n: ink.count }
    const [rm, rp] = [rel(m, mc), rel(p, pc)]
    const same = rm && rp && ['l', 'r', 't', 'b'].every((k) => near(rm[k], rp[k], 2)) && rm.n / rp.n > 0.85 && rm.n / rp.n < 1.15
    out[a1] = { mirrored: rm, plain: rp, same }
    ok = ok && Boolean(same)
  }
  await page.screenshot({ path: `${OUT}mirror-extras${TAG}.png` })
  return { ok, cells: out }
})

await check('floating image is not mirrored: arrow points right, text top-right', async () => {
  const canvas = await canvasBox(page)
  const clip = { x: Math.round(canvas.left), y: Math.round(canvas.top), width: Math.round(canvas.right - canvas.left), height: 300 }
  const box = await inkBox(page, clip, 'yellow')
  if (!box) return { ok: false, reason: 'image not found on screen' }
  const imgClip = { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.right - box.left), height: Math.round(box.bottom - box.top) }
  const arrow = await inkBox(page, imgClip, 'blue')
  const label = await inkBox(page, { ...imgClip, height: Math.round(imgClip.height / 2) }, 'dark')
  const mid = imgClip.x + imgClip.width / 2
  // Arrowhead and "RTL" sit in the right part of the image when it is not mirrored.
  const ok = Boolean(arrow && label) && arrow.right > mid + imgClip.width * 0.25 && label.meanX > mid
  return { ok, image: imgClip, arrow, label }
})

// --- floating images: anchor, selection, handles, menu, drag, resize --------
// (apps/api OPEN_QUESTIONS.md "Images" I15.) The harness inserts the picture
// at E4 with no offset (harness/main.ts `imageInserted`), 160 × 60 px.
const imageInk = async (p) => {
  const c = await canvasBox(p)
  return inkBox(p, { x: Math.round(c.left), y: Math.round(c.top), width: Math.round(c.right - c.left), height: 420 }, 'yellow')
}
const imagePlacement = (p = page) => p.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveSheet().getImages()[0]?.getPlacement())
const activeImages = (p = page) => p.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveSheet().getActiveImages().length)
// A click on an empty cell drops the image selection (Escape alone does not).
const deselectImage = async (p = page) => { const b = await cellBox(p, 'H18', p === page); await p.mouse.click(centre(b).x, centre(b).y); await p.waitForTimeout(300) }

await check('floating image sits on its anchor cell: its start (visual right) edge and top at E4’s', async () => {
  const box = await imageInk(page)
  const e4 = await cellBox(page, 'E4')
  const placement = await imagePlacement()
  const ok = Boolean(box) && placement?.from?.column === 4 && placement?.from?.row === 3 && near(box.right, e4.right, 3) && near(box.top, e4.top, 3) && near(box.right - box.left, 160, 4)
  return { ok, box, e4, placement }
})

await check('a click on the image selects it, as in the unmirrored grid at the mirrored point', async () => {
  const box = await imageInk(page)
  const pbox = await imageInk(plain)
  if (!box || !pbox) return { ok: false, reason: 'image not found' }
  await page.mouse.click((box.left + box.right) / 2, (box.top + box.bottom) / 2)
  await plain.mouse.click((pbox.left + pbox.right) / 2, (pbox.top + pbox.bottom) / 2)
  await page.waitForTimeout(500)
  await plain.waitForTimeout(500)
  const [m, p] = [await activeImages(page), await activeImages(plain)]
  await deselectImage(plain)
  return { ok: m === 1 && p === 1, mirrored: m, plain: p }
})

await check('selection handles are drawn around the image where it is on screen', async () => {
  const box = await imageInk(page)
  await deselectImage()
  const c = await canvasBox(page)
  const clip = { x: Math.round(c.left), y: Math.round(c.top), width: Math.round(c.right - c.left), height: 420 }
  const before = (await page.screenshot({ clip })).toString('base64')
  await page.mouse.click((box.left + box.right) / 2, (box.top + box.bottom) / 2)
  await page.waitForTimeout(500)
  const after = (await page.screenshot({ clip })).toString('base64')
  // Changed pixels (handles, outline, the rotation knob below, the menu button beside it).
  const changed = await lab.evaluate(async ({ before, after, clip }) => {
    const load = async (s) => { const i = new Image(); i.src = `data:image/png;base64,${s}`; await i.decode(); const cv = document.createElement('canvas'); cv.width = i.width; cv.height = i.height; const x = cv.getContext('2d'); x.drawImage(i, 0, 0); return { d: x.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height } }
    const [a, b] = [await load(before), await load(after)]
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4
      if (Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]) < 60) continue
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    return minX === Infinity ? null : { left: clip.x + minX, right: clip.x + maxX, top: clip.y + minY, bottom: clip.y + maxY }
  }, { before, after, clip })
  // The handles hug the picture on both sides (the menu button may sit just past one edge); the knob sits below.
  const ok = Boolean(changed) && changed.left >= box.left - 40 && changed.left <= box.left + 2 && changed.right <= box.right + 40 && changed.right >= box.right - 2 && near(changed.top, box.top, 8) && changed.bottom > box.bottom && changed.bottom < box.bottom + 60
  return { ok, image: box, changed }
})

await check('the image menu opens beside the image, on its end side (visual left), not over the grid elsewhere', async () => {
  const box = await imageInk(page)
  // Univer's canvas popups are fixed <section>s, parked off screen when hidden.
  const popups = await page.evaluate(() => [...document.querySelectorAll('section')]
    .filter((e) => getComputedStyle(e).position === 'fixed')
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0 && r.left > -1000)
    .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })))
  await page.screenshot({ path: `${OUT}mirror-image-selected${TAG}.png` })
  const menu = popups.find((r) => r.bottom > box.top && r.top < box.bottom)
  const ok = Boolean(menu) && menu.right <= box.left + 4 && menu.right >= box.left - 40
  return { ok, image: box, popups }
})

await check('drag moves the image under the pointer: two columns to the visual left anchors it two columns later', async () => {
  const box = await imageInk(page)
  const cx = (box.left + box.right) / 2
  const cy = (box.top + box.bottom) / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 88, cy, { steps: 6 })
  await page.mouse.move(cx - 176, cy, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  const placement = await imagePlacement()
  const moved = await imageInk(page)
  const ok = placement?.from?.column === 6 && placement?.from?.row === 3 && near(placement?.from?.columnOffset ?? -1, 0, 2) && Boolean(moved) && near(moved.right, box.right - 176, 3) && near(moved.top, box.top, 3)
  return { ok, before: box, after: moved, placement }
})

await check('resize: dragging the visual-left middle handle outwards widens the image and keeps its start edge', async () => {
  const box = await imageInk(page)
  const before = await imagePlacement()
  const hx = box.left - 1
  const hy = (box.top + box.bottom) / 2
  await page.mouse.move(hx, hy)
  await page.mouse.down()
  await page.mouse.move(hx - 20, hy, { steps: 4 })
  await page.mouse.move(hx - 40, hy, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  const after = await imagePlacement()
  const resized = await imageInk(page)
  const ok = Boolean(resized) && near(resized.right, box.right, 3) && near(resized.left, box.left - 40, 4) && near(after?.width ?? 0, (before?.width ?? 0) + 40, 4) && after?.from?.column === before?.from?.column
  // Back where it was for the checks that follow: undo the resize and the move.
  await deselectImage()
  for (let i = 0; i < 2; i++) await page.evaluate(() => window.univerAPI.undo())
  await page.waitForTimeout(500)
  return { ok, before: box, after: resized, placement: after }
})

await plain.close()

// --- touch -------------------------------------------------------------------

await check('touch: a tap selects the cell under the finger', async () => {
  const touch = await openPage('?dir=rtl&grid=mirror&selftest=0', { hasTouch: true })
  const got = []
  for (const a1 of ['B3', 'G4']) {
    const { x, y } = centre(await cellBox(touch, a1))
    await touch.touchscreen.tap(x, y)
    await touch.waitForTimeout(250)
    got.push(await active(touch))
  }
  await touch.close()
  return { ok: got.join() === 'B3,G4', got }
})

// --- data --------------------------------------------------------------------

await check('stored values are untouched (no direction marks leak into the model)', async () => {
  await sheet(page, 'tasks')
  const v = await value('A6')
  return { ok: v === 'نشر المقال على LinkedIn', v }
})

// --- document text: cell editor, formula bar, rich-text cells ----------------
// Univer lays document text out in logical order with no bidi; src/rtl-text.ts
// shows it in Unicode bidi order. The oracle is the browser's own layout of
// the same string in a dir="rtl" element (see browserUnits).

const tp = await openPage('?dir=rtl&grid=mirror&selftest=0', {}, { record: true })
await sheet(tp, 'bidi')
// Rows of the harness sheet "bidi" (harness/main.ts).
const BIDI_ROWS = { 1: 'نشر المقال على LinkedIn Ads', 2: 'موعد التسليم 2026-11-10 بمبلغ 12,400.00 ريال', 3: 'متابعة قضية رقم 2291/ت/1447', 4: 'هل انتهى العمل؟', 5: '(مسودة) خطة الربع الأول.', 6: 'Basecamp API v2', 8: 'إعداد خطة الاتصال' }

await check('text layer applied to the document surfaces, no text contract problems', async () => {
  const s = await tp.evaluate(() => window.__rtlStatus)
  return { ok: s?.mirrored === true && s.text?.applied === true && s.textProblems?.length === 0, status: s }
})

await check('cell editor and formula bar paint every mixed string in the browser\'s bidi order', async () => {
  const rows = {}
  let ok = true
  for (const [row, text] of Object.entries(BIDI_ROWS)) {
    await openEditor(tp, `A${row}`)
    const shown = await docText(tp)
    const ref = await browserUnits(tp, shown)
    const editor = await paintedUnits(tp, EDITOR_ID)
    const formulaBar = await paintedUnits(tp, FORMULA_BAR_ID)
    const same = shown === text && sameUnits(editor, ref) && sameUnits(formulaBar, ref)
    rows[row] = same ? 'same' : { shown, browser: ref.map((u) => u.text).join(' '), editor: editor.map((u) => u.text).join(' '), formulaBar: formulaBar.map((u) => u.text).join(' ') }
    ok = ok && same
    if (row === '1') {
      await tp.screenshot({ path: `${OUT}mirror-text-editor${TAG}.png`, clip: { x: 0, y: 70, width: 1280, height: 110 } })
    }
    await cancelEdit(tp)
  }
  return { ok, rows }
})

await check('a pure-Latin cell stays left to right in the editor', async () => {
  await openEditor(tp, 'A6')
  const painted = (await paintedUnits(tp, EDITOR_ID)).map((u) => u.text).join('')
  await cancelEdit(tp)
  return { ok: painted === BIDI_ROWS[6].replace(/ /g, ''), painted }
})

await check('editor text starts on the right like the cell (logical start = visual right)', async () => {
  const box = await cellBox(tp, 'A1')
  await openEditor(tp, 'A1')
  const units = await paintedUnits(tp, EDITOR_ID)
  await cancelEdit(tp)
  const right = Math.max(...units.map((u) => u.x1))
  return { ok: units.length > 0 && near(right, box.right - 2, 4), textRight: right, cellRight: box.right }
})

await check('a formula with an Arabic sheet name reads left to right in the editor', async () => {
  await sheet(tp, 'summary')
  await openEditor(tp, 'B2')
  const shown = await docText(tp)
  const ref = await browserFormulaUnits(tp, "='\u2068المهام\u2069'!A2")
  const editor = await paintedUnits(tp, EDITOR_ID)
  await cancelEdit(tp)
  await sheet(tp, 'bidi')
  return { ok: shown === "='المهام'!A2" && sameUnits(editor, ref), shown, browser: ref.map((u) => u.text).join(' '), editor: editor.map((u) => u.text).join(' ') }
})

await check('click places the caret at the clicked character, drawn on its correct side', async () => {
  // Row 1: «نشر المقال على LinkedIn Ads». Targets come from the units the editor
  // painted: 2px inside the start of «على» (offset 11) and the end of «المقال»
  // (offset 10), both wide letters, and both halves of the Latin «k» (18, 19).
  const got = []
  let ok = true
  const word = (u, t) => u.find((x) => x.text === t)
  for (const [what, offset, pick] of [
    ['start of «على»', 11, (u) => word(u, 'على') && { x: word(u, 'على').x1 - 2, edge: word(u, 'على').x1 }],
    ['end of «المقال»', 10, (u) => word(u, 'المقال') && { x: word(u, 'المقال').x0 + 2, edge: word(u, 'المقال').x0 }],
    ['before «k»', 18, (u) => word(u, 'k') && { x: word(u, 'k').x0 + 2, edge: word(u, 'k').x0 }],
    ['after «k»', 19, (u) => word(u, 'k') && { x: word(u, 'k').x1 - 2, edge: word(u, 'k').x1 }],
  ]) {
    await openEditor(tp, 'A1')
    const target = pick(await paintedUnits(tp, EDITOR_ID))
    if (!target) {
      ok = false
      got.push({ what, error: 'unit not painted' })
      await cancelEdit(tp)
      continue
    }
    await tp.mouse.click(target.x, (await editorTop(tp)) + 12)
    await tp.waitForTimeout(150)
    const caret = await caretX(tp)
    const at = await markerOffset(tp)
    const pass = at === offset && caret !== null && near(caret, target.edge, 1.5)
    ok = ok && pass
    got.push({ what, offset: at, expected: offset, caret, edge: target.edge })
    await cancelEdit(tp)
  }
  return { ok, got }
})

await check('arrow keys move the caret visually; Home and End go to the logical start and end', async () => {
  const len = BIDI_ROWS[8].length
  const run = async (keys) => {
    await openEditor(tp, 'A8')
    for (const k of keys) await tp.keyboard.press(k)
    const at = await markerOffset(tp)
    await cancelEdit(tp)
    return at
  }
  // Pure Arabic: ArrowLeft goes forward in reading order, ArrowRight back.
  const got = { home: await run([RTL_START]), end: await run([RTL_END]), homeLeft3: await run([RTL_START, 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']), endRight2: await run([RTL_END, 'ArrowRight', 'ArrowRight']) }
  // Mixed line: the caret must move strictly left on every ArrowLeft until the
  // visual left end of the text, and strictly right back to the right end.
  await openEditor(tp, 'A1')
  await tp.keyboard.press(RTL_START)
  const units = await paintedUnits(tp, EDITOR_ID)
  const xs = [await caretX(tp)]
  for (let i = 0; i < 34; i++) {
    await tp.keyboard.press('ArrowLeft')
    xs.push(await caretX(tp))
  }
  const back = [xs[xs.length - 1]]
  for (let i = 0; i < 34; i++) {
    await tp.keyboard.press('ArrowRight')
    back.push(await caretX(tp))
  }
  await cancelEdit(tp)
  const textLeft = Math.min(...units.map((u) => u.x0))
  const textRight = Math.max(...units.map((u) => u.x1))
  const strict = (a, sign) => {
    let steps = 0
    for (let i = 1; i < a.length; i++) {
      const d = (a[i] - a[i - 1]) * sign
      if (d > 0.5) steps++
      else if (Math.abs(d) <= 0.5) { if (a.slice(i).some((x) => Math.abs(x - a[i]) > 0.5)) return -1 } // a stop must be final
      else return -1
    }
    return steps
  }
  const leftSteps = strict(xs, -1)
  const rightSteps = strict(back, 1)
  const ok = got.home === 0 && got.end === len && got.homeLeft3 === 3 && got.endRight2 === len - 2 &&
    leftSteps >= BIDI_ROWS[1].length - 2 && rightSteps === leftSteps && near(xs[0], textRight, 1.5) && near(xs[xs.length - 1], textLeft, 1.5) && near(back[back.length - 1], textRight, 1.5)
  return { ok, got, leftSteps, rightSteps, ends: { start: xs[0], textRight, leftmost: xs[xs.length - 1], textLeft } }
})

await check('line ends: Home/End are logical; with the Mac key map Cmd+Left/Right go to the visual left/right end', async () => {
  const at = async (row, keys) => {
    await openEditor(tp, `A${row}`)
    for (const k of keys) await tp.keyboard.press(k)
    const caret = await caretX(tp)
    const units = await paintedUnits(tp, EDITOR_ID)
    const offset = await markerOffset(tp)
    await cancelEdit(tp)
    return { offset, caret, left: Math.min(...units.map((u) => u.x0)), right: Math.max(...units.map((u) => u.x1)) }
  }
  const rtl = BIDI_ROWS[8].length
  const ltr = BIDI_ROWS[6].length
  const got = {}
  let ok
  if (KEYS.mac) {
    // Visual, whatever the line's direction: Arabic (A8), Latin (A6), mixed (A1).
    got.rtlLeft = await at(8, ['Meta+ArrowLeft'])
    got.rtlRight = await at(8, ['Meta+ArrowRight'])
    got.ltrLeft = await at(6, ['Meta+ArrowLeft'])
    got.ltrRight = await at(6, ['Meta+ArrowRight'])
    got.mixedLeft = await at(1, ['Meta+ArrowLeft'])
    got.mixedRight = await at(1, ['Meta+ArrowRight'])
    await openEditor(tp, 'A8')
    await tp.keyboard.press('Meta+ArrowRight')
    await tp.keyboard.press('Shift+Meta+ArrowLeft')
    await tp.keyboard.type('Y')
    got.selectWholeLine = await docText(tp)
    await cancelEdit(tp)
    ok = got.rtlLeft.offset === rtl && got.rtlRight.offset === 0 && got.ltrLeft.offset === 0 && got.ltrRight.offset === ltr &&
      near(got.mixedLeft.caret, got.mixedLeft.left, 1.5) && near(got.mixedRight.caret, got.mixedRight.right, 1.5) && got.mixedRight.offset === 0 &&
      ['rtlLeft', 'rtlRight', 'ltrLeft', 'ltrRight'].every((k) => near(got[k].caret, k.endsWith('Left') ? got[k].left : got[k].right, 1.5)) && got.selectWholeLine === 'Y'
  } else {
    // Logical: Home to the start, End to the end, whatever the line's direction.
    got.rtlHome = await at(8, ['Home'])
    got.rtlEnd = await at(8, ['End'])
    got.ltrHome = await at(6, ['Home'])
    got.ltrEnd = await at(6, ['End'])
    ok = got.rtlHome.offset === 0 && got.rtlEnd.offset === rtl && got.ltrHome.offset === 0 && got.ltrEnd.offset === ltr &&
      near(got.rtlHome.caret, got.rtlHome.right, 1.5) && near(got.rtlEnd.caret, got.rtlEnd.left, 1.5) && near(got.ltrHome.caret, got.ltrHome.left, 1.5)
  }
  return { ok, macKeys: KEYS.mac, got }
})

await check('Shift+Arrow and drag select the right glyphs (a split selection is two rectangles)', async () => {
  // Shift+ArrowLeft x3 from Home in «إعداد خطة الاتصال»: the first three letters, on the right.
  await openEditor(tp, 'A8')
  await tp.keyboard.press(RTL_START)
  const right = Math.max(...(await paintedUnits(tp, EDITOR_ID)).map((u) => u.x1))
  for (let i = 0; i < 3; i++) await tp.keyboard.press('Shift+ArrowLeft')
  const shiftRects = await selectionRects(tp)
  await tp.keyboard.type('Y')
  const afterShift = await docText(tp)
  await cancelEdit(tp)
  // Drag from the start of «على» to the start of the third letter of «LinkedIn»: offsets 11..17.
  await openEditor(tp, 'A1')
  const units = await paintedUnits(tp, EDITOR_ID)
  const ala = units.find((u) => u.text === 'على')
  const latin = units.filter((u) => /^[A-Za-z]$/.test(u.text))
  const [L, i1, n1] = latin
  const s = units.find((u) => u.text === 's')
  const top = (await editorTop(tp)) + 12
  await tp.mouse.move(ala.x1 - 2, top)
  await tp.mouse.down()
  await tp.mouse.move(n1.x0 + 1.5, top, { steps: 6 })
  await tp.mouse.up()
  await tp.waitForTimeout(150)
  const dragRects = await selectionRects(tp)
  await tp.keyboard.type('Z')
  const afterDrag = await docText(tp)
  await cancelEdit(tp)
  const r1 = BIDI_ROWS[1]
  const ok = shiftRects.length === 1 && near(shiftRects[0].x1, right, 1.5) && shiftRects[0].x1 - shiftRects[0].x0 > 8 && afterShift === 'Y' + BIDI_ROWS[8].slice(3) &&
    dragRects.length === 2 && near(dragRects[0].x0, L.x0, 1.5) && near(dragRects[0].x1, i1.x1, 1.5) && near(dragRects[1].x1, ala.x1, 1.5) && near(dragRects[1].x0, s.x1, 2.5) &&
    afterDrag === r1.slice(0, 11) + 'Z' + r1.slice(17)
  return { ok, shiftRects, right, afterShift, dragRects, expected: { latin: [L.x0, i1.x1], arabic: [s.x1, ala.x1] }, afterDrag }
})

await check('typing Arabic renders in bidi order live; the stored value is what the editor shows', async () => {
  const typed = 'نص تجريبي LinkedIn 2026 نهاية'
  await openEditor(tp, 'A7')
  const steps = []
  let ok = true
  let soFar = ''
  for (const piece of typed.split(/(?<= )/)) {
    await tp.keyboard.type(piece)
    await tp.waitForTimeout(60)
    soFar += piece
    const shown = await docText(tp)
    const same = sameUnits(await paintedUnits(tp, EDITOR_ID), await browserUnits(tp, shown))
    ok = ok && same
    steps.push({ typed: soFar, shown, same })
  }
  const shown = await docText(tp)
  await tp.keyboard.press('Enter')
  await tp.waitForTimeout(300)
  const stored = await value('A7', tp)
  // Firefox: Playwright's synthetic Arabic input is corrupted before Univer sees it (known upstream, test/known-upstream.mjs).
  const typedIntact = shown === typed
  return { ok: ok && stored === shown && typedIntact, typed, stored, shown, typedIntact, steps }
})

await check('IME: the input sits at the caret, and composed text is ordered as it is composed', async () => {
  await openEditor(tp, 'A8')
  await tp.keyboard.press(RTL_END)
  const caret = await caretX(tp)
  const ime = await imeBox(tp)
  let composition = 'not available in this browser (CDP is Chromium only)'
  let composedOk = true
  if (BROWSER === 'chromium') {
    const cdp = await tp.context().newCDPSession(tp)
    await cdp.send('Input.imeSetComposition', { text: 'جد', selectionStart: 2, selectionEnd: 2 })
    await tp.waitForTimeout(150)
    const during = { text: await docText(tp), caret: await caretX(tp), ime: await imeBox(tp) }
    await cdp.send('Input.insertText', { text: 'جديد' })
    await tp.waitForTimeout(200)
    const shown = await docText(tp)
    const same = sameUnits(await paintedUnits(tp, EDITOR_ID), await browserUnits(tp, shown))
    composedOk = during.text === BIDI_ROWS[8] + 'جد' && near(during.caret, during.ime.left, 1.5) && during.caret < caret && shown === BIDI_ROWS[8] + 'جديد' && same
    composition = { during, committed: shown, same }
  }
  await cancelEdit(tp)
  const ok = caret !== null && ime?.focused === true && near(ime.left, caret, 1.5) && composedOk
  return { ok, caret, ime, composition }
})

await check('an Arabic rich-text cell (hyperlink) reads in bidi order in the mirrored grid', async () => {
  const text = 'تقرير الربع الأول'
  const words = text.split(' ')
  const order = await tp.evaluate(async (words) => {
    window.__fillTextLog = { canvas: null, items: [] }
    window.univerAPI.getActiveWorkbook().getActiveSheet().refreshCanvas()
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r))
    const items = window.__fillTextLog.items.filter((it) => words.includes(it.text))
    window.__fillTextLog = null
    const byWord = new Map(items.map((it) => [it.text, it]))
    // The sheet canvas is mirrored by CSS: on screen, a larger device x is further left.
    return [...byWord.values()].sort((a, b) => b.x0 - a.x0).map((it) => it.text)
  }, words)
  const ref = (await browserUnits(tp, text)).map((u) => u.text)
  return { ok: JSON.stringify(order) === JSON.stringify(ref), painted: order, browser: ref }
})

await check('stored values are untouched by editing round trips (open, move, select, cancel)', async () => {
  const got = {}
  for (const row of Object.keys(BIDI_ROWS)) got[row] = await value(`A${row}`, tp)
  const ok = Object.entries(BIDI_ROWS).every(([row, text]) => got[row] === text)
  return { ok, got }
})

await tp.close()

// --- formula colours (../src/formula-colours.ts) -------------------------------
//
// Excel's reference colours and outlines, plus the owner's extra categories.
// The expected colour of every character is written out here by hand from the
// rules (apps/web/OPEN_QUESTIONS.md F1–F4), independently of the module: the
// colours really painted (fillStyle beneath the layer) in visual order must
// equal the browser's bidi order of the same text with those colours.

const fp = await openPage('?dir=rtl&grid=mirror&selftest=0', {}, { record: true })
const FC = await fp.evaluate(() => window.__formulaColours)
const PAL = FC?.palette
// [text, colour] pieces of `=IF(SUM(A4:B5,A4)>=10,"نعم",'المهام'!A2)` on sheet «حالات خاصة».
const FORMULA_PIECES = PAL ? [
  ['=', PAL.plain], ['IF', PAL.function], ['(', PAL.plain], ['SUM', PAL.function], ['(', PAL.references[1]],
  ['A4:B5', PAL.references[0]], [',', PAL.plain], ['A4', PAL.references[1]], [')', PAL.references[1]],
  ['>=', PAL.comparison], ['10', PAL.number], [',', PAL.plain], ['"نعم"', PAL.string], [',', PAL.plain],
  ["'المهام'!", PAL.sheet], ['A2', PAL.plain], [')', PAL.plain],
] : []
const FORMULA = FORMULA_PIECES.map(([t]) => t).join('')
// Formula mode: «نعم» and «المهام» are isolates, so they keep their typed order.
const FORMULA_MARKED = FORMULA.replace('"نعم"', '"\u2068نعم\u2069"').replace("'المهام'", "'\u2068المهام\u2069'")
const charColours = FORMULA_PIECES.flatMap(([t, c]) => Array.from(t, () => c))
// The browser's visual order of the formula's units (formula mode: left to
// right, Arabic tokens isolated), each with the colour of its first character.
const expectedColoured = async (p) => (await browserFormulaUnits(p, FORMULA_MARKED)).map((u) => ({ text: u.text, fill: charColours[u.start] }))
const paintedColoured = (p, unitId) => p.evaluate(async (unitId) => {
  const unit = window.__renderManager.getRenderUnitById(unitId)
  const canvas = unit.engine.getCanvasElement()
  window.__fillTextLog = { canvas, items: [] }
  unit.mainComponent.makeDirty(true)
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r))
  const items = window.__fillTextLog.items.filter((it) => it.text.trim() && !/^[\u0000-\u001f]+$/.test(it.text))
  window.__fillTextLog = null
  const seen = new Map()
  for (const it of items) seen.set(`${it.text}|${Math.round(it.x0)}|${Math.round(it.y)}`, { text: it.text, fill: it.fill, x0: it.x0 })
  return [...seen.values()].sort((a, b) => a.x0 - b.x0).map(({ text, fill }) => ({ text, fill }))
}, unitId)
const sameColoured = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// Arabic goes in with insertText, the rest is typed key by key: Firefox's
// synthetic typing of Arabic reaches Univer 1.4.0 duplicated (known-upstream.mjs),
// which is not what these checks are about.
const typeFormula = async (p, text) => {
  for (const part of text.match(new RegExp(`${ARABIC_RUN}|[^\\u0600-\\u06FF]+`, 'g')) ?? []) {
    if (new RegExp(ARABIC_RUN).test(part)) await p.keyboard.insertText(part)
    else await p.keyboard.type(part)
  }
}

await check('formula colours: layer applied, theme carries Excel\'s sequence, no contract problems', async () => {
  const ok = FC?.applied === true && FC.themed === true && FC.problems.length === 0 && PAL.references.length === 7
  return { ok, status: FC && { applied: FC.applied, themed: FC.themed, problems: FC.problems, reason: FC.reason } }
})

await sheet(fp, 'extras')
await openEditor(fp, 'D7')
await typeFormula(fp, FORMULA)
await fp.waitForTimeout(700)

await check('formula colours (cell editor): every token painted in its colour, in bidi order, Arabic sheet name and string joined', async () => {
  const painted = await paintedColoured(fp, EDITOR_ID)
  const expected = await expectedColoured(fp)
  await fp.screenshot({ path: `${OUT}formula-colours-cell-editor${TAG}.png` })
  return { ok: sameColoured(painted, expected), painted, expected }
})

await check('formula colours: outlines on the mirrored grid in Excel\'s colours around A4:B5 and A4', async () => {
  const canvas = await canvasBox(fp)
  const top = (await cellBox(fp, 'A3')).top
  const editor = await editorTop(fp)
  // From column C to the canvas edge: the floating image (E4:F5) has blue edges of its own.
  const left = (await cellBox(fp, 'C3')).left
  const clip = { x: Math.round(left), y: Math.round(top), width: Math.round(canvas.right - left), height: Math.round(editor - top - 4) }
  const blue = await inkBox(fp, clip, 'refBlue')
  const red = await inkBox(fp, clip, 'refRed')
  const a4 = await cellBox(fp, 'A4')
  const b5 = await cellBox(fp, 'B5')
  const want = { blue: { left: b5.left, right: a4.right, top: a4.top, bottom: b5.bottom }, red: a4 }
  const fits = (got, w) => got && ['left', 'right', 'top', 'bottom'].every((k) => near(got[k], w[k], 4))
  await fp.screenshot({ path: `${OUT}formula-colours-outlines${TAG}.png` })
  return { ok: fits(blue, want.blue) && fits(red, want.red), blue, red, want }
})

await cancelEdit(fp)
await clickAway(fp)

// Like Excel, Univer colours the editor in use: editing in the formula bar colours the formula bar.
await check('formula colours (formula bar): every token painted in its colour, in bidi order, Arabic sheet name and string joined', async () => {
  const { x, y } = centre(await cellBox(fp, 'D8'))
  await fp.mouse.click(x, y)
  await fp.waitForTimeout(200)
  const bar = await fp.evaluate((id) => window.__renderManager.getRenderUnitById(id).engine.getCanvasElement().getBoundingClientRect().toJSON(), FORMULA_BAR_ID)
  await fp.mouse.click(bar.left + bar.width / 2, bar.top + bar.height / 2)
  await fp.waitForTimeout(300)
  await typeFormula(fp, FORMULA)
  await fp.waitForTimeout(700)
  const painted = await paintedColoured(fp, FORMULA_BAR_ID)
  const expected = await expectedColoured(fp)
  await fp.screenshot({ path: `${OUT}formula-colours-formula-bar${TAG}.png` })
  await cancelEdit(fp)
  await clickAway(fp)
  return { ok: sameColoured(painted, expected), painted, expected }
})

// The same edit at 150 % zoom, scrolled, in the mirrored and in the unmirrored
// grid: the outlines must be each other's mirror image (getCellRect ignores
// scroll and zoom, so the unmirrored grid is the reference here).
const fpPlain = await openPage('?dir=rtl&selftest=0&textLayer=1')
const outlineAfterScrollZoom = async (p) => {
  await p.evaluate(async () => {
    const wb = window.univerAPI.getActiveWorkbook()
    wb.getSheetBySheetId('extras').activate()
    await new Promise((r) => setTimeout(r, 400))
    const ws = wb.getActiveSheet()
    ws.zoom(1.5)
    await new Promise((r) => setTimeout(r, 300))
    // Scrolled down and across: the floating image (rows 4-5) is out of view.
    ws.scrollToCell(6, 1)
    await new Promise((r) => setTimeout(r, 300))
    ws.getRange('E16').activate()
    await new Promise((r) => setTimeout(r, 300))
    document.getElementById('__editor___INTERNAL_EDITOR__DOCS_NORMAL')?.focus()
  })
  await p.keyboard.type('=SUM(C9:D10,D12)')
  await p.waitForTimeout(700)
  const canvas = await canvasBox(p)
  const editor = await editorTop(p)
  const clip = { x: Math.round(canvas.left), y: Math.round(canvas.top), width: Math.round(canvas.right - canvas.left), height: Math.round(editor - canvas.top - 4) }
  const blue = await inkBox(p, clip, 'refBlue')
  const red = await inkBox(p, clip, 'refRed')
  return { canvas, blue, red }
}
await check('formula colours: after scroll and 150% zoom, the outlines mirror those of the unmirrored grid', async () => {
  const m = await outlineAfterScrollZoom(fp)
  const u = await outlineAfterScrollZoom(fpPlain)
  await fp.screenshot({ path: `${OUT}formula-colours-outlines-zoom${TAG}.png` })
  const mirror = (b) => b && { left: u.canvas.left + u.canvas.right - b.right, right: u.canvas.left + u.canvas.right - b.left, top: b.top, bottom: b.bottom }
  const fits = (got, w) => got && w && ['left', 'right', 'top', 'bottom'].every((k) => near(got[k], w[k], 3))
  const ok = fits(m.blue, mirror(u.blue)) && fits(m.red, mirror(u.red)) && m.blue.right - m.blue.left > 100
  return { ok, mirrored: { blue: m.blue, red: m.red }, expected: { blue: mirror(u.blue), red: mirror(u.red) } }
})
await fpPlain.close()
await fp.close()

// --- formula mode (../src/formula-layout.ts, rtl-text.ts step 7) ------------------
//
// Owner decision 2026-11-11 («طبق من اليسار الى اليمين»): a formula in the cell
// editor or the formula bar reads left to right, token by token, in the order it
// was typed; every Arabic token reads right to left inside its own place. The
// oracle is the browser's layout of the same formula with FSI … PDI written by
// hand around each Arabic token (browserFormulaUnits).

const fm = await openPage('?dir=rtl&grid=mirror&selftest=0', {}, { record: true })
const FM = `=IF(A1>0,"ملخص",'نعم'!A1)`
const FM_MARKED = `=IF(A1>0,"⁨ملخص⁩",'⁨نعم⁩'!A1)`
const editorBox = (p, id = EDITOR_ID) => p.evaluate((id) => window.__renderManager.getRenderUnitById(id).engine.getCanvasElement().getBoundingClientRect().toJSON(), id)
const startFormula = async (p, a1 = 'D7', text = FM) => {
  await openEditor(p, a1)
  await typeFormula(p, text)
  await p.waitForTimeout(500)
}
const unitX = (units, text) => units.find((u) => u.text === text)

await check('formula mode: applied with the text layer (lexer contract checked, no problems)', async () => {
  const s = await fm.evaluate(() => window.__rtlStatus)
  const st = await fm.evaluate(() => window.__rtlText.state())
  return { ok: s?.text?.applied === true && s.text.formula?.applied === true && st.formulaMode === true, text: s?.text }
})

await sheet(fm, 'extras')
await check('formula mode (cell editor and formula bar): «=IF(A1>0,"ملخص",\'نعم\'!A1)» reads left to right, token by token, the Arabic tokens in their typed places', async () => {
  await startFormula(fm)
  const shown = await docText(fm)
  const ref = await browserFormulaUnits(fm, FM_MARKED)
  const editor = await paintedUnits(fm, EDITOR_ID)
  const bar = await paintedUnits(fm, FORMULA_BAR_ID)
  await fm.screenshot({ path: `${OUT}formula-ltr${TAG}.png`, clip: { x: 0, y: 70, width: 1280, height: 300 } })
  await cancelEdit(fm)
  await clickAway(fm)
  const order = (u) => unitX(u, 'ملخص') && unitX(u, 'نعم') && unitX(u, 'ملخص').x1 < unitX(u, 'نعم').x0
  // Before formula mode (plain UAX #9 in an LTR paragraph) the two swapped: «نعم» painted left of «ملخص».
  const ok = shown === FM && sameUnits(editor, ref) && sameUnits(bar, ref) && order(editor) && order(bar)
  return { ok, shown, browser: ref.map((u) => u.text).join(' '), editor: editor.map((u) => u.text).join(' '), formulaBar: bar.map((u) => u.text).join(' ') }
})

await check('formula mode: the formula starts at the left edge of the cell editor and of the formula bar', async () => {
  await startFormula(fm)
  const editor = await paintedUnits(fm, EDITOR_ID)
  const bar = await paintedUnits(fm, FORMULA_BAR_ID)
  const eb = await editorBox(fm)
  const bb = await editorBox(fm, FORMULA_BAR_ID)
  await cancelEdit(fm)
  await clickAway(fm)
  const eLeft = Math.min(...editor.map((u) => u.x0))
  const bLeft = Math.min(...bar.map((u) => u.x0))
  const ok = editor[0]?.text === '=' && bar[0]?.text === '=' && eLeft - eb.left >= 0 && eLeft - eb.left <= 6 && bLeft - bb.left >= 0 && bLeft - bb.left <= 6
  return { ok, editor: { textLeft: eLeft, canvasLeft: eb.left }, bar: { textLeft: bLeft, canvasLeft: bb.left } }
})

await check('formula mode: stable while typing, character by character: no completed token moves, an unterminated string reads in place', async () => {
  await openEditor(fm, 'D7')
  const steps = []
  for (const ch of Array.from(FM)) {
    if (/[؀-ۿ]/.test(ch)) await fm.keyboard.insertText(ch)
    else await fm.keyboard.type(ch)
    await fm.waitForTimeout(120)
    const units = await paintedUnits(fm, EDITOR_ID)
    const left = (await editorBox(fm)).left
    steps.push({ text: await docText(fm), arabicLast: /[؀-ۿ]/.test(ch), units: units.map((u) => ({ text: u.text, x: u.x0 - left })) })
  }
  await cancelEdit(fm)
  await clickAway(fm)
  const final = steps[steps.length - 1].units
  const moved = []
  for (const step of steps) {
    // The open Arabic token (the last unit while a letter is typed) is still being shaped; everything before it is final.
    const done = step.arabicLast ? step.units.slice(0, -1) : step.units
    done.forEach((u, i) => {
      if (u.text !== final[i]?.text || !near(u.x, final[i].x, 1)) moved.push({ at: step.text, unit: u, final: final[i] })
    })
  }
  // «="ملخ» (unterminated): the run sits right after its opening quote.
  const open = steps.find((s) => s.text === '=IF(A1>0,"ملخ')
  const quote = open?.units.findIndex((u) => u.text === '"')
  const inPlace = open && quote >= 0 && open.units[quote + 1]?.text === 'ملخ' && open.units.length === quote + 2
  return { ok: steps.length === Array.from(FM).length && steps[steps.length - 1].text === FM && moved.length === 0 && inPlace, moved: moved.slice(0, 5), unterminated: open?.units.map((u) => u.text).join(' ') }
})

await check('formula mode: a click inside an Arabic token places the caret at the clicked letter; Backspace and Delete remove the letter beside it', async () => {
  const got = {}
  // Visual right of «ملخص» is its logical start (offset 10), its visual left its end (14).
  for (const [what, side, key, expected] of [
    ['start of «ملخص» + Delete', 'right', 'Delete', FM.slice(0, 10) + FM.slice(11)],
    ['end of «ملخص» + Backspace', 'left', 'Backspace', FM.slice(0, 13) + FM.slice(14)],
    ['end of «نعم» + Backspace', 'left-2', 'Backspace', FM.slice(0, 19) + FM.slice(20)],
  ]) {
    await startFormula(fm)
    const units = await paintedUnits(fm, EDITOR_ID)
    const word = side === 'left-2' ? unitX(units, 'نعم') : unitX(units, 'ملخص')
    const x = side === 'right' ? word.x1 - 2 : word.x0 + 2
    const edge = side === 'right' ? word.x1 : word.x0
    await fm.mouse.click(x, (await editorBox(fm)).top + 12)
    await fm.waitForTimeout(150)
    const caret = await caretX(fm)
    await fm.keyboard.press(key)
    await fm.waitForTimeout(150)
    const text = await docText(fm)
    await cancelEdit(fm)
    await clickAway(fm)
    got[what] = { ok: text === expected && caret !== null && near(caret, edge, 1.5), text, expected, caret, edge }
  }
  return { ok: Object.values(got).every((g) => g.ok), got }
})

// Univer 1.4.0, stock grid included: an arrow key pressed with the caret right
// after `(`, `,`, an operator, or at a reference picks a cell into the formula
// (Excel's "point" mode; seen 2026-11-11 in the unmirrored page without the
// layer too). So the caret is driven across the two Arabic tokens and their
// quotes only, from a click: that is where formula mode changes the order.
await check('formula mode: ArrowLeft and ArrowRight move the caret strictly visually across each Arabic token and its quotes', async () => {
  const FM2 = `=IF(A1>0,"ملخص","نعم")`
  const got = {}
  // [what, click x from the painted units, presses, expected final x going left]
  for (const [what, from, presses, to] of [
    ['«نعم» from the end', (u) => u[16].x1 + 3, 5, (u) => u[14].x0],
    ['«ملخص» from after its closing quote', (u) => u[11].x1 - 1, 5, (u) => u[10].x0],
  ]) {
    await startFormula(fm, 'D7', FM2)
    const units = await paintedUnits(fm, EDITOR_ID)
    if (units.length !== 17 || units[10].text !== 'ملخص' || units[14].text !== 'نعم') {
      got[what] = { ok: false, units: units.map((u) => u.text).join(' ') }
      await cancelEdit(fm)
      await clickAway(fm)
      continue
    }
    await fm.mouse.click(from(units), (await editorBox(fm)).top + 12)
    await fm.waitForTimeout(150)
    const xs = [await caretX(fm)]
    for (let i = 0; i < presses; i++) {
      await fm.keyboard.press('ArrowLeft')
      xs.push(await caretX(fm))
    }
    const back = [xs[xs.length - 1]]
    for (let i = 0; i < presses; i++) {
      await fm.keyboard.press('ArrowRight')
      back.push(await caretX(fm))
    }
    const text = await docText(fm)
    const cell = await active(fm)
    await cancelEdit(fm)
    await clickAway(fm)
    const strict = (a, sign) => a.every((x, i) => i === 0 || (x - a[i - 1]) * sign > 0.5)
    const ok = text === FM2 && cell === 'D7' && strict(xs, -1) && strict(back, 1) && near(xs[xs.length - 1], to(units), 1.5) && near(back[back.length - 1], xs[0], 0.5)
    got[what] = { ok, text, cell, xs: xs.map(Math.round), back: back.map(Math.round), expectedLeft: Math.round(to(units)) }
  }
  return { ok: Object.values(got).every((g) => g.ok), got }
})

await check('formula mode: plain Arabic text in the same editor keeps its right-to-left layout at the start side', async () => {
  await openEditor(fm, 'D1')
  const shown = await docText(fm)
  const ref = await browserUnits(fm, shown)
  const editor = await paintedUnits(fm, EDITOR_ID)
  const box = await cellBox(fm, 'D1')
  await cancelEdit(fm)
  const right = Math.max(...editor.map((u) => u.x1))
  return { ok: shown === 'نص عادي' && sameUnits(editor, ref) && near(right, box.right - 2, 4), shown, textRight: right, cellRight: box.right }
})
await fm.close()

await check('safety net: a changed formula lexer leaves formulas in plain bidi; the text layer and the grid stay', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&simulateBreak=formula-layout', {}, { record: true })
  const status = await p.evaluate(() => window.__rtlStatus)
  await sheet(p, 'extras')
  await startFormula(p)
  const shown = await docText(p)
  const editor = await paintedUnits(p, EDITOR_ID)
  const before = await browserUnits(p, shown, 'ltr') // plain UAX #9: today's behaviour before formula mode
  await p.screenshot({ path: `${OUT}formula-ltr-fallback${TAG}.png`, clip: { x: 0, y: 70, width: 1280, height: 300 } })
  await cancelEdit(p)
  await p.close()
  const ok = status?.mirrored === true && status.text?.applied === true && status.text.formula?.applied === false && /sequenceNodesBuilder/.test(status.text.formula?.reason ?? '') &&
    shown === FM && sameUnits(editor, before)
  return { ok, status: status?.text, editor: editor.map((u) => u.text).join(' ') }
})

await check('safety net: a changed formula-colour hook leaves Univer\'s own colouring, with Excel\'s palette', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&simulateBreak=formula-contract')
  const status = await p.evaluate(() => window.__formulaColours)
  await sheet(p, 'extras')
  await openEditor(p, 'D7')
  await p.keyboard.type('=SUM(A4)')
  await p.waitForTimeout(600)
  const runs = await p.evaluate((id) => (window.__renderManager.getRenderUnitById(id).mainComponent.getSkeleton().getViewModel().getDataModel().getBody().textRuns ?? []).map((r) => [r.st, r.ed, r.ts?.cl?.rgb?.toLowerCase() ?? null]), EDITOR_ID)
  await p.close()
  const sumColour = runs.find(([st]) => st === 1)?.[2] ?? null
  const refColour = runs.find(([st]) => st === 5)?.[2] ?? null
  const ok = status?.applied === false && /resetSelectionsByModelData/.test(status.reason ?? '') && status.themed === true && sumColour !== status.palette.function && refColour === status.palette.references[0]
  return { ok, status: { applied: status?.applied, reason: status?.reason }, runs }
})

// --- safety nets --------------------------------------------------------------

await check('safety net: a changed Univer hook leaves the stock grid untouched and working', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&simulateBreak=contract')
  const status = await p.evaluate(() => window.__rtlStatus)
  const flipped = await p.evaluate(() => Boolean(document.querySelector('.naf-rtl-grid')))
  const { x, y } = centre(await cellBox(p, 'B3', false)) // unmirrored geometry
  await p.mouse.click(x, y)
  await p.waitForTimeout(150)
  const got = await active(p)
  await p.close()
  const ok = status?.mirrored === false && /_drawGlyphGroup/.test(status.reason ?? '') && !flipped && got === 'B3'
  return { ok, status, flipped, clicked: got }
})

await check('enabling on a sheet already painted and idle repaints it and stays mirrored', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&enableAfterIdle=1')
  await p.waitForTimeout(4000) // past the 3 s heartbeat window
  const status = await p.evaluate(() => window.__rtlStatus)
  // The repaint must have gone through the hooks: same ink as an RTL page enabled at once.
  const ink = await inkBox(p, clipOf(await cellBox(p, 'A2'), 3))
  const ref = await inkBox(page, clipOf(await cellBox(page, 'A2'), 3))
  await p.close()
  const sameInk = ink && ref && near(ink.right - ink.left, ref.right - ref.left, 3) && ink.count / ref.count > 0.85 && ink.count / ref.count < 1.15
  return { ok: status?.mirrored === true && Boolean(sameInk), status, ink, ref }
})

await check('enabled right after createWorkbook (as apps/web does): document text applied, arrows visual', async () => {
  // Univer's cursor controller does not exist yet at that point: the text layer must wait for it.
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&enableEarly=1')
  const status = await p.evaluate(() => window.__rtlStatus)
  await sheet(p, 'bidi')
  await openEditor(p, 'A8')
  await p.keyboard.press(RTL_START)
  for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft')
  const at = await markerOffset(p)
  await p.close()
  return { ok: status?.mirrored === true && status.text?.applied === true && at === 3, status, lineStart: RTL_START, offsetAfterLineStartAndThreeArrowLeft: at }
})

await check('control (not the layer): line start/end and arrow keys in the editor of the unmirrored grid', async () => {
  // Stock Univer, no mirror, no text layer, a Latin cell (per-letter glyphs in
  // stock Univer too): do the keys reach Univer's editor in this browser, and
  // which key map is it using? Univer binds line start/end to Home/End, except
  // with Mac bindings, where they are Cmd+Left/Right and Home/End do nothing.
  // The check passes only if stock Univer behaves exactly so.
  const p = await openPage('?dir=rtl&selftest=0')
  const keys = await p.evaluate(() => window.__univerKeys())
  await sheet(p, 'bidi')
  const text = BIDI_ROWS[6]
  const run = async (presses) => {
    const { x, y } = centre(await cellBox(p, 'A6', false))
    await p.mouse.dblclick(x, y)
    await p.waitForTimeout(350)
    for (const k of presses) await p.keyboard.press(k)
    const at = await markerOffset(p)
    await cancelEdit(p)
    return at
  }
  const got = {
    lineStart: await run([LINE_START]),
    lineEnd: await run([LINE_END]),
    homeAfterLineEnd: await run([LINE_END, 'Home']),
    endAfterLineStart: await run([LINE_START, 'End']),
    lineStartRight3: await run([LINE_START, 'ArrowRight', 'ArrowRight', 'ArrowRight']),
    lineEndLeft2: await run([LINE_END, 'ArrowLeft', 'ArrowLeft']),
  }
  const { x, y } = centre(await cellBox(p, 'A6', false))
  await p.mouse.dblclick(x, y)
  await p.waitForTimeout(350)
  await p.keyboard.press(LINE_START)
  for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowRight')
  await p.keyboard.type('Y')
  const afterShift = await docText(p)
  await cancelEdit(p)
  await p.close()
  const expected = {
    lineStart: 0,
    lineEnd: text.length,
    // Home/End: bound only without Mac bindings.
    homeAfterLineEnd: keys.mac ? text.length : 0,
    endAfterLineStart: keys.mac ? 0 : text.length,
    lineStartRight3: 3,
    lineEndLeft2: text.length - 2,
  }
  const ok = keys.mac === KEYS.mac && Object.entries(expected).every(([k, v]) => got[k] === v) && afterShift === 'Y' + text.slice(3)
  return { ok, keys, lineKeys: [LINE_START, LINE_END], got, expected, afterShift }
})

await check('control (not the layer): typing Arabic into the editor of the unmirrored grid', async () => {
  // Same keystrokes as the mirrored editing check, on a grid without the layer.
  // If this fails too in a browser, the failure there is not caused by the mirror.
  const p = await openPage('?dir=rtl&selftest=0')
  const box = await cellBox(p, 'H5', false)
  await p.mouse.dblclick(box.left + box.width / 2, box.top + box.height / 2)
  await p.waitForTimeout(300)
  const typed = 'تجربة RTL 123'
  await p.keyboard.type(typed)
  await p.keyboard.press('Enter')
  await p.waitForTimeout(300)
  const stored = await value('H5', p)
  await p.close()
  return { ok: stored === typed, stored }
})

await check('safety net: text bypassing the flip-back path withdraws the mirror', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&simulateBreak=heartbeat')
  await p.waitForTimeout(4000)
  const status = await p.evaluate(() => window.__rtlStatus)
  const flipped = await p.evaluate(() => Boolean(document.querySelector('.naf-rtl-grid')))
  await p.close()
  const ok = status?.mirrored === false && /heartbeat/.test(status.reason ?? '') && !flipped
  return { ok, status, flipped }
})

await check('safety net: a changed text hook leaves the editor stock and the grid mirrored', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&simulateBreak=text-contract', {}, { record: true })
  const status = await p.evaluate(() => window.__rtlStatus)
  await sheet(p, 'bidi')
  await openEditor(p, 'A8')
  // Stock Univer: the words in logical order from the left.
  const painted = (await paintedUnits(p, EDITOR_ID)).map((u) => u.text)
  await p.close()
  const ok = status?.mirrored === true && status.text?.applied === false && /getRangePointData/.test(status.text?.reason ?? '') && /getRangePointData/.test(status.reason ?? '') &&
    JSON.stringify(painted) === JSON.stringify(['إعداد', 'خطة', 'الاتصال'])
  return { ok, status, painted }
})

await check('safety net: document text painted around the hook withdraws the text layer, not the grid', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&simulateBreak=text-heartbeat', {}, { record: true })
  await sheet(p, 'bidi')
  await openEditor(p, 'A8')
  await p.keyboard.press(RTL_END)
  await p.keyboard.type('ب')
  await p.waitForTimeout(600)
  const status = await p.evaluate(() => window.__rtlStatus)
  const flipped = await p.evaluate(() => Boolean(document.querySelector('.naf-rtl-grid')))
  await p.close()
  const ok = status?.mirrored === true && flipped && status.text?.applied === false && /heartbeat/.test(status.text?.reason ?? '')
  return { ok, status, flipped }
})

// --- imported dropdowns (apps/api OPEN_QUESTIONS.md "Google import" G32) ---------
// Sheet «قوائم» of the harness: rules as the import writes them (chip colours
// by position, a multiple selection), Arabic items.

const hexKind = (hex, tol = 10) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `Math.abs(r - ${r}) <= ${tol} && Math.abs(g - ${g}) <= ${tol} && Math.abs(b - ${b}) <= ${tol}`
}
Object.assign(KINDS, { chipBlue: hexKind('#bfe1f6'), chipGreen: hexKind('#d4edbc'), chipRed: hexKind('#ffcfc9') })
// Mean per-channel difference of two same-size regions as they are, and with the second flipped horizontally.
const orientationDiff = async (pa, clipA, pb, clipB) => {
  const a = (await pa.screenshot({ clip: clipA })).toString('base64')
  const b = (await pb.screenshot({ clip: clipB })).toString('base64')
  return lab.evaluate(async ({ a, b }) => {
    const load = async (s) => { const i = new Image(); i.src = `data:image/png;base64,${s}`; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return { d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height } }
    const [A, B] = [await load(a), await load(b)]
    let asIs = 0
    let flipped = 0
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) for (let k = 0; k < 3; k++) {
      const v = A.d[(y * A.w + x) * 4 + k]
      asIs += Math.abs(v - B.d[(y * B.w + x) * 4 + k])
      flipped += Math.abs(v - B.d[(y * B.w + (B.w - 1 - x)) * 4 + k])
    }
    const n = A.w * A.h * 3
    return { asIs: asIs / n, flipped: flipped / n }
  }, { a, b })
}
const boxOf = (ink) => ink && { left: ink.left, right: ink.right, top: ink.top, bottom: ink.bottom, width: ink.right - ink.left + 1, height: ink.bottom - ink.top + 1 }
const dd = await openPage('?dir=rtl&grid=mirror&selftest=0')
await sheet(dd, 'lists')
const ddPlain = await openPage('?dir=rtl&selftest=0')
await sheet(ddPlain, 'lists')

await check('dropdown chips: each at its cell start, in its colour, Arabic text as in the unmirrored grid', async () => {
  const out = {}
  let ok = true
  for (const [a1, kind] of [['A2', 'chipBlue'], ['A3', 'chipGreen'], ['A4', 'chipRed']]) {
    const mc = await cellBox(dd, a1)
    const pc = await cellBox(ddPlain, a1, false)
    const mChip = boxOf(await inkBox(dd, clipOf(mc, 1), kind))
    const pChip = boxOf(await inkBox(ddPlain, clipOf(pc, 1), kind))
    if (!mChip || !pChip) {
      out[a1] = { mChip, pChip }
      ok = false
      continue
    }
    // Mirrored, the chip keeps its distance from the cell's start: the right edge on screen.
    const placed = near(mc.right - mChip.right, pChip.left - pc.left, 2) && near(mChip.width, pChip.width, 2)
    // The text only: the arrow sits in the chip's last 22 px, its end (visual left mirrored, right stock).
    const ARROW = 22
    const mText = await inkBox(dd, clipOf({ ...mChip, left: mChip.left + ARROW, width: mChip.width - ARROW }, 1), 'dark')
    const pText = await inkBox(ddPlain, clipOf({ ...pChip, width: pChip.width - ARROW }, 1), 'dark')
    // Same glyphs, not mirrored: same extent and ink, and the same picture once aligned on the ink.
    const same = Boolean(mText && pText) && near(mText.right - mText.left, pText.right - pText.left, 2) && mText.count / pText.count > 0.85 && mText.count / pText.count < 1.15
    const w = Math.round(Math.min(mText?.right - mText?.left, pText?.right - pText?.left)) + 1
    const h = Math.round(Math.min(mText?.bottom - mText?.top, pText?.bottom - pText?.top)) + 1
    // Not mirrored: the text matches the stock text clearly better as it is than flipped
    // (pixel-identical is too strict: glyphs rasterised under a flipped transform antialias differently).
    // The two ink boxes may differ by a pixel: the best alignment within ±1 px, for both comparisons.
    let orient = null
    if (same) {
      for (const dx of [-1, 0, 1]) {
        const o = await orientationDiff(dd, { x: Math.round(mText.left) + dx, y: Math.round(mText.top), width: w, height: h }, ddPlain, { x: Math.round(pText.left), y: Math.round(pText.top), width: w, height: h })
        orient = orient === null ? o : { asIs: Math.min(orient.asIs, o.asIs), flipped: Math.min(orient.flipped, o.flipped) }
      }
    }
    out[a1] = { placed, same, orient, mText, pText }
    ok = ok && placed && same && orient !== null && orient.asIs < orient.flipped * 0.7
  }
  await dd.screenshot({ path: `${OUT}mirror-dropdown-chips${TAG}.png` })
  return { ok, cells: out }
})

await check('multiple-selection chips read from the cell start: the first item at the visual right', async () => {
  const mc = await cellBox(dd, 'B2')
  const pc = await cellBox(ddPlain, 'B2', false)
  const [mFirst, mSecond] = [await inkBox(dd, clipOf(mc, 1), 'chipBlue'), await inkBox(dd, clipOf(mc, 1), 'chipRed')]
  const [pFirst, pSecond] = [await inkBox(ddPlain, clipOf(pc, 1), 'chipBlue'), await inkBox(ddPlain, clipOf(pc, 1), 'chipRed')]
  // فهد (blue) then سارة (red): left to right in the unmirrored grid, right to left mirrored.
  const ok = Boolean(mFirst && mSecond && pFirst && pSecond) && mFirst.meanX > mSecond.meanX && pFirst.meanX < pSecond.meanX
  return { ok, mirrored: { first: mFirst?.meanX, second: mSecond?.meanX }, plain: { first: pFirst?.meanX, second: pSecond?.meanX } }
})

await check('a dropdown in the lower half opens below its cell when it fits there, as stock "vertical" does', async () => {
  // Univer resolves "vertical-right" (the mirrored "vertical") by the roomier side; the
  // layer asks for "bottom-right" when the list fits below (rtl-grid.ts mirroredVerticalDirection).
  const vh = dd.viewportSize().height
  let target = null
  for (let r = 2; r <= 30 && !target; r++) {
    const b = await cellBox(dd, `A${r}`)
    if (b.top >= vh - b.bottom && vh - b.bottom >= 320) target = { a1: `A${r}`, box: b }
  }
  if (!target) return { ok: false, reason: 'no row in the lower half with room below' }
  const { box } = target
  await dd.mouse.click(box.left + box.width * 0.6, box.top + box.height / 2)
  await dd.waitForTimeout(600)
  const panel = await domBoxWithText(['قيد التنفيذ', 'منجز', 'متأخر', 'تحرير'], dd)
  await dd.screenshot({ path: `${OUT}mirror-dropdown-lower${TAG}.png` })
  await clickAway(dd)
  const ok = Boolean(panel) && near(panel.top, box.bottom, 12) && near(panel.right, box.right, 6)
  return { ok, cell: target, panel }
})

await dd.close()
await ddPlain.close()

await page.screenshot({ path: `${OUT}mirror-final${TAG}.png` })
await browser.close()

// Known upstream defects, matched strictly against evidence: see
// test/known-upstream.mjs (its rules have unit tests of their own). In short:
// in Firefox, Playwright's synthetic Arabic typing reaches Univer 1.4.0's editor
// duplicated and reversed, in the UNMIRRORED grid as well. Only when every
// condition of a rule holds is a check recorded as `knownUpstream` instead of
// failing the run; a fix upstream shows up as the checks passing.
applyKnownUpstream(checks, BROWSER)

const summary = { browser: BROWSER, passed: checks.filter((c) => c.ok && !c.knownUpstream).length, knownUpstream: checks.filter((c) => c.knownUpstream).length, total: checks.length, pageErrors, checks }
writeFileSync(`${OUT}rtl-interactions${TAG}.json`, JSON.stringify(summary, null, 2))
for (const c of checks) console.log(`${c.knownUpstream ? 'XFAIL' : c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.knownUpstream ? `  (${c.knownUpstream}; stored ${JSON.stringify(c.detail.stored)})` : c.ok ? '' : '  ' + JSON.stringify(c.detail)}`)
console.log(`${BROWSER}: ${summary.passed}/${summary.total} passed, ${summary.knownUpstream} known upstream; page errors: ${pageErrors.length}`)
process.exitCode = summary.passed + summary.knownUpstream === summary.total && pageErrors.length === 0 ? 0 : 1
