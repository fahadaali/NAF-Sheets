// Google Sheets API v4 `spreadsheets.get` (includeGridData=true) → Univer 1.4.0
// IWorkbookData, plus the import report (spec §7.2). Pure: no network, no
// Univer runtime, deterministic ids.
//
// What goes where (spec §7.2 table):
//   sheets[].properties              → IWorksheetData name/order/hidden/tabColor/
//                                      rightToLeft/freeze/rowCount/columnCount/showGridlines
//   userEnteredValue                 → cellData.v / .t, formulas → .f as written
//   userEnteredFormat (+ effective   → styles (deduplicated) + cellData.s
//     numberFormat)
//   textFormatRuns, links, newlines  → cellData.p (rich-text.ts)
//   row/columnMetadata               → rowData/columnData h, w, hd
//   merges                           → mergeData
//   conditionalFormats               → resource SHEET_CONDITIONAL_FORMATTING_PLUGIN
//   dataValidation                   → resource SHEET_DATA_VALIDATION_PLUGIN
//   basicFilter                      → resource SHEET_FILTER_PLUGIN
//   note                             → resource SHEET_NOTE_PLUGIN
//   namedRanges                      → resource SHEET_DEFINED_NAME_PLUGIN (formulas use them)
//   bandedRanges                     → static fills
//   filterViews, charts, pivot tables, slicers, protected ranges, IMAGE(),
//   tables, groups, comments, chips  → report only
//
// Spilled results. A cell with an effectiveValue but no userEnteredValue was
// produced by something else: an array formula, a pivot table or a data source
// table. Each such cell is attributed to the anchor whose spill rectangle
// holds it — the rectangle starts at the anchor and extends over the unbroken
// run of produced cells to its right and below it. Cells of a formula that is
// kept are left empty and the anchor is written without a cached value, so
// Univer computes it and spills (sheets-formula's default WHEN_EMPTY mode
// computes only formulas without `v`). Cells of anything that is not kept stay
// as static values. Produced cells no anchor claims stay as static values and
// are reported. OPEN: OPEN_QUESTIONS.md §4.

import type { DateSystem, ICellData, ISheetDataValidationRule, IObjectArrayPrimitiveType, IObjectMatrixPrimitiveType, IRange, IRowData, IColumnData, IStyleData, IWorkbookData, IWorksheetData, LocaleType } from '@univerjs/core'
import type { GridSize } from './a1'
import { absoluteA1Range, cellRange, cellsToRanges, gridRangeToRange, quoteSheetName } from './a1'
import { bandedFills } from './banding'
import { ColorResolver } from './color'
import { convertConditionalFormat } from './conditional-format'
import { convertDataValidation } from './data-validation'
import { convertBasicFilter } from './filter'
import { findUnsupportedFunctions, UNIVER_SUPPORTED_FUNCTIONS } from './formula'
import type { GsCellData, GsDataValidationRule, GsDimensionProperties, GsErrorType, GsExtendedValue, GsNumberFormat, GsSheet, GsSpreadsheet } from './google-types'
import { emptyCounts, formulaNote, GOOGLE_SHEETS, location, MESSAGES, type ImportCounts, type ImportedSheetInfo, type ImportOrigin, type ImportReport, type ImportReportItem } from './report'
import { buildCellDocument, type TextSegment } from './rich-text'
import { cellFormatToStyle, mergeTextFormats, pickNumberFormat, stableStringify, StyleRegistry, textFormatToStyle, type StyleContext } from './style'
import {
  BOOL,
  CELL_TYPE,
  DEFAULT_ITERATION,
  DEFAULT_NOTE_SIZE,
  DEFINED_NAME_WORKBOOK_SCOPE,
  LOCALE_AR_SA,
  RESOURCE,
  UNIVER_VERSION,
  type UniverAutoFilter,
  type UniverCfRule,
  type UniverDefinedName,
  type UniverSheetNote,
} from './univer-constants'

export interface ConvertOptions {
  /** Univer unit id. Default: `gsheets-<spreadsheetId>`. */
  workbookId?: string
  /** Default: Arabic (Saudi Arabia), `arSA`. */
  locale?: LocaleType
  /**
   * Function names (upper case) the formula engine evaluates. Default: every
   * function @univerjs/engine-formula 1.4.0 implements. The web app may pass
   * its live set, including custom functions it registers.
   */
  supportedFunctions?: ReadonlySet<string>
  /**
   * Where the data came from (report `source.origin`). Default: the Sheets
   * API. The .xlsx reader (@naf-sheets/xlsx-import) passes the detected origin.
   */
  origin?: ImportOrigin
  /** The program named in report messages and cell notes. Default: Google Sheets. */
  sourceName?: string
  /**
   * Reasons beyond unknown functions that keep a formula from being kept
   * (e.g. an Excel structured reference). Each label is reported with the
   * function names. Default: none (the Sheets API path has no such cases).
   */
  formulaBlockers?: (formula: string) => string[]
  /** Univer `IWorkbookData.dateSystem`; omitted means Excel 1900 (what Google uses). */
  dateSystem?: DateSystem
}

