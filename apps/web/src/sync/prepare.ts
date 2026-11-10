// Adjustments to the workbook data before Univer loads it, for synced
// sheets only. They are part of the data from the start, so opening a
// workbook still changes nothing by itself (no mutation, no save); they are
// stored with the next real save.
//
// - The row header is widened to make room for the row's sync indicator
//   (spec §5.2 «في هامش الصف»).
// - The status column becomes a checkbox (spec §5.2 «عمود الحالة: مربع
//   اختيار»): a Univer checkbox validation rule over the column's task rows,
//   which is the first thing sheet-model's `readCompleted` reads. Only when the
//   column has no validation rule yet and holds no status text: a column of
//   words («منجز»، «قيد التنفيذ») keeps its words and the plan's
//   `completedValues`. OPEN: apps/web/OPEN_QUESTIONS.md #37.

import type { IWorkbookData, IWorksheetData } from '@univerjs/core'
import type { SheetMeta } from '@naf-sheets/shared'
import { cellText, snapshotReader } from './cells'
import { sheetLayout } from './layout'

export const DV_RESOURCE = 'SHEET_DATA_VALIDATION_PLUGIN'

type Rule = { uid: string; type: string; ranges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number; rangeType?: number }>; allowBlank?: boolean }

function readRules(data: Partial<IWorkbookData>): Record<string, Rule[]> | null {
  const entry = data.resources?.find((r) => r.name === DV_RESOURCE)
  if (!entry || !entry.data) return {}
  try {
    const parsed = JSON.parse(entry.data) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Rule[]>) : null
  } catch {
    return null
  }
}

const BOOLEAN_TEXT = new Set(['', 'TRUE', 'FALSE', '1', '0'])

export const statusRuleId = (sheetId: string) => `naf-status-${sheetId}`

export interface PrepareOptions {
  /** Row header width for synced sheets, in pixels (theme `--row-margin-width`). */
  rowHeaderWidth: number
}

/** A copy of `data` with the synced sheets prepared; `data` is not changed. */
export function prepareSyncedSheets(data: Partial<IWorkbookData>, metas: readonly SheetMeta[], options: PrepareOptions): Partial<IWorkbookData> {
  const sheets = { ...(data.sheets ?? {}) } as Record<string, Partial<IWorksheetData>>
  let rules = readRules(data)
  let rulesChanged = false
  for (const meta of metas) {
    const sheet = sheets[meta.univerSheetId]
    if (!sheet || meta.syncMode !== 'synced') continue
    const reader = snapshotReader(sheet)
    const layout = sheetLayout(reader, meta)
    if (!layout?.system) continue
    const next: Partial<IWorksheetData> = { ...sheet }
    const width = sheet.rowHeader?.width ?? 0
    if (width < options.rowHeaderWidth) next.rowHeader = { ...(sheet.rowHeader ?? { hidden: 0 }), width: options.rowHeaderWidth } as IWorksheetData['rowHeader']
    sheets[meta.univerSheetId] = next

    const status = layout.fields.completed
    if (status === undefined || rules === null) continue
    const sheetRules = rules[meta.univerSheetId] ?? []
    const covered = sheetRules.some((r) => r.ranges.some((g) => g.startColumn <= status && status <= g.endColumn))
    if (covered) continue
    let words = false
    for (let row = layout.header + 1; row <= reader.lastRow(); row++) {
      if (!BOOLEAN_TEXT.has(cellText(reader.cell(row, status)).trim().toUpperCase())) words = true
    }
    if (words) continue
    const lastRow = Math.max((sheet.rowCount ?? 1000) - 1, reader.lastRow(), layout.header + 1)
    const rule: Rule = {
      uid: statusRuleId(meta.univerSheetId),
      type: 'checkbox',
      ranges: [{ startRow: layout.header + 1, endRow: lastRow, startColumn: status, endColumn: status, rangeType: 0 }],
      allowBlank: true,
    }
    rules = { ...rules, [meta.univerSheetId]: [...sheetRules, rule] }
    rulesChanged = true
  }
  const out: Partial<IWorkbookData> = { ...data, sheets: sheets as IWorkbookData['sheets'] }
  if (rulesChanged && rules) {
    const others = (data.resources ?? []).filter((r) => r.name !== DV_RESOURCE)
    out.resources = [...others, { name: DV_RESOURCE, data: JSON.stringify(rules) }]
  }
  return out
}
