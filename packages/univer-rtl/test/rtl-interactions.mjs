// Interaction checks for the mirrored (RTL) grid — ../src/rtl-grid.ts.
// Copied from the phase 0 spike (spike/univer/rtl-interactions.mjs); only the
// paths, the port and the results directory differ.
//
// Each check drives the page the way a user would (real mouse, keyboard and
// touch at the cell's on-screen position) and asserts against Univer's own
// state, or against the pixels actually on screen. Where a mirrored result must
// look exactly like the unmirrored grid (rotated text, images), the two are
// compared pixel by pixel.
//
// Run while `npm run harness:preview` is serving on :4175.
//   BROWSER=chromium|firefox|webkit   (default chromium; CI runs all three)
// Writes results/rtl-interactions[-browser].json and results/mirror-*.png.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

const playwright = createRequire(import.meta.url)('playwright')
const BROWSER = process.env.BROWSER ?? 'chromium'
const BASE = process.env.SPIKE_URL ?? 'http://localhost:4175/'
const OUT = new URL('../results/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const TAG = BROWSER === 'chromium' ? '' : `-${BROWSER}`

const browser = await playwright[BROWSER].launch()
const pageErrors = []
const openPage = async (query, contextOptions = {}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, ...contextOptions })
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${query}: ${String(e).slice(0, 300)}`))
  await page.goto(BASE + query)
  await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 90000 })
  await page.waitForTimeout(1000)
  return page
}
const page = await openPage('?dir=rtl&grid=mirror&selftest=0')
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

const plain = await openPage('?dir=rtl&selftest=0')
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

await check('safety net: text bypassing the flip-back path withdraws the mirror', async () => {
  const p = await openPage('?dir=rtl&grid=mirror&selftest=0&simulateBreak=heartbeat')
  await p.waitForTimeout(4000)
  const status = await p.evaluate(() => window.__rtlStatus)
  const flipped = await p.evaluate(() => Boolean(document.querySelector('.naf-rtl-grid')))
  await p.close()
  const ok = status?.mirrored === false && /heartbeat/.test(status.reason ?? '') && !flipped
  return { ok, status, flipped }
})

await page.screenshot({ path: `${OUT}mirror-final${TAG}.png` })
await browser.close()

const summary = { browser: BROWSER, passed: checks.filter((c) => c.ok).length, total: checks.length, pageErrors, checks }
writeFileSync(`${OUT}rtl-interactions${TAG}.json`, JSON.stringify(summary, null, 2))
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`)
console.log(`${BROWSER}: ${summary.passed}/${summary.total} passed; page errors: ${pageErrors.length}`)
process.exitCode = summary.passed === summary.total && pageErrors.length === 0 ? 0 : 1
