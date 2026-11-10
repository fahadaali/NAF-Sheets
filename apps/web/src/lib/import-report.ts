// The import report screen's data (spec §7.2, §12.1 item 7). The contract
// carries the report as `unknown` (`ImportReportResponse.report`), stored JSON
// of `ImportReport` from @naf-sheets/gsheets-import; it is checked here before
// anything is drawn from it, and its items are grouped by sheet. Pure,
// unit-tested; type-only import of the package (nothing of it is bundled).

import type { ImportCounts, ImportedSheetInfo, ImportReport, ImportReportItem } from '@naf-sheets/gsheets-import'
import { isCellRange } from './cell-target'
import type { EditorTarget } from './cell-target'

type JsonObject = Record<string, unknown>
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

const OUTCOMES = new Set(['not_transferred', 'value_only', 'converted'])

/** The counts the screen shows, in order. */
export const COUNT_KEYS = [
  'sheets',
  'cells',
  'formulas',
  'valueOnlyFormulas',
  'styles',
  'merges',
  'conditionalFormatRules',
  'dataValidationRules',
  'filters',
  'notes',
  'hyperlinks',
  'richTextCells',
  'definedNames',
] as const satisfies ReadonlyArray<keyof ImportCounts>

function isItem(value: unknown): value is ImportReportItem {
  if (!isObject(value)) return false
  if (typeof value.kind !== 'string' || typeof value.message !== 'string' || !OUTCOMES.has(value.outcome as string)) return false
  if (value.detail !== undefined && typeof value.detail !== 'string') return false
  const loc = value.location
  if (loc === null) return true
  if (!isObject(loc)) return false
  return (
    typeof loc.sheetId === 'string' &&
    typeof loc.sheetName === 'string' &&
    typeof loc.ref === 'string' &&
    (loc.range === null || isCellRange(loc.range))
  )
}

function isSheetInfo(value: unknown): value is ImportedSheetInfo {
  return isObject(value) && typeof value.sheetId === 'string' && typeof value.name === 'string' && typeof value.hidden === 'boolean'
}

/**
 * The report when it has the shape the screen relies on, otherwise null (the
 * screen then says so instead of guessing). Unknown item kinds are kept: the
 * screen labels them generically.
 */
export function parseImportReport(value: unknown): ImportReport | null {
  if (!isObject(value) || !isObject(value.source) || !isObject(value.counts)) return null
  if (typeof value.source.title !== 'string') return null
  if (!Array.isArray(value.sheets) || !value.sheets.every(isSheetInfo)) return null
  if (!Array.isArray(value.items) || !value.items.every(isItem)) return null
  const counts = value.counts
  if (!COUNT_KEYS.every((k) => typeof counts[k] === 'number' && Number.isFinite(counts[k]))) return null
  return value as unknown as ImportReport
}

export interface ReportGroup {
  /** Null: items about the workbook as a whole. */
  sheetId: string | null
  sheetName: string | null
  hidden: boolean
  items: ImportReportItem[]
}

/**
 * Items grouped by sheet, in the report's sheet order; sheets named only by
 * an item come next, in order of first appearance; workbook-wide items last.
 * Sheets without items are left out. Items keep their order within a group.
 */
export function groupReportItems(report: Pick<ImportReport, 'sheets' | 'items'>): ReportGroup[] {
  const groups = new Map<string, ReportGroup>()
  for (const sheet of report.sheets) {
    groups.set(sheet.sheetId, { sheetId: sheet.sheetId, sheetName: sheet.name, hidden: sheet.hidden, items: [] })
  }
  const workbook: ReportGroup = { sheetId: null, sheetName: null, hidden: false, items: [] }
  for (const item of report.items) {
    const loc = item.location
    if (!loc) {
      workbook.items.push(item)
      continue
    }
    let group = groups.get(loc.sheetId)
    if (!group) {
      group = { sheetId: loc.sheetId, sheetName: loc.sheetName, hidden: false, items: [] }
      groups.set(loc.sheetId, group)
    }
    group.items.push(item)
  }
  const out = [...groups.values()].filter((g) => g.items.length > 0)
  if (workbook.items.length > 0) out.push(workbook)
  return out
}

export function outcomeCounts(items: readonly ImportReportItem[]): Record<ImportReportItem['outcome'], number> {
  const counts = { not_transferred: 0, value_only: 0, converted: 0 }
  for (const item of items) counts[item.outcome]++
  return counts
}

/** Where «الانتقال إلى الموقع» lands in the editor; null for workbook-wide items. */
export function itemTarget(item: ImportReportItem): EditorTarget | null {
  if (!item.location) return null
  return { sheet: item.location.sheetId, range: item.location.range }
}
