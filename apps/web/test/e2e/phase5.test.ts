// Browser tests of phase 5 in the editor (spec §5.2 attachment cell editor,
// §10 attachments, §12.1 item 5 task details: comments) against the built
// app, the API mocked by route interception (mock-api.ts). Same harness as
// sync.test.ts: vite preview on :4174, headless Chromium, hermetic.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkbookSnapshot } from '@naf-sheets/sheet-model'
import type { AttachmentInfo, CommentInfo, WorkbookSyncResponse } from '@naf-sheets/shared'
import { BASE_URL } from './global-setup'
import { openFirstSheet } from './editor-tabs'
import { error, MockApi, summary } from './mock-api'
import { COL, META, SHEET, syncedWorkbook, type RowSpec } from '../unit/sync-fixtures'

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

const WB = 'wb-phase5'
const ROWS: RowSpec[] = [
  { title: 'خطة الاتصال' },
  { title: 'تصميم الهوية', level: 1 },
  { title: 'نشر المقال', cells: { [COL.attachments]: { v: 'دليل الهوية.pdf' } } },
  { title: 'حملة LinkedIn' },
]
// uids u-1 … u-4 on rows 2 … 5 (0-based 1 … 4); u-2 is a subtask of u-1.

function snapshot(): WorkbookSnapshot {
  const workbook = syncedWorkbook(ROWS)
  const sheet = workbook.sheets[SHEET] as unknown as Record<string, unknown>
  sheet.name = 'المهام'
  sheet.rightToLeft = 1
  sheet.defaultStyle = { ff: 'Thmanyah Sans' }
  return { ...workbook, id: WB, name: 'خطة المرفقات' }
}

const task = (uid: string, over: Partial<WorkbookSyncResponse['tasks'][number]> = {}): WorkbookSyncResponse['tasks'][number] => ({
  uid,
  sheetId: META.id,
  state: 'synced',
  message: null,
  remoteStatus: 'active',
  bcUrl: `https://3.basecamp.com/5000001/buckets/4021/todos/${uid}`,
  assignMode: 'manual',
  commentsCount: 0,
  attachmentsCount: 0,
  ...over,
})

const comment = (id: number, text: string, creatorName: string): CommentInfo => ({
  id,
  text,
  creatorName,
  creatorAvatarUrl: null,
  createdAt: '2026-11-10T08:15:00Z',
  appUrl: `https://3.basecamp.com/5000001/buckets/4021/todos/u-1#__recording_${id}`,
  attachments: [],
})

const existing = (over: Partial<AttachmentInfo> = {}): AttachmentInfo => ({
  id: 'att-guide',
  taskUid: 'u-3',
  filename: 'دليل الهوية.pdf',
  size: 2_400_000,
  mime: 'application/pdf',
  origin: 'basecamp',
  state: 'attached',
  message: null,
  downloadPath: `/api/workbooks/${WB}/attachments/att-guide/download`,
  createdAt: '2026-11-09T10:00:00Z',
  ...over,
})

function phase5Api(over: { access?: 'owner' | 'editor' | 'viewer' } = {}): MockApi {
  const api = new MockApi()
  api.add(summary({ id: WB, title: 'خطة المرفقات', bcProjectId: 4021, syncState: 'synced', access: over.access ?? 'owner' }), snapshot(), 5, [{ ...META }])
  api.sync[WB] = {
    state: 'synced',
    lastSuccessAt: '2026-11-10T09:25:00Z',
    counts: { pending: 0, error: 0, conflict: 0 },
    notice: null,
    tasks: [task('u-1', { commentsCount: 2 }), task('u-2', { assignMode: null, commentsCount: null }), task('u-3', { attachmentsCount: 1 }), task('u-4')],
  }
  api.levels['u-2'] = 1
  api.attachmentNotices['u-2'] = 'المهام الفرعية في Basecamp لا تقبل مرفقات، فمرفقات هذا الصف تبقى في المنصة ولا تظهر في Basecamp.'
  api.attachments['u-3'] = [existing()]
  api.files.set('att-guide', Buffer.from('%PDF-1.7 guide'))
  const thread = [comment(501, 'راجعت المسودة،\nوأرفقت الملاحظات.', 'سارة القحطاني'), comment(502, 'تمت الموافقة على الخطة.', 'فهد العتيبي')]
  api.comments['u-1'] = { comments: thread }
  api.comments['u-2'] = { comments: thread, onParent: true, targetUid: 'u-1' }
  return api
}