export interface ConvertResult {
  workbook: IWorkbookData
  report: ImportReport
}

/** Univer sheet id for a Google sheetId. */
export function univerSheetId(googleSheetId: number): string {
  return `sheet-${googleSheetId}`
}

const ERROR_TEXT: Record<GsErrorType, string | null> = {
  ERROR_TYPE_UNSPECIFIED: '#ERROR!',
  ERROR: '#ERROR!',
  NULL_VALUE: '#NULL!',
  DIVIDE_BY_ZERO: '#DIV/0',
  VALUE: '#VALUE!',
  REF: '#REF!',
  NAME: '#NAME?',
  NUM: '#NUM!',
  N_A: '#N/A',
  LOADING: null,
}

const NUMERIC_STRING = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/

type CellValue = Pick<ICellData, 'v' | 't'>

/** A literal (user-entered or computed) as Univer stores it; null when there is nothing to store. */
function valueToCell(value: GsExtendedValue | undefined, formatted: string | undefined): CellValue | null {
  if (!value) return null
  if (typeof value.numberValue === 'number') return { v: value.numberValue, t: CELL_TYPE.NUMBER }
  if (typeof value.stringValue === 'string') {
    if (value.stringValue === '') return null
    // Google drops the leading apostrophe of '123: a numeric-looking string is forced text.
    return { v: value.stringValue, t: NUMERIC_STRING.test(value.stringValue) ? CELL_TYPE.FORCE_STRING : CELL_TYPE.STRING }
  }
  // Univer stores booleans as 1/0 with t = BOOLEAN (docs.univer.ai sheets/model/cell-data).
  if (typeof value.boolValue === 'boolean') return { v: value.boolValue ? 1 : 0, t: CELL_TYPE.BOOLEAN }
  if (value.errorValue) {
    const text = formatted ?? ERROR_TEXT[value.errorValue.type ?? 'ERROR_TYPE_UNSPECIFIED']
    return text ? { v: text, t: CELL_TYPE.STRING } : null
  }
  return null
}

/** The text sheets-filter's value filter compares (core extractPureTextFromCell). */
function univerFilterText(cell: CellValue | null): string {
  if (!cell || cell.v === null || cell.v === undefined) return ''
  if (cell.t === CELL_TYPE.BOOLEAN) return cell.v ? 'TRUE' : 'FALSE'
  if (typeof cell.v === 'string') return cell.v.replace(/[\r\n]/g, '')
  return String(cell.v)
}

/** Rewrites a link to another sheet of this spreadsheet (`#gid=123…`) to the Univer sheet id. */
export function rewriteSheetLink(url: string, sheetIds: ReadonlyMap<number, string>): string {
  if (!url.startsWith('#')) return url
  // OPEN: OPEN_QUESTIONS.md §9 — links to an unknown gid, to a named range (#rangeid=) or to the
  // original file's URL are kept as they are.
  return url.replace(/([#&])gid=(\d+)/, (match, sep: string, gid: string) => {
    const id = sheetIds.get(Number(gid))
    return id ? `${sep}gid=${id}` : match
  })
}

function mostCommon(values: number[]): number | null {
  const counts = new Map<number, number>()
  let best: number | null = null
  let bestCount = 0
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1
    counts.set(v, n)
    if (n > bestCount) {
      best = v
      bestCount = n
    }
  }
  return best
}

interface SheetContext {
  sheetId: string
  name: string
  size: GridSize
  styleCtx: StyleContext
  supported: ReadonlySet<string>
  blockers: (formula: string) => string[]
  sourceName: string
  sheetIds: ReadonlyMap<number, string>
  styles: StyleRegistry
  counts: ImportCounts
  items: ImportReportItem[]
}

interface ConvertedSheet {
  data: Partial<IWorksheetData>
  cf: UniverCfRule[]
  dv: ISheetDataValidationRule[]
  filter: UniverAutoFilter | null
  notes: Record<number, Record<number, UniverSheetNote>>
}

type Anchor = { kind: 'formula'; keep: boolean } | { kind: 'pivot' } | { kind: 'data_source_table' }

