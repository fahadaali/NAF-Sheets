// The dashboard tab «اللوحة»: what the editor refuses on it
// (src/dashboard/sheet-guard.ts), and the Univer 1.4.0 extension point it
// relies on (src/dashboard/sheet-tab.ts), checked against the installed sources.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_EMBED_ANCHOR, SHEET_ROLE_KEY, UNIVER_EMBED_TAB_KEY } from '@naf-sheets/shared'
import { guardDashboardCommand, guardDashboardMutation } from '../../src/dashboard/sheet-guard'
import type { DashboardGuardContext } from '../../src/dashboard/sheet-guard'
import { t } from '../../src/strings'

const D = 'naf-dashboard'
const ts = t.dashboard.sheet

const ctx = (over: Partial<DashboardGuardContext> = {}): DashboardGuardContext => ({
  dashboardSheetId: D,
  activeSheetId: 's1',
  visibleContentSheetIds: ['s1', 's2'],
  ...over,
})

describe('guardDashboardCommand', () => {
  it('refuses deleting, renaming, hiding, copying, recolouring or moving the dashboard, named or active', () => {
    const cases: Array<[string, Record<string, unknown> | undefined, string]> = [
      ['sheet.command.remove-sheet', { subUnitId: D }, ts.cannotDelete],
      ['sheet.command.remove-sheet-confirm', { subUnitId: D }, ts.cannotDelete],
      ['sheet.command.set-worksheet-name', { subUnitId: D, name: 'لوحتي' }, ts.cannotRename],
      ['sheet.operation.rename-sheet', { subUnitId: D }, ts.cannotRename],
      ['sheet.command.set-worksheet-hidden', { subUnitId: D }, ts.cannotHide],
      ['sheet.command.copy-sheet', { subUnitId: D }, ts.cannotCopy],
      ['sheet.command.set-tab-color', { subUnitId: D, value: '#000000' }, ts.readOnly],
      ['sheet.command.set-worksheet-order', { subUnitId: D, order: 2 }, ts.cannotMove],
      ['sheet.command.add-worksheet-protection', { subUnitId: D }, ts.readOnly],
      ['sheet.command.add-range-protection-from-sheet-bar', { subUnitId: D }, ts.readOnly],
    ]
    for (const [id, params, message] of cases) {
      expect(guardDashboardCommand(id, params, ctx()), id).toEqual({ kind: 'refuse', message })
      // Without `subUnitId`, Univer acts on the active sheet.
      const { subUnitId: _omit, ...rest } = params ?? {}
      expect(guardDashboardCommand(id, rest, ctx({ activeSheetId: D })), `${id} (active)`).toEqual({ kind: 'refuse', message })
    }
    for (const message of Object.values(ts)) expect(message).toMatch(/[؀-ۿ]/)
  })

  it('keeps it first: no sheet moves before it, and a new sheet asked at position 0 goes right after it (a copy of the params)', () => {
    expect(guardDashboardCommand('sheet.command.set-worksheet-order', { subUnitId: 's2', order: 0 }, ctx())).toEqual({ kind: 'refuse', message: ts.staysFirst })
    expect(guardDashboardCommand('sheet.command.set-worksheet-order', { subUnitId: 's2', order: 1 }, ctx())).toEqual({ kind: 'allow' })
    const params = { index: 0, sheet: { name: 'جديدة' } }
    const decision = guardDashboardCommand('sheet.command.insert-sheet', params, ctx())
    expect(decision).toEqual({ kind: 'replace', params: { index: 1, sheet: { name: 'جديدة' } } })
    expect(params.index).toBe(0)
    expect(guardDashboardCommand('sheet.command.insert-sheet', { index: 3 }, ctx())).toEqual({ kind: 'allow' })
    expect(guardDashboardCommand('sheet.command.insert-sheet', undefined, ctx())).toEqual({ kind: 'allow' })
    // A second dashboard (inserting a copy of its data) is refused.
    expect(guardDashboardCommand('sheet.command.insert-sheet', { index: 2, sheet: { custom: { [SHEET_ROLE_KEY]: 'dashboard' } } }, ctx())).toEqual({ kind: 'refuse', message: ts.cannotCopy })
  })

  it('keeps one content sheet: the last one is neither deleted nor hidden (Univer counts the dashboard as a sheet)', () => {
    const one = ctx({ visibleContentSheetIds: ['s1'] })
    expect(guardDashboardCommand('sheet.command.remove-sheet', { subUnitId: 's1' }, one)).toEqual({ kind: 'refuse', message: ts.lastSheet })
    expect(guardDashboardCommand('sheet.command.remove-sheet-confirm', {}, one)).toEqual({ kind: 'refuse', message: ts.lastSheet })
    expect(guardDashboardCommand('sheet.command.set-worksheet-hidden', { subUnitId: 's1' }, one)).toEqual({ kind: 'refuse', message: ts.lastVisible })
    // A hidden sheet may still be deleted while one stays visible.
    expect(guardDashboardCommand('sheet.command.remove-sheet', { subUnitId: 'hidden' }, one)).toEqual({ kind: 'allow' })
    expect(guardDashboardCommand('sheet.command.remove-sheet', { subUnitId: 's2' }, ctx())).toEqual({ kind: 'allow' })
  })

  it('lets everything else through, on other sheets and on the dashboard (its writes are caught as mutations)', () => {
    for (const id of ['sheet.command.set-worksheet-name', 'sheet.command.copy-sheet', 'sheet.command.set-worksheet-hidden', 'sheet.command.set-tab-color']) {
      expect(guardDashboardCommand(id, { subUnitId: 's2' }, ctx()), id).toEqual({ kind: 'allow' })
    }
    expect(guardDashboardCommand('sheet.command.set-worksheet-activate', { subUnitId: D }, ctx())).toEqual({ kind: 'allow' })
    expect(guardDashboardCommand('sheet.command.set-range-values', {}, ctx({ activeSheetId: D }))).toEqual({ kind: 'allow' })
  })
})