// ---------------------------------------------------------------------------
// Harness (as sync.test.ts)
// ---------------------------------------------------------------------------

async function openEditor(api: MockApi, viewport = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh', acceptDownloads: true })
  await context.route(
    (url) => !url.href.startsWith(BASE_URL),
    (route) => {
      blockedRequests.push(route.request().url())
      return route.abort()
    },
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(`phase5: ${String(e).slice(0, 300)}`))
  await api.install(page)
  await page.goto(`${BASE_URL}/workbooks/${WB}`)
  await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
  await openFirstSheet(page)
  await page.locator('[data-screen="editor"]:not([data-collab="connecting"])').waitFor({ timeout: 30_000 })
  await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-rtl-mirrored'), { timeout: 15_000 }).toBe('true')
  return { context, page }
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) })

const GRID = { rowHeaderWidth: 64, columnHeaderHeight: 20, columnWidth: 88, rowHeight: 24 }

async function cellCentre(page: Page, column: number, row: number) {
  const box = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!box) throw new Error('sheet canvas not found')
  return {
    x: box.x + box.width - GRID.rowHeaderWidth - GRID.columnWidth * column - GRID.columnWidth / 2,
    y: box.y + GRID.columnHeaderHeight + GRID.rowHeight * row + GRID.rowHeight / 2,
  }
}

async function clickCell(page: Page, column: number, row: number) {
  const { x, y } = await cellCentre(page, column, row)
  await page.mouse.click(x, y)
  await page.waitForTimeout(150)
}

type Marks = Record<string, { states: Record<string, string>; comments: Record<string, number> }>
const marks = async (page: Page): Promise<Marks> => JSON.parse((await page.getByTestId('univer-host').getAttribute('data-sync-marks')) ?? '{}') as Marks

async function waitForMarks(page: Page) {
  await expect.poll(async () => Object.keys((await marks(page))[SHEET]?.states ?? {}).length, { timeout: 15_000 }).toBeGreaterThan(0)
}

async function openAttachments(page: Page, row: number): Promise<Locator> {
  const { x, y } = await cellCentre(page, COL.attachments, row)
  await page.mouse.dblclick(x, y)
  const editor = page.getByTestId('attachment-editor')
  await editor.waitFor()
  return editor
}

const uploads = (api: MockApi, uid: string) => api.requests.filter((r) => r.method === 'POST' && r.path.startsWith(`/api/workbooks/${WB}/tasks/${uid}/attachments?`))
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

// ---------------------------------------------------------------------------

