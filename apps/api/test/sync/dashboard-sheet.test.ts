// Sync never reads the dashboard tab «اللوحة» (@naf-sheets/shared
// dashboard-sheet.ts): it has no D1 row, so the link plan cannot name it and
// outbound detection never looks at it — even if cells were forced into it.

import { describe, expect, it } from 'vitest'
import { DASHBOARD_SHEET_ID, isDashboardSheet } from '@naf-sheets/shared'
import type { WorkbookSyncResponse } from '@naf-sheets/shared'
import { call, createWorkbook, json, seedMember } from '../helpers'
import { defaultSheetPlan, drainOutbound, edit, harness, readSheetView, setupLinked } from './harness'

describe('sync and the dashboard sheet', () => {
  it('detects nothing in it: rows written there by a client that bypassed the editor are never sent', async () => {
    const h = harness()
    const l = await setupLinked(h, { rows: [{ title: 'إعداد الخطة' }] })
    const todosBefore = h.fake.todos.size
    const view = await readSheetView(l)
    expect(isDashboardSheet(view.snapshot.sheets[DASHBOARD_SHEET_ID])).toBe(true)

    // Header, system columns and a task-like row copied into the dashboard sheet.
    await edit(l, (v) => {
      const content = v.snapshot.sheets[l.univerSheetId] as { cellData: Record<number, Record<number, unknown>> }
      const dash = v.snapshot.sheets[DASHBOARD_SHEET_ID] as { cellData: Record<number, Record<number, unknown>> }
      dash.cellData = { 0: structuredClone(content.cellData[0]!), 1: { 0: { v: 'مهمة مكتوبة في اللوحة' } } }
      v.set(v.row('إعداد الخطة'), 'A', 'إعداد الخطة المعدّلة')
    })
    await drainOutbound(h)

    expect(h.fake.todos.size).toBe(todosBefore)
    expect([...h.fake.todos.values()].map((t) => t.content)).toContain('إعداد الخطة المعدّلة')
    expect([...h.fake.todos.values()].some((t) => t.content === 'مهمة مكتوبة في اللوحة')).toBe(false)
    const sync = await json<WorkbookSyncResponse>(await call(h.app, 'GET', `/api/workbooks/${l.wbId}/sync`, { user: l.owner, env: h.env }))
    expect(sync.tasks).toHaveLength(1)
  })

  it('the link plan cannot name it (it has no D1 sheet), and the wizard\'s preview refuses it', async () => {
    const h = harness()
    const owner = await seedMember('editor')
    const wbId = await createWorkbook(h.app, owner)
    for (const path of [`/api/workbooks/${wbId}/link/preview`, `/api/workbooks/${wbId}/link`]) {
      const res = await call(h.app, 'POST', path, {
        user: owner,
        env: h.env,
        body: { project: { mode: 'new', name: 'مشروع' }, sheets: [defaultSheetPlan(DASHBOARD_SHEET_ID, { mode: 'new' })] },
      })
      expect(res.status, path).toBe(400)
    }
  })
})
