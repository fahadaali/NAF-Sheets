// Realtime collaboration in the real editor (spec §11, phase 6): three
// browser contexts — owner, editor, viewer — open the same workbook in the
// built app, against the real API Worker and WorkbookRoom running locally
// under wrangler (`unstable_dev`: workerd/Miniflare, local D1/R2/Durable
// Objects, no network).
//
// What it proves: the editor UI (Univer, the right-to-left layer, React)
// sends its edits through the room and applies the others' edits; presence,
// the soft lock (a cell another person is editing does not open, and its
// frame is drawn in the grid) and the viewer's read-only grid work end to end.
// What it does not prove: production Cloudflare, naf-id sign-in (a test entry
// takes the member id from a header, apps/api/test/collab-e2e/worker.ts), the
// platform's real origin (Playwright forwards /api and the room's WebSocket to
// the local Worker), other browsers.

import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page, WebSocketRoute } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL } from './global-setup'

const SHOTS = process.env.E2E_SCREENSHOTS ?? fileURLToPath(new URL('./screenshots/', import.meta.url))
mkdirSync(SHOTS, { recursive: true })
const root = fileURLToPath(new URL('../../../../', import.meta.url))
// wrangler is the API's tool (apps/api devDependencies), resolved from the workspace.
const requireFromWeb = createRequire(join(root, 'apps/web/package.json'))

interface Wrangler {
  unstable_dev(script: string, options: Record<string, unknown>): Promise<{ port: number; stop(): Promise<void> }>
  unstable_splitSqlQuery(sql: string): string[]
}

type User = { id: string; name: string }
const OWNER: User = { id: 'collab-owner', name: 'سارة القحطاني' }
const EDITOR: User = { id: 'collab-editor', name: 'خالد العمري' }
const VIEWER: User = { id: 'collab-viewer', name: 'نورة السبيعي' }

let worker: { port: number; stop(): Promise<void> }
let browser: Browser
let workbookId = ''
let sheetId = ''
const contexts: BrowserContext[] = []

const api = (path: string, user: User, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${worker.port}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), 'x-test-user': user.id, 'content-type': 'application/json' } })

beforeAll(async () => {
  const wrangler = (await import(requireFromWeb.resolve('wrangler'))) as Wrangler
  worker = await wrangler.unstable_dev(join(root, 'apps/api/test/collab-e2e/worker.ts'), {
    config: join(root, 'apps/api/wrangler.toml'),
    local: true,
    persist: false,
    ip: '127.0.0.1',
    logLevel: 'warn',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  })
  const exec = async (statements: string[]) => {
    const res = await fetch(`http://127.0.0.1:${worker.port}/__test/exec`, { method: 'POST', body: JSON.stringify({ statements }) })
    if (!res.ok) throw new Error(`exec: ${res.status} ${await res.text()}`)
  }
  for (const file of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await exec(wrangler.unstable_splitSqlQuery(readFileSync(join(root, 'migrations', file), 'utf8')))
  }
  const now = Math.floor(Date.now() / 1000)
  await exec(
    [
      [OWNER, 'editor'],
      [EDITOR, 'editor'],
      [VIEWER, 'viewer'],
    ].map(([u, role]) => `INSERT INTO members (user_id, display_name, email, role, is_active, created_at) VALUES ('${(u as User).id}', '${(u as User).name}', '${(u as User).id}@naflaw.sa', '${role}', 1, ${now})`),
  )
  const created = await api('/api/workbooks', OWNER, { method: 'POST', body: JSON.stringify({ title: 'خطة التعاون اللحظي', source: 'blank' }) })
  workbookId = ((await created.json()) as { id: string }).id
  const members = await api(`/api/workbooks/${workbookId}/members`, OWNER, {
    method: 'PUT',
    body: JSON.stringify({ members: [{ userId: EDITOR.id, role: 'editor' }, { userId: VIEWER.id, role: 'viewer' }] }),
  })
  if (members.status !== 200) throw new Error(`members: ${members.status}`)
  const loaded = (await (await api(`/api/workbooks/${workbookId}`, OWNER)).json()) as { sheets: Array<{ univerSheetId: string }> }
  sheetId = loaded.sheets[0]!.univerSheetId
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined)
  await browser?.close()
  await worker?.stop()
})

