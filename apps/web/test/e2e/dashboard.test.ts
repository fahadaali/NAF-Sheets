// Browser tests of the workbook dashboard («اللوحة», src/dashboard/) and the
// admin palette («المظهر», src/screens/AppearanceScreen.tsx), against the
// built app with the API mocked (mock-api.ts). Same harness as phase7.test.ts.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DashboardResponse, DashboardWidgetConfig, WidgetResult } from '@naf-sheets/shared'
import { BASE_URL } from './global-setup'
import { MockApi, sheetMeta, summary, taskSnapshot } from './mock-api'

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
  expect(pageErrors).toEqual([])
  // Only the font CDN is ever asked for outside the app (src/main.tsx, OPEN), and it is blocked.
  expect(blockedRequests.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/gh/engdawood/thmanyah-font-web@'))).toEqual([])
})

async function openPage(api: MockApi, path: string, viewport = { width: 1280, height: 900 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh', reducedMotion: 'reduce' })
  await context.route(
    (url) => !url.href.startsWith(BASE_URL),
    (route) => {
      blockedRequests.push(route.request().url())
      return route.abort()
    },
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${path}: ${String(e).slice(0, 300)}`))
  await api.install(page)
  await page.goto(BASE_URL + path)
  return { context, page }
}

/** The editor chunk (with Univer) loads first: give it time. */
const READY = { timeout: 30_000 }

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })

const WB = 'wb-dash'
/** The dashboard sheet's id (@naf-sheets/shared dashboard-sheet.ts). */
const DASH = 'naf-dashboard'
const SHEET = 'sheet-1'
const BUDGET = 'sheet-2'

const link = (range: string, sheetId = SHEET) => ({ sheetId, range })

/** Univer's own sheet tabs (sheets-ui `SheetBarItem`); the dashboard is the first. */
const TABS = '[data-u-comp="slide-tab-item"]'
const tab = (page: Page, sheetId: string) => page.locator(`${TABS}[data-id="${sheetId}"]`)

/** The tab bar as the person sees it: ids and names, first (rightmost in RTL) to last. */
async function tabBar(page: Page): Promise<Array<{ id: string; name: string; right: number }>> {
  return page.locator(TABS).evaluateAll((els) =>
    els.map((e) => ({ id: (e as HTMLElement).dataset.id ?? '', name: (e.textContent ?? '').trim(), right: e.getBoundingClientRect().right })),
  )
}

/** A picture of the bottom of the editor: the end of the grid or dashboard, and the tab bar. */
async function shotTabBar(page: Page, name: string): Promise<void> {
  const bar = await page.locator(TABS).first().evaluate((el) => {
    const footer = el.closest('footer') ?? el.parentElement!
    const r = footer.getBoundingClientRect()
    return { y: r.top, height: r.height }
  })
  const width = page.viewportSize()!.width
  const y = Math.max(0, bar.y - 160)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: 0, y, width, height: bar.y - y + bar.height } })
}

function dashboard(over: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    workbookId: WB,
    version: 3,
    asOf: '2026-11-10',
    weekStart: '2026-11-08',
    weekEnd: '2026-11-14',
    canEdit: true,
    totals: {
      todos: 24,
      done: 11,
      completion: 11 / 24,
      overdue: 4,
      dueThisWeek: 5,
      undated: 3,
      completionLink: link('E2:E25'),
      overdueLink: link('D3:D18'),
      dueThisWeekLink: link('D5:D21'),
    },
    sheets: [
      { sheetId: SHEET, title: 'المحتوى', kind: 'tasks', todos: 16, done: 8, open: 5, overdue: 3, completion: 0.5, issues: 1, link: link('E2:E17'), columns: [{ key: 'A', header: 'المهمة' }, { key: 'B', header: 'المسؤول' }, { key: 'D', header: 'تاريخ الاستحقاق' }, { key: 'E', header: 'الحالة' }], headerRow: 1 },
      { sheetId: 'sheet-3', title: 'الفعاليات', kind: 'tasks', todos: 8, done: 3, open: 4, overdue: 1, completion: 3 / 8, issues: 0, link: link('E2:E9', 'sheet-3'), columns: [{ key: 'A', header: 'المهمة' }], headerRow: 1 },
      { sheetId: BUDGET, title: 'الميزانية', kind: 'plain', todos: 0, done: 0, open: 0, overdue: 0, completion: null, issues: 0, link: link('A1', BUDGET), columns: [{ key: 'A', header: 'القسم' }, { key: 'B', header: 'المبلغ' }, { key: 'C', header: 'الحالة' }], headerRow: 1 },
    ],
    overdue: [
      { uid: 'u1', sheetId: SHEET, sheetTitle: 'المحتوى', title: 'كتابة بيان اليوم الوطني', level: 0, status: 'overdue', dueOn: '2026-11-02', assignees: ['سارة القحطاني'], link: link('A3') },
      { uid: 'u2', sheetId: SHEET, sheetTitle: 'المحتوى', title: 'مراجعة التصاميم', level: 1, status: 'overdue', dueOn: '2026-11-05', assignees: ['وكالة النشر'], link: link('A7') },
      { uid: 'u3', sheetId: 'sheet-3', sheetTitle: 'الفعاليات', title: 'حجز القاعة', level: 0, status: 'overdue', dueOn: '2026-11-08', assignees: [], link: link('A4', 'sheet-3') },
    ],
    dueThisWeek: [
      { uid: 'u4', sheetId: SHEET, sheetTitle: 'المحتوى', title: 'نشر المقال على LinkedIn', level: 0, status: 'open', dueOn: '2026-11-11', assignees: ['فهد العتيبي'], link: link('A5') },
      { uid: 'u5', sheetId: SHEET, sheetTitle: 'المحتوى', title: 'تصوير فيديو تعريفي', level: 0, status: 'open', dueOn: '2026-11-13', assignees: ['سارة القحطاني', 'فهد العتيبي'], link: link('A9') },
    ],
    listLimit: 50,
    assignees: [
      { key: 'bc:1', kind: 'bc_person', name: 'سارة القحطاني', done: 5, open: 3, overdue: 2, link: link('B2:B14') },
      { key: 'bc:2', kind: 'bc_person', name: 'فهد العتيبي', done: 4, open: 4, overdue: 0, link: link('B3:B16') },
      { key: 'ext:1', kind: 'external', name: 'وكالة النشر', done: 1, open: 1, overdue: 1, link: link('B7:B12') },
      { key: 'name:خالد', kind: 'unmatched', name: 'خالد', done: 0, open: 2, overdue: 0, link: link('B10:B11') },
    ],
    timeline: [
      { weekStart: '2026-10-25', done: 3, open: 0, overdue: 0, link: link('D2:D4') },
      { weekStart: '2026-11-01', done: 4, open: 0, overdue: 3, link: link('D3:D8') },
      { weekStart: '2026-11-08', done: 2, open: 5, overdue: 1, link: link('D5:D21') },
      { weekStart: '2026-11-15', done: 0, open: 4, overdue: 0, link: link('D10:D14') },
      { weekStart: '2026-11-22', done: 0, open: 2, overdue: 0, link: link('D15:D16') },
      { weekStart: '2026-11-29', done: 0, open: 0, overdue: 0, link: null },
      { weekStart: '2026-12-06', done: 0, open: 3, overdue: 0, link: link('D17:D19') },
    ],
    timelineLimit: 16,
    timelineTruncated: false,
    subtasks: {
      total: 9,
      done: 5,
      link: link('A6:A13'),
      parents: [
        { uid: 'p1', sheetId: SHEET, title: 'هوية الحملة', done: 3, total: 4, link: link('A6') },
        { uid: 'p2', sheetId: SHEET, title: 'خطة النشر', done: 2, total: 5, link: link('A11') },
      ],
    },
    activity: [
      { id: 3, at: '2026-11-10T08:15:00Z', direction: 'out', action: 'set_completion', field: null, status: 'ok', actorName: 'فهد العتيبي', taskTitle: 'نشر المقال على LinkedIn', link: link('A5') },
      { id: 2, at: '2026-11-10T07:40:00Z', direction: 'in', action: 'update_row', field: null, status: 'ok', actorName: null, taskTitle: 'كتابة بيان اليوم الوطني', link: link('A3') },
      { id: 1, at: '2026-11-09T16:05:00Z', direction: 'out', action: 'update_todo', field: null, status: 'error', actorName: 'سارة القحطاني', taskTitle: 'حجز القاعة', link: link('A4', 'sheet-3') },
    ],
    sync: { state: 'synced', lastSuccessAt: '2026-11-10T08:16:00Z', counts: { pending: 0, error: 0, conflict: 0 } },
    widgets: [],
    results: [],
    ...over,
  }
}

const GROUPED: Extract<WidgetResult, { ok: true }> = {
  widgetId: null,
  ok: true,
  value: 48500,
  cells: 9,
  skipped: 1,
  uncomputed: 1,
  groups: [
    { label: 'التسويق', value: 21000, cells: 3, link: link('B2:B4', BUDGET) },
    { label: 'العلاقات العامة', value: 12500, cells: 2, link: link('B5:B6', BUDGET) },
    { label: 'الإنتاج', value: 9000, cells: 2, link: link('B7:B8', BUDGET) },
    { label: 'الفعاليات', value: 6000, cells: 2, link: link('B9:B10', BUDGET) },
  ],
  otherGroups: 0,
  groupLimit: 50,
  link: link('B2:B11', BUDGET),
}

function dashApi(over: Partial<DashboardResponse> = {}): MockApi {
  const api = new MockApi()
  api.add(summary({ id: WB, title: 'حملة اليوم الوطني', sheetCount: 3 }), taskSnapshot(WB, SHEET, 'حملة اليوم الوطني'), 3, [sheetMeta(SHEET, 'المحتوى')])
  api.dashboards[WB] = dashboard(over)
  api.widgetResult = (config: DashboardWidgetConfig) =>
    config.groupBy === null ? { ...GROUPED, groups: null } : config.aggregation === 'count' ? { ...GROUPED, value: 9, groups: (GROUPED.groups ?? []).map((g) => ({ ...g, value: g.cells })) } : GROUPED
  return api
}

const widget = (over: Partial<DashboardWidgetConfig> = {}): DashboardWidgetConfig => ({
  title: 'الميزانية حسب القسم',
  sheetId: BUDGET,
  source: { kind: 'column', column: 'B' },
  aggregation: 'sum',
  groupBy: 'A',
  display: 'donut',
  ...over,
})

describe('the automatic dashboard', () => {
  it('is the first sheet tab «اللوحة» in Univer\'s own bar, shows KPIs and charts, and every figure links to its cells', async () => {
    const api = dashApi()
    const { context, page } = await openPage(api, `/workbooks/${WB}`, { width: 1280, height: 900 })
    const host = page.getByTestId('univer-host')
    await expect.poll(() => host.getAttribute('data-engine'), READY).toBe('ready')
    // No view switch in the editor bar any more: the dashboard is a tab like the sheets.
    expect(await page.locator('.view-tabs, [data-testid^="view-tab-"]').count()).toBe(0)
    await expect.poll(() => tabBar(page).then((tabs) => tabs.map((t) => t.id))).toEqual([DASH, SHEET])
    const tabs = await tabBar(page)
    expect(tabs.map((t) => t.name)).toEqual(['اللوحة', 'المهام'])
    // RTL: the first tab is the rightmost.
    expect(tabs[0]!.right).toBeGreaterThan(tabs[1]!.right)
    // /workbooks/:id opens on the first sheet, not on the dashboard; nothing is requested or saved yet.
    expect(await host.getAttribute('data-active-sheet')).toBe(SHEET)
    expect(api.count('GET', `/api/workbooks/${WB}/dashboard`)).toBe(0)
    expect(await page.getByTestId('dashboard').count()).toBe(0)

    await tab(page, DASH).click()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}/dashboard`)
    const dash = page.getByTestId('dashboard')
    await expect.poll(() => dash.getAttribute('data-state'), READY).toBe('ready')
    expect(await host.getAttribute('data-active-sheet')).toBe(DASH)
    // It covers the grid only: the toolbar above and the tab bar below stay where they are.
    const box = (await page.locator('.editor-dashboard').boundingBox())!
    const bar = (await page.locator(TABS).first().boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + 1)
    expect(await page.locator('.editor-host [data-u-comp="headerbar"]').isVisible()).toBe(true)
    await shotTabBar(page, 'dashboard-tab-bar')

    // KPIs: Latin digits, isolated.
    expect(await page.getByTestId('kpi-completion').innerText()).toContain('46%')
    expect(await page.getByTestId('kpi-completion').innerText()).toContain('11 من 24 مهمة منجزة')
    expect(await page.getByTestId('kpi-overdue').innerText()).toContain('4')
    expect(await page.getByTestId('kpi-week').innerText()).toContain('5')
    expect(await page.getByTestId('kpi-sync').innerText()).toContain('متزامن')
    // Every card is there, with Arabic labels, and the charts are drawn (SVG) in the platform's face.
    for (const id of ['dash-sheets', 'dash-people', 'dash-timeline', 'dash-subtasks', 'dash-overdue', 'dash-week', 'dash-activity']) await page.getByTestId(id).waitFor()
    await page.locator('[data-chart="bars"] svg .recharts-bar-rectangle').first().waitFor()
    await page.locator('[data-chart="columns"] svg .recharts-bar-rectangle').first().waitFor()
    const font = await page.locator('[data-chart="bars"] svg text').first().evaluate((el) => getComputedStyle(el).fontFamily)
    expect(font).toContain('Thmanyah')
    // RTL: the category labels sit to the right of the bars, which grow leftwards.
    const geometry = await page.locator('[data-testid="dash-sheets"] [data-chart="bars"]').evaluate((chart) => {
      const label = chart.querySelector('.chart__tick--label')!.getBoundingClientRect()
      const bar = chart.querySelector('.recharts-bar-rectangle path')!.getBoundingClientRect()
      return { labelStart: label.left, barEnd: bar.right }
    })
    expect(geometry.labelStart).toBeGreaterThanOrEqual(geometry.barEnd - 1)
    // Times run right to left: the oldest week is on the right.
    await page.getByTestId('dash-timeline').scrollIntoViewIfNeeded()
    const weeks = await page.locator('[data-chart="columns"] .chart__tick').evaluateAll((els) =>
      els.filter((e) => /^\d\d-\d\d$/.test(e.textContent ?? '')).map((e) => ({ text: e.textContent, x: e.getBoundingClientRect().left })),
    )
    expect(weeks.length).toBeGreaterThan(1)
    expect(weeks[0]!.x).toBeGreaterThan(weeks[weeks.length - 1]!.x)
    // The status colours are paired with icons and labels.
    expect(await page.getByTestId('dash-sheets').innerText()).toContain('منجزة')
    expect(await page.getByTestId('dash-people').innerText()).toContain('جهة خارجية')
    expect(await page.getByTestId('dash-people').innerText()).toContain('اسم لا يطابق أحداً')
    expect(await page.getByTestId('dash-activity').innerText()).toContain('تغيّرت حالة الإنجاز')
    expect(await page.getByTestId('dash-activity').innerText()).toContain('لم ينجح')
    await shot(page, 'dashboard-auto')

    // A KPI links to its cells.
    expect(await page.getByTestId('kpi-overdue').getAttribute('href')).toBe(`/workbooks/${WB}?sheet=${SHEET}&range=D3%3AD18`)
    // A chart element: the first sheet's bar → that sheet's completion column, selected in the grid.
    await page.getByTestId('dash-sheets').scrollIntoViewIfNeeded()
    await page.locator('[data-testid="dash-sheets"] .recharts-bar-rectangle').first().click()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}?sheet=${SHEET}&range=E2%3AE17`)
    await expect.poll(() => host.getAttribute('data-selection'), { timeout: 20_000 }).toBe(`${SHEET}!E2:E17`)
    expect(await host.getAttribute('data-active-sheet')).toBe(SHEET)
    expect(await page.getByTestId('dashboard').isVisible()).toBe(false)

    // Back to the dashboard tab (kept mounted), then a list item.
    await tab(page, DASH).click()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}/dashboard`)
    await page.getByTestId('dash-overdue').getByTestId('dash-task-link').first().click()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}?sheet=${SHEET}&range=A3`)
    await expect.poll(() => host.getAttribute('data-selection'), { timeout: 20_000 }).toBe(`${SHEET}!A3`)
    // Choosing a sheet tab puts the address back on the workbook; Back returns to the dashboard tab.
    await tab(page, DASH).click()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}/dashboard`)
    await tab(page, SHEET).click()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}`)
    await page.goBack()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}/dashboard`)
    await expect.poll(() => host.getAttribute('data-active-sheet')).toBe(DASH)
    // Opening it changed nothing: no save.
    expect(api.count('PUT', `/api/workbooks/${WB}/snapshot`)).toBe(0)
    await context.close()
  })

  it('cannot be deleted, renamed, hidden, copied or protected, with an Arabic reason; a new sheet goes after it', async () => {
    const api = dashApi()
    const { context, page } = await openPage(api, `/workbooks/${WB}/dashboard`)
    const host = page.getByTestId('univer-host')
    await expect.poll(() => host.getAttribute('data-engine'), READY).toBe('ready')
    await expect.poll(() => host.getAttribute('data-active-sheet')).toBe(DASH)
    // The mock has no room: wait for the fallback (saved with PUT), where the workbook takes edits.
    await expect.poll(() => host.getAttribute('data-editable'), READY).toBe('true')
    // Opened on the dashboard tab, the grid under it is still mirrored, and stays so past
    // the RTL layer's 3 s heartbeat (packages/univer-rtl).
    await expect.poll(() => host.getAttribute('data-rtl-mirrored'), READY).toBe('true')
    await page.waitForTimeout(4_000)
    expect(await host.getAttribute('data-rtl-mirrored')).toBe('true')
    expect(await page.getByTestId('editor-rtl-off').count()).toBe(0)
    const refusal = page.getByTestId('sync-refusal')

    // The tab's context menu: deleting, renaming and hiding it are switched off.
    const menuItem = (text: string) => page.locator(`button:has(> span > span:text-is("${text}"))`)
    await tab(page, DASH).click({ button: 'right' })
    for (const item of ['حذف', 'إعادة تسمية', 'إخفاء']) await expect.poll(() => menuItem(item).isDisabled(), { timeout: 10_000 }).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'dashboard-tab-menu.png') })
    // Copying or protecting it is refused, with the reason.
    for (const [item, reason] of [['نسخ', 'لم تُنسخ «اللوحة»'], ['حماية ورقة العمل', '«اللوحة» تعرض أرقام الملف']] as const) {
      if (!(await menuItem(item).isVisible())) await tab(page, DASH).click({ button: 'right' })
      await menuItem(item).click()
      await expect.poll(() => refusal.innerText(), { timeout: 10_000 }).toContain(reason)
      await refusal.getByRole('button').click()
    }
    await page.keyboard.press('Escape')
    await expect.poll(() => tabBar(page).then((tabs) => tabs.length)).toBe(2)

    // The toolbar stays as on any tab; what it would write into the dashboard is refused.
    await page.locator('[data-u-command="sheet.command.set-range-bold"]').first().click()
    await expect.poll(() => refusal.innerText(), { timeout: 10_000 }).toContain('«اللوحة» تعرض أرقام الملف')
    await refusal.getByRole('button').click()

    // Double-click to rename: the name stays.
    await tab(page, DASH).dblclick()
    await page.keyboard.type('لوحتي')
    await page.keyboard.press('Enter')
    await expect.poll(() => tabBar(page).then((tabs) => tabs[0]!.name)).toBe('اللوحة')

    // Moving a sheet before it is refused by the same rules (unit tests: test/unit/dashboard-sheet.test.ts,
    // and the room's apps/api/test/room/dashboard-sheet.test.ts); a synthetic drag does not reach Univer's tab bar.
    // On a sheet tab the same menu works as usual.
    await tab(page, SHEET).click({ button: 'right' })
    await expect.poll(() => menuItem('حذف').isDisabled(), { timeout: 10_000 }).toBe(false)
    await page.keyboard.press('Escape')

    // «+» adds a sheet after the dashboard, never before it.
    await page.locator('.editor-host footer button').filter({ has: page.locator('svg') }).first().click()
    await expect.poll(() => tabBar(page).then((tabs) => tabs.length)).toBe(3)
    expect((await tabBar(page))[0]!.id).toBe(DASH)
    expect(pageErrors).toEqual([])
    // Nothing was ever written into the dashboard: every save so far leaves it empty and first.
    for (const body of api.bodies('PUT', `/api/workbooks/${WB}/snapshot`) as Array<{ snapshot: { sheetOrder: string[]; sheets: Record<string, { cellData?: unknown; name?: string }> } }>) {
      expect(body.snapshot.sheetOrder[0]).toBe(DASH)
      expect(body.snapshot.sheets[DASH]).toMatchObject({ name: 'اللوحة' })
      expect(Object.keys((body.snapshot.sheets[DASH]?.cellData ?? {}) as object)).toEqual([])
    }
    await shotTabBar(page, 'dashboard-tab-guarded')
    await context.close()
  })

  it('is reachable at /workbooks/:id/dashboard; refreshes on saves and by polling; empty states invite action', async () => {
    const api = dashApi({ sheets: [dashboard().sheets[2]!], overdue: [], dueThisWeek: [], assignees: [], timeline: [], activity: [], subtasks: { total: 0, done: 0, link: null, parents: [] }, sync: { state: 'unlinked', lastSuccessAt: null, counts: { pending: 0, error: 0, conflict: 0 } } })
    api.dashboards[WB]!.totals = { todos: 0, done: 0, completion: null, overdue: 0, dueThisWeek: 0, undated: 0, completionLink: null, overdueLink: null, dueThisWeekLink: null }
    const { context, page } = await openPage(api, `/workbooks/${WB}/dashboard`)
    await expect.poll(() => page.getByTestId('dashboard').getAttribute('data-state'), READY).toBe('ready')
    await page.getByTestId('dashboard-no-tasks').waitFor()
    expect(await page.getByTestId('dashboard-no-tasks').innerText()).toContain('ربط بمشروع في Basecamp')
    expect(await page.getByTestId('widgets-empty').innerText()).toContain('أضف أول عنصر إلى اللوحة')
    expect(await page.getByTestId('kpi-sync').innerText()).toContain('غير مرتبط')
    await shot(page, 'dashboard-empty')

    // «تحديث» asks again.
    const before = api.count('GET', `/api/workbooks/${WB}/dashboard`)
    await page.getByTestId('dashboard-refresh').click()
    await expect.poll(() => api.count('GET', `/api/workbooks/${WB}/dashboard`)).toBe(before + 1)
    await context.close()
  })
})

