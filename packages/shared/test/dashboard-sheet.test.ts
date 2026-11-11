import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_EMBED_ANCHOR,
  DASHBOARD_SHEET_ID,
  DASHBOARD_SHEET_TITLE,
  SHEET_ROLE_KEY,
  UNIVER_EMBED_TAB_KEY,
  contentSheetIds,
  dashboardMutationProblem,
  ensureDashboardSheet,
  findDashboardSheetId,
  isDashboardSheet,
  roomMutationClass,
  withDashboardSheet,
  withoutDashboardSheet,
} from '../src'

const D = DASHBOARD_SHEET_ID

function workbook(over: Record<string, unknown> = {}) {
  return {
    id: 'wb',
    name: 'خطة',
    sheetOrder: ['s1', 's2'],
    sheets: {
      s1: { id: 's1', name: 'المهام', cellData: { 0: { 0: { v: 'المهمة' } } } },
      s2: { id: 's2', name: 'الميزانية', cellData: {} },
    },
    ...over,
  }
}

describe('ensureDashboardSheet', () => {
  it('adds «اللوحة» first, marked by platform data, with Univer\'s embed-tab anchor; the input is not changed', () => {
    const input = workbook()
    const before = JSON.stringify(input)
    const { workbook: out, sheetId, changed } = ensureDashboardSheet(input)
    expect(changed).toBe(true)
    expect(sheetId).toBe(D)
    expect(out.sheetOrder).toEqual([D, 's1', 's2'])
    expect(out.sheets[D as 's1']).toMatchObject({ id: D, name: DASHBOARD_SHEET_TITLE, hidden: 0, cellData: {} })
    const custom = (out.sheets as unknown as Record<string, { custom: Record<string, unknown> }>)[D]!.custom
    expect(custom[SHEET_ROLE_KEY]).toBe('dashboard')
    expect(custom[UNIVER_EMBED_TAB_KEY]).toEqual(DASHBOARD_EMBED_ANCHOR)
    expect(JSON.stringify(input)).toBe(before)
    expect(out.sheets.s1).toBe(input.sheets.s1)
  })

  it('is idempotent and deterministic (the API and the room must build the same model)', () => {
    const once = withDashboardSheet(workbook())
    expect(withDashboardSheet(once)).toBe(once)
    expect(JSON.stringify(withDashboardSheet(workbook()))).toBe(JSON.stringify(once))
  })

  it('moves an existing dashboard back to the first position and restores its name, visibility and anchor', () => {
    const dash = { id: D, name: 'غيّرها أحد', hidden: 1, custom: { [SHEET_ROLE_KEY]: 'dashboard', keep: 1 } }
    const input = workbook({ sheetOrder: ['s1', D, 's2'], sheets: { ...workbook().sheets, [D]: dash } })
    const { workbook: out, changed } = ensureDashboardSheet(input)
    expect(changed).toBe(true)
    expect(out.sheetOrder).toEqual([D, 's1', 's2'])
    const fixed = (out.sheets as Record<string, Record<string, unknown>>)[D]!
    expect(fixed).toMatchObject({ name: DASHBOARD_SHEET_TITLE, hidden: 0 })
    expect(fixed.custom).toEqual({ [SHEET_ROLE_KEY]: 'dashboard', keep: 1, [UNIVER_EMBED_TAB_KEY]: DASHBOARD_EMBED_ANCHOR })
    expect(dash.name).toBe('غيّرها أحد')
  })

  it('recognises the dashboard by its mark, not its id or name', () => {
    // A person's sheet named «اللوحة» that happens to hold the preferred id.
    const input = workbook({ sheetOrder: [D, 's1'], sheets: { [D]: { id: D, name: DASHBOARD_SHEET_TITLE, cellData: { 0: { 0: { v: 'بيانات' } } } }, s1: workbook().sheets.s1 } })
    expect(findDashboardSheetId(input)).toBeNull()
    const { workbook: out, sheetId } = ensureDashboardSheet(input)
    expect(sheetId).toBe(`${D}-2`)
    expect(out.sheetOrder).toEqual([`${D}-2`, D, 's1'])
    expect(contentSheetIds(out)).toEqual([D, 's1'])
  })

  it('handles a snapshot without sheetOrder, and leaves a non-workbook as it is', () => {
    const { sheetOrder: _omit, ...noOrder } = workbook()
    expect(withDashboardSheet(noOrder as never as ReturnType<typeof workbook>).sheetOrder).toEqual([D, 's1', 's2'])
    expect(ensureDashboardSheet({ sheets: null } as never)).toMatchObject({ changed: false, sheetId: '' })
  })
})

