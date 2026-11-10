// Browser tests of phase 7 (spec §15): «من قالب ناف» in «ملف جديد» (§7.1),
// the admin screens — sync health (§9.4), templates (§7.1, §12.1 item 8),
// service tokens of the internal API (§13) — against the built app, the API
// mocked by route interception (mock-api.ts). Same harness as smoke.test.ts.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TemplateSummary } from '@naf-sheets/shared'
import { BASE_URL } from './global-setup'
import { MockApi, summary, taskSnapshot } from './mock-api'

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

function adminApi(): MockApi {
  const api = new MockApi()
  api.me = { user: { id: 'u-admin', name: 'مسؤول المنصة', email: 'admin@example.com', role: 'admin' } }
  return api
}

const TEMPLATE: TemplateSummary = {
  id: 'tpl-1',
  title: 'قالب حملة إعلامية',
  description: 'أوراق المحتوى والميزانية والمتابعة',
  sheetCount: 1,
  sourceWorkbookId: 'wb-src',
  sourceTitle: 'حملة اليوم الوطني',
  createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T08:00:00Z',
}

describe('«من قالب ناف» in «ملف جديد» (§7.1 option 2)', () => {
  it('lists the templates, suggests the template’s name, and opens the new workbook in the editor', async () => {
    const api = new MockApi()
    api.templates = [TEMPLATE]
    api.templateSnapshots['tpl-1'] = taskSnapshot('wb-tpl-src', 'sheet-1', 'قالب')
    const { context, page } = await openPage(api, '/')
    await page.getByTestId('files-empty').waitFor()
    await page.locator('.toolbar').getByRole('button', { name: 'ملف جديد', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'ملف جديد' })
    await dialog.waitFor()
    expect(api.count('GET', '/api/templates')).toBe(0)

    await dialog.getByLabel('من قالب ناف').check()
    const select = dialog.getByLabel('القالب', { exact: true })
    await select.waitFor()
    expect(api.count('GET', '/api/templates')).toBe(1)
    // Pressing «إنشاء» with no template says what to do and sends nothing.
    await dialog.getByRole('button', { name: 'إنشاء' }).click()
    expect(await dialog.getByTestId('new-file-error').innerText()).toContain('لم يُختر قالب')
    expect(api.count('POST', '/api/workbooks')).toBe(0)

    await select.selectOption('tpl-1')
    expect(await dialog.getByLabel('عنوان الملف').inputValue()).toBe('قالب حملة إعلامية')
    expect(await dialog.innerText()).toContain('أوراق المحتوى والميزانية والمتابعة')
    await dialog.getByLabel('عنوان الملف').fill('حملة رمضان 1448')
    await shot(page, 'phase7-new-from-template')
    await dialog.getByRole('button', { name: 'إنشاء' }).click()

    await page.waitForURL(`${BASE_URL}/workbooks/wb-tpl-1`)
    expect(api.bodies('POST', '/api/workbooks')).toEqual([{ title: 'حملة رمضان 1448', source: 'template', templateId: 'tpl-1' }])
    await page.locator('[data-testid="univer-host"][data-engine="ready"]').waitFor({ timeout: 60_000 })
    await context.close()
  })

  it('without templates, explains where they come from', async () => {
    const api = new MockApi()
    const { context, page } = await openPage(api, '/')
    await page.locator('.toolbar').getByRole('button', { name: 'ملف جديد', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'ملف جديد' })
    await dialog.getByLabel('من قالب ناف').check()
    expect(await dialog.getByTestId('templates-empty').innerText()).toContain('يحفظ مسؤول المنصة')
    await context.close()
  })
})

