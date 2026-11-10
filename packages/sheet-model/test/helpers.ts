// Snapshots built the way apps/web builds a blank workbook
// (apps/web/src/editor/workbook-data.ts `blankWorkbookData`): one sheet per
// SheetMeta, the default columns of spec §7.1 in the header row.

import { DEFAULT_COLUMNS, type SheetPlan } from '@naf-sheets/shared'
import type { ICellData } from '@univerjs/core'
import { ensureSystemColumns, type WorkbookSnapshot } from '../src'

export const GRID_FONT = 'Thmanyah Sans'

export function blankWorkbook(sheets: Array<{ id: string; title: string }> = [{ id: 'sheet-1', title: 'المهام' }]): WorkbookSnapshot {
  const header = Object.fromEntries(DEFAULT_COLUMNS.map((value, column) => [column, { v: value }]))
  return {
    id: 'wb-1',
    name: 'خطة الاتصال',
    appVersion: '1.4.0',
    styles: {},
    sheetOrder: sheets.map((s) => s.id),
    sheets: Object.fromEntries(
      sheets.map((s) => [s.id, { id: s.id, name: s.title, rightToLeft: 1, defaultStyle: { ff: GRID_FONT }, cellData: { 0: structuredClone(header) } }]),
    ),
  } as unknown as WorkbookSnapshot
}

/** The platform's id of a sheet (D1 sheets.id), kept distinct from the Univer sheet id in tests. */
export function platformId(univerSheetId: string): string {
  return `p-${univerSheetId}`
}

/** The default columns (A..G) mapped as the wizard suggests for a blank workbook. */
export function defaultPlan(univerSheetId = 'sheet-1', extra: Partial<SheetPlan> = {}): SheetPlan {
  return {
    sheetId: platformId(univerSheetId),
    mode: 'existing',
    todolistId: 101,
    headerRow: 1,
    columns: [
      { columnKey: 'A', field: 'title' },
      { columnKey: 'B', field: 'assignees' },
      { columnKey: 'C', field: 'starts_on' },
      { columnKey: 'D', field: 'due_on' },
      { columnKey: 'E', field: 'completed' },
      { columnKey: 'F', field: 'attachments' },
      { columnKey: 'G', field: 'notes' },
    ],
    hierarchy: { mode: 'flat' },
    existingTasks: 'create_all',
    assigneeMatches: {},
    ...extra,
  }
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Writes cells by column letter, e.g. { A: 'مهمة', D: 46336 } (mutates). */
export function putRow(workbook: WorkbookSnapshot, sheetId: string, row: number, cells: Record<string, ICellData | string | number | null>): void {
  const sheet = workbook.sheets[sheetId] as { cellData: Record<number, Record<number, ICellData>> }
  sheet.cellData[row] ??= {}
  for (const [key, value] of Object.entries(cells)) {
    const column = LETTERS.indexOf(key)
    if (value === null) delete (sheet.cellData[row] as Record<number, ICellData>)[column]
    else (sheet.cellData[row] as Record<number, ICellData>)[column] = typeof value === 'object' ? value : { v: value }
  }
}

export function cell(workbook: WorkbookSnapshot, sheetId: string, row: number, column: number | string): ICellData | undefined {
  const c = typeof column === 'string' ? LETTERS.indexOf(column) : column
  const line = workbook.sheets[sheetId]?.cellData?.[row] as Record<number, ICellData> | undefined
  return line?.[c]
}

export function counterUids(prefix = 'u'): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

/** A blank workbook with system columns and the given task titles (rows 2..), all to-dos unless `levels` says. */
export function linkedWorkbook(
  titles: string[],
  options: { sheetId?: string; levels?: Array<{ row: number; level: 0 | 1; parentRow: number | null }>; plan?: SheetPlan } = {},
): { workbook: WorkbookSnapshot; plan: SheetPlan; uids: string[] } {
  const sheetId = options.sheetId ?? 'sheet-1'
  const workbook = blankWorkbook([{ id: sheetId, title: 'المهام' }])
  titles.forEach((title, i) => putRow(workbook, sheetId, i + 1, { A: title }))
  const plan = options.plan ?? defaultPlan(sheetId, options.levels ? { hierarchy: { mode: 'indent' } } : {})
  const ensured = ensureSystemColumns(workbook.sheets[sheetId] as never, plan, counterUids(), options.levels ? { levels: options.levels } : {})
  if (!ensured.ok) throw new Error(ensured.error.message)
  workbook.sheets[sheetId] = ensured.value.sheet
  return { workbook, plan, uids: ensured.value.assigned.map((a) => a.uid) }
}

/** Every row's [uid, title] in sheet order (system column H = uid in a blank workbook). */
export function uidTitles(workbook: WorkbookSnapshot, sheetId = 'sheet-1'): Array<[string, string]> {
  const data = (workbook.sheets[sheetId]?.cellData ?? {}) as Record<string, Record<number, ICellData>>
  return Object.keys(data)
    .map(Number)
    .filter((r) => r > 0)
    .sort((a, b) => a - b)
    .filter((r) => data[r]?.[7]?.v !== undefined)
    .map((r) => [String(data[r]?.[7]?.v), String(data[r]?.[0]?.v ?? '')])
}