/** The page's room socket, forwarded to the local Worker with this person's identity. */
function bridge(ws: WebSocketRoute, user: User): void {
  const url = new URL(ws.url())
  const upstream = new WebSocket(`ws://127.0.0.1:${worker.port}${url.pathname}?test-user=${encodeURIComponent(user.id)}`)
  const early: string[] = []
  upstream.addEventListener('open', () => {
    for (const m of early.splice(0)) upstream.send(m)
  })
  ws.onMessage((message) => {
    const text = typeof message === 'string' ? message : message.toString()
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text)
    else early.push(text)
  })
  upstream.addEventListener('message', (event) => ws.send(String(event.data)))
  upstream.addEventListener('close', (event) => void ws.close({ code: event.code >= 3000 || event.code === 1000 ? event.code : 1000, reason: event.reason }).catch(() => undefined))
  ws.onClose(() => upstream.close())
}

async function openAs(user: User): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
  contexts.push(context)
  // Hermetic: only the preview server; /api goes to the local Worker as this person.
  await context.route((url) => !url.href.startsWith(BASE_URL), (route) => route.abort())
  await context.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const response = await route.fetch({ url: `http://127.0.0.1:${worker.port}${url.pathname}${url.search}`, headers: { ...request.headers(), 'x-test-user': user.id } })
      await route.fulfill({ response })
    },
  )
  await context.routeWebSocket(/\/api\/workbooks\/[^/]+\/room$/, (ws) => bridge(ws, user))
  const page = await context.newPage()
  await page.goto(`${BASE_URL}/workbooks/${workbookId}`)
  await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 90_000 })
  await page.locator('[data-screen="editor"][data-collab="live"]').waitFor({ timeout: 60_000 })
  await expect.poll(() => page.getByTestId('univer-host').getAttribute('data-rtl-mirrored'), { timeout: 15_000 }).toBe('true')
  return page
}

// Univer 1.4.0 defaults on a local (not synced) sheet.
const GRID = { rowHeaderWidth: 46, columnHeaderHeight: 20, columnWidth: 88, rowHeight: 24 }

async function cellBox(page: Page, column: number, row: number) {
  const box = await page.locator('canvas[id^="univer-sheet-main-canvas"]').boundingBox()
  if (!box) throw new Error('sheet canvas not found')
  // Column A is at the visual right (the mirrored grid).
  const right = box.x + box.width - GRID.rowHeaderWidth - GRID.columnWidth * column
  return { x: right - GRID.columnWidth, y: box.y + GRID.columnHeaderHeight + GRID.rowHeight * row, width: GRID.columnWidth, height: GRID.rowHeight }
}

async function centre(page: Page, column: number, row: number) {
  const b = await cellBox(page, column, row)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function typeInto(page: Page, column: number, row: number, text: string) {
  const { x, y } = await centre(page, column, row)
  await page.mouse.dblclick(x, y)
  await page.waitForTimeout(300)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** Pixel colours of a cell as the person sees it (after the CSS mirror), inset from the grid lines. */
async function cellColours(page: Page, column: number, row: number, inset = 2): Promise<Array<[number, number, number]>> {
  const b = await cellBox(page, column, row)
  const png = (await page.screenshot({ clip: { x: b.x + inset, y: b.y + inset, width: b.width - 2 * inset, height: b.height - 2 * inset } })).toString('base64')
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
    const out: Array<[number, number, number]> = []
    for (let i = 0; i < pixels.length; i += 4) out.push([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!])
    return out
  }, png)
}

/** Text drawn in the cell: dark pixels (the theme's text is near black; the grid lines are light). */
const hasText = async (page: Page, column: number, row: number) => (await cellColours(page, column, row)).filter(([r, g, b]) => r + g + b < 200).length > 3

const near = (colours: Array<[number, number, number]>, rgb: [number, number, number], tolerance = 60) =>
  colours.some(([r, g, b]) => Math.abs(r - rgb[0]) + Math.abs(g - rgb[1]) + Math.abs(b - rgb[2]) <= tolerance)

/** The committed snapshot's value of a cell (the room commits 2 s after the last edit). */
async function committed(row: number, column: number): Promise<unknown> {
  const res = await api(`/api/workbooks/${workbookId}`, OWNER)
  const body = (await res.json()) as { snapshot: { sheets: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }> } }
  return body.snapshot.sheets[sheetId]?.cellData?.[row]?.[column]?.v
}

const root$ = (page: Page) => page.locator('[data-screen="editor"]')
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) })

