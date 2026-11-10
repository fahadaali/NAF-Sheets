// Browser tests of the wave 3 editor features on synced sheets (spec §5.2,
// §8, §9) against the built app, the API mocked by route interception
// (mock-api.ts). Same harness as smoke.test.ts: vite preview on :4174,
// headless Chromium, hermetic.
//
// The synced snapshot is built the way the server builds it: sheet-model's
// `ensureSystemColumns` (test/unit/sync-fixtures.ts). Saved snapshots are read
// back with sheet-model's `readTasks`, which is what the server reads.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readTasks, type WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { ERROR_MESSAGES } from '@naf-sheets/sync-engine'
import type { AssigneeOptionsResponse, BcPerson, ConflictRecord, SaveSnapshotRequest, WorkbookSyncResponse } from '@naf-sheets/shared'
import { BASE_URL } from './global-setup'
import { MockApi, summary } from './mock-api'
import { COL, META, PLAN, SHEET, syncedWorkbook, type RowSpec } from '../unit/sync-fixtures'

const SHOTS = process.env.E2E_SCREENSHOTS ?? fileURLToPath(new URL('./screenshots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })

let browser: Browser
const pageErrors: string[] = []
const blockedRequests: string[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const WB = 'wb-sync'
const ROWS: RowSpec[] = [
  { title: 'خطة الاتصال', cells: { [COL.assignees]: { v: 'فهد العتيبي' } } },
  { title: 'تصميم الهوية', level: 1, cells: { [COL.starts]: { v: '2026-11-12' }, [COL.notes]: { v: 'محلية' } } },
  { title: 'كتابة النصوص', level: 1, cells: { [COL.status]: { v: 1, t: 2 } } },
  { title: 'نشر المقال', cells: { [COL.due]: { v: '2026-11-20' } } },
  { title: 'حملة LinkedIn' },
  { title: 'مهمة حُذفت' },
]
// uids u-1 … u-6 on rows 2 … 7 (0-based 1 … 6).

function snapshot(rows: RowSpec[] = ROWS): WorkbookSnapshot {
  const workbook = syncedWorkbook(rows)
  const sheet = workbook.sheets[SHEET] as unknown as Record<string, unknown>
  sheet.name = 'المهام'
  sheet.rightToLeft = 1
  sheet.defaultStyle = { ff: 'Thmanyah Sans' }
  return { ...workbook, id: WB, name: 'خطة متزامنة' }
}

const person = (id: number, name: string, email: string | null = null): BcPerson => ({ id, name, email, avatarUrl: null, personableType: 'User', client: false })
const OPTIONS = (): AssigneeOptionsResponse => ({
  projectPeople: [person(1, 'فهد العتيبي', 'fahad@example.com'), person(2, 'سارة القحطاني', 'sara@example.com')],
  accountPeople: [person(3, 'نورة السبيعي')],
  externals: [{ id: 'ext-1', name: 'وكالة المدى', organization: 'المدى للتصميم', email: null, phone: null }],
  refreshedAt: '2026-11-10T09:00:00Z',
})

const task = (uid: string, over: Partial<WorkbookSyncResponse['tasks'][number]> = {}): WorkbookSyncResponse['tasks'][number] => ({
  uid,
  sheetId: META.id,
  state: 'synced',
  message: null,
  remoteStatus: 'active',
  bcUrl: `https://3.basecamp.com/5000001/buckets/4021/todos/${uid}`,
  assignMode: 'manual',
  ...over,
})

const ERROR_TEXT = 'لم تُرسل المهمة إلى Basecamp: رُفض الطلب لأن التاريخ غير صالح. صحّح تاريخ الاستحقاق ثم احفظ.'
const NOTICE_TEXT = 'حساب Basecamp المرتبط غير نشط، فأُوقفت المزامنة مؤقتاً. راجع مسؤول الحساب في Basecamp.'

function syncInfo(over: Partial<WorkbookSyncResponse> = {}): WorkbookSyncResponse {
  return {
    state: 'error',
    lastSuccessAt: '2026-11-10T09:25:00Z',
    counts: { pending: 1, error: 1, conflict: 1 },
    notice: null,
    tasks: [
      task('u-1', { assignMode: 'auto' }),
      task('u-2', { assignMode: null, state: 'pending' }),
      task('u-3', { assignMode: null }),
      task('u-4', { state: 'error', message: ERROR_TEXT }),
      task('u-5', { state: 'conflict', message: 'عُدّل تاريخ الاستحقاق هنا وفي Basecamp.' }),
      task('u-6', { remoteStatus: 'trashed' }),
    ],
    ...over,
  }
}

const conflict = (over: Partial<ConflictRecord> = {}): ConflictRecord => ({
  id: 'c-1',
  sheetId: META.id,
  uid: 'u-5',
  field: 'title',
  localValue: 'حملة LinkedIn',
  remoteValue: 'حملة لينكدإن',
  winner: 'local',
  localChangedAt: '2026-11-10T09:20:00Z',
  remoteUpdatedAt: '2026-11-10T09:10:00Z',
  createdAt: '2026-11-10T09:21:00Z',
  ...over,
})

function syncedApi(over: { access?: 'owner' | 'editor' | 'viewer'; rows?: RowSpec[] } = {}): MockApi {
  const api = new MockApi()
  api.add(summary({ id: WB, title: 'خطة متزامنة', bcProjectId: 4021, syncState: 'error', access: over.access ?? 'owner' }), snapshot(over.rows), 5, [{ ...META }])
  api.sync[WB] = syncInfo()
  api.conflicts[WB] = [conflict()]
  api.assigneeOptions[WB] = OPTIONS()
  return api
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function openEditor(api: MockApi, viewport = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
  await context.route(
    (url) => !url.href.startsWith(BASE_URL),
    (route) => {
      blockedRequests.push(route.request().url())
      return route.abort()
    },
  )
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`sync: ${String(e).slice(0, 300)}`))
  await api.install(page)
  await page.goto(`${BASE_URL}/workbooks/${WB}`)
  await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
  await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-rtl-mirrored'), { timeout: 15_000 }).toBe('true')
  return { context, page }
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) })

