// Browser tests of «أعضاء المنصة» (/admin/members): the admin screen for
// platform roles and the active state, against the built app with the API
// mocked by route interception (mock-api.ts). Same harness as phase7.test.ts.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlatformMember } from '@naf-sheets/shared'
import { BASE_URL } from './global-setup'
import { MockApi } from './mock-api'

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

async function openPage(api: MockApi, path: string, viewport = { width: 1280, height: 800 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' })
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

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })

function member(over: Partial<PlatformMember> & Pick<PlatformMember, 'userId' | 'name' | 'role'>): PlatformMember {
  return {
    email: `${over.userId}@naflaw.sa`,
    active: true,
    lastSeenAt: '2026-11-10T22:30:00Z',
    createdAt: '2026-11-01T08:00:00Z',
    basecamp: { state: 'none', bcPersonId: null, personName: null },
    ...over,
  }
}

function membersApi(): MockApi {
  const api = new MockApi()
  api.me = { user: { id: 'u-admin', name: 'فهد العتيبي', email: 'fahad@naflaw.sa', role: 'admin' } }
  api.platformMembers = [
    member({ userId: 'u-admin', name: 'فهد العتيبي', role: 'admin', email: 'fahad@naflaw.sa', basecamp: { state: 'auto', bcPersonId: 900, personName: 'Fahad Alotaibi' } }),
    member({ userId: 'u-sara', name: 'سارة القحطاني', role: 'editor', basecamp: { state: 'manual', bcPersonId: 901, personName: 'Sara Q.' } }),
    member({ userId: 'u-ali', name: 'علي الدوسري', role: 'viewer', lastSeenAt: null }),
    member({ userId: 'u-noura', name: 'نورة الشهري', role: 'viewer', active: false, basecamp: { state: 'declined', bcPersonId: null, personName: null } }),
  ]
  api.peopleMatches = {
    matches: [
      { userId: 'u-admin', name: 'فهد العتيبي', email: 'fahad@naflaw.sa', bcPersonId: 900, source: 'email' },
      { userId: 'u-sara', name: 'سارة القحطاني', email: 'u-sara@naflaw.sa', bcPersonId: 901, source: 'manual' },
      { userId: 'u-ali', name: 'علي الدوسري', email: 'u-ali@naflaw.sa', bcPersonId: null, source: null },
    ],
    people: [
      { id: 900, name: 'Fahad Alotaibi', email: 'fahad@naflaw.sa', avatarUrl: null, personableType: 'User', client: false },
      { id: 901, name: 'Sara Q.', email: 'sara@naflaw.sa', avatarUrl: null, personableType: 'User', client: false },
    ],
  }
  return api
}

const row = (page: Page, userId: string) => page.locator(`tr[data-user-id="${userId}"]`)