describe('realtime collaboration in the browser (spec §11)', () => {
  let owner: Page
  let editor: Page
  let viewer: Page

  it('three people open the workbook: each is live and sees the other two', async () => {
    owner = await openAs(OWNER)
    editor = await openAs(EDITOR)
    viewer = await openAs(VIEWER)
    for (const [page, others] of [
      [owner, [EDITOR, VIEWER]],
      [editor, [OWNER, VIEWER]],
      [viewer, [OWNER, EDITOR]],
    ] as const) {
      await expect.poll(async () => ((await root$(page).getAttribute('data-room-peers')) ?? '').split(' ').filter(Boolean).sort(), { timeout: 15_000 }).toEqual(others.map((u) => u.id).sort())
      expect(await page.getByTestId('presence-avatar').count()).toBe(2)
    }
    expect(await owner.getByTestId('univer-host').getAttribute('data-editable')).toBe('true')
    expect(await editor.getByTestId('univer-host').getAttribute('data-editable')).toBe('true')
    expect(await viewer.getByTestId('univer-host').getAttribute('data-editable')).toBe('false')
    // No PUT autosave in a room session: the save indicator is the room's.
    expect(await owner.getByTestId('save-status').count()).toBe(0)
    expect(await owner.getByTestId('room-status').count()).toBe(1)
    await shot(owner, 'collab-presence')
  }, 240_000)

  it('each editor sees the other’s edits, and the room commits both', async () => {
    expect(await hasText(editor, 1, 2)).toBe(false)
    await typeInto(owner, 1, 2, 'من المالك')
    await expect.poll(() => hasText(editor, 1, 2), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => hasText(viewer, 1, 2), { timeout: 15_000 }).toBe(true)

    expect(await hasText(owner, 2, 3)).toBe(false)
    await typeInto(editor, 2, 3, 'من المحرر')
    await expect.poll(() => hasText(owner, 2, 3), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => hasText(viewer, 2, 3), { timeout: 15_000 }).toBe(true)

    await expect.poll(() => committed(2, 1), { timeout: 20_000 }).toBe('من المالك')
    await expect.poll(() => committed(3, 2), { timeout: 20_000 }).toBe('من المحرر')
    await shot(viewer, 'collab-remote-edits')
  }, 120_000)

  it('a cell open in one editor is framed and locked for the other until it closes', async () => {
    const target = { column: 3, row: 5 }
    const { x, y } = await centre(owner, target.column, target.row)
    await owner.mouse.dblclick(x, y)
    await expect
      .poll(async () => JSON.parse((await root$(editor).getAttribute('data-room-locks')) ?? '[]'), { timeout: 15_000 })
      .toEqual([{ userId: OWNER.id, sheetId, row: target.row, column: target.column }])
    // The owner's avatar shows they are editing, and their colour frames the cell in the editor's grid.
    const avatar = editor.locator(`[data-testid="presence-avatar"][data-user-id="${OWNER.id}"]`)
    await expect.poll(() => avatar.getAttribute('class'), { timeout: 5_000 }).toContain('is-editing')
    const colour = await avatar.evaluate((el) => getComputedStyle(el).backgroundColor)
    const rgb = colour.match(/\d+/g)!.slice(0, 3).map(Number) as [number, number, number]
    // The frame is drawn on the cell's edges: sample the whole cell.
    await expect.poll(async () => near(await cellColours(editor, target.column, target.row, 0), rgb), { timeout: 10_000 }).toBe(true)

    // The editor cannot open it.
    const other = await centre(editor, target.column, target.row)
    await editor.mouse.dblclick(other.x, other.y)
    const notice = editor.getByTestId('room-notice')
    await notice.waitFor({ timeout: 10_000 })
    expect(await notice.innerText()).toContain(OWNER.name)
    await shot(editor, 'collab-locked-cell')

    // Closing the cell editor releases the lock.
    await owner.keyboard.press('Escape')
    await expect.poll(async () => JSON.parse((await root$(editor).getAttribute('data-room-locks')) ?? '[]'), { timeout: 15_000 }).toEqual([])
    await expect.poll(() => avatar.getAttribute('class'), { timeout: 5_000 }).not.toContain('is-editing')
  }, 120_000)

  it('the viewer’s grid is read-only: typing changes nothing anywhere', async () => {
    await typeInto(viewer, 4, 6, 'محاولة القارئ')
    await viewer.waitForTimeout(3_000)
    expect(await root$(viewer).getAttribute('data-room-pending')).toBe('0')
    expect(await hasText(owner, 4, 6)).toBe(false)
    expect(await committed(6, 4)).toBeUndefined()
    expect(await viewer.getByTestId('editor-read-only').count()).toBe(1)
    await shot(viewer, 'collab-viewer')
  }, 60_000)
})