/** Synced sheets have a 64 px row header (theme --row-margin-width); the rest are Univer 1.4.0 defaults. */
const GRID = { rowHeaderWidth: 64, columnHeaderHeight: 20, columnWidth: 88, rowHeight: 24 }

async function canvasBox(page: Page) {
  const box = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!box) throw new Error('sheet canvas not found')
  return box
}

/** On-screen centre of a cell (0-based) on the mirrored grid: column A at the visual right. */
async function cellCentre(page: Page, column: number, row: number) {
  const box = await canvasBox(page)
  return {
    x: box.x + box.width - GRID.rowHeaderWidth - GRID.columnWidth * column - GRID.columnWidth / 2,
    y: box.y + GRID.columnHeaderHeight + GRID.rowHeight * row + GRID.rowHeight / 2,
  }
}

/** On-screen point inside a row's number cell (the row header, at the visual right). */
async function rowHeaderPoint(page: Page, row: number, fromEdge = GRID.rowHeaderWidth / 2) {
  const box = await canvasBox(page)
  return { x: box.x + box.width - fromEdge, y: box.y + GRID.columnHeaderHeight + GRID.rowHeight * row + GRID.rowHeight / 2 }
}

async function clickCell(page: Page, column: number, row: number) {
  const { x, y } = await cellCentre(page, column, row)
  await page.mouse.click(x, y)
  await page.waitForTimeout(150)
}

type Marks = Record<string, { states: Record<string, string>; unsyncedRows: number[]; unsyncedColumns: number[]; conflicts: string[]; deleted: number[] }>
const marks = async (page: Page): Promise<Marks> => JSON.parse((await page.getByTestId('univer-host').getAttribute('data-sync-marks')) ?? '{}') as Marks

async function waitForMarks(page: Page) {
  await expect.poll(async () => Object.keys((await marks(page))[SHEET]?.states ?? {}).length, { timeout: 15_000 }).toBeGreaterThan(0)
}

/** The tasks the server would read from the last saved snapshot (names resolved against the options). */
function savedTasks(api: MockApi) {
  const last = api.puts(WB).at(-1) as SaveSnapshotRequest | undefined
  if (!last) throw new Error('nothing saved')
  const o = OPTIONS()
  const read = readTasks(last.snapshot as WorkbookSnapshot, SHEET, PLAN, { directory: { people: [...o.projectPeople, ...o.accountPeople], externals: o.externals } })
  if (!read.ok) throw new Error(read.error.message)
  return read.value
}