describe('«أعضاء المنصة» (/admin/members)', () => {
  it('is the first entry of the settings’ admin section and opens the screen', async () => {
    const api = membersApi()
    const { context, page } = await openPage(api, '/settings')
    const section = page.getByTestId('admin-section')
    await section.waitFor()
    const firstLink = section.locator('a').first()
    expect(await firstLink.getAttribute('data-testid')).toBe('open-members')
    expect(await section.locator('h3').first().innerText()).toBe('أعضاء المنصة')
    await firstLink.click()
    await page.getByTestId('members-table').waitFor()
    expect(new URL(page.url()).pathname).toBe('/admin/members')
    expect(await page.title()).toContain('أعضاء المنصة')
    await context.close()
  })

  it('shows each member: name, isolated email, role, status, last sign-in, Basecamp match', async () => {
    const api = membersApi()
    const { context, page } = await openPage(api, '/admin/members')
    await page.getByTestId('members-table').waitFor()
    expect(await page.getByTestId('members-first-sign-in').innerText()).toContain('أول دخول')

    const sara = row(page, 'u-sara')
    expect(await sara.locator('bdi[dir="ltr"]').first().innerText()).toBe('u-sara@naflaw.sa')
    expect(await sara.getByTestId('member-role').inputValue()).toBe('editor')
    expect(await sara.getByTestId('member-role').locator('option').allInnerTexts()).toEqual(['مسؤول', 'محرّر', 'مشاهد'])
    expect(await sara.getByTestId('member-status').innerText()).toContain('نشط')
    // 22:30 UTC on 10 Nov is 11 Nov in Riyadh: YYYY-MM-DD, Latin digits.
    expect(await sara.locator('bdi.num').innerText()).toBe('2026-11-11')
    expect(await sara.locator('[data-match]').innerText()).toContain('مطابَق يدوياً')
    expect(await sara.innerText()).toContain('Sara Q.')
    expect(await row(page, 'u-ali').innerText()).toContain('لم يُسجَّل')
    expect(await row(page, 'u-ali').locator('[data-match]').innerText()).toContain('غير مطابَق')
    expect(await row(page, 'u-noura').getByTestId('member-status').innerText()).toContain('موقوف')
    expect(await row(page, 'u-noura').getByTestId('member-open-match').count()).toBe(0)

    // The admin's own row is locked and says why.
    const self = row(page, 'u-admin')
    expect(await self.getByTestId('member-role').isDisabled()).toBe(true)
    expect(await self.getByTestId('member-suspend').count()).toBe(0)
    expect(await self.getByTestId('member-self-hint').innerText()).toContain('مسؤول آخر')
    expect(await self.innerText()).toContain('أنت')

    await shot(page, 'members-desktop')
    await context.close()
  })

  it('changes a role and names the action in the success message', async () => {
    const api = membersApi()
    const { context, page } = await openPage(api, '/admin/members')
    const ali = row(page, 'u-ali')
    await ali.getByTestId('member-role').waitFor()
    expect(await ali.getByTestId('member-save-role').isDisabled()).toBe(true)
    await ali.getByTestId('member-role').selectOption('editor')
    await ali.getByTestId('member-save-role').click()
    await page.getByTestId('members-outcome').getByText('تم تغيير الدور إلى «محرّر»').waitFor()
    expect(await page.getByTestId('members-outcome').innerText()).toContain('علي الدوسري')
    expect(api.bodies('PUT', '/api/admin/members/u-ali')).toEqual([{ role: 'editor' }])
    await page.waitForFunction(() => document.querySelector('tr[data-user-id="u-ali"]')?.getAttribute('data-role') === 'editor')
    await context.close()
  })

  it('asks before suspending, can be kept active, then suspends and reactivates', async () => {
    const api = membersApi()
    const { context, page } = await openPage(api, '/admin/members')
    const sara = row(page, 'u-sara')
    await sara.getByTestId('member-suspend').click()
    const confirm = sara.getByTestId('member-suspend-confirm')
    expect(await confirm.innerText()).toContain('لا يُحذف شيء')
    await shot(page, 'members-confirm')
    await confirm.getByRole('button', { name: 'الإبقاء نشطاً' }).click()
    expect(await sara.getByTestId('member-suspend-confirm').count()).toBe(0)
    expect(api.count('PUT', '/api/admin/members/u-sara')).toBe(0)

    await sara.getByTestId('member-suspend').click()
    await sara.getByTestId('member-suspend-yes').click()
    await page.getByTestId('members-outcome').getByText('تم الإيقاف').waitFor()
    expect(api.bodies('PUT', '/api/admin/members/u-sara')).toEqual([{ active: false }])
    await sara.getByTestId('member-reactivate').waitFor()
    expect(await sara.getByTestId('member-status').innerText()).toContain('موقوف')

    await sara.getByTestId('member-reactivate').click()
    await page.getByTestId('members-outcome').getByText('تمت إعادة التفعيل').waitFor()
    expect(api.bodies('PUT', '/api/admin/members/u-sara')).toEqual([{ active: false }, { active: true }])
    await context.close()
  })

  it('says when naf-id could not be told, and the change still shows', async () => {
    const api = membersApi()
    api.memberReport = 'failed'
    const { context, page } = await openPage(api, '/admin/members')
    const ali = row(page, 'u-ali')
    await ali.getByTestId('member-role').selectOption('admin')
    await ali.getByTestId('member-save-role').click()
    const outcome = page.getByTestId('members-outcome')
    await outcome.getByText('تعذّر إبلاغ naf-id').waitFor()
    expect(await outcome.innerText()).toContain('ساري في المنصة')
    await context.close()
  })

  it('locks the last active admin and explains it; the API’s refusal is shown inline', async () => {
    const api = membersApi()
    // Signed in as another admin who is not in the list as active (e.g. just suspended elsewhere).
    api.me = { user: { id: 'u-elsewhere', name: 'مسؤول آخر', email: 'x@naflaw.sa', role: 'admin' } }
    const { context, page } = await openPage(api, '/admin/members')
    const fahad = row(page, 'u-admin')
    await fahad.getByTestId('member-last-admin-hint').waitFor()
    expect(await fahad.getByTestId('member-last-admin-hint').innerText()).toContain('آخر مسؤول نشط')
    expect(await fahad.getByTestId('member-role').isDisabled()).toBe(true)

    // The API's own message when the guard bites on a row the screen did not lock (a stale list).
    api.override = (req) =>
      req.method === 'PUT' && req.path === '/api/admin/members/u-sara'
        ? { status: 409, body: { ok: false, error: 'last_active_admin', message: 'لم يُحفظ التغيير: هذا آخر مسؤول نشط في المنصة. رقِّ عضواً آخر إلى «مسؤول» أولاً، ثم أعد المحاولة.' } }
        : undefined
    const sara = row(page, 'u-sara')
    await sara.getByTestId('member-role').selectOption('viewer')
    await sara.getByTestId('member-save-role').click()
    expect(await sara.getByTestId('member-error').innerText()).toContain('آخر مسؤول نشط')
    await context.close()
  })

  it('links a member to their row in the people matching, focused', async () => {
    const api = membersApi()
    const { context, page } = await openPage(api, '/admin/members')
    await row(page, 'u-ali').getByTestId('member-open-match').click()
    await page.getByTestId('people-table').waitFor()
    expect(new URL(page.url()).pathname).toBe('/admin/people-matches')
    expect(new URL(page.url()).hash).toBe('#match-u-ali')
    await page.waitForFunction(() => document.activeElement?.id === 'match-u-ali')
    await context.close()
  })

  it('fits a 375 px screen without a horizontal page scroll; focus is visible', async () => {
    const api = membersApi()
    const { context, page } = await openPage(api, '/admin/members', { width: 375, height: 800 })
    await page.getByTestId('members-table').waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl')

    const select = row(page, 'u-sara').getByTestId('member-role')
    await select.focus()
    await page.keyboard.press('Tab')
    const focusStyle = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return null
      const s = getComputedStyle(el)
      return { tag: el.tagName, outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }
    })
    expect(focusStyle?.tag).toBe('BUTTON')
    expect(focusStyle?.outline !== 'none' || focusStyle?.shadow !== 'none').toBe(true)
    await shot(page, 'members-375')
    await context.close()
  })

  it('an editor sees an explanation and no admin request is made', async () => {
    const api = membersApi()
    api.me = { user: { id: 'u-sara', name: 'سارة القحطاني', email: 'u-sara@naflaw.sa', role: 'editor' } }
    const { context, page } = await openPage(api, '/admin/members')
    await page.getByTestId('admin-only').waitFor()
    expect(api.count('GET', '/api/admin/members')).toBe(0)
    await context.close()

    const settings = await openPage(api, '/settings')
    await settings.page.locator('main').waitFor()
    expect(await settings.page.getByTestId('open-members').count()).toBe(0)
    await settings.context.close()
  })

  it('had no page errors and no requests outside the app', () => {
    expect(pageErrors).toEqual([])
    expect(blockedRequests.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/'))).toEqual([])
  })
})