describe('guardDashboardMutation', () => {
  const m = (id: string, params: Record<string, unknown>) => guardDashboardMutation(id, { unitId: 'wb', ...params }, { dashboardSheetId: D })

  it('refuses writes into the dashboard and changes to its place, with the matching message', () => {
    expect(m('sheet.mutation.set-range-values', { subUnitId: D, cellValue: { 0: { 0: { v: 1 } } } })).toEqual({ kind: 'refuse', message: ts.readOnly })
    expect(m('sheet.mutation.add-worksheet-merge', { subUnitId: D, ranges: [] })).toEqual({ kind: 'refuse', message: ts.readOnly })
    expect(m('sheet.mutation.update-note', { sheetId: D })).toEqual({ kind: 'refuse', message: ts.readOnly })
    expect(m('sheet.mutation.remove-sheet', { subUnitId: D })).toEqual({ kind: 'refuse', message: ts.cannotDelete })
    expect(m('sheet.mutation.set-worksheet-order', { subUnitId: D, fromOrder: 0, toOrder: 1 })).toEqual({ kind: 'refuse', message: ts.cannotMove })
    expect(m('sheet.mutation.set-worksheet-order', { subUnitId: 's1', fromOrder: 1, toOrder: 0 })).toEqual({ kind: 'refuse', message: ts.staysFirst })
  })

  it('lets row heights, column widths and every other sheet through', () => {
    expect(m('sheet.mutation.set-worksheet-row-auto-height', { subUnitId: D, rowsAutoHeightInfo: [] })).toEqual({ kind: 'allow' })
    expect(m('sheet.mutation.set-worksheet-col-width', { subUnitId: D, ranges: [] })).toEqual({ kind: 'allow' })
    expect(m('sheet.mutation.set-range-values', { subUnitId: 's1', cellValue: {} })).toEqual({ kind: 'allow' })
  })
})

describe('Univer 1.4.0 embed-tab anchor (the contract src/dashboard/sheet-tab.ts relies on)', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../../node_modules/@univerjs/sheets-ui/lib/es/index.js', import.meta.url)), 'utf8')
  const types = readFileSync(fileURLToPath(new URL('../../../../node_modules/@univerjs/sheets-ui/lib/types/index.d.ts', import.meta.url)), 'utf8')

  it('reads the custom key and accepts only version 1 with string ids', () => {
    expect(source).toContain(`const EMBED_SHEETS_TAB_CUSTOM_KEY = "${UNIVER_EMBED_TAB_KEY}"`)
    expect(source).toMatch(/candidate\.version === 1 && typeof candidate\.embedId === "string" && typeof candidate\.hostAnchorId === "string"/)
    expect(DASHBOARD_EMBED_ANCHOR.version).toBe(1)
  })

  it('renders the host element the editor looks for, covering the content, and asks the runtime service to mount it', () => {
    expect(source).toMatch(/"data-embed-sheets-sheet-tab-host": hostAnchorId,\s*className: "univer-absolute univer-inset-0/)
    expect(source).toMatch(/embedRuntimeService\.mountSheetTab\(\{\s*hostUnitId,\s*hostAnchorId,\s*embedId\s*\}\)/)
    expect(types).toMatch(/export \{ ISheetEmbedRuntimeService \} from '\.\/services\/sheet-embed-runtime\.service'/)
  })
})
