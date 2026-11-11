// The dashboard tab «اللوحة» (@naf-sheets/shared dashboard-sheet.ts) is a real
// Univer worksheet, first in the tab bar, that holds no tasks: every entry
// point of this package refuses it, the content sheets read the same with or
// without it, and Univer 1.4.0 keeps its platform mark through load and save.

import { DASHBOARD_SHEET_ID, DASHBOARD_SHEET_TITLE, SHEET_ROLE_KEY, UNIVER_EMBED_TAB_KEY, isDashboardSheet, withDashboardSheet } from '@naf-sheets/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { applyInbound, decorateTaskRows, ensureSystemColumns, indentTaskRow, readTasks, type WorkbookSnapshot } from '../src'
import { blankWorkbook, counterUids, defaultPlan, linkedWorkbook, putRow } from './helpers'
import { loadHeadless, type HeadlessUniver } from './headless-univer'

const S = 'sheet-1'
const D = DASHBOARD_SHEET_ID

function linkedWithDashboard(): { workbook: WorkbookSnapshot; plan: ReturnType<typeof defaultPlan> } {
  const { workbook, plan } = linkedWorkbook(['إعداد الخطة', 'تصميم'])
  return { workbook: withDashboardSheet(workbook), plan }
}

describe('sheet-model and the dashboard sheet', () => {
  it('reads the content sheets the same with or without the dashboard sheet', () => {
    const { workbook: plain, plan } = linkedWorkbook(['إعداد الخطة', 'نشر'])
    const withDash = withDashboardSheet(plain)
    expect(withDash.sheetOrder).toEqual([D, S])
    const a = readTasks(plain, S, plan)
    const b = readTasks(withDash, S, plan)
    expect(b).toEqual(a)
    expect(b.ok && b.value.tasks.map((t) => t.title)).toEqual(['إعداد الخطة', 'نشر'])
  })

  it('refuses to read, link, decorate, indent or write into the dashboard sheet', () => {
    const { workbook: wb, plan: linkedPlan } = linkedWithDashboard()
    const plan = { ...linkedPlan, sheetId: 'p-dash' }
    const read = readTasks(wb, D, plan)
    expect(read.ok ? null : read.error.code).toBe('dashboard_sheet')
    expect(read.ok ? '' : read.error.message).toContain('«اللوحة»')

    const ensured = ensureSystemColumns(wb.sheets[D] as never, plan, counterUids())
    expect(ensured.ok ? null : ensured.error.code).toBe('dashboard_sheet')

    const decorated = decorateTaskRows(wb, D, plan, {})
    expect(decorated.ok ? null : decorated.error.code).toBe('dashboard_sheet')
    const indented = indentTaskRow(wb, D, plan, 'u-2')
    expect(indented.ok ? null : indented.error.code).toBe('dashboard_sheet')
    const inbound = applyInbound(wb, D, plan, [{ type: 'rewrite_managed_block', uid: 'u-1' } as never], { uidFactory: counterUids() } as never)
    expect(inbound.ok ? null : inbound.error.code).toBe('dashboard_sheet')
    // Nothing was written into it.
    expect(wb.sheets[D]).toMatchObject({ cellData: {} })
  })

  it('treats a sheet named «اللوحة» without the platform mark as an ordinary sheet', () => {
    const wb = blankWorkbook([{ id: 'mine', title: DASHBOARD_SHEET_TITLE }])
    putRow(wb, 'mine', 1, { A: 'مهمة في ورقة اسمها اللوحة' })
    const plan = defaultPlan('mine')
    const ensured = ensureSystemColumns(wb.sheets.mine as never, plan, counterUids())
    expect(ensured.ok).toBe(true)
    expect(isDashboardSheet(wb.sheets.mine)).toBe(false)
  })
})

describe('the dashboard sheet in a headless Univer 1.4.0', () => {
  let u: HeadlessUniver | undefined
  afterEach(() => {
    u?.dispose()
    u = undefined
  })

  it('loads as the first sheet, keeps its mark and Univer\'s embed-tab anchor through save, and holds no cells', () => {
    const data = withDashboardSheet(blankWorkbook())
    u = loadHeadless(data)
    const sheets = u.workbook.getSheets()
    expect(sheets.map((s) => s.getSheetId())).toEqual([D, S])
    expect(sheets[0]!.getName()).toBe(DASHBOARD_SHEET_TITLE)
    const custom = sheets[0]!.getCustomMetadata() as Record<string, unknown>
    expect(custom[SHEET_ROLE_KEY]).toBe('dashboard')
    expect(custom[UNIVER_EMBED_TAB_KEY]).toEqual({ version: 1, embedId: 'naf-dashboard', hostAnchorId: 'naf-dashboard' })

    const saved = u.workbook.save() as unknown as WorkbookSnapshot
    expect(saved.sheetOrder).toEqual([D, S])
    expect(isDashboardSheet(saved.sheets[D])).toBe(true)
    expect(saved.sheets[D]?.cellData).toEqual({})
    // Saving it again through the platform changes nothing.
    expect(withDashboardSheet(saved)).toBe(saved)
  })
})