describe('contentSheetIds, withoutDashboardSheet', () => {
  it('lists every sheet but the dashboard, in tab order', () => {
    const wb = withDashboardSheet(workbook())
    expect(contentSheetIds(wb)).toEqual(['s1', 's2'])
    expect(isDashboardSheet((wb.sheets as Record<string, unknown>)[D])).toBe(true)
    expect(isDashboardSheet(wb.sheets.s1)).toBe(false)
  })

  it('strips the dashboard from sheets, order and plugin resources keyed by its id', () => {
    const wb = {
      ...withDashboardSheet(workbook()),
      resources: [
        { name: 'SHEET_FILTER_PLUGIN', data: JSON.stringify({ [D]: { x: 1 }, s1: { x: 2 } }) },
        { name: 'SHEET_DEFINED_NAME_PLUGIN', data: '' },
        { name: 'BROKEN', data: '{' },
      ],
    }
    const out = withoutDashboardSheet(wb)
    expect(out.sheetOrder).toEqual(['s1', 's2'])
    expect(Object.keys(out.sheets)).toEqual(['s1', 's2'])
    expect(out.resources).toEqual([
      { name: 'SHEET_FILTER_PLUGIN', data: JSON.stringify({ s1: { x: 2 } }) },
      { name: 'SHEET_DEFINED_NAME_PLUGIN', data: '' },
      { name: 'BROKEN', data: '{' },
    ])
    expect(withoutDashboardSheet(workbook())).toEqual(workbook())
  })
})

describe('dashboardMutationProblem (the room\'s and the editor\'s backstop)', () => {
  const p = (id: string, params: Record<string, unknown>) => dashboardMutationProblem(id, { unitId: 'wb', ...params }, D, roomMutationClass)

  it('refuses removing, moving, renaming, hiding, writing into it, and putting a sheet before it', () => {
    expect(p('sheet.mutation.remove-sheet', { subUnitId: D })).toBe('remove')
    expect(p('sheet.mutation.set-worksheet-order', { subUnitId: D, fromOrder: 0, toOrder: 2 })).toBe('move')
    expect(p('sheet.mutation.set-worksheet-order', { subUnitId: 's2', fromOrder: 2, toOrder: 0 })).toBe('insert_before')
    expect(p('sheet.mutation.insert-sheet', { index: 0, sheet: { id: 'n' } })).toBe('insert_before')
    expect(p('sheet.mutation.insert-sheet', { index: 3, sheet: { id: 'n', custom: { [SHEET_ROLE_KEY]: 'dashboard' } } })).toBe('second_dashboard')
    expect(p('sheet.mutation.set-worksheet-name', { subUnitId: D, name: 'x' })).toBe('edit')
    expect(p('sheet.mutation.set-worksheet-hidden', { subUnitId: D, hidden: 1 })).toBe('edit')
    expect(p('sheet.mutation.set-tab-color', { subUnitId: D, color: '#000' })).toBe('edit')
    expect(p('sheet.mutation.set-range-values', { subUnitId: D, cellValue: { 0: { 0: { v: 1 } } } })).toBe('edit')
    expect(p('sheet.mutation.insert-row', { subUnitId: D })).toBe('edit')
    expect(p('sheet.mutation.update-note', { sheetId: D })).toBe('edit')
  })

  it('lets everything else through: other sheets, and row heights / column widths on it', () => {
    expect(p('sheet.mutation.remove-sheet', { subUnitId: 's1' })).toBeNull()
    expect(p('sheet.mutation.set-worksheet-order', { subUnitId: 's2', fromOrder: 2, toOrder: 1 })).toBeNull()
    expect(p('sheet.mutation.insert-sheet', { index: 1, sheet: { id: 'n' } })).toBeNull()
    expect(p('sheet.mutation.set-range-values', { subUnitId: 's1', cellValue: {} })).toBeNull()
    expect(p('sheet.mutation.set-worksheet-row-auto-height', { subUnitId: D })).toBeNull()
    expect(p('sheet.mutation.set-worksheet-col-width', { subUnitId: D })).toBeNull()
    expect(dashboardMutationProblem('sheet.mutation.remove-sheet', { subUnitId: D }, '', roomMutationClass)).toBeNull()
  })
})
