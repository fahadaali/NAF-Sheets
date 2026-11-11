// The import report screen's data (spec §7.2, §12.1 item 7). The contract
// carries the report as `unknown` (`ImportReportResponse.report`), stored JSON
// of `ImportReport` from @naf-sheets/gsheets-import; it is checked here before
// anything is drawn from it, and its items are grouped by sheet. Pure,
// unit-tested; type-only import of the package (nothing of it is bundled).

import type { ImportCounts, ImportedSheetInfo, ImportOrigin, ImportReport, ImportReportItem } from '@naf-sheets/gsheets-import'
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

/** Counts shown only when the report has them (pictures: .xlsx imports since 2026-11-11). */
export const OPTIONAL_COUNT_KEYS = ['floatingImages', 'cellImages'] as const satisfies ReadonlyArray<keyof ImportCounts>

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

const ORIGIN_KINDS = new Set(['google_api', 'google_export', 'excel', 'other'])
const VIAS = new Set(['google_api', 'upload', 'google_link'])
const isStringOrNull = (v: unknown) => v === null || v === undefined || typeof v === 'string'

/** `source.origin` when it has a known shape; reports stored before 2026-11-11 have none. */
function isOrigin(value: unknown): value is ImportOrigin {
  if (!isObject(value)) return false
  if (!ORIGIN_KINDS.has(value.kind as string) || !VIAS.has(value.via as string)) return false
  if (!isStringOrNull(value.application) || !isStringOrNull(value.fileName)) return false
  if (value.defaultFont !== undefined && value.defaultFont !== null) {
    const f = value.defaultFont
    if (!isObject(f) || !isStringOrNull(f.family) || !(f.size === null || typeof f.size === 'number')) return false
  }
  if (value.dateSystem !== undefined && value.dateSystem !== 'date1900' && value.dateSystem !== 'date1904') return false
  return true
}

/**
 * The report when it has the shape the screen relies on, otherwise null (the
 * screen then says so instead of guessing). Unknown item kinds are kept: the
 * screen labels them generically.
 */
export function parseImportReport(input: unknown): ImportReport | null {
  if (!isObject(input) || !isObject(input.source) || !isObject(input.counts)) return null
  if (typeof input.source.title !== 'string') return null
  let value: JsonObject = input
  // An unreadable origin is dropped rather than refusing the whole report.
  if (input.source.origin !== undefined && !isOrigin(input.source.origin)) {
    const { origin: _dropped, ...rest } = input.source
    void _dropped
    value = { ...input, source: rest }
  }
  if (!Array.isArray(value.sheets) || !value.sheets.every(isSheetInfo)) return null
  if (!Array.isArray(value.items) || !value.items.every(isItem)) return null
  const counts = value.counts as JsonObject
  if (!COUNT_KEYS.every((k) => typeof counts[k] === 'number' && Number.isFinite(counts[k]))) return null
  return value as unknown as ImportReport
}

/** What the screen states about where the file came from. */
export interface OriginFacts {
  kind: ImportOrigin['kind']
  via: ImportOrigin['via']
  application: string | null
  fileName: string | null
  /** `Calibri 11`, `Arial 10`…; null when the report has none (Sheets API imports). */
  defaultFont: string | null
  dateSystem: 'date1900' | 'date1904' | null
}

/** Origin facts; a report without `origin` predates 2026-11-11 and came from the Sheets API. */
export function originFacts(report: Pick<ImportReport, 'source'>): OriginFacts {
  const o = report.source.origin
  if (!o) return { kind: 'google_api', via: 'google_api', application: null, fileName: null, defaultFont: null, dateSystem: null }
  const font = o.defaultFont && o.defaultFont.family ? `${o.defaultFont.family}${typeof o.defaultFont.size === 'number' ? ` ${o.defaultFont.size}` : ''}` : null
  return {
    kind: o.kind,
    via: o.via,
    application: o.application ?? null,
    fileName: o.fileName ?? null,
    defaultFont: font,
    dateSystem: o.dateSystem ?? null,
  }
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