describe('sync health (§9.4, admin)', () => {
  function healthApi(): MockApi {
    const api = adminApi()
    api.syncHealth = {
      deadLetters: 3,
      workbooks: [
        { workbookId: 'wb-a', title: 'حملة اليوم الوطني', bcProjectId: 4021, counts: { error: 2, conflict: 1, pending: 5 }, lastSuccessAt: '2026-11-10T06:15:00Z', webhook: 'active' },
        { workbookId: 'wb-b', title: 'خطة المحتوى الربعية', bcProjectId: 4022, counts: { error: 0, conflict: 0, pending: 0 }, lastSuccessAt: null, webhook: 'inactive' },
        { workbookId: 'wb-c', title: 'تقارير الإعلام', bcProjectId: 4023, counts: { error: 0, conflict: 0, pending: 1 }, lastSuccessAt: '2026-11-09T21:00:00Z', webhook: 'missing' },
      ],
    }
    api.backups = { configured: true, runs: [{ id: 'run-1', startedAt: '2026-11-10T00:23:00Z', finishedAt: '2026-11-10T00:24:10Z', status: 'succeeded', tables: 24, rows: 18250, snapshots: 12, message: null }] }
    return api
  }

  it('is reached from «الإعدادات» and shows counts, last success, webhook state and dead letters', async () => {
    const api = healthApi()
    const { context, page } = await openPage(api, '/settings')
    await page.getByTestId('open-sync-health').click()
    await page.waitForURL(`${BASE_URL}/admin/sync-health`)
    const table = page.getByTestId('sync-health-table')
    await table.waitFor()
    expect(await page.locator('h1').innerText()).toBe('صحة المزامنة')

    const a = page.locator('tr[data-workbook-id="wb-a"]')
    expect(await a.locator('[data-col="errors"] [data-count]').getAttribute('data-count')).toBe('2')
    expect(await a.locator('[data-col="conflicts"] [data-count]').getAttribute('data-count')).toBe('1')
    expect(await a.locator('[data-col="pending"] [data-count]').getAttribute('data-count')).toBe('5')
    // Riyadh time, Latin digits, YYYY-MM-DD HH:mm.
    expect(await a.locator('[data-col="last-success"]').innerText()).toBe('2026-11-10 09:15')
    expect(await a.locator('[data-col="webhook"]').innerText()).toContain('يعمل')

    const b = page.locator('tr[data-workbook-id="wb-b"]')
    expect(await b.locator('[data-col="last-success"]').innerText()).toBe('لم تنجح بعد')
    expect(await b.locator('[data-col="webhook"]').innerText()).toContain('معطّل')
    expect(await b.locator('[data-col="webhook"]').innerText()).toContain('كل 15 دقيقة')
    expect(await page.locator('tr[data-workbook-id="wb-c"] [data-col="webhook"]').innerText()).toContain('غير مسجّل')
    // Meaning never by colour alone: every non-zero count and state has an icon and a label.
    expect(await table.locator('.badge svg').count()).toBeGreaterThanOrEqual(7)

    expect(await page.getByTestId('dead-letters').getAttribute('data-dead-letters')).toBe('3')
    expect(await page.getByTestId('dead-letters').innerText()).toContain('3 رسائل توقفت')
    expect(await page.getByTestId('backup-card').getAttribute('data-backup-status')).toBe('succeeded')
    expect(await page.getByTestId('backup-card').innerText()).toContain('18,250')

    // The workbook link opens the editor.
    expect(await a.getByRole('link', { name: 'حملة اليوم الوطني' }).getAttribute('href')).toBe('/workbooks/wb-a')
    await shot(page, 'phase7-sync-health')

    await page.getByTestId('sync-health-refresh').click()
    await expect.poll(() => api.count('GET', '/api/admin/sync-health')).toBe(2)
    await context.close()
  })

  it('fits a 375 px screen without a horizontal page scroll', async () => {
    const { context, page } = await openPage(healthApi(), '/admin/sync-health', { width: 375, height: 800 })
    await page.getByTestId('sync-health-table').waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await shot(page, 'phase7-sync-health-375')
    await context.close()
  })

  it('an empty report invites linking; an editor sees an explanation and no admin request is made', async () => {
    const api = adminApi()
    const { context, page } = await openPage(api, '/admin/sync-health')
    expect(await page.getByTestId('sync-health-empty').innerText()).toContain('معالج الربط')
    expect(await page.getByTestId('backup-card').innerText()).toContain('03:23')
    await context.close()

    const editor = new MockApi()
    const second = await openPage(editor, '/admin/sync-health')
    await second.page.getByTestId('admin-only').waitFor()
    expect(editor.count('GET', '/api/admin/sync-health')).toBe(0)
    // And the settings screen lists no admin entry for them.
    await second.page.goto(`${BASE_URL}/settings`)
    await second.page.locator('[data-screen="settings"]').waitFor()
    expect(await second.page.getByTestId('open-sync-health').count()).toBe(0)
    await second.context.close()
  })
})