async function waitForSave(api: MockApi, count: number) {
  await expect.poll(() => api.puts(WB).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(count)
}

/** Colours of the pixels of a region of the page as the person sees it (after the CSS mirror). */
async function regionColours(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<string[]> {
  const png = (await page.screenshot({ clip })).toString('base64')
  return page.evaluate(async (data) => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data
    const out = new Set<string>()
    for (let i = 0; i < pixels.length; i += 4) out.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`)
    return [...out]
  }, png)
}

const near = (colours: string[], rgb: [number, number, number], tolerance = 40) =>
  colours.some((c) => {
    const [r, g, b] = c.split(',').map(Number) as [number, number, number]
    return Math.abs(r - rgb[0]) + Math.abs(g - rgb[1]) + Math.abs(b - rgb[2]) <= tolerance
  })

// ---------------------------------------------------------------------------

describe('row sync indicators (spec §5.2)', () => {
  it('each row shows its state in the row margin at the visual right, with a tooltip, the workbook notice as a banner, and polling', async () => {
    const api = syncedApi()
    api.sync[WB] = syncInfo({ notice: NOTICE_TEXT })
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    const m = (await marks(page))[SHEET]!
    expect(m.states).toEqual({ 1: 'synced', 2: 'pending', 3: 'synced', 4: 'error', 5: 'conflict', 6: 'deleted' })
    expect(m.deleted).toEqual([6])
    // Workbook-level notice.
    expect(await page.getByTestId('sync-notice').innerText()).toContain(NOTICE_TEXT)
    // The header badge follows GET …/sync.
    expect(await page.locator('.editor-bar [data-sync-state]').getAttribute('data-sync-state')).toBe('error')
    await shot(page, 'sync-indicators')

    // The icons are drawn in the row numbers, which the mirror puts at the visual right:
    // the error colour (#c5221f) is there on row 5 and nowhere in the leftmost strip.
    const box = await canvasBox(page)
    const row5 = { x: box.x + box.width - GRID.rowHeaderWidth, y: box.y + GRID.columnHeaderHeight + GRID.rowHeight * 4, width: GRID.rowHeaderWidth, height: GRID.rowHeight }
    expect(near(await regionColours(page, row5), [0xc5, 0x22, 0x1f])).toBe(true)
    expect(near(await regionColours(page, { ...row5, x: box.x }), [0xc5, 0x22, 0x1f])).toBe(false)
    const row2 = { ...row5, y: row5.y - 3 * GRID.rowHeight }
    expect(near(await regionColours(page, row2), [0x13, 0x73, 0x33])).toBe(true) // synced green

    // Tooltip on the row number: state, Arabic message, link to Basecamp.
    const p = await rowHeaderPoint(page, 4, 8)
    await page.mouse.move(p.x, p.y)
    const tooltip = page.getByTestId('row-tooltip')
    await tooltip.waitFor()
    expect(await tooltip.getAttribute('data-state')).toBe('error')
    expect(await tooltip.innerText()).toContain(ERROR_TEXT)
    expect(await tooltip.getByTestId('row-bc-link').getAttribute('href')).toBe('https://3.basecamp.com/5000001/buckets/4021/todos/u-4')
    await shot(page, 'sync-row-tooltip')

    // A to-do with subtasks shows «1 من 2» in its tooltip.
    const p1 = await rowHeaderPoint(page, 1, 8)
    await page.mouse.move(p1.x, p1.y)
    await expect.poll(() => tooltip.getAttribute('data-row')).toBe('2')
    expect(await tooltip.getByTestId('row-progress').innerText()).toContain('1 من 2')

    // Polling: again after 10 s.
    const before = api.count('GET', `/api/workbooks/${WB}/sync`)
    await page.waitForTimeout(10_500)
    expect(api.count('GET', `/api/workbooks/${WB}/sync`)).toBeGreaterThan(before)
    await context.close()
  })
})

// ---------------------------------------------------------------------------

/** A synthetic paste on the grid's focused element (headless Chromium has no system clipboard). */
async function paste(page: Page, text: string) {
  await page.evaluate((value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

const uidTitles = (api: MockApi) => savedTasks(api).tasks.map((x) => [x.uid, x.title])

describe('system columns are protected at run time (sheet-model OPEN #1)', () => {
  it('a paste that would reach them is refused with the Arabic reason, and nothing is saved', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    await clickCell(page, COL.attachments, 4) // F5: H, I, J lie two columns further
    await paste(page, 'أ\tب\tج\tد\tهـ')
    const refusal = page.getByTestId('sync-refusal')
    await refusal.waitFor({ timeout: 10_000 })
    expect(await refusal.innerText()).toContain('لم يُلصق المحتوى')
    await shot(page, 'sync-refused-paste')
    await page.waitForTimeout(2500)
    expect(api.puts(WB)).toHaveLength(0)
    // A paste inside the visible columns goes through.
    await clickCell(page, COL.due, 5)
    await paste(page, '2026-12-01')
    await waitForSave(api, 1)
    expect(savedTasks(api).tasks.find((x) => x.uid === 'u-5')?.dueOn).toBe('2026-12-01')
    expect(uidTitles(api)).toEqual(ROWS.map((r, i) => [`u-${i + 1}`, r.title]))
    await context.close()
  })

  it('clearing whole rows clears what shows and keeps every identity', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    const p = await rowHeaderPoint(page, 4)
    await page.mouse.click(p.x, p.y)
    await page.keyboard.press('Delete')
    await waitForSave(api, 1)
    const read = savedTasks(api)
    const row = read.tasks.find((x) => x.uid === 'u-4')
    expect(row?.title).toBe('')
    expect(row?.dueOn).toBeNull()
    expect(read.tasks.map((x) => x.uid)).toEqual(['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6'])
    await context.close()
  })

  it('a sort of one column is widened to whole rows: every uid stays with its title', async () => {
    const rows: RowSpec[] = [
      { title: 'ثالثة', cells: { [COL.due]: { v: '2026-11-25' } } },
      { title: 'أولى', cells: { [COL.due]: { v: '2026-11-20' } } },
      { title: 'ثانية', cells: { [COL.due]: { v: '2026-11-22' } } },
    ]
    const api = syncedApi({ rows })
    api.sync[WB] = syncInfo({ tasks: [task('u-1'), task('u-2'), task('u-3')] })
    api.conflicts[WB] = []
    const { context, page } = await openEditor(api)
    // Select D2:D4 and sort it ascending, keeping the selected range.
    const from = await cellCentre(page, COL.due, 1)
    const to = await cellCentre(page, COL.due, 3)
    await page.mouse.click(from.x, from.y)
    await page.keyboard.down('Shift')
    await page.mouse.click(to.x, to.y)
    await page.keyboard.up('Shift')
    await page.mouse.click(to.x, to.y, { button: 'right' })
    await page.getByText('فرز', { exact: true }).first().hover()
    await page.getByText('تصاعدي', { exact: true }).first().click()
    const keep = page.getByText('الاحتفاظ بنطاق الفرز')
    if (await keep.isVisible({ timeout: 3000 }).catch(() => false)) {
      await keep.click()
      await page.getByRole('button', { name: /تأكيد|موافق|فرز/ }).last().click().catch(() => undefined)
    }
    await waitForSave(api, 1)
    expect(savedTasks(api).tasks.map((x) => [x.uid, x.title, x.dueOn])).toEqual([
      ['u-2', 'أولى', '2026-11-20'],
      ['u-3', 'ثانية', '2026-11-22'],
      ['u-1', 'ثالثة', '2026-11-25'],
    ])
    await context.close()
  })

  it('a title typed in a new row gives it a fresh uid, level and parent in the same save', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    const { x, y } = await cellCentre(page, COL.title, 7)
    await page.mouse.dblclick(x, y)
    await page.waitForTimeout(300)
    await page.keyboard.type('مهمة جديدة')
    await page.keyboard.press('Enter')
    await waitForSave(api, 1)
    const created = savedTasks(api).tasks.find((x) => x.title === 'مهمة جديدة')
    expect(created?.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(created?.level).toBe(0)
    expect(created?.parentUid).toBeNull()
    expect(savedTasks(api).issues).toEqual([])
    await context.close()
  })
})

describe('hierarchy (spec §8)', () => {
  it('Tab and Shift+Tab on the title indent and outdent like sheet-model; a third level is refused', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    // Tab on «نشر المقال» (u-4): last subtask of «خطة الاتصال» (u-1).
    await clickCell(page, COL.title, 4)
    await page.keyboard.press('Tab')
    await waitForSave(api, 1)
    let read = savedTasks(api)
    expect(read.tasks.find((x) => x.uid === 'u-4')).toMatchObject({ level: 1, parentUid: 'u-1', position: 3 })
    expect(read.issues).toEqual([])
    await shot(page, 'sync-indented')

    // Tab again: a third level is refused with the sync engine's message.
    await clickCell(page, COL.title, 4)
    await page.keyboard.press('Tab')
    const refusal = page.getByTestId('sync-refusal')
    await refusal.waitFor()
    expect(await refusal.innerText()).toContain(ERROR_MESSAGES.third_level_not_allowed)

    // Shift+Tab on the middle subtask «تصميم الهوية» (u-2): a to-do after its former siblings.
    const saves = api.puts(WB).length
    await clickCell(page, COL.title, 2)
    await page.keyboard.press('Shift+Tab')
    await waitForSave(api, saves + 1)
    read = savedTasks(api)
    expect(read.tasks.map((x) => [x.uid, x.level, x.parentUid])).toEqual([
      ['u-1', 0, null],
      ['u-3', 1, 'u-1'],
      ['u-4', 1, 'u-1'],
      ['u-2', 0, null],
      ['u-5', 0, null],
      ['u-6', 0, null],
    ])
    expect(read.issues).toEqual([])

    // Tab outside the title column moves between cells as usual.
    const before = api.puts(WB).length
    await clickCell(page, COL.due, 5)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(2500)
    expect(api.puts(WB)).toHaveLength(before)
    expect(await page.getByTestId('univer-host').getAttribute('data-active-sheet')).toBe(SHEET)
    await context.close()
  })

  it('the «تحويل لمهمة فرعية» button indents, collapse hides the subtasks, and moving a to-do takes its subtasks', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    await clickCell(page, COL.title, 5) // «حملة LinkedIn» (u-5)
    await page.getByTestId('indent-button').click()
    await waitForSave(api, 1)
    expect(savedTasks(api).tasks.find((x) => x.uid === 'u-5')).toMatchObject({ level: 1, parentUid: 'u-4' })

    // Collapse «خطة الاتصال»: its two subtasks are hidden rows.
    await clickCell(page, COL.title, 1)
    await expect.poll(() => page.getByTestId('toolbar-progress').innerText()).toContain('1 من 2')
    await page.getByTestId('collapse-button').click()
    await expect.poll(() => page.getByTestId('collapse-button').getAttribute('aria-pressed')).toBe('true')
    await shot(page, 'sync-collapsed')
    const saves = api.puts(WB).length
    await waitForSave(api, saves + 1)
    const hidden = (api.puts(WB).at(-1)?.snapshot as WorkbookSnapshot).sheets[SHEET]?.rowData as Record<number, { hd?: number }>
    expect([hidden[2]?.hd, hidden[3]?.hd]).toEqual([1, 1])
    await page.getByTestId('collapse-button').click()
    await expect.poll(() => page.getByTestId('collapse-button').getAttribute('aria-pressed')).toBe('false')
    await context.close()
  })
})

describe('moving rows (spec §8: a to-do moves with its subtasks)', () => {
  it('dragging a to-do by its row number takes its subtasks along', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    const from = await rowHeaderPoint(page, 1)
    await page.mouse.click(from.x, from.y)
    await page.waitForTimeout(200)
    const to = await rowHeaderPoint(page, 6)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let step = 1; step <= 12; step++) await page.mouse.move(from.x, from.y + ((to.y - from.y + GRID.rowHeight / 2) * step) / 12)
    await page.mouse.up()
    await waitForSave(api, 1)
    // Dropped on the bottom edge of row 7: the whole family lands after it.
    expect(savedTasks(api).tasks.map((x) => [x.uid, x.level, x.parentUid])).toEqual([
      ['u-4', 0, null],
      ['u-5', 0, null],
      ['u-6', 0, null],
      ['u-1', 0, null],
      ['u-2', 1, 'u-1'],
      ['u-3', 1, 'u-1'],
    ])
    expect(savedTasks(api).issues).toEqual([])
    await context.close()
  })
})

describe('formulas are computed when the workbook opens (sheet-model OPEN #16)', () => {
  it('a stale cached value is replaced, and opening alone still saves nothing', async () => {
    const rows: RowSpec[] = [{ title: 'أ', cells: { [COL.level + 2]: { f: '=1+1', v: 5, t: 2 } } }, { title: 'ب' }]
    const api = syncedApi({ rows })
    const { context, page } = await openEditor(api)
    await page.waitForTimeout(4000)
    expect(api.puts(WB)).toHaveLength(0)
    await clickCell(page, COL.due, 2)
    const { x, y } = await cellCentre(page, COL.due, 2)
    await page.mouse.dblclick(x, y)
    await page.waitForTimeout(300)
    await page.keyboard.type('2026-12-05')
    await page.keyboard.press('Enter')
    await waitForSave(api, 1)
    const cell = (api.puts(WB).at(-1)?.snapshot as WorkbookSnapshot).sheets[SHEET]?.cellData?.[1]?.[COL.level + 2]
    expect(cell?.f).toBe('=1+1')
    expect(cell?.v).toBe(2)
    await context.close()
  })
})

describe('deleting synced rows (spec §9.2.7)', () => {
  async function deleteRow(page: Page, row: number) {
    const p = await rowHeaderPoint(page, row)
    await page.mouse.click(p.x, p.y)
    await page.mouse.click(p.x, p.y, { button: 'right' })
    await page.getByText('حذف الصف المحدد').first().click()
  }

  it('a to-do with subtasks: the dialog says the trash and that the subtasks go with it; cancel keeps the rows', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    await deleteRow(page, 1)
    const dialog = page.getByTestId('deletion-dialog')
    await dialog.waitFor()
    const text = await dialog.innerText()
    expect(text).toContain('ستُنقل إلى سلة المهملات في Basecamp ويمكن استرجاعها')
    expect(text).toContain('ومعها مهامها الفرعية (2)')
    expect(text).toContain('خطة الاتصال')
    await shot(page, 'sync-delete-todo')
    await dialog.getByTestId('deletion-cancel').click()
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForTimeout(2500)
    expect(api.puts(WB)).toHaveLength(0)

    await deleteRow(page, 1)
    await dialog.getByTestId('deletion-confirm').click()
    await waitForSave(api, 1)
    const last = api.puts(WB).at(-1)!
    expect([...(last.confirmedDeletions ?? [])].sort()).toEqual(['u-1', 'u-2', 'u-3'])
    expect(savedTasks(api).tasks.map((x) => x.uid)).toEqual(['u-4', 'u-5', 'u-6'])
    await context.close()
  })

  it('a subtask: the dialog says it is deleted for good; undo before the save sends no deletion', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    await deleteRow(page, 3)
    const dialog = page.getByTestId('deletion-dialog')
    await dialog.waitFor()
    expect(await dialog.getByTestId('deletion-subtasks').innerText()).toContain('سيُحذف نهائياً من Basecamp ولا يمكن استرجاعه')
    await shot(page, 'sync-delete-subtask')
    await dialog.getByTestId('deletion-confirm').click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-pending-deletions')).toBe('1')
    // Undo before the save.
    await clickCell(page, COL.due, 10)
    await page.keyboard.press('Control+z')
    await waitForSave(api, 1)
    await page.waitForTimeout(2000)
    for (const put of api.puts(WB)) expect(put.confirmedDeletions ?? []).toEqual([])
    expect(savedTasks(api).tasks.map((x) => x.uid)).toContain('u-3')
    await context.close()
  })

  it('a row deleted in Basecamp: a badge, and the person may remove it (no trash, the row only)', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    expect((await marks(page))[SHEET]?.deleted).toEqual([6])
    const p = await rowHeaderPoint(page, 6, 8)
    await page.mouse.move(p.x, p.y)
    const tooltip = page.getByTestId('row-tooltip')
    await tooltip.waitFor()
    expect(await tooltip.innerText()).toContain('محذوفة في Basecamp')
    await tooltip.getByTestId('row-remove').click()
    const dialog = page.getByTestId('deletion-dialog')
    await dialog.waitFor()
    expect(await dialog.getByTestId('deletion-gone').innerText()).toContain('محذوفة في Basecamp أصلاً')
    expect(await dialog.getByTestId('deletion-todos').count()).toBe(0)
    await dialog.getByTestId('deletion-confirm').click()
    await waitForSave(api, 1)
    expect(api.puts(WB).at(-1)?.confirmedDeletions).toEqual(['u-6'])
    await context.close()
  })
})

describe('assignee cell editor (spec §5.2, §8.2)', () => {
  const directory = () => {
    const o = OPTIONS()
    return { people: [...o.projectPeople, ...o.accountPeople], externals: o.externals }
  }

  async function openAssignees(page: Page, row: number) {
    const { x, y } = await cellCentre(page, COL.assignees, row)
    await page.mouse.dblclick(x, y)
    const editor = page.getByTestId('assignee-editor')
    await editor.waitFor()
    await editor.getByTestId('section-project').waitFor()
    return editor
  }

  it('picks people by section and writes the names readTasks reads back', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    const editor = await openAssignees(page, 4)
    expect(await editor.getByTestId('section-project').innerText()).toContain('أعضاء المشروع')
    expect(await editor.getByTestId('section-account').innerText()).toContain('أعضاء الحساب (خارج المشروع)')
    expect(await editor.getByTestId('section-externals').innerText()).toContain('جهات خارجية')
    await editor.getByLabel('سارة القحطاني').check()
    await editor.getByLabel('وكالة المدى').check()
    await shot(page, 'sync-assignee-editor')
    await editor.getByTestId('assignee-save').click()
    await editor.waitFor({ state: 'hidden' })
    await waitForSave(api, 1)
    const last = api.puts(WB).at(-1)!
    const read = readTasks(last.snapshot as WorkbookSnapshot, SHEET, PLAN, { directory: directory() })
    expect(read.ok && read.value.tasks.find((x) => x.uid === 'u-4')?.assignees).toEqual([
      { kind: 'bc_person', bcPersonId: 2, source: 'manual' },
      { kind: 'external', externalContactId: 'ext-1', source: 'manual', notifyEmail: false },
    ])
    expect(read.ok && read.value.issues).toEqual([])
    await context.close()
  })

  it('externals only need an internal follower; automatic assignees are dotted', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    // u-1 is automatic (assignMode auto): its chips are dotted, with the hint.
    let editor = await openAssignees(page, 1)
    await editor.getByTestId('assignee-auto-hint').waitFor()
    expect(await editor.locator('.chip').first().getAttribute('data-auto')).toBe('true')
    expect(await editor.locator('.chip').first().getAttribute('title')).toBe('تلقائي من المهام الفرعية')
    await editor.getByRole('button', { name: 'إلغاء' }).last().click()
    await editor.waitFor({ state: 'hidden' })

    editor = await openAssignees(page, 5)
    await editor.getByLabel('وكالة المدى').check()
    await editor.getByTestId('assignee-save').click()
    const error = editor.getByTestId('assignee-error')
    await error.waitFor()
    expect(await error.innerText()).toContain(ERROR_MESSAGES.external_requires_follower)
    await shot(page, 'sync-assignee-follower')
    await editor.getByLabel('فهد العتيبي').check()
    await editor.getByTestId('assignee-save').click()
    await editor.waitFor({ state: 'hidden' })
    await waitForSave(api, 1)
    await context.close()
  })

  it('an account member outside the project: confirm, then POST project-people; a 403 shows the Arabic message', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    let editor = await openAssignees(page, 4)
    await editor.getByLabel('نورة السبيعي').click()
    const grant = editor.getByTestId('assignee-grant')
    await grant.waitFor()
    expect(await grant.innerText()).toContain('نورة السبيعي ليس عضواً في مشروع Basecamp رقم 4021')
    await shot(page, 'sync-assignee-grant')
    await grant.getByRole('button', { name: 'إضافته إلى المشروع' }).click()
    await editor.getByTestId('assignee-chips').getByText('نورة السبيعي').waitFor()
    expect(api.bodies('POST', `/api/workbooks/${WB}/project-people`)).toEqual([{ bcPersonId: 3 }])
    await editor.getByTestId('assignee-save').click()
    await editor.waitFor({ state: 'hidden' })

    // A person without the right to manage people.
    api.assigneeOptions[WB] = { ...OPTIONS(), accountPeople: [person(4, 'خالد الدوسري')] }
    api.grant = () => ({ status: 403, body: { ok: false, error: 'forbidden', message: 'لا تملك صلاحية إضافة أعضاء للمشروع؛ اطلب ذلك من مدير المشروع' } })
    editor = await openAssignees(page, 5)
    await editor.getByLabel('خالد الدوسري').click()
    await editor.getByTestId('assignee-grant').getByRole('button', { name: 'إضافته إلى المشروع' }).click()
    const refused = editor.getByTestId('assignee-grant-error')
    await refused.waitFor()
    expect(await refused.innerText()).toContain('لا تملك صلاحية إضافة أعضاء للمشروع')
    await context.close()
  })

  it('«إضافة شخص جديد» creates an external contact (POST /api/external-contacts); the invitation is not offered yet', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    const editor = await openAssignees(page, 4)
    await editor.getByTestId('assignee-add-new').click()
    const form = editor.getByTestId('assignee-new')
    await form.waitFor()
    expect(await form.getByLabel(/دعوة إلى Basecamp/).isDisabled()).toBe(true)
    await form.getByRole('button', { name: 'إضافة' }).click()
    expect(await form.innerText()).toContain('الاسم فارغ')
    await form.getByLabel('الاسم').fill('مكتب الترجمة')
    await form.getByLabel(/الجهة أو الشركة/).fill('الترجمة المعتمدة')
    await shot(page, 'sync-assignee-new')
    await form.getByRole('button', { name: 'إضافة' }).click()
    await editor.getByTestId('assignee-chips').getByText('مكتب الترجمة').waitFor()
    expect(api.bodies('POST', '/api/external-contacts')).toEqual([{ name: 'مكتب الترجمة', organization: 'الترجمة المعتمدة', email: null, phone: null }])
    await context.close()
  })
})

describe('conflicts (spec §9.1)', () => {
  it('a cell alert on the cell, and a panel to restore the other value or keep the winner', async () => {
    const api = syncedApi()
    api.conflicts[WB] = [conflict(), conflict({ id: 'c-2', uid: 'u-4', field: 'dueOn', localValue: '2026-11-20', remoteValue: '2026-11-27', winner: 'remote' })]
    const { context, page } = await openEditor(api)
    await expect.poll(async () => (await marks(page))[SHEET]?.conflicts ?? []).toEqual([`4:${COL.due}`, `5:${COL.title}`])
    const { x, y } = await cellCentre(page, COL.title, 5)
    await page.mouse.move(x, y)
    await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-cell-alert')).toMatch(/^naf-conflict-/)
    await page.getByText('تعارض في المزامنة').first().waitFor()
    await shot(page, 'sync-conflict-alert')

    await page.getByTestId('sync-panel-button').click()
    const panel = page.getByTestId('sync-panel')
    await panel.waitFor()
    const list = panel.getByTestId('conflict-list')
    expect(await list.innerText()).toContain('حملة لينكدإن')
    expect(await list.innerText()).toContain('2026-11-27')
    await shot(page, 'sync-conflict-panel')
    await list.locator('[data-conflict-id="c-1"]').getByTestId('conflict-restore').click()
    await expect.poll(() => api.count('POST', `/api/workbooks/${WB}/conflicts/c-1/restore`)).toBe(1)
    await list.locator('[data-conflict-id="c-1"]').waitFor({ state: 'detached' })
    await list.locator('[data-conflict-id="c-2"]').getByTestId('conflict-dismiss').click()
    await expect.poll(() => api.count('POST', `/api/workbooks/${WB}/conflicts/c-2/dismiss`)).toBe(1)
    await list.getByText('لا تعارضات بانتظار المراجعة.').waitFor()
    // Rows needing attention: the error and the row deleted in Basecamp.
    const attention = panel.getByTestId('attention-list')
    expect(await attention.locator('li[data-state="error"]').innerText()).toContain(ERROR_TEXT)
    expect(await attention.locator('li[data-state="deleted"]').count()).toBe(1)
    await context.close()
  })
})

describe('«مزامنة الآن» and the unsynced subtask cells', () => {
  it('file settings send POST sync-now; the hatch stays on the subtask cells after scrolling and zooming', async () => {
    const api = syncedApi()
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    const m = (await marks(page))[SHEET]!
    expect(m.unsyncedRows).toEqual([2, 3])
    expect(m.unsyncedColumns).toEqual([COL.starts, COL.notes, COL.attachments])
    await page.getByTestId('file-settings-button').click()
    await page.getByTestId('sync-now').click()
    await page.getByTestId('sync-now-result').waitFor()
    expect(await page.getByTestId('sync-now-result').innerText()).toContain('(2)')
    expect(api.count('POST', `/api/workbooks/${WB}/sync-now`)).toBe(1)
    await page.keyboard.press('Escape')

    // The hatch tooltip on C3 (start date of a subtask).
    const c3 = await cellCentre(page, COL.starts, 2)
    await page.mouse.move(c3.x, c3.y)
    await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-cell-alert')).toMatch(/^naf-unsynced-/)
    await page.getByText('لا يُزامَن مع Basecamp').first().waitFor()
    await shot(page, 'sync-unsynced-tooltip')

    // Scroll a little and zoom in: the hatch is drawn by the grid, so it follows.
    await page.mouse.move(c3.x, c3.y + 200)
    await page.mouse.wheel(0, 48)
    await page.waitForTimeout(400)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -200)
    await page.keyboard.up('Control')
    await page.waitForTimeout(800)
    await shot(page, 'sync-hatch-scrolled-zoomed')
    await context.close()
  })
})

describe('a viewer is truly read-only', () => {
  it('no editor opens, no hierarchy change, no sync-now, no conflict action, no write', async () => {
    const api = syncedApi({ access: 'viewer' })
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    const { x, y } = await cellCentre(page, COL.assignees, 4)
    await page.mouse.dblclick(x, y)
    await page.waitForTimeout(600)
    expect(await page.getByTestId('assignee-editor').count()).toBe(0)
    await clickCell(page, COL.title, 4)
    await page.keyboard.press('Tab')
    expect(await page.getByTestId('indent-button').isDisabled()).toBe(true)
    expect(await page.getByTestId('outdent-button').isDisabled()).toBe(true)
    await page.getByTestId('sync-panel-button').click()
    expect(await page.getByTestId('conflict-restore').count()).toBe(0)
    await page.keyboard.press('Escape')
    await page.getByTestId('file-settings-button').click()
    expect(await page.getByTestId('sync-now').count()).toBe(0)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(2500)
    expect(api.puts(WB)).toHaveLength(0)
    const writes = api.requests.filter((r) => r.method !== 'GET')
    expect(writes).toEqual([])
    await context.close()
  })
})

describe('narrow screens', () => {
  it('375 px wide: the toolbar, the notice and the sync panel fit without horizontal page scroll', async () => {
    const api = syncedApi()
    api.sync[WB] = syncInfo({ notice: NOTICE_TEXT })
    const { context, page } = await openEditor(api, { width: 375, height: 740 })
    await page.getByTestId('sync-toolbar').waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shot(page, 'sync-375')
    await page.getByTestId('sync-panel-button').click()
    await page.getByTestId('sync-panel').waitFor()
    await shot(page, 'sync-375-panel')
    await page.keyboard.press('Escape')
    await context.close()
  })
})

describe('hermetic', () => {
  it('no uncaught page error and no request left 127.0.0.1 except the blocked CDN font', () => {
    expect(pageErrors).toEqual([])
    expect(blockedRequests.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/'))).toEqual([])
  })
})