function convertGridSheet(sheet: GsSheet, ctx: SheetContext): ConvertedSheet {
  const { sheetId, name, size, styleCtx, styles, counts, items } = ctx
  const here = (range: IRange | null) => location(sheetId, name, range)
  const props = sheet.properties ?? {}

  // ---- cells and dimension metadata, from every GridData block ----------------
  const cells = new Map<number, Map<number, GsCellData>>()
  const rowMeta = new Map<number, GsDimensionProperties>()
  const colMeta = new Map<number, GsDimensionProperties>()
  for (const block of sheet.data ?? []) {
    const r0 = block.startRow ?? 0
    const c0 = block.startColumn ?? 0
    block.rowData?.forEach((row, i) => {
      row.values?.forEach((cell, j) => {
        if (!cell || Object.keys(cell).length === 0) return
        let line = cells.get(r0 + i)
        if (!line) cells.set(r0 + i, (line = new Map()))
        line.set(c0 + j, cell)
      })
    })
    block.rowMetadata?.forEach((m, i) => rowMeta.set(r0 + i, m))
    block.columnMetadata?.forEach((m, j) => colMeta.set(c0 + j, m))
  }
  const cellAt = (r: number, c: number) => cells.get(r)?.get(c)
  const rowsInOrder = [...cells.keys()].sort((a, b) => a - b)
  const forEachCell = (fn: (r: number, c: number, cell: GsCellData) => void) => {
    for (const r of rowsInOrder) {
      const line = cells.get(r) as Map<number, GsCellData>
      for (const c of [...line.keys()].sort((a, b) => a - b)) fn(r, c, line.get(c) as GsCellData)
    }
  }

  // ---- anchors and the cells they produced -------------------------------------
  const isProduced = (cell: GsCellData | undefined) =>
    !!cell && !cell.userEnteredValue && !!cell.effectiveValue && !cell.pivotTable && !cell.dataSourceTable
  const anchors = new Map<string, Anchor>()
  const unsupportedByCell = new Map<string, string[]>()
  forEachCell((r, c, cell) => {
    const key = `${r}:${c}`
    const formula = cell.userEnteredValue?.formulaValue
    if (typeof formula === 'string') {
      const unsupported = [...findUnsupportedFunctions(formula, ctx.supported), ...ctx.blockers(formula)]
      if (unsupported.length > 0) unsupportedByCell.set(key, unsupported)
      anchors.set(key, { kind: 'formula', keep: unsupported.length === 0 })
    } else if (cell.pivotTable) anchors.set(key, { kind: 'pivot' })
    else if (cell.dataSourceTable) anchors.set(key, { kind: 'data_source_table' })
  })
  const producedOwner = new Map<string, string>()
  const spillRect = new Map<string, IRange>()
  forEachCell((r, c) => {
    const key = `${r}:${c}`
    if (!anchors.has(key)) return
    let w = 1
    while (isProduced(cellAt(r, c + w)) && !producedOwner.has(`${r}:${c + w}`)) w++
    let h = 1
    while (isProduced(cellAt(r + h, c)) && !producedOwner.has(`${r + h}:${c}`)) h++
    const rect: IRange = { startRow: r, startColumn: c, endRow: r + h - 1, endColumn: c + w - 1 }
    spillRect.set(key, rect)
    for (let rr = r; rr <= rect.endRow; rr++) {
      for (let cc = c; cc <= rect.endColumn; cc++) {
        const k = `${rr}:${cc}`
        if (k !== key && isProduced(cellAt(rr, cc)) && !producedOwner.has(k)) producedOwner.set(k, key)
      }
    }
  })
  const spills = (key: string) => {
    const rect = spillRect.get(key)
    return !!rect && (rect.endRow > rect.startRow || rect.endColumn > rect.startColumn)
  }

  // ---- alternating colours → static fills --------------------------------------
  const bandFill = new Map<string, string>()
  for (const banded of sheet.bandedRanges ?? []) {
    const range = gridRangeToRange(banded.range, size)
    if (!range) continue
    const fills = bandedFills(range, banded.rowProperties, banded.columnProperties, styleCtx.colors)
    if (fills === 'unresolved') {
      items.push({ kind: 'banded_range', outcome: 'not_transferred', location: here(range), message: MESSAGES.bandedRangeNotTransferred() })
      continue
    }
    for (const [k, v] of fills) bandFill.set(k, v)
    items.push({ kind: 'banded_range', outcome: 'converted', location: here(range), message: MESSAGES.bandedRangeConverted() })
  }

  // ---- cells --------------------------------------------------------------------
  const cellData: IObjectMatrixPrimitiveType<ICellData> = {}
  const put = (r: number, c: number, data: ICellData) => {
    const line = (cellData[r] ??= {})
    line[c] = data
  }
  const notes: ConvertedSheet['notes'] = {}
  const putNote = (r: number, c: number, text: string) => {
    ;(notes[r] ??= {})[c] = { id: `note-${sheetId}-${r}-${c}`, row: r, col: c, ...DEFAULT_NOTE_SIZE, note: text }
    counts.notes++
  }
  const dvGroups = new Map<string, { rule: GsDataValidationRule; cells: Array<[number, number]> }>()
  const missingPattern = new Map<string, Array<[number, number]>>()
  const unclaimedProduced: Array<[number, number]> = []
  const filterTexts = new Map<string, { displayed: string; univerText: string }>()

  const allKeys = new Set<string>()
  forEachCell((r, c) => allKeys.add(`${r}:${c}`))
  for (const k of bandFill.keys()) allKeys.add(k)
  const ordered = [...allKeys]
    .map((k) => k.split(':').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])

  for (const [r, c] of ordered) {
    const key = `${r}:${c}`
    const cell = cellAt(r, c)
    const fmt = cell?.userEnteredFormat
    const out: ICellData = {}

    // Style.
    const number = pickNumberFormat(fmt?.numberFormat, cell?.effectiveFormat?.numberFormat)
    let pattern: string | null = null
    if (number && 'pattern' in number) pattern = number.pattern
    else if (number && 'missingPattern' in number) {
      const type = (number.missingPattern as GsNumberFormat).type ?? 'NUMBER_FORMAT_TYPE_UNSPECIFIED'
      const list = missingPattern.get(type) ?? []
      list.push([r, c])
      missingPattern.set(type, list)
    }
    let style: IStyleData | null = cellFormatToStyle(fmt, pattern, styleCtx)
    const band = bandFill.get(key)
    if (band && !style?.bg) style = { ...(style ?? {}), bg: { rgb: band } }

    // Value.
    let stored: CellValue | null = null
    let richText = false
    const anchor = anchors.get(key)
    const owner = producedOwner.get(key)
    const formula = cell?.userEnteredValue?.formulaValue
    if (cell && typeof formula === 'string' && anchor?.kind === 'formula') {
      if (anchor.keep) {
        // OPEN: OPEN_QUESTIONS.md §15 — kept exactly as the API returns it (argument separators unverified).
        out.f = formula
        counts.formulas++
        // Cached result for display; omitted when the formula spills or errs, so Univer computes it.
        const cached = valueToCell(cell.effectiveValue, cell.formattedValue)
        if (cached && !cell.effectiveValue?.errorValue && !spills(key)) {
          out.v = cached.v
          out.t = cached.t
        }
      } else {
        const unsupported = unsupportedByCell.get(key) ?? []
        stored = valueToCell(cell.effectiveValue, cell.formattedValue)
        counts.valueOnlyFormulas++
        putNote(r, c, formulaNote(formula, cell.note, ctx.sourceName))
        const onlyImage = unsupported.every((n) => n === 'IMAGE')
        items.push({
          kind: onlyImage ? 'image' : 'unsupported_formula',
          outcome: 'value_only',
          location: here(spillRect.get(key) ?? cellRange(r, c)),
          message: onlyImage ? MESSAGES.imageFormula() : MESSAGES.unsupportedFormula(unsupported, ctx.sourceName),
          detail: formula,
        })
      }
    } else if (cell && owner) {
      const ownerAnchor = anchors.get(owner)
      if (!(ownerAnchor?.kind === 'formula' && ownerAnchor.keep)) stored = valueToCell(cell.effectiveValue, cell.formattedValue)
    } else if (cell && isProduced(cell)) {
      stored = valueToCell(cell.effectiveValue, cell.formattedValue)
      if (stored) unclaimedProduced.push([r, c])
    } else if (cell) {
      stored = valueToCell(cell.userEnteredValue ?? (anchor ? cell.effectiveValue : undefined), cell.formattedValue)
    }

    // Links and runs belong to literal cells only: TextFormatRun "runs are only valid on user
    // entered strings", and a formula's link comes from the formula (=HYPERLINK, kept as is).
    // A run's link wins over the cell-level link (CellFormat.textFormat).
    const literal = !!cell?.userEnteredValue && typeof formula !== 'string'
    const runs = literal && cell?.userEnteredValue?.stringValue !== undefined ? (cell.textFormatRuns ?? []) : []
    const cellLink = literal ? (fmt?.textFormat?.link?.uri ?? cell?.hyperlink) : undefined
    const anyRunLink = runs.some((run) => run.format?.link?.uri)
    const wantsLink = !!cellLink || anyRunLink
    const linkDetail = cellLink ?? runs.map((run) => run.format?.link?.uri).filter(Boolean).join(' ')
    let linksAllowed = wantsLink
    if (wantsLink && fmt?.hyperlinkDisplayType === 'PLAIN_TEXT') {
      linksAllowed = false
      items.push({ kind: 'hyperlink', outcome: 'not_transferred', location: here(cellRange(r, c)), message: MESSAGES.hyperlinkPlainText(), detail: linkDetail })
    } else if (wantsLink && typeof stored?.v !== 'string') {
      linksAllowed = false
      items.push({ kind: 'hyperlink', outcome: 'not_transferred', location: here(cellRange(r, c)), message: MESSAGES.hyperlinkNotText(), detail: linkDetail })
    }

    if (stored && typeof stored.v === 'string' && out.f === undefined) {
      const text = stored.v
      const needsDoc = runs.length > 0 || linksAllowed || text.includes('\n')
      if (needsDoc) {
        const cellTf = fmt?.textFormat
        const starts = [...new Set([0, ...runs.map((run) => run.startIndex ?? 0)])].filter((s) => s >= 0 && s < text.length).sort((a, b) => a - b)
        const segments: TextSegment[] = starts.map((start, i) => {
          const run = [...runs].reverse().find((x) => (x.startIndex ?? 0) === start)
          const merged = mergeTextFormats(cellTf, run?.format)
          const runLink = run?.format?.link?.uri
          const link = linksAllowed ? (anyRunLink ? (runLink ?? null) : (cellLink ?? null)) : null
          return {
            start,
            end: starts[i + 1] ?? text.length,
            style: textFormatToStyle(merged, styleCtx.colors),
            link: link ? rewriteSheetLink(link, ctx.sheetIds) : null,
          }
        })
        out.p = buildCellDocument(text, segments, `${sheetId}-r${r}c${c}`)
        richText = true
        const links = out.p.body?.customRanges?.length ?? 0
        counts.hyperlinks += links
        if (runs.length > 0 || links > 0) counts.richTextCells++
      }
    }
    if (stored) {
      out.v = stored.v
      out.t = stored.t
    }

    if (style) out.s = styles.register(style)
    if (out.v !== undefined || out.f !== undefined || richText) counts.cells++
    if (Object.keys(out).length > 0) put(r, c, out)

    if (cell) {
      if (cell.note && !(typeof formula === 'string' && anchor?.kind === 'formula' && !anchor.keep)) putNote(r, c, cell.note)
      if (cell.dataValidation) {
        const k = stableStringify(cell.dataValidation)
        const group = dvGroups.get(k) ?? { rule: cell.dataValidation, cells: [] }
        group.cells.push([r, c])
        dvGroups.set(k, group)
      }
      if (cell.chipRuns?.some((run) => run.chip?.personProperties || run.chip?.richLinkProperties)) {
        const detail = cell.chipRuns
          .map((run) => run.chip?.personProperties?.email ?? run.chip?.richLinkProperties?.uri)
          .filter(Boolean)
          .join(' ')
        items.push({ kind: 'smart_chip', outcome: 'not_transferred', location: here(cellRange(r, c)), message: MESSAGES.smartChip(), detail })
      }
      if (cell.pivotTable) {
        items.push({ kind: 'pivot_table', outcome: 'not_transferred', location: here(spillRect.get(key) ?? cellRange(r, c)), message: MESSAGES.pivotTable() })
      }
      if (cell.dataSourceTable) {
        items.push({
          kind: 'data_source_table',
          outcome: 'not_transferred',
          location: here(spillRect.get(key) ?? cellRange(r, c)),
          message: MESSAGES.dataSourceTable(),
        })
      }
      // For the filter. Kept formulas and their spills may hold no value yet; Univer will compute
      // Google's. Rich text compares as its stream without the final "\r\n" (core getPlainText).
      const filterValue = stored ?? (owner || out.f ? valueToCell(cell.effectiveValue, cell.formattedValue) : null)
      const univerText = richText && out.p ? (out.p.body?.dataStream ?? '').slice(0, -2) : univerFilterText(filterValue)
      filterTexts.set(key, { displayed: cell.formattedValue ?? '', univerText })
    }
  }

  for (const range of cellsToRanges(unclaimedProduced)) {
    items.push({ kind: 'derived_value', outcome: 'value_only', location: here(range), message: MESSAGES.derivedValue() })
  }
  for (const [type, list] of missingPattern) {
    for (const range of cellsToRanges(list)) {
      items.push({ kind: 'number_format', outcome: 'not_transferred', location: here(range), message: MESSAGES.numberFormat(type) })
    }
  }

  // ---- rows and columns ----------------------------------------------------------
  const defaultRowHeight = mostCommon([...rowMeta.values()].map((m) => m.pixelSize).filter((n): n is number => typeof n === 'number' && n > 0))
  const defaultColumnWidth = mostCommon([...colMeta.values()].map((m) => m.pixelSize).filter((n): n is number => typeof n === 'number' && n > 0))
  const rowData: IObjectArrayPrimitiveType<Partial<IRowData>> = {}
  for (const [r, m] of rowMeta) {
    const row: Partial<IRowData> = {}
    if (typeof m.pixelSize === 'number' && m.pixelSize > 0 && m.pixelSize !== defaultRowHeight) row.h = m.pixelSize
    // hiddenByFilter is not copied: the transferred filter hides rows itself.
    // OPEN: OPEN_QUESTIONS.md §16 — pixel sizes are written as they are; the API does not say
    // whether a Google row was auto-sized.
    if (m.hiddenByUser) row.hd = BOOL.TRUE
    if (Object.keys(row).length > 0) rowData[r] = row
  }
  const columnData: IObjectArrayPrimitiveType<Partial<IColumnData>> = {}
  for (const [c, m] of colMeta) {
    const col: Partial<IColumnData> = {}
    if (typeof m.pixelSize === 'number' && m.pixelSize > 0 && m.pixelSize !== defaultColumnWidth) col.w = m.pixelSize
    if (m.hiddenByUser) col.hd = BOOL.TRUE
    if (Object.keys(col).length > 0) columnData[c] = col
  }

  // ---- merges ----------------------------------------------------------------------
  const mergeData = (sheet.merges ?? []).map((m) => gridRangeToRange(m, size)).filter((m): m is IRange => m !== null)
  counts.merges += mergeData.length

  // ---- conditional formats -----------------------------------------------------------
  const cf: UniverCfRule[] = []
  ;(sheet.conditionalFormats ?? []).forEach((rule, i) => {
    const result = convertConditionalFormat(rule, `cf-${sheetId}-${i}`, size, styleCtx.colors, ctx.supported)
    if (result.ok) cf.push(result.rule)
    else
      items.push({
        kind: 'conditional_format',
        outcome: 'not_transferred',
        location: here(result.ranges[0] ?? null),
        message: MESSAGES.conditionalFormat(result.reason),
        detail: rule.booleanRule?.condition?.type ?? (rule.gradientRule ? 'GRADIENT' : undefined),
      })
  })
  counts.conditionalFormatRules += cf.length

  // ---- data validation -----------------------------------------------------------------
  const dv: ISheetDataValidationRule[] = []
  for (const group of dvGroups.values()) {
    const ranges = cellsToRanges(group.cells)
    const result = convertDataValidation(group.rule, ctx.supported)
    if (result.ok) dv.push({ ...result.rule, uid: `dv-${sheetId}-${dv.length}`, ranges })
    else {
      for (const range of ranges) {
        items.push({
          kind: 'data_validation',
          outcome: 'not_transferred',
          location: here(range),
          message: MESSAGES.dataValidation(result.reason),
          detail: group.rule.condition?.type,
        })
      }
    }
  }
  counts.dataValidationRules += dv.length

  // ---- basic filter ----------------------------------------------------------------------
  let filter: UniverAutoFilter | null = null
  if (sheet.basicFilter) {
    const result = convertBasicFilter(sheet.basicFilter, size, styleCtx.colors, (row, column) => filterTexts.get(`${row}:${column}`) ?? { displayed: '', univerText: '' })
    if (!result.ok) {
      items.push({ kind: 'filter', outcome: 'not_transferred', location: here(gridRangeToRange(sheet.basicFilter.range, size)), message: MESSAGES.filter(result.reason) })
    } else {
      filter = result.filter
      counts.filters++
      for (const failure of result.failures) {
        items.push({
          kind: 'filter_criteria',
          outcome: 'not_transferred',
          location: here({ startRow: result.filter.ref.startRow, endRow: result.filter.ref.endRow, startColumn: failure.column, endColumn: failure.column }),
          message: MESSAGES.filterCriteria(failure.reason),
        })
      }
    }
  }

  // ---- report-only objects ------------------------------------------------------------------
  for (const view of sheet.filterViews ?? []) {
    items.push({ kind: 'filter_view', outcome: 'not_transferred', location: here(gridRangeToRange(view.range, size)), message: MESSAGES.filterView(), detail: view.title })
  }
  const anchorOf = (pos: { overlayPosition?: { anchorCell?: { rowIndex?: number; columnIndex?: number } } } | undefined) => {
    const a = pos?.overlayPosition?.anchorCell
    return a ? cellRange(a.rowIndex ?? 0, a.columnIndex ?? 0) : null
  }
  for (const chart of sheet.charts ?? []) {
    items.push({ kind: 'chart', outcome: 'not_transferred', location: here(anchorOf(chart.position)), message: MESSAGES.chart(), detail: chart.spec?.title })
  }
  for (const slicer of sheet.slicers ?? []) {
    items.push({ kind: 'slicer', outcome: 'not_transferred', location: here(anchorOf(slicer.position)), message: MESSAGES.slicer(), detail: slicer.spec?.title })
  }
  for (const pr of sheet.protectedRanges ?? []) {
    const range = pr.range ? gridRangeToRange(pr.range, size) : null
    items.push({ kind: 'protected_range', outcome: 'not_transferred', location: here(range), message: MESSAGES.protectedRange(), detail: pr.description })
  }
  for (const table of sheet.tables ?? []) {
    items.push({ kind: 'table', outcome: 'converted', location: here(gridRangeToRange(table.range, size)), message: MESSAGES.table(), detail: table.name })
  }
  for (const group of sheet.rowGroups ?? []) {
    const start = group.range?.startIndex ?? 0
    const end = (group.range?.endIndex ?? size.rowCount) - 1
    if (end >= start)
      items.push({
        kind: 'row_group',
        outcome: 'not_transferred',
        location: here({ startRow: start, endRow: end, startColumn: 0, endColumn: size.columnCount - 1 }),
        message: MESSAGES.rowGroup(),
      })
  }
  for (const group of sheet.columnGroups ?? []) {
    const start = group.range?.startIndex ?? 0
    const end = (group.range?.endIndex ?? size.columnCount) - 1
    if (end >= start)
      items.push({
        kind: 'column_group',
        outcome: 'not_transferred',
        location: here({ startRow: 0, endRow: size.rowCount - 1, startColumn: start, endColumn: end }),
        message: MESSAGES.columnGroup(),
      })
  }
  for (const anchorItem of sheet.commentAnchors ?? []) {
    items.push({ kind: 'comment', outcome: 'not_transferred', location: here(gridRangeToRange(anchorItem.range, size)), message: MESSAGES.comment() })
  }

  // ---- worksheet ---------------------------------------------------------------------------
  const grid = props.gridProperties ?? {}
  const frozenRows = grid.frozenRowCount ?? 0
  const frozenCols = grid.frozenColumnCount ?? 0
  const data: Partial<IWorksheetData> = {
    id: sheetId,
    name,
    tabColor: styleCtx.colors.resolve(props.tabColorStyle, props.tabColor) ?? '',
    hidden: props.hidden ? BOOL.TRUE : BOOL.FALSE,
    rowCount: size.rowCount,
    columnCount: size.columnCount,
    freeze: { xSplit: frozenCols, ySplit: frozenRows, startRow: frozenRows > 0 ? frozenRows : -1, startColumn: frozenCols > 0 ? frozenCols : -1 },
    mergeData,
    cellData,
    rowData,
    columnData,
    showGridlines: grid.hideGridlines ? BOOL.FALSE : BOOL.TRUE,
    rightToLeft: props.rightToLeft ? BOOL.TRUE : BOOL.FALSE,
  }
  if (defaultRowHeight !== null) data.defaultRowHeight = defaultRowHeight
  if (defaultColumnWidth !== null) data.defaultColumnWidth = defaultColumnWidth
  return { data, cf, dv, filter, notes }
}

