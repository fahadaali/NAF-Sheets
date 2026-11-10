// Snapshots of a synced sheet for the wave 3 unit tests, built the way the
// server builds them: sheet-model's `ensureSystemColumns` adds the system
// columns and the uids.

import { ensureSystemColumns, type WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { DEFAULT_COLUMNS } from '@naf-sheets/shared'
import type { SheetMeta, SheetPlan } from '@naf-sheets/shared'
import type { ICellData, IWorksheetData } from '@univerjs/core'

export const SHEET = 'sheet-1'
export const META: SheetMeta = { id: 'meta-1', univerSheetId: SHEET, title: 'المهام', position: 1, syncMode: 'synced', bcTodolistId: 70, headerRow: 1 }
/** DEFAULT_COLUMNS: A title, B assignees, C starts_on, D due_on, E status, F attachments, G notes; system H, I, J. */
export const COL = { title: 0, assignees: 1, starts: 2, due: 3, status: 4, attachments: 5, notes: 6, uid: 7, parent: 8, level: 9 } as const

export const PLAN: SheetPlan = {
  sheetId: META.id,
  mode: 'new',
  headerRow: 1,
  columns: DEFAULT_COLUMNS.map((_, i) => ({
    columnKey: 'ABCDEFG'[i] as string,
    field: (['title', 'assignees', 'starts_on', 'due_on', 'completed', 'attachments', 'notes'] as const)[i] as SheetPlan['columns'][number]['field'],
  })),
  completedValues: [],
  hierarchy: { mode: 'indent' },
  existingTasks: 'create_all',
  assigneeMatches: {},
}

export interface RowSpec {
  title: string
  level?: 0 | 1
  cells?: Record<number, ICellData>
}

/** A workbook whose sheet has the default header and `rows` from row 2, with uids u-1, u-2… */
export function syncedWorkbook(rows: RowSpec[]): WorkbookSnapshot {
  const cellData: Record<number, Record<number, ICellData>> = { 0: Object.fromEntries(DEFAULT_COLUMNS.map((v, c) => [c, { v }])) }
  rows.forEach((r, i) => {
    cellData[i + 1] = { [COL.title]: { v: r.title }, ...(r.cells ?? {}) }
  })
  const sheet: Partial<IWorksheetData> = { id: SHEET, name: 'المهام', rowCount: 1000, columnCount: 20, cellData }
  let n = 0
  let lastTodo: number | null = null
  const levels = rows.map((r, i) => {
    const level = r.level ?? 0
    const row = i + 1
    if (level === 0) lastTodo = row
    return { row, level, parentRow: level === 1 ? lastTodo : null }
  })
  const ensured = ensureSystemColumns(sheet as never, PLAN, () => `u-${++n}`, { levels })
  if (!ensured.ok) throw new Error(ensured.error.message)
  return { id: 'wb', appVersion: '1.4.0', styles: {}, sheetOrder: [SHEET], sheets: { [SHEET]: ensured.value.sheet as IWorksheetData } } as WorkbookSnapshot
}

export const sheetOf = (workbook: WorkbookSnapshot): Partial<IWorksheetData> => workbook.sheets[SHEET] as Partial<IWorksheetData>

/** Writes cells into the sheet (mutates). */
export function put(workbook: WorkbookSnapshot, row: number, cells: Record<number, ICellData | undefined>): void {
  const data = sheetOf(workbook).cellData as Record<number, Record<number, ICellData>>
  data[row] ??= {}
  for (const [c, cell] of Object.entries(cells)) {
    if (cell === undefined) delete (data[row] as Record<number, ICellData>)[Number(c)]
    else (data[row] as Record<number, ICellData>)[Number(c)] = cell
  }
}

/**
 * Univer's `SetRangeValuesMutation` merge, reduced to what the editor sends
 * (keys set to null are removed; styles merge key by key).
 */
export function applyPatch(cell: ICellData | undefined, patch: Record<string, unknown>, styles: Record<string, unknown> = {}): ICellData | undefined {
  const out: Record<string, unknown> = { ...(cell ?? {}) }
  for (const key of ['p', 'f', 'si', 'custom'] as const) {
    if (!(key in patch)) continue
    if (patch[key] === null) delete out[key]
    else out[key] = patch[key]
  }
  if ('v' in patch) {
    if (patch.v === null) {
      delete out.v
      delete out.t
    } else {
      out.v = patch.v
      if ('t' in patch) out.t = patch.t
    }
  }
  if ('s' in patch) {
    const old = typeof out.s === 'string' ? ((styles[out.s] as Record<string, unknown>) ?? {}) : ((out.s as Record<string, unknown>) ?? {})
    const merged: Record<string, unknown> = { ...old, ...(patch.s as Record<string, unknown>) }
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k]
    if (Object.keys(merged).length === 0) delete out.s
    else out.s = merged
  }
  return Object.keys(out).length === 0 ? undefined : (out as ICellData)
}