describe('attachment cell editor (spec §5.2, §10)', () => {
  it('opens on the attachments cell; uploads by the button with progress, and by drag and drop; downloads; removes after confirmation, also by keyboard', async () => {
    const api = phase5Api()
    api.uploadDelayMs = 900
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    const editor = await openAttachments(page, 1)
    await editor.getByTestId('attachment-empty').waitFor()
    expect(await editor.innerText()).toContain('خطة الاتصال')
    expect(await editor.innerText()).toContain('100 ميغابايت')

    // The upload button (keyboard reachable) opens the file chooser; its input takes the file.
    const pdf = Buffer.from('%PDF-1.7 خطة الحملة للربع الأول')
    const chooser = page.waitForEvent('filechooser')
    await editor.getByTestId('attachment-upload').focus()
    await page.keyboard.press('Enter')
    await (await chooser).setFiles({ name: 'خطة الحملة.pdf', mimeType: 'application/pdf', buffer: pdf })
    const progress = editor.getByTestId('attachment-uploads').locator('progress')
    await progress.waitFor()
    expect(await progress.getAttribute('aria-label')).toContain('خطة الحملة.pdf')
    await shot(page, 'attachments-progress')
    await editor.getByTestId('attachment-chips').getByText('خطة الحملة.pdf').waitFor()
    await expect.poll(() => editor.getByTestId('attachment-announce').innerText()).toContain('رُفع الملف')
    const sent = uploads(api, 'u-1')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.path).toBe(`/api/workbooks/${WB}/tasks/u-1/attachments?name=${encodeURIComponent('خطة الحملة.pdf')}`)
    expect(sent[0]?.body).toMatchObject({ size: pdf.length, contentType: 'application/pdf' })

    // Drag and drop onto the dialog.
    api.uploadDelayMs = 0
    const dropzone = editor.getByTestId('attachment-dropzone')
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['png-bytes'], 'غلاف الحملة.png', { type: 'image/png' }))
      return dt
    })
    await dropzone.dispatchEvent('dragenter', { dataTransfer })
    await dropzone.dispatchEvent('dragover', { dataTransfer })
    expect(await dropzone.getAttribute('data-dragging')).toBe('true')
    await shot(page, 'attachments-drag')
    await dropzone.dispatchEvent('drop', { dataTransfer })
    await editor.getByTestId('attachment-chips').getByText('غلاف الحملة.png').waitFor()
    expect(await dropzone.getAttribute('data-dragging')).toBe('false')
    expect(uploads(api, 'u-1')).toHaveLength(2)
    expect(uploads(api, 'u-1')[1]?.body).toMatchObject({ size: 9, contentType: 'image/png' })
    expect(await editor.locator('[data-attachment-id]').count()).toBe(2)
    await shot(page, 'attachments-editor')

    // The chip is a download link through the proxy.
    const link = editor.locator('[data-attachment-id] a').first()
    expect(await link.getAttribute('href')).toMatch(new RegExp(`^/api/workbooks/${WB}/attachments/att-\\d+/download$`))
    expect(await link.getAttribute('download')).toBe('خطة الحملة.pdf')
    const href = (await link.getAttribute('href')) as string
    const download = page.waitForEvent('download')
    await link.click()
    // Clicking starts a download of the proxy path. (Chromium cancels a download whose response a
    // route fulfilled, so its bytes are read with fetch; the API's own headers are checked by
    // apps/api test/phase5/attachments.test.ts.)
    expect((await download).url()).toBe(`${BASE_URL}${href}`)
    const bytes = await page.evaluate(async (path) => Array.from(new Uint8Array(await (await fetch(path)).arrayBuffer())), href)
    expect(Buffer.from(bytes).equals(pdf)).toBe(true)

    // Remove: a confirmation first; cancelling sends nothing.
    await editor.getByTestId('attachment-remove').first().click()
    const confirm = editor.getByTestId('attachment-confirm')
    await confirm.waitFor()
    expect(await confirm.innerText()).toContain('Basecamp')
    expect(await confirm.innerText()).toContain('30')
    await shot(page, 'attachments-confirm')
    await confirm.getByTestId('attachment-confirm-cancel').click()
    await confirm.waitFor({ state: 'hidden' })
    expect(api.requests.filter((r) => r.path.endsWith('/remove'))).toHaveLength(0)

    // By keyboard: Delete on a chip opens the same confirmation; Enter confirms.
    await editor.locator('[data-attachment-id] a').first().focus()
    await page.keyboard.press('Delete')
    await confirm.waitFor()
    await confirm.getByTestId('attachment-confirm-remove').click()
    await expect.poll(() => editor.locator('[data-attachment-id]').count()).toBe(1)
    const removal = api.requests.find((r) => r.path.endsWith('/remove'))
    expect(removal?.body).toEqual({ confirmed: true })
    expect(await editor.getByTestId('attachment-chips').innerText()).toContain('غلاف الحملة.png')
    // The focus moved to the remaining chip.
    expect(await page.evaluate(() => document.activeElement?.closest('[data-attachment-id]') !== null)).toBe(true)
    await page.keyboard.press('Escape')
    await editor.waitFor({ state: 'hidden' })
    await context.close()
  })

  it('refuses a file over the limit before sending it, shows a server refusal, and retries a file Basecamp did not take', async () => {
    const api = phase5Api()
    api.attachmentSettings = { maxBytes: 1024, subtaskMode: 'local' }
    api.attachments['u-4'] = [existing({ id: 'att-failed', taskUid: 'u-4', filename: 'عرض.pptx', origin: 'local', state: 'failed', size: 900, message: 'رفض Basecamp إرفاق الملف لأن حسابك لا يصل إلى هذه المهمة هناك، فبقي في المنصة. اطلب من مدير المشروع في Basecamp إضافتك، ثم اضغط «إعادة المحاولة».', downloadPath: `/api/workbooks/${WB}/attachments/att-failed/download` })]
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    const editor = await openAttachments(page, 4)
    const failed = editor.locator('[data-attachment-id="att-failed"]')
    await failed.waitFor()
    expect(await failed.getAttribute('data-state')).toBe('failed')
    expect(await failed.innerText()).toContain('لم يُرسل')
    expect(await failed.innerText()).toContain('إعادة المحاولة')

    await editor.getByTestId('attachment-input').setInputFiles({ name: 'كبير.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048) })
    const refused = editor.getByTestId('attachment-uploads').locator('[data-phase="error"]')
    await refused.waitFor()
    expect(await refused.innerText()).toContain('1 كيلوبايت')
    expect(uploads(api, 'u-4')).toHaveLength(0)

    api.failNextUpload = error(409, 'task_busy', 'تجري مزامنة هذه المهمة الآن، فلم يكتمل الطلب ولم يتغيّر شيء في Basecamp. أعد المحاولة بعد لحظات.')
    await editor.getByTestId('attachment-input').setInputFiles({ name: 'صغير.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') })
    await expect.poll(() => refused.count()).toBe(2)
    expect(await refused.nth(1).innerText()).toContain('تجري مزامنة هذه المهمة الآن')
    await shot(page, 'attachments-errors')

    await failed.getByTestId('attachment-retry').click()
    await expect.poll(() => failed.getAttribute('data-state')).toBe('attached')
    expect(api.requests.some((r) => r.method === 'POST' && r.path === `/api/workbooks/${WB}/attachments/att-failed/retry`)).toBe(true)
    await context.close()
  })

  it('a subtask’s files stay in the platform, with the notice', async () => {
    const api = phase5Api()
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    const editor = await openAttachments(page, 2)
    await editor.getByTestId('attachment-notice').waitFor()
    expect(await editor.getByTestId('attachment-notice').innerText()).toContain('المهام الفرعية')
    await editor.getByTestId('attachment-input').setInputFiles({ name: 'مسودة.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('docx') })
    const chip = editor.locator('[data-attachment-id]')
    await chip.waitFor()
    expect(await chip.getAttribute('data-state')).toBe('local_only')
    expect(await chip.innerText()).toContain('في المنصة فقط')
    await shot(page, 'attachments-subtask')
    await context.close()
  })
})

describe('task details panel: comments (spec §12.1 item 5)', () => {
  it('reads a to-do’s comments and adds one; the counter on the row follows; a subtask shows its to-do’s comments', async () => {
    const api = phase5Api()
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    // The comment counter is drawn on the row (end of the title cell).
    await expect.poll(async () => (await marks(page))[SHEET]?.comments).toEqual({ 1: 2 })
    await page.waitForTimeout(300)
    await shot(page, 'comments-row-counter')
    await clickCell(page, COL.title, 1)
    const button = page.getByTestId('details-button')
    await expect.poll(() => page.getByTestId('details-button-count').innerText()).toBe('2')
    await button.click()
    const panel = page.getByTestId('details-panel')
    await panel.getByTestId('comment-list').waitFor()
    const items = panel.getByTestId('comment-list').locator('li')
    expect(await items.count()).toBe(2)
    expect(await items.first().innerText()).toContain('سارة القحطاني')
    expect(await items.first().innerText()).toContain('راجعت المسودة')
    expect(await items.first().innerText()).toContain('2026-11-10 11:15')
    expect(await panel.getByTestId('details-bc-link').getAttribute('href')).toBe('https://3.basecamp.com/5000001/buckets/4021/todos/u-1')
    expect(await panel.getByTestId('details-comment-count').innerText()).toBe('2')

    // An empty comment is refused in place, nothing sent.
    await panel.getByTestId('comment-send').click()
    await panel.getByTestId('comment-error').waitFor()
    expect(api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'))).toHaveLength(0)

    await panel.getByTestId('comment-input').fill('أُرسلت الخطة إلى الإدارة.\nبانتظار الرد.')
    await panel.getByTestId('comment-send').click()
    await panel.getByTestId('comment-sent').waitFor()
    expect(await items.count()).toBe(3)
    expect(await panel.getByTestId('details-comment-count').innerText()).toBe('3')
    const post = api.requests.find((r) => r.method === 'POST' && r.path === `/api/workbooks/${WB}/tasks/u-1/comments`)
    expect(post?.body).toEqual({ content: 'أُرسلت الخطة إلى الإدارة.\nبانتظار الرد.' })
    expect(await panel.getByTestId('details-attachments').innerText()).toContain('المرفقات')
    await shot(page, 'details-panel')
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })

    // A subtask's row: its to-do's comments, and it says so.
    await clickCell(page, COL.title, 2)
    await button.click()
    await panel.getByTestId('details-on-parent').waitFor()
    expect(await panel.getByTestId('details-on-parent').innerText()).toContain('خطة الاتصال')
    expect(await panel.locator('label').innerText()).toContain('المهمة الرئيسية')
    await shot(page, 'details-subtask')
    await page.keyboard.press('Escape')
    await context.close()
  })

  it('«إدارة المرفقات» in the panel opens the attachment editor of that row', async () => {
    const api = phase5Api()
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    await clickCell(page, COL.title, 3)
    await page.getByTestId('details-button').click()
    const panel = page.getByTestId('details-panel')
    await panel.getByTestId('details-attachments').getByText('دليل الهوية.pdf').waitFor()
    await panel.getByTestId('details-manage-attachments').click()
    const editor = page.getByTestId('attachment-editor')
    await editor.waitFor()
    await editor.getByText('دليل الهوية.pdf').waitFor()
    expect(await editor.locator('[data-attachment-id="att-guide"]').innerText()).toContain('2.3 ميغابايت')
    await context.close()
  })
})