/** Grid size: the declared one, grown to hold every cell and metadata entry in the response. */
function sheetSize(sheet: GsSheet): GridSize {
  let rows = 0
  let cols = 0
  for (const block of sheet.data ?? []) {
    const r0 = block.startRow ?? 0
    const c0 = block.startColumn ?? 0
    rows = Math.max(rows, r0 + (block.rowData?.length ?? 0), r0 + (block.rowMetadata?.length ?? 0))
    cols = Math.max(cols, c0 + (block.columnMetadata?.length ?? 0))
    for (const row of block.rowData ?? []) cols = Math.max(cols, c0 + (row.values?.length ?? 0))
  }
  const grid = sheet.properties?.gridProperties
  return { rowCount: Math.max(grid?.rowCount ?? 0, rows, 1), columnCount: Math.max(grid?.columnCount ?? 0, cols, 1) }
}

export function convertSpreadsheet(response: GsSpreadsheet, options: ConvertOptions = {}): ConvertResult {
  const props = response.properties ?? {}
  const colors = new ColorResolver(props.spreadsheetTheme)
  const styles = new StyleRegistry()
  const counts = emptyCounts()
  const items: ImportReportItem[] = []
  const supported = options.supportedFunctions ?? UNIVER_SUPPORTED_FUNCTIONS

  const ordered = (response.sheets ?? [])
    .map((sheet, i) => ({ sheet, i }))
    .sort((a, b) => (a.sheet.properties?.index ?? a.i) - (b.sheet.properties?.index ?? b.i) || a.i - b.i)

  // Ids first: links and named ranges may point at any sheet.
  const sheetIds = new Map<number, string>()
  const usedIds = new Set<string>()
  const idOf = new Map<GsSheet, string>()
  ordered.forEach(({ sheet, i }) => {
    const gid = sheet.properties?.sheetId
    let id = typeof gid === 'number' ? univerSheetId(gid) : `sheet-at-${i}`
    if (usedIds.has(id)) id = `${id}-${i}`
    usedIds.add(id)
    idOf.set(sheet, id)
    if (typeof gid === 'number' && !sheetIds.has(gid)) sheetIds.set(gid, id)
  })

  const sheets: IWorkbookData['sheets'] = {}
  const sheetOrder: string[] = []
  const sheetInfo: ImportedSheetInfo[] = []
  const nameOf = new Map<number, { id: string; name: string; size: GridSize }>()
  const cfResource: Record<string, UniverCfRule[]> = {}
  const dvResource: Record<string, ISheetDataValidationRule[]> = {}
  const filterResource: Record<string, UniverAutoFilter> = {}
  const noteResource: Record<string, ConvertedSheet['notes']> = {}

  for (const { sheet, i } of ordered) {
    const p = sheet.properties ?? {}
    const id = idOf.get(sheet) as string
    const name = p.title ?? `Sheet${i + 1}`
    if (p.sheetType === 'OBJECT') {
      items.push({ kind: 'object_sheet', outcome: 'not_transferred', location: location(id, name, null), message: MESSAGES.objectSheet(), detail: name })
      continue
    }
    const size = sheetSize(sheet)
    if (typeof p.sheetId === 'number') nameOf.set(p.sheetId, { id, name, size })
    const converted = convertGridSheet(sheet, {
      sheetId: id,
      name,
      size,
      styleCtx: { colors, sheetIsRtl: !!p.rightToLeft },
      supported,
      blockers: options.formulaBlockers ?? (() => []),
      sourceName: options.sourceName ?? GOOGLE_SHEETS,
      sheetIds,
      styles,
      counts,
      items,
    })
    if (p.sheetType === 'DATA_SOURCE') {
      items.push({ kind: 'data_source_sheet', outcome: 'value_only', location: location(id, name, null), message: MESSAGES.dataSourceSheet() })
    }
    sheets[id] = converted.data
    sheetOrder.push(id)
    sheetInfo.push({ googleSheetId: typeof p.sheetId === 'number' ? p.sheetId : null, sheetId: id, name, hidden: !!p.hidden, rightToLeft: !!p.rightToLeft })
    if (converted.cf.length > 0) cfResource[id] = converted.cf
    if (converted.dv.length > 0) dvResource[id] = converted.dv
    if (converted.filter) filterResource[id] = converted.filter
    if (Object.keys(converted.notes).length > 0) noteResource[id] = converted.notes
  }
  counts.sheets = sheetOrder.length

  // ---- named ranges → defined names ----------------------------------------------
  // OPEN: OPEN_QUESTIONS.md §14 — not in the spec §7.2 table; formulas that use them need them.
  const definedNames: Record<string, UniverDefinedName> = {}
  for (const nr of response.namedRanges ?? []) {
    const target = typeof nr.range?.sheetId === 'number' ? nameOf.get(nr.range.sheetId) : undefined
    const range = target ? gridRangeToRange(nr.range, target.size) : null
    if (!nr.name || !target || !range) {
      items.push({ kind: 'named_range', outcome: 'not_transferred', location: null, message: MESSAGES.namedRange('الورقة أو النطاق غير موجود في الملف المستورد'), detail: nr.name })
      continue
    }
    const id = `nr-${nr.namedRangeId ?? Object.keys(definedNames).length}`
    definedNames[id] = {
      id,
      name: nr.name,
      formulaOrRefString: `${quoteSheetName(target.name)}!${absoluteA1Range(range)}`,
      localSheetId: DEFINED_NAME_WORKBOOK_SCOPE,
    }
  }
  counts.definedNames = Object.keys(definedNames).length

  for (const thread of response.comments ?? []) {
    // Threads without an anchor in a converted sheet are reported at workbook level.
    const anchored = (response.sheets ?? []).some((s) => (s.commentAnchors ?? []).some((a) => a.anchorId && a.anchorId === thread.anchorId))
    if (!anchored) items.push({ kind: 'comment', outcome: 'not_transferred', location: null, message: MESSAGES.comment(), detail: thread.headPost?.content })
  }
  if (colors.unresolved.size > 0) {
    items.push({ kind: 'theme_color', outcome: 'not_transferred', location: null, message: MESSAGES.themeColor([...colors.unresolved]) })
  }

  const resources: NonNullable<IWorkbookData['resources']> = []
  if (Object.keys(cfResource).length > 0) resources.push({ name: RESOURCE.CONDITIONAL_FORMATTING, data: JSON.stringify(cfResource) })
  if (Object.keys(dvResource).length > 0) resources.push({ name: RESOURCE.DATA_VALIDATION, data: JSON.stringify(dvResource) })
  if (Object.keys(filterResource).length > 0) resources.push({ name: RESOURCE.FILTER, data: JSON.stringify(filterResource) })
  if (Object.keys(noteResource).length > 0) resources.push({ name: RESOURCE.NOTE, data: JSON.stringify(noteResource) })
  if (Object.keys(definedNames).length > 0) resources.push({ name: RESOURCE.DEFINED_NAME, data: JSON.stringify(definedNames) })

  counts.styles = styles.size
  const title = props.title ?? ''
  const workbook: IWorkbookData = {
    id: options.workbookId ?? (response.spreadsheetId ? `gsheets-${response.spreadsheetId}` : 'gsheets-import'),
    name: title,
    appVersion: UNIVER_VERSION,
    locale: options.locale ?? LOCALE_AR_SA,
    styles: styles.styles,
    sheetOrder,
    sheets,
    resources,
  }
  if (options.dateSystem) workbook.dateSystem = options.dateSystem
  const iterative = props.iterativeCalculationSettings
  if (iterative) {
    workbook.calculationSettings = {
      iterativeCalculation: true,
      maxIterations: iterative.maxIterations ?? DEFAULT_ITERATION.maxIterations,
      maxChange: iterative.convergenceThreshold ?? DEFAULT_ITERATION.maxChange,
    }
  }

  return {
    workbook,
    report: {
      source: {
        spreadsheetId: response.spreadsheetId ?? null,
        title,
        locale: props.locale ?? null,
        origin: options.origin ?? { kind: 'google_api', via: 'google_api', application: null, alignment: 'as_given' },
      },
      counts,
      sheets: sheetInfo,
      items,
    },
  }
}