describe('templates (§7.1, admin)', () => {
  it('saves a workbook as a template, renames it, and archives it after a confirmation', async () => {
    const api = adminApi()
    api.add(summary({ id: 'wb-src', title: 'حملة اليوم الوطني' }), taskSnapshot('wb-src', 'sheet-1', 'حملة اليوم الوطني'), 3)
    const { context, page } = await openPage(api, '/settings')
    await page.getByTestId('open-templates').click()
    await page.waitForURL(`${BASE_URL}/admin/templates`)
    await page.getByTestId('templates-empty').waitFor()

    const form = page.getByTestId('template-create')
    await form.getByRole('button', { name: 'حفظ قالباً' }).click()
    expect(await form.getByTestId('template-create-error').innerText()).toContain('لم يُختر ملف')
    await form.getByLabel('الملف', { exact: true }).selectOption('wb-src')
    expect(await form.getByLabel('اسم القالب').inputValue()).toBe('حملة اليوم الوطني')
    await form.getByLabel('اسم القالب').fill('قالب الحملات الوطنية')
    await form.getByLabel('الوصف (اختياري)').fill('ورقة المحتوى بأعمدتها الافتراضية')
    await form.getByRole('button', { name: 'حفظ قالباً' }).click()
    await form.getByTestId('template-created').waitFor()
    expect(api.bodies('POST', '/api/admin/templates')).toEqual([{ workbookId: 'wb-src', title: 'قالب الحملات الوطنية', description: 'ورقة المحتوى بأعمدتها الافتراضية' }])

    const row = page.locator('tr[data-template-id="tpl-new-1"]')
    await row.waitFor()
    expect(await row.innerText()).toContain('حملة اليوم الوطني')
    await shot(page, 'phase7-templates')

    await row.getByRole('button', { name: 'تعديل' }).click()
    await row.getByLabel('اسم القالب').fill('قالب الحملات')
    await row.getByRole('button', { name: 'حفظ' }).click()
    await expect.poll(() => api.bodies('PUT', '/api/admin/templates/tpl-new-1').length).toBe(1)
    await page.locator('tr[data-template-id="tpl-new-1"] th', { hasText: 'قالب الحملات' }).waitFor()

    await page.locator('tr[data-template-id="tpl-new-1"]').getByRole('button', { name: 'أرشفة' }).click()
    expect(await page.locator('tr[data-template-id="tpl-new-1"]').innerText()).toContain('لا يُحذف شيء')
    expect(api.count('POST', '/api/admin/templates/tpl-new-1/archive')).toBe(0)
    await page.locator('tr[data-template-id="tpl-new-1"]').getByRole('button', { name: 'تأكيد الأرشفة' }).click()
    await page.getByTestId('templates-empty').waitFor()
    expect(api.count('POST', '/api/admin/templates/tpl-new-1/archive')).toBe(1)
    await context.close()
  })
})

describe('service tokens of the internal API (§13, admin)', () => {
  it('creates a token, shows it once, and revokes it after a confirmation', async () => {
    const api = adminApi()
    const { context, page } = await openPage(api, '/admin/api-tokens')
    await page.getByTestId('tokens-empty').waitFor()
    expect(await page.getByTestId('api-endpoints').innerText()).toContain('GET /api/v1/stats')

    await page.getByRole('button', { name: 'إنشاء رمز' }).click()
    expect(await page.getByTestId('token-error').innerText()).toContain('اسم الرمز فارغ')
    await page.getByLabel('اسم الرمز (النظام الذي سيستخدمه)').fill('لوحة مؤشرات ناف')
    await page.getByRole('button', { name: 'إنشاء رمز' }).click()
    const secret = page.getByTestId('token-secret-value')
    await secret.waitFor()
    expect(await secret.inputValue()).toMatch(/^nafs_mock1/)
    const row = page.locator('tr[data-token-id="tok-1"]')
    await row.waitFor()
    expect(await row.getAttribute('data-revoked')).toBe('false')
    await shot(page, 'phase7-api-tokens')

    await page.getByRole('button', { name: 'تم النسخ، إخفاء الرمز' }).click()
    expect(await page.getByTestId('token-secret').count()).toBe(0)

    await row.getByRole('button', { name: 'إلغاء الرمز' }).click()
    await row.getByRole('button', { name: 'تأكيد الإلغاء' }).click()
    await page.locator('tr[data-token-id="tok-1"][data-revoked="true"]').waitFor()
    expect(api.count('POST', '/api/admin/api-tokens/tok-1/revoke')).toBe(1)
    await context.close()
  })
})

describe('hygiene', () => {
  it('raised no page error and reached nothing outside the preview server', () => {
    expect(pageErrors).toEqual([])
    expect(blockedRequests.filter((u) => !u.startsWith('https://cdn.jsdelivr.net/'))).toEqual([])
  })
})