describe('custom widgets', () => {
  it('add with a live preview, edit, reorder and remove (with confirmation); the deep link from a chart', async () => {
    const api = dashApi()
    const { context, page } = await openPage(api, `/workbooks/${WB}/dashboard`, { width: 1280, height: 1100 })
    await expect.poll(() => page.getByTestId('dashboard').getAttribute('data-state'), READY).toBe('ready')

    // Add.
    await page.getByTestId('widgets-empty').getByTestId('widget-add').click()
    const dialog = page.getByTestId('widget-dialog')
    await dialog.waitFor()
    await dialog.getByTestId('widget-title').fill('الميزانية حسب القسم')
    await dialog.getByTestId('widget-sheet').selectOption(BUDGET)
    await dialog.getByTestId('widget-column').selectOption('B')
    await dialog.getByTestId('widget-aggregation').selectOption('sum')
    await dialog.getByTestId('widget-group').selectOption('A')
    await dialog.getByTestId('widget-display-donut').check()
    // The preview is computed by the server, nothing stored.
    await dialog.getByTestId('widget-legend').waitFor()
    expect(await dialog.getByTestId('widget-preview').innerText()).toContain('التسويق')
    expect(api.requests.some((r) => r.method === 'POST' && r.path === `/api/workbooks/${WB}/dashboard/preview`)).toBe(true)
    expect(api.widgets[WB] ?? []).toHaveLength(0)
    await shot(page, 'dashboard-widget-dialog')
    // A grouped chart needs a group column.
    await dialog.getByTestId('widget-group').selectOption('')
    expect(await dialog.innerText()).toContain('تحتاج عمود تجميع')
    await dialog.getByTestId('widget-group').selectOption('A')
    await dialog.getByTestId('widget-save').click()
    await dialog.waitFor({ state: 'detached' })
    expect(api.bodies('POST', `/api/workbooks/${WB}/dashboard/widgets`)).toEqual([widget()])
    const cards = page.getByTestId('widget')
    await expect.poll(() => cards.count()).toBe(1)
    await cards.first().locator('[data-chart="donut"] .recharts-pie-sector').first().waitFor()

    // A second one: a KPI on a range.
    await page.getByTestId('widget-add').click()
    await dialog.waitFor()
    await dialog.getByTestId('widget-title').fill('إجمالي المبالغ')
    await dialog.getByTestId('widget-sheet').selectOption(BUDGET)
    await dialog.getByTestId('widget-source-range').check()
    await dialog.getByTestId('widget-range').fill('b2:b11')
    await dialog.getByTestId('widget-aggregation').selectOption('sum')
    await dialog.getByTestId('widget-group').selectOption('')
    await dialog.getByTestId('widget-display-kpi').check()
    await dialog.getByTestId('widget-save').click()
    await dialog.waitFor({ state: 'detached' })
    expect(api.bodies('POST', `/api/workbooks/${WB}/dashboard/widgets`)[1]).toEqual(widget({ title: 'إجمالي المبالغ', source: { kind: 'range', range: 'B2:B11' }, groupBy: null, display: 'kpi' }))
    await expect.poll(() => cards.count()).toBe(2)
    expect(await cards.nth(1).getByTestId('widget-kpi').innerText()).toBe('48,500')

    // Edit: the first one becomes bars.
    await cards.first().getByTestId('widget-edit').click()
    await dialog.waitFor()
    expect(await dialog.getByTestId('widget-title').inputValue()).toBe('الميزانية حسب القسم')
    await dialog.getByTestId('widget-display-bar').check()
    await dialog.getByTestId('widget-save').click()
    await dialog.waitFor({ state: 'detached' })
    expect(api.widgets[WB]![0]!.display).toBe('bar')
    await cards.first().locator('[data-chart="bars"] .recharts-bar-rectangle').first().waitFor()

    // Reorder: the KPI first.
    await cards.nth(1).getByTestId('widget-earlier').click()
    await expect.poll(() => cards.first().locator('.widget__title').innerText()).toBe('إجمالي المبالغ')
    expect(api.bodies('PUT', `/api/workbooks/${WB}/dashboard/widgets/order`)).toEqual([{ ids: ['w-2', 'w-1'] }])
    await shot(page, 'dashboard-widgets')

    // Remove: asks first; «إلغاء» keeps it.
    await cards.first().getByTestId('widget-remove').click()
    const confirm = page.getByTestId('widget-remove-dialog')
    await confirm.waitFor()
    expect(await confirm.innerText()).toContain('إجمالي المبالغ')
    await shot(page, 'dashboard-widget-remove')
    await confirm.getByRole('button', { name: 'إلغاء' }).click()
    await confirm.waitFor({ state: 'detached' })
    expect(api.count('POST', `/api/workbooks/${WB}/dashboard/widgets/w-2/remove`)).toBe(0)
    await cards.first().getByTestId('widget-remove').click()
    await confirm.waitFor()
    await confirm.getByTestId('widget-remove-confirm').click()
    await confirm.waitFor({ state: 'detached' })
    expect(api.bodies('POST', `/api/workbooks/${WB}/dashboard/widgets/w-2/remove`)).toEqual([{ confirmed: true }])
    await expect.poll(() => cards.count()).toBe(1)

    // The deep link from a widget's chart: a bar → its group's cells on the budget sheet.
    await cards.first().locator('.recharts-bar-rectangle').first().click()
    await page.waitForURL(`${BASE_URL}/workbooks/${WB}?sheet=${BUDGET}&range=B2%3AB4`)
    await context.close()
  })

  it('a viewer sees the dashboard and widgets, and no way to change them', async () => {
    const api = dashApi()
    api.workbooks.get(WB)!.workbook.access = 'viewer'
    api.widgets[WB] = [{ ...widget(), id: 'w-9', position: 0, updatedAt: '2026-11-10T09:00:00Z' }]
    const { context, page } = await openPage(api, `/workbooks/${WB}/dashboard`)
    await expect.poll(() => page.getByTestId('dashboard').getAttribute('data-state'), READY).toBe('ready')
    await page.getByTestId('widget').waitFor()
    await page.getByTestId('dashboard-read-only').waitFor()
    expect(await page.getByTestId('widget-add').count()).toBe(0)
    expect(await page.getByTestId('widget-edit').count()).toBe(0)
    expect(await page.getByTestId('widget-remove').count()).toBe(0)
    expect(await page.getByTestId('dashboard-no-tasks').count()).toBe(0)
    await shot(page, 'dashboard-viewer')
    expect(api.requests.filter((r) => r.method !== 'GET' && r.path.includes('/dashboard'))).toEqual([])
    await context.close()
  })

  it('works at 375 px: no horizontal scroll, the KPI row wraps, charts fit', async () => {
    const api = dashApi()
    api.widgets[WB] = [{ ...widget(), id: 'w-9', position: 0, updatedAt: '2026-11-10T09:00:00Z' }]
    const { context, page } = await openPage(api, `/workbooks/${WB}/dashboard`, { width: 375, height: 2600 })
    await expect.poll(() => page.getByTestId('dashboard').getAttribute('data-state'), READY).toBe('ready')
    await page.locator('[data-chart="donut"] .recharts-pie-sector').first().waitFor()
    // The tab bar at phone width: «اللوحة» first (rightmost), selected.
    await expect.poll(() => tabBar(page).then((tabs) => tabs.map((t) => t.id))).toEqual([DASH, SHEET])
    expect(await page.getByTestId('univer-host').getAttribute('data-active-sheet')).toBe(DASH)
    await shotTabBar(page, 'dashboard-tab-bar-375')
    const overflow = await page.locator('.editor-dashboard').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    // The whole page too, editor bar included.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    const widths = await page.locator('.dash-card, .widget, .kpi').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))
    for (const right of widths) expect(right).toBeLessThanOrEqual(375)
    // Keyboard: the first KPI is reachable with Tab and shows its focus ring.
    await page.getByTestId('dashboard-refresh').focus()
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? '')
    expect(focused).toBe('kpi-completion')
    expect(await page.getByTestId('kpi-completion').evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
    await shot(page, 'dashboard-375')
    await context.close()
  })
})