describe('a viewer reads files and comments, and writes nothing', () => {
  it('no attachment editor from the cell, no upload or remove, no comment form; downloads and comments are there', async () => {
    const api = phase5Api({ access: 'viewer' })
    const { context, page } = await openEditor(api)
    await waitForMarks(page)
    const { x, y } = await cellCentre(page, COL.attachments, 3)
    await page.mouse.dblclick(x, y)
    await page.waitForTimeout(600)
    expect(await page.getByTestId('attachment-editor').count()).toBe(0)
    // The toolbar opens it read-only.
    await clickCell(page, COL.title, 3)
    await page.getByTestId('attachments-button').click()
    const editor = page.getByTestId('attachment-editor')
    await editor.getByTestId('attachment-read-only').waitFor()
    expect(await editor.getByTestId('attachment-upload').count()).toBe(0)
    expect(await editor.getByTestId('attachment-remove').count()).toBe(0)
    expect(await editor.locator('[data-attachment-id="att-guide"] a').getAttribute('href')).toBe(`/api/workbooks/${WB}/attachments/att-guide/download`)
    await shot(page, 'attachments-viewer')
    await page.keyboard.press('Escape')
    await clickCell(page, COL.title, 1)
    await page.getByTestId('details-button').click()
    const panel = page.getByTestId('details-panel')
    await panel.getByTestId('comment-list').waitFor()
    expect(await panel.getByTestId('comment-form').count()).toBe(0)
    await panel.getByTestId('comment-read-only').waitFor()
    expect(await panel.getByTestId('details-manage-attachments').count()).toBe(0)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([])
    await context.close()
  })
})

describe('narrow screens', () => {
  it('375 px wide: the attachment editor and the details panel fit without horizontal page scroll', async () => {
    const api = phase5Api()
    const { context, page } = await openEditor(api, { width: 375, height: 740 })
    await waitForMarks(page)
    await clickCell(page, COL.title, 3)
    await page.getByTestId('attachments-button').click()
    const editor = page.getByTestId('attachment-editor')
    await editor.getByText('دليل الهوية.pdf').waitFor()
    expect(await noHorizontalScroll(page)).toBe(true)
    const box = await editor.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true)
    await shot(page, 'attachments-375')
    await page.keyboard.press('Escape')
    await editor.waitFor({ state: 'hidden' })
    await clickCell(page, COL.title, 1)
    await page.getByTestId('details-button').click()
    const panel = page.getByTestId('details-panel')
    await panel.getByTestId('comment-list').waitFor()
    expect(await noHorizontalScroll(page)).toBe(true)
    const panelBox = await panel.boundingBox()
    expect(panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= 375).toBe(true)
    await shot(page, 'details-375')
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
