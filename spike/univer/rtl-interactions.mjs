// Interaction checks for the mirrored (RTL) grid — src/rtl-grid.ts.
// Each check drives the page the way a user would (real mouse and keyboard at
// the cell's on-screen position) and then asserts against Univer's own state.
// Run while `npm run preview` is serving on :4173.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

const { chromium } = createRequire(import.meta.url)('playwright')
const BASE = process.env.SPIKE_URL ?? 'http://localhost:4173/'
const OUT = new URL('./results/', import.meta.url).pathname

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
await page.goto(BASE + '?dir=rtl&grid=mirror')
await page.waitForFunction(() => document.title === 'SPIKE-READY', null, { timeout: 60000 })
await page.waitForTimeout(1000)

// On-screen rectangle of a cell: Univer reports canvas coordinates of the
// unmirrored grid; the grid is mirrored across the canvas's vertical axis.
const cellBox = (a1) => page.evaluate((a1) => {
  const ws = window.univerAPI.getActiveWorkbook().getActiveSheet()
  const r = ws.getRange(a1).getCellRect()
  const c = document.querySelector('canvas[id^=univer-sheet-main-canvas]').getBoundingClientRect()
  const left = c.left + c.width - (r.left + r.width)
  return { left, right: left + r.width, top: c.top + r.top, bottom: c.top + r.top + r.height, width: r.width, height: r.height }
}, a1)
const centre = (b) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 })
const active = () => page.evaluate(() => window.univerAPI.getActiveWorkbook().getActiveRange()?.getA1Notation())
const value = (a1) => page.evaluate((a1) => window.univerAPI.getActiveWorkbook().getActiveSheet().getRange(a1).getValue(), a1)
const colWidth = (i) => page.evaluate((i) => window.univerAPI.getActiveWorkbook().getActiveSheet().getColumnWidth(i), i)
// Smallest visible DOM element whose text contains every given string.
const domBoxWithText = (texts) => page.evaluate((texts) => {
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
const near = (a, b, tol) => Math.abs(a - b) <= tol

const checks = []
const check = async (name, fn) => {
  try {
    const detail = await fn()
    checks.push({ name, ok: detail.ok, detail })
  } catch (e) {
    checks.push({ name, ok: false, detail: { error: String(e).slice(0, 300) } })
  }
}

await check('click selects the cell under the pointer', async () => {
  const got = []
  for (const a1 of ['B3', 'G4', 'A6']) {
    const { x, y } = centre(await cellBox(a1))
    await page.mouse.click(x, y)
    await page.waitForTimeout(150)
    got.push(await active())
  }
  return { ok: got.join() === 'B3,G4,A6', got }
})

await check('ArrowLeft moves to the next column (visually left), ArrowRight back', async () => {
  const { x, y } = centre(await cellBox('B3'))
  await page.mouse.click(x, y)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(100)
  const afterLeft = await active()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(100)
  const afterRight = await active()
  return { ok: afterLeft === 'C3' && afterRight === 'A3', afterLeft, afterRight }
})

await check('Shift+ArrowLeft extends the selection leftwards on screen', async () => {
  const { x, y } = centre(await cellBox('B3'))
  await page.mouse.click(x, y)
  await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForTimeout(100)
  const got = await active()
  return { ok: got === 'B3:C3', got }
})

await check('Tab moves to the next column', async () => {
  const { x, y } = centre(await cellBox('A3'))
  await page.mouse.click(x, y)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(100)
  const got = await active()
  return { ok: got === 'B3', got }
})

await check('drag selects the range between the two cells', async () => {
  const from = centre(await cellBox('B3'))
  const to = centre(await cellBox('C5'))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const got = await active()
  return { ok: got === 'B3:C5', got }
})

await check('double-click opens the editor over the cell; typing lands in that cell', async () => {
  const box = await cellBox('H5')
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
  await page.screenshot({ path: OUT + 'mirror-editing.png' })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  const stored = await value('H5')
  // Text starts at the cell's right edge in RTL, and the editor may grow leftwards.
  const editorOnCell = editor && near(editor.right, box.right, 6) && near(editor.top, box.top, 6)
  return { ok: stored === typed && Boolean(editorOnCell), stored, editor, cell: box }
})

await check('column resize: dragging the C|D border leftwards widens column C', async () => {
  // Not A|B: column A is frozen and that border is the freeze handle (same in the unmirrored grid).
  const c = await cellBox('C1')
  const before = await colWidth(2)
  const headerY = c.top - 10 // column header row sits above row 1
  const border = c.left // C's left edge on screen is the C|D border
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

await check('data-validation dropdown opens under its cell', async () => {
  const box = await cellBox('B4')
  // The dropdown arrow is drawn at the cell's end — the left edge on screen.
  await page.mouse.click(box.left + 8, box.top + box.height / 2)
  await page.waitForTimeout(500)
  const panel = await domBoxWithText(['فهد', 'نورة', 'تحرير']) // options + the panel's footer
  await page.screenshot({ path: OUT + 'mirror-dropdown.png' })
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 700) // click away so nothing stays open over the grid
  await page.waitForTimeout(300)
  const ok = Boolean(panel) && panel.left < box.right && panel.right > box.left && near(panel.top, box.bottom, 12)
  return { ok, panel, cell: box }
})

await check('filter panel opens beside its column, level with the header', async () => {
  // Univer opens this panel beside the column, not under it (unmirrored grid: to the column's
  // right). Mirrored, it must sit flush against the column and start at the header row.
  const box = await cellBox('E1')
  await page.mouse.click(box.left + 9, box.top + box.height / 2) // filter button: header cell's end
  await page.waitForTimeout(600)
  const panel = await domBoxWithText(['منجز', 'متأخر', 'إلغاء'])
  await page.screenshot({ path: OUT + 'mirror-filter.png' })
  await page.getByText('إلغاء', { exact: true }).click()
  await page.waitForTimeout(300)
  const flush = panel && (near(panel.left, box.right, 12) || near(panel.right, box.left, 12))
  const ok = Boolean(flush) && near(panel.top, box.top, 12)
  return { ok, panel, cell: box }
})

await check('right-click opens the context menu at the pointer', async () => {
  const { x, y } = centre(await cellBox('C6'))
  await page.mouse.click(x, y, { button: 'right' })
  await page.waitForTimeout(400)
  const menu = await domBoxWithText(['نسخ', 'لصق'])
  await page.screenshot({ path: OUT + 'mirror-context-menu.png' })
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 700)
  await page.waitForTimeout(200)
  const ok = Boolean(menu) && near(menu.top, y, 40) && (near(menu.left, x, 40) || near(menu.right, x, 40))
  return { ok, menu, pointer: { x, y } }
})

await check('hovering a cell with a note shows the note beside that cell', async () => {
  const box = await cellBox('G4')
  await page.mouse.move(box.left + 20, box.top + box.height / 2, { steps: 4 })
  await page.waitForTimeout(800)
  const note = await domBoxWithText(['ملاحظة على الخلية'])
  await page.screenshot({ path: OUT + 'mirror-note.png' })
  await page.mouse.move(5, 700)
  await page.waitForTimeout(300)
  // Beside the cell on either side, level with it.
  const beside = note && (near(note.right, box.left, 16) || near(note.left, box.right, 16))
  const ok = Boolean(beside) && note.top < box.bottom && note.bottom > box.top
  return { ok, note, cell: box }
})

await check('hovering a link shows the link popup at that cell', async () => {
  const box = await cellBox('F3')
  await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2, { steps: 4 })
  await page.waitForTimeout(800)
  const popup = await domBoxWithText(['example.com'])
  await page.screenshot({ path: OUT + 'mirror-link.png' })
  await page.mouse.move(5, 700)
  await page.waitForTimeout(300)
  const ok = Boolean(popup) && popup.left < box.right + 40 && popup.right > box.left - 40 && near(popup.top, box.bottom, 16)
  return { ok, popup, cell: box }
})

await check('horizontal swipe scrolls the way it looks', async () => {
  const { x, y } = centre(await cellBox('C10'))
  await page.mouse.move(x, y)
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

await check('stored values are untouched (no direction marks leak into the model)', async () => {
  const v = await value('A6')
  return { ok: v === 'نشر المقال على LinkedIn', v }
})

await page.screenshot({ path: OUT + 'mirror-final.png' })
await browser.close()

const summary = { passed: checks.filter((c) => c.ok).length, total: checks.length, pageErrors, checks }
writeFileSync(OUT + 'rtl-interactions.json', JSON.stringify(summary, null, 2))
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`)
console.log(`${summary.passed}/${summary.total} passed; page errors: ${pageErrors.length}`)
process.exitCode = summary.passed === summary.total && pageErrors.length === 0 ? 0 : 1