describe('«المظهر» (admin)', () => {
  function adminApi(): MockApi {
    const api = dashApi()
    api.me = { user: { id: 'u-admin', name: 'مسؤول المنصة', email: 'admin@example.com', role: 'admin' } }
    return api
  }

  it('edits the palette with a live preview and a contrast warning, saves it, applies it at load, and restores the defaults', async () => {
    const api = adminApi()
    const { context, page } = await openPage(api, '/settings')
    await page.getByTestId('open-appearance').click()
    await page.waitForURL(`${BASE_URL}/admin/appearance`)
    await page.getByTestId('appearance').waitFor()
    const accent = page.getByTestId('hex-accent')
    const original = await accent.inputValue()
    expect(original).toMatch(/^#[0-9a-f]{6}$/)
    expect(await page.getByTestId('contrast-ok').count()).toBe(1)
    // The preview follows the form at once, scoped: the rest of the page does not change yet.
    await accent.fill('#7a3e8c')
    const previewAccent = await page.getByTestId('appearance-preview').evaluate((el) => getComputedStyle(el).getPropertyValue('--color-accent').trim())
    expect(previewAccent).toBe('#7a3e8c')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())).toBe(original)
    expect(await page.getByTestId('appearance-preview').locator('.button--primary').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(122, 62, 140)')
    // Invalid hex: refused in the form.
    await page.getByTestId('hex-text').fill('#12')
    expect(await page.getByTestId('appearance-save').isDisabled()).toBe(true)
    expect(await page.getByTestId('colour-text').innerText()).toContain('#RRGGBB')
    // Low contrast warns but does not block.
    await page.getByTestId('hex-text').fill('#b0b0b0')
    await page.getByTestId('contrast-warnings').waitFor()
    expect(await page.getByTestId('contrast-warnings').innerText()).toContain('النص على خلفية البطاقات')
    await shot(page, 'appearance-warning')
    await page.getByTestId('hex-text').fill('#1f2a2e')
    await page.getByTestId('contrast-ok').waitFor()
    await page.getByTestId('appearance-save').click()
    await page.getByTestId('appearance-message').waitFor()
    expect(api.bodies('PUT', '/api/admin/appearance')).toEqual([{ palette: { accent: '#7a3e8c' } }])
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())).toBe('#7a3e8c')
    await shot(page, 'appearance')

    // Another page load: applied from GET /api/appearance, charts included.
    await page.goto(`${BASE_URL}/workbooks/${WB}/dashboard`)
    await expect.poll(() => page.getByTestId('dashboard').getAttribute('data-state'), READY).toBe('ready')
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--color-accent'))).toBe('#7a3e8c')

    // «استعادة الافتراضي»: asks, then stores {}.
    await page.goto(`${BASE_URL}/admin/appearance`)
    await page.getByTestId('appearance').waitFor()
    await page.getByTestId('appearance-reset').click()
    await page.getByTestId('appearance-reset-confirm').click()
    await page.getByTestId('appearance-message').waitFor()
    expect(api.bodies('PUT', '/api/admin/appearance').at(-1)).toEqual({ palette: {} })
    expect(await page.getByTestId('hex-accent').inputValue()).toBe(original)
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--color-accent'))).toBe('')
    await context.close()
  })

  it('is for admins only', async () => {
    const api = dashApi()
    const { context, page } = await openPage(api, '/admin/appearance')
    await page.getByTestId('admin-only').waitFor()
    expect(await page.getByTestId('appearance').count()).toBe(0)
    await context.close()
  })
})
