import { describe, expect, it } from 'vitest'
import { DASHBOARD_SHEET_ID, DEFAULT_COLUMNS, isDashboardSheet, withDashboardSheet } from '@naf-sheets/shared'
import type { SheetMeta, WorkbookResponse } from '@naf-sheets/shared'
import { blankWorkbookData, DERIVED_MUTATIONS, GRID_FONT, isPersistentChange, resolveWorkbookData } from '../../src/editor/workbook-data'

const sheet = (over: Partial<SheetMeta> = {}): SheetMeta => ({
  id: 's1',
  univerSheetId: 'sheet-1',
  title: 'المهام',
  position: 0,
  syncMode: 'local',
  bcTodolistId: null,
  headerRow: 1,
  ...over,
})

const response = (snapshot: unknown, sheets: SheetMeta[] = [sheet()]): Pick<WorkbookResponse, 'workbook' | 'sheets' | 'snapshot'> => ({
  workbook: {
    id: 'wb-1',
    title: 'خطة الاتصال',
    bcProjectId: null,
    sheetCount: sheets.length,
    completion: null,
    syncState: 'unlinked',
    updatedAt: '2026-11-10T10:00:00Z',
    access: 'owner',
    ownerId: 'u1',
    source: 'blank',
    createdAt: '2026-11-10T10:00:00Z',
  },
  sheets,
  snapshot,
})

describe('blankWorkbookData', () => {
  it('builds one sheet per meta, ordered, with the default columns in the header row', () => {
    const data = blankWorkbookData('wb-1', 'خطة', [sheet({ univerSheetId: 'b', title: 'ثانية', position: 1, headerRow: 2 }), sheet({ univerSheetId: 'a', position: 0 })])
    expect(data.id).toBe('wb-1')
    expect(data.name).toBe('خطة')
    // The dashboard tab «اللوحة» first, then the sheets.
    expect(data.sheetOrder).toEqual([DASHBOARD_SHEET_ID, 'a', 'b'])
    expect(isDashboardSheet(data.sheets?.[DASHBOARD_SHEET_ID])).toBe(true)
    const a = data.sheets?.a
    expect(a?.name).toBe('المهام')
    expect(a?.rightToLeft).toBe(1)
    expect(a?.defaultStyle).toEqual({ ff: GRID_FONT })
    expect(Object.values(a?.cellData?.[0] ?? {}).map((c) => c?.v)).toEqual([...DEFAULT_COLUMNS])
    // headerRow is 1-based
    expect(data.sheets?.b?.cellData?.[1]?.[0]?.v).toBe(DEFAULT_COLUMNS[0])
  })
})

describe('resolveWorkbookData', () => {
  it('uses a stored snapshot as is, filling a missing id from the workbook, with the dashboard tab first', () => {
    const snapshot = { name: 'x', sheetOrder: ['s'], sheets: { s: { id: 's', cellData: {} } } }
    const resolved = resolveWorkbookData(response(snapshot))
    expect(resolved).toEqual({ ok: true, source: 'snapshot', data: { ...withDashboardSheet(snapshot), id: 'wb-1' } })
    expect(resolved.ok && resolved.data.sheetOrder).toEqual([DASHBOARD_SHEET_ID, 's'])
    expect(snapshot).not.toHaveProperty('id')
    expect(snapshot.sheetOrder).toEqual(['s'])
  })

  it('leaves a snapshot that already has its dashboard tab (as the API and the room send it) unchanged', () => {
    const snapshot = withDashboardSheet({ id: 'wb-1', name: 'x', sheetOrder: ['s'], sheets: { s: { id: 's', cellData: {} } } })
    const resolved = resolveWorkbookData(response(snapshot))
    expect(resolved.ok && resolved.data).toEqual(snapshot)
  })

  it('keeps the snapshot id when it has one', () => {
    const resolved = resolveWorkbookData(response({ id: 'unit-9', sheets: { s: {} } }))
    expect(resolved.ok && resolved.data.id).toBe('unit-9')
  })

  it('builds a blank workbook when there is no snapshot yet', () => {
    const resolved = resolveWorkbookData(response(null))
    expect(resolved.ok && resolved.source).toBe('blank')
    expect(resolved.ok && resolved.data.sheetOrder).toEqual([DASHBOARD_SHEET_ID, 'sheet-1'])
  })

  it('refuses to guess: no snapshot and no sheets, or a snapshot that is not a workbook', () => {
    expect(resolveWorkbookData(response(null, []))).toEqual({ ok: false })
    for (const bad of ['text', 42, [], {}, { sheets: [] }, { sheets: {} }, { sheets: { s: {} }, sheetOrder: 's' }]) {
      expect(resolveWorkbookData(response(bad)), JSON.stringify(bad)).toEqual({ ok: false })
    }
  })
})

describe('isPersistentChange', () => {
  const MUTATION = 2
  const OPERATION = 1
  const base = { id: 'sheet.mutation.set-range-values', type: MUTATION, params: { unitId: 'wb-1', subUnitId: 's' } }

  it('accepts a mutation of this workbook', () => {
    expect(isPersistentChange(base, 'wb-1', MUTATION)).toBe(true)
    expect(isPersistentChange({ ...base, options: {} }, 'wb-1', MUTATION)).toBe(true)
  })

  it('ignores operations, other units, local-only, collaborators and derived layout', () => {
    expect(isPersistentChange({ ...base, id: 'sheet.operation.set-selections', type: OPERATION }, 'wb-1', MUTATION)).toBe(false)
    expect(isPersistentChange({ ...base, params: { unitId: 'cell-editor-doc' } }, 'wb-1', MUTATION)).toBe(false)
    expect(isPersistentChange({ ...base, params: undefined }, 'wb-1', MUTATION)).toBe(false)
    expect(isPersistentChange({ ...base, options: { onlyLocal: true } }, 'wb-1', MUTATION)).toBe(false)
    expect(isPersistentChange({ ...base, options: { fromCollab: true } }, 'wb-1', MUTATION)).toBe(false)
    for (const id of DERIVED_MUTATIONS) expect(isPersistentChange({ ...base, id }, 'wb-1', MUTATION)).toBe(false)
  })
})
