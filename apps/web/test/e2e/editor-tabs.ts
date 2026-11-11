// A workbook opens on its first tab, the dashboard «اللوحة» (owner, 2026-11-11).
// Tests about the grid choose the first content sheet the way a person does:
// by its tab in Univer's tab bar.

import type { Page } from 'playwright'

/** The dashboard sheet's id (packages/shared/src/dashboard-sheet.ts). */
export const DASHBOARD_SHEET_ID = 'naf-dashboard'

const TABS = '[data-u-comp="slide-tab-item"]'

/** After the engine is ready: leave the dashboard for the first sheet tab after it. No-op without a dashboard. */
export async function openFirstSheet(page: Page): Promise<void> {
  const host = page.getByTestId('univer-host')
  if ((await host.getAttribute('data-active-sheet')) !== DASHBOARD_SHEET_ID) return
  const first = page.locator(`${TABS}:not([data-id="${DASHBOARD_SHEET_ID}"])`).first()
  const id = await first.getAttribute('data-id')
  await first.click()
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="univer-host"]')?.getAttribute('data-active-sheet') === want,
    id,
    { timeout: 15_000 },
  )
}
