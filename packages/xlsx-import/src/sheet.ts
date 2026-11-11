// One worksheet part (ECMA-376 Part 1 §18.3) → a Google `Sheet` of the
// intermediate model, plus what the converter cannot see (report items the
// reader adds itself).
//
// <sheetData> is streamed (it can hold hundreds of thousands of cells);
// every other child of <worksheet> is small and read as a tree.

import type {
  GsBandedRange,
  GsBooleanCondition,
  GsCellData,
  GsConditionalFormatRule,
  GsConditionValue,
  GsConditionType,
  GsDataValidationRule,
  GsDimensionProperties,
  GsEmbeddedChart,
  GsExtendedValue,
  GsGridData,
  GsInterpolationPoint,
  GsSheet,
  GsSlicer,
  GsTextFormatRun,
  ImportItemKind,
  ImportItemOutcome,
} from '@naf-sheets/gsheets-import'
import { MESSAGES } from '@naf-sheets/gsheets-import'
import type { XlsxColors } from './colors'
import { XlsxImportError } from './errors'
import { shiftFormula, stripFuturePrefixes, unwrapGoogleDummy } from './formula'
import { REL, relIs, type XlsxPackage } from './package'
import { clip, parseCell, parseRange, parseSqref, toGridRange, type RangeRef } from './ref'
import { richTextOf, type SharedString } from './shared-strings'
import { hexToGsColor, type StyleSheet } from './styles'
import { child, children, deepText, descendants, parseXmlEvents, parseXmlTree, type XmlAttributes, type XmlNode } from './xml'

export type OriginFamily = 'google_export' | 'excel_like'

export interface PendingItem {
  kind: ImportItemKind
  outcome: ImportItemOutcome
  /** Inclusive 0-based; null = the whole sheet. */
  range: { startRow: number; startCol: number; endRow: number; endCol: number } | null
  message: string
  detail?: string
}

export interface SheetContext {
  pkg: XlsxPackage
  part: string
  gid: number
  name: string
  family: OriginFamily
  styles: StyleSheet
  colors: XlsxColors
  sharedStrings: SharedString[]
  /** Sheet name → gid, for internal links. */
  sheetGids: ReadonlyMap<string, number>
  date1904: boolean
  /** Cells read so far in the workbook; throws above `maxCells`. */
  countCell: () => void
  maxDeclaredCells: { remaining: number }
}

export interface SheetResult {
  sheet: GsSheet
  items: PendingItem[]
  /** A DUMMYFUNCTION wrapper was seen (origin signal). */
  sawGoogleDummy: boolean
  /** Cells holding a literal boolean (for checkbox restoration). */
  booleanCells: Array<[number, number]>
}

/** Minimum grid, like a blank workbook (and a new Google sheet): 1000 × 26. */
const MIN_ROWS = 1000
const MIN_COLS = 26
/** Excel's Maximum Digit Width for Calibri 11 / Aptos Narrow 11 at 96 dpi. OPEN: G23. */
const EXCEL_MDW = 7

/** Column width in characters → pixels, per origin (verified for Google; ECMA formula for Excel). */
export function columnPixels(width: number, family: OriginFamily): number {
  if (family === 'google_export') {
    // Google writes width = (pixels + 1) / 8, rounded to 2 decimals: verified on
    // 13 columns of a real export against Google's own htmlview pixel widths
    // (12.63 ↔ 100, 67.13 ↔ 536, 3.5 ↔ 27, 24.63 ↔ 196 …).
    return Math.max(0, Math.round(width * 8 - 1))
  }
  // ECMA-376 Part 1 §18.3.1.13: pixels = Truncate(((256·width + Truncate(128/MDW)) / 256) · MDW).
  return Math.max(0, Math.trunc(((256 * width + Math.trunc(128 / EXCEL_MDW)) / 256) * EXCEL_MDW))
}

/** Row height in points → pixels (96 dpi). Google's 15.75 pt default is its 21 px row. */
export function rowPixels(points: number): number {
  return Math.max(0, Math.round((points * 96) / 72))
}

const ERROR_TYPES: Record<string, NonNullable<GsExtendedValue['errorValue']>['type']> = {
  '#NULL!': 'NULL_VALUE',
  '#DIV/0!': 'DIVIDE_BY_ZERO',
  '#VALUE!': 'VALUE',
  '#REF!': 'REF',
  '#NAME?': 'NAME',
  '#NUM!': 'NUM',
  '#N/A': 'N_A',
}

const MS_PER_DAY = 86_400_000
/** ISO date (t="d") → 1900-system serial. */
function isoToSerial(iso: string): number | null {
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso.endsWith('Z') ? iso : `${iso}Z`)
  if (!Number.isFinite(t)) return null
  const serial = (t - Date.UTC(1899, 11, 30)) / MS_PER_DAY
  return serial
}

interface RawCell {
  row: number
  col: number
  s: number
  t: string
  f: { text: string; t: string | null; ref: string | null; si: string | null } | null
  v: string | null
  inline: SharedString | null
}

const CF_TEXT_TYPES: Record<string, GsConditionType> = {
  containsText: 'TEXT_CONTAINS',
  notContainsText: 'TEXT_NOT_CONTAINS',
  beginsWith: 'TEXT_STARTS_WITH',
  endsWith: 'TEXT_ENDS_WITH',
}

const CELLIS_NUMBER: Record<string, GsConditionType> = {
  greaterThan: 'NUMBER_GREATER',
  greaterThanOrEqual: 'NUMBER_GREATER_THAN_EQ',
  lessThan: 'NUMBER_LESS',
  lessThanOrEqual: 'NUMBER_LESS_THAN_EQ',
  equal: 'NUMBER_EQ',
  notEqual: 'NUMBER_NOT_EQ',
  between: 'NUMBER_BETWEEN',
  notBetween: 'NUMBER_NOT_BETWEEN',
}

const CELLIS_OPERATOR: Record<string, string> = {
  greaterThan: '>',
  greaterThanOrEqual: '>=',
  lessThan: '<',
  lessThanOrEqual: '<=',
  equal: '=',
  notEqual: '<>',
}

const DV_NUMBER: Record<string, GsConditionType> = { ...CELLIS_NUMBER }
const DV_DATE: Record<string, GsConditionType> = {
  between: 'DATE_BETWEEN',
  notBetween: 'DATE_NOT_BETWEEN',
  equal: 'DATE_EQ',
  lessThan: 'DATE_BEFORE',
  lessThanOrEqual: 'DATE_ON_OR_BEFORE',
  greaterThan: 'DATE_AFTER',
  greaterThanOrEqual: 'DATE_ON_OR_AFTER',
}

const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const QUOTED = /^"((?:[^"]|"")*)"$/

/** A condition operand as Google's ConditionValue holds it: a plain number, else a formula. */
function operand(f: string | undefined): GsConditionValue | null {
  if (f === undefined) return null
  const text = f.trim()
  if (text === '') return null
  if (PLAIN_NUMBER.test(text)) return { userEnteredValue: text }
  return { userEnteredValue: `=${stripFuturePrefixes(text)}` }
}

/**
 * Google's export of a "date is valid" rule (verified on a real export):
 * `OR(NOT(ISERROR(DATEVALUE(B2))), AND(ISNUMBER(B2), LEFT(CELL("format", B2))="D"))`.
 */
const GOOGLE_VALID_DATE = /^OR\(NOT\(ISERROR\(DATEVALUE\((\$?[A-Z]{1,3}\$?\d+)\)\)\),\s*AND\(ISNUMBER\(\1\),\s*LEFT\(CELL\("format",\s*\1\)\)="D"\)\)$/i

export async function readSheet(ctx: SheetContext): Promise<SheetResult> {
  const { pkg, part, gid, family, styles, colors } = ctx
  const items: PendingItem[] = []
  const xml = await pkg.text(part)
  if (xml === null) throw new XlsxImportError('corrupt', `missing worksheet part ${part}`)

  // ---- streaming read ---------------------------------------------------------
  const raw: RawCell[] = []
  const rowInfo = new Map<number, XmlAttributes>()
  const top: XmlNode = { name: 'worksheet', qname: 'worksheet', attrs: {}, children: [], text: '' }
  const treeStack: XmlNode[] = []
  let depth = 0
  let inSheetData = false
  let currentRow = -1
  let nextCol = 0
  let cell: RawCell | null = null
  let textTarget: 'f' | 'v' | 'is' | null = null
  let isRuns: XmlNode[] = []
  let isRunStack: XmlNode[] = []
  let fAttrs: XmlAttributes = {}
  let fText = ''
  let vText = ''

  parseXmlEvents(xml, {
    open(name, attrs, qname) {
      depth++
      if (depth === 1) return
      if (depth === 2 && name === 'sheetData') {
        inSheetData = true
        return
      }
      if (!inSheetData) {
        const node: XmlNode = { name, qname, attrs, children: [], text: '' }
        ;(treeStack[treeStack.length - 1] ?? top).children.push(node)
        treeStack.push(node)
        return
      }
      if (name === 'row') {
        const r = attrs.r !== undefined ? Number(attrs.r) - 1 : currentRow + 1
        if (!Number.isInteger(r) || r < 0 || r > 1_048_575) throw new XlsxImportError('corrupt', 'bad row number')
        currentRow = r
        nextCol = 0
        rowInfo.set(r, attrs)
      } else if (name === 'c') {
        const ref = attrs.r ? parseCell(attrs.r) : { row: currentRow, col: nextCol }
        if (!ref) throw new XlsxImportError('corrupt', 'bad cell reference')
        nextCol = ref.col + 1
        ctx.countCell()
        cell = { row: ref.row, col: ref.col, s: Number(attrs.s ?? 0) || 0, t: attrs.t ?? 'n', f: null, v: null, inline: null }
      } else if (cell && name === 'f') {
        textTarget = 'f'
        fAttrs = attrs
        fText = ''
      } else if (cell && name === 'v') {
        textTarget = 'v'
        vText = ''
      } else if (cell && name === 'is') {
        textTarget = 'is'
        isRuns = []
        isRunStack = []
      } else if (cell && textTarget === 'is') {
        const node: XmlNode = { name, qname, attrs, children: [], text: '' }
        ;(isRunStack[isRunStack.length - 1]?.children ?? isRuns).push(node)
        isRunStack.push(node)
      }
    },
    close(name) {
      depth--
      if (depth === 0) return
      if (depth === 1 && name === 'sheetData') {
        inSheetData = false
        return
      }
      if (!inSheetData) {
        treeStack.pop()
        return
      }
      if (cell && name === 'f' && textTarget === 'f') {
        cell.f = { text: fText, t: fAttrs.t ?? null, ref: fAttrs.ref ?? null, si: fAttrs.si ?? null }
        textTarget = null
      } else if (cell && name === 'v' && textTarget === 'v') {
        cell.v = vText
        textTarget = null
      } else if (cell && name === 'is' && textTarget === 'is') {
        cell.inline = sharedStringFromNodes(isRuns, colors, styles)
        textTarget = null
      } else if (cell && textTarget === 'is') {
        isRunStack.pop()
      } else if (cell && name === 'c') {
        raw.push(cell)
        cell = null
      }
    },
    text(text) {
      if (!inSheetData) {
        const node = treeStack[treeStack.length - 1]
        if (node) node.text += text
        return
      }
      if (textTarget === 'f') fText += text
      else if (textTarget === 'v') vText += text
      else if (textTarget === 'is') {
        const node = isRunStack[isRunStack.length - 1]
        if (node) node.text += text
      }
    },
  })

  const sheetPr = child(top, 'sheetPr')
  const sheetView = child(child(top, 'sheetViews'), 'sheetView')
  const formatPr = child(top, 'sheetFormatPr')
  const rels = await pkg.rels(part)

  // ---- extent --------------------------------------------------------------------
  let maxRow = -1
  let maxCol = -1
  for (const c of raw) {
    if (c.row > maxRow) maxRow = c.row
    if (c.col > maxCol) maxCol = c.col
  }
  const mergeRanges = children(child(top, 'mergeCells'), 'mergeCell')
    .map((m) => parseRange(m.attrs.ref ?? ''))
    .filter((r): r is RangeRef => r !== null)
  for (const m of mergeRanges) {
    maxRow = Math.max(maxRow, m.endRow ?? m.startRow)
    maxCol = Math.max(maxCol, m.endCol ?? m.startCol)
  }
  const colNodes = children(child(top, 'cols'), 'col')
  for (const col of colNodes) {
    const max = Number(col.attrs.max) - 1
    // A <col> styling the whole sheet (max 16384) does not make the sheet wider.
    if (Number.isInteger(max) && max < 16_383 && (col.attrs.customWidth === '1' || col.attrs.hidden === '1')) maxCol = Math.max(maxCol, max)
  }
  const rowCount = Math.max(maxRow + 1, MIN_ROWS)
  const columnCount = Math.max(maxCol + 1, MIN_COLS)
  ctx.maxDeclaredCells.remaining -= rowCount * columnCount
  if (ctx.maxDeclaredCells.remaining < 0) throw new XlsxImportError('too_large', 'declared grid')
  const clipped = (r: RangeRef) => clip(r, rowCount, columnCount)

  // ---- cells ----------------------------------------------------------------------
  const cells = new Map<number, Map<number, GsCellData>>()
  const cellAt = (r: number, c: number, create = true): GsCellData | undefined => {
    let line = cells.get(r)
    if (!line) {
      if (!create) return undefined
      cells.set(r, (line = new Map()))
    }
    let data = line.get(c)
    if (!data && create) line.set(c, (data = {}))
    return data
  }
  const sharedMasters = new Map<string, { text: string; row: number; col: number }>()
  const arrayMembers = new Set<string>()
  const booleanCells: Array<[number, number]> = []
  let sawGoogleDummy = false
  const dataTableCells: Array<[number, number]> = []

  for (const c of raw) {
    const style = styles.cellStyles[c.s] ?? styles.cellStyles[0]
    const data: GsCellData = {}
    if (style?.format) data.userEnteredFormat = style.format

    // Cached / literal value.
    let value: GsExtendedValue | undefined
    let runs: GsTextFormatRun[] | undefined
    let formatted: string | undefined
    switch (c.t) {
      case 's': {
        const ss = ctx.sharedStrings[Number(c.v)]
        if (ss) {
          value = { stringValue: ss.text }
          runs = ss.runs
        } else if (c.v !== null) throw new XlsxImportError('corrupt', 'shared string index out of range')
        break
      }
      case 'inlineStr':
        if (c.inline) {
          value = { stringValue: c.inline.text }
          runs = c.inline.runs
        }
        break
      case 'str':
        if (c.v !== null) value = { stringValue: c.v }
        break
      case 'b':
        if (c.v !== null) value = { boolValue: c.v.trim() === '1' || c.v.trim().toLowerCase() === 'true' }
        break
      case 'e':
        if (c.v !== null) {
          const text = c.v.trim()
          value = { errorValue: { type: ERROR_TYPES[text] ?? 'ERROR', message: text } }
          formatted = text
        }
        break
      case 'd':
        if (c.v !== null) {
          const serial = isoToSerial(c.v.trim())
          if (serial !== null) value = { numberValue: serial }
        }
        break
      default:
        if (c.v !== null && c.v.trim() !== '') {
          const n = Number(c.v)
          if (Number.isFinite(n)) value = { numberValue: n }
        }
    }

    // Formula.
    let formula: string | null = null
    let produced = false
    if (c.f) {
      const kind = c.f.t ?? 'normal'
      if (kind === 'shared' && c.f.si !== null) {
        const master = sharedMasters.get(c.f.si)
        if (c.f.text.trim() !== '') sharedMasters.set(c.f.si, { text: c.f.text, row: c.row, col: c.col })
        const base = c.f.text.trim() !== '' ? { text: c.f.text, row: c.row, col: c.col } : master
        if (base) formula = shiftFormula(base.text, c.row - base.row, c.col - base.col)
      } else if (kind === 'dataTable') {
        // A what-if data table: Univer has none; the computed values stay.
        dataTableCells.push([c.row, c.col])
      } else {
        formula = c.f.text
        if (kind === 'array' && c.f.ref) {
          const ref = parseRange(c.f.ref)
          if (ref && ref.endRow !== null && ref.endCol !== null) {
            for (let r = ref.startRow; r <= ref.endRow; r++) for (let k = ref.startCol; k <= ref.endCol; k++) if (r !== c.row || k !== c.col) arrayMembers.add(`${r}:${k}`)
          }
        }
      }
      if (formula !== null && formula.trim() === '') formula = null
    } else if (arrayMembers.has(`${c.row}:${c.col}`)) {
      produced = true
    }

    if (formula !== null) {
      const dummy = unwrapGoogleDummy(formula)
      if (dummy) sawGoogleDummy = true
      if (dummy?.kind === 'computed') {
        produced = true
        formula = null
      } else if (dummy?.kind === 'formula') {
        formula = dummy.formula
      } else {
        formula = `=${stripFuturePrefixes(formula)}`
      }
    }

    if (formula !== null) {
      data.userEnteredValue = { formulaValue: formula }
      if (value) data.effectiveValue = value
      if (formatted) data.formattedValue = formatted
    } else if (produced) {
      if (value) data.effectiveValue = value
      if (formatted) data.formattedValue = formatted
    } else if (value) {
      if (value.errorValue) {
        // A literal error typed into a cell: kept as its text.
        data.userEnteredValue = { stringValue: formatted ?? '#ERROR!' }
      } else {
        data.userEnteredValue = value
        if (runs && runs.length > 0 && value.stringValue !== undefined) data.textFormatRuns = runs
        if (value.boolValue !== undefined) booleanCells.push([c.row, c.col])
      }
    }
    if (Object.keys(data).length === 0) continue
    // A date serial is a day count in the file's own system; Univer reads it with
    // the workbook's `dateSystem` (set from date1904), so it is written unchanged.
    const line = cells.get(c.row) ?? new Map<number, GsCellData>()
    cells.set(c.row, line)
    line.set(c.col, data)
  }
  if (dataTableCells.length > 0) {
    items.push({ kind: 'derived_value', outcome: 'value_only', range: boundingBox(dataTableCells), message: MESSAGES.derivedValue() })
  }

  // ---- hyperlinks ------------------------------------------------------------------
  for (const h of children(child(top, 'hyperlinks'), 'hyperlink')) {
    const range = parseRange(h.attrs.ref ?? '')
    if (!range) continue
    let url: string | null = null
    const rel = h.attrs['r:id'] ?? h.attrs.id
    if (rel) {
      const target = rels.find((r) => r.id === rel)
      if (target?.external) url = target.target + (h.attrs.location ? `#${h.attrs.location}` : '')
    } else if (h.attrs.location) {
      url = internalLink(h.attrs.location, ctx.sheetGids)
    }
    if (!url) continue
    const box = clipped(range)
    if (!box) continue
    for (let r = box.startRow; r <= box.endRow; r++) {
      for (let k = box.startCol; k <= box.endCol; k++) {
        const data = cellAt(r, k, false)
        if (data?.userEnteredValue) data.hyperlink = url
      }
    }
  }

  // ---- notes and comments --------------------------------------------------------------
  const threaded = new Set<string>()
  for (const rel of rels.filter((r) => relIs(r, REL.threadedComment) && !r.external)) {
    const tree = await pkg.tree(rel.target)
    for (const tc of children(tree ?? undefined, 'threadedComment')) {
      if (tc.attrs.parentId) continue
      const ref = parseCell(tc.attrs.ref ?? '')
      if (!ref) continue
      const key = `${ref.row}:${ref.col}`
      if (threaded.has(key)) continue
      threaded.add(key)
      items.push({ kind: 'comment', outcome: 'not_transferred', range: { startRow: ref.row, startCol: ref.col, endRow: ref.row, endCol: ref.col }, message: MESSAGES.threadedComment() })
    }
  }
  for (const rel of rels.filter((r) => relIs(r, REL.comments) && !r.external)) {
    const tree = await pkg.tree(rel.target)
    for (const cm of children(child(tree ?? undefined, 'commentList'), 'comment')) {
      const ref = parseCell(cm.attrs.ref ?? '')
      if (!ref || threaded.has(`${ref.row}:${ref.col}`)) continue
      const text = deepText(child(cm, 'text')).replace(/\r\n?/g, '\n').trim()
      if (!text) continue
      const data = cellAt(ref.row, ref.col) as GsCellData
      data.note = text
    }
  }

  // ---- rows and columns ---------------------------------------------------------------
  const filterNode = child(top, 'autoFilter')
  const filterRange = filterNode ? parseRange(filterNode.attrs.ref ?? '') : null
  const filterHasCriteria = !!filterNode && children(filterNode, 'filterColumn').length > 0
  const defaultRowPt = Number(formatPr?.attrs.defaultRowHeight)
  const defaultRowPx = Number.isFinite(defaultRowPt) && defaultRowPt > 0 ? rowPixels(defaultRowPt) : family === 'google_export' ? 21 : 20
  const rowMetadata: GsDimensionProperties[] = []
  const rowOutline: Array<[number, number]> = []
  for (let r = 0; r < rowCount; r++) {
    const info = rowInfo.get(r)
    const m: GsDimensionProperties = { pixelSize: defaultRowPx }
    if (info) {
      const ht = Number(info.ht)
      if (Number.isFinite(ht) && ht > 0 && (info.customHeight === '1' || info.customHeight === 'true' || family === 'excel_like')) m.pixelSize = rowPixels(ht)
      if (info.hidden === '1' || info.hidden === 'true') {
        const byFilter = filterHasCriteria && filterRange && r > filterRange.startRow && (filterRange.endRow === null || r <= filterRange.endRow)
        if (byFilter) m.hiddenByFilter = true
        else m.hiddenByUser = true
      }
      const level = Number(info.outlineLevel)
      if (level > 0) rowOutline.push([r, 0])
    }
    rowMetadata.push(m)
  }
  const defaultColChars = Number(formatPr?.attrs.defaultColWidth)
  const baseColChars = Number(formatPr?.attrs.baseColWidth)
  const defaultColPx = Number.isFinite(defaultColChars) && defaultColChars > 0
    ? columnPixels(defaultColChars, family)
    : family === 'google_export'
      ? 100
      : Number.isFinite(baseColChars) && baseColChars > 0
        ? Math.round(baseColChars * EXCEL_MDW + 8)
        : 64
  const columnMetadata: GsDimensionProperties[] = Array.from({ length: columnCount }, () => ({ pixelSize: defaultColPx }))
  const colOutline: Array<[number, number]> = []
  for (const col of colNodes) {
    const min = Number(col.attrs.min) - 1
    const max = Math.min(Number(col.attrs.max) - 1, columnCount - 1)
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0) continue
    const width = Number(col.attrs.width)
    for (let k = min; k <= max; k++) {
      const m = columnMetadata[k] as GsDimensionProperties
      if (Number.isFinite(width) && width >= 0 && (col.attrs.customWidth === '1' || col.attrs.customWidth === 'true' || family === 'excel_like')) m.pixelSize = columnPixels(width, family)
      if (col.attrs.hidden === '1' || col.attrs.hidden === 'true') m.hiddenByUser = true
      if (Number(col.attrs.outlineLevel) > 0) colOutline.push([0, k])
    }
  }
  for (const run of runsOf(rowOutline.map(([r]) => r))) items.push({ kind: 'row_group', outcome: 'not_transferred', range: { startRow: run[0], startCol: 0, endRow: run[1], endCol: columnCount - 1 }, message: MESSAGES.rowGroup() })
  for (const run of runsOf(colOutline.map(([, k]) => k))) items.push({ kind: 'column_group', outcome: 'not_transferred', range: { startRow: 0, startCol: run[0], endRow: rowCount - 1, endCol: run[1] }, message: MESSAGES.columnGroup() })

  // ---- data validation ---------------------------------------------------------------
  const dvNodes: Array<{ node: XmlNode; formula1?: string; formula2?: string; sqref?: string }> = []
  for (const dv of children(child(top, 'dataValidations'), 'dataValidation')) {
    dvNodes.push({ node: dv, formula1: child(dv, 'formula1')?.text, formula2: child(dv, 'formula2')?.text, sqref: dv.attrs.sqref })
  }
  for (const ext of children(child(top, 'extLst'), 'ext')) {
    for (const dv of descendants(ext, 'dataValidation')) {
      if (!dv.qname.includes(':')) continue
      dvNodes.push({
        node: dv,
        formula1: child(child(dv, 'formula1'), 'f')?.text,
        formula2: child(child(dv, 'formula2'), 'f')?.text,
        sqref: child(dv, 'sqref')?.text,
      })
    }
  }
  const validated = new Set<string>()
  for (const { node, formula1, formula2, sqref } of dvNodes) {
    const ranges = parseSqref(sqref).map(clipped).filter((r): r is NonNullable<typeof r> => r !== null)
    if (ranges.length === 0) continue
    const result = dataValidationRule(node.attrs, formula1, formula2, family)
    if ('reason' in result) {
      for (const range of ranges) items.push({ kind: 'data_validation', outcome: 'not_transferred', range, message: MESSAGES.dataValidation(result.reason), detail: node.attrs.type })
      continue
    }
    for (const range of ranges) {
      for (let r = range.startRow; r <= range.endRow; r++) {
        for (let k = range.startCol; k <= range.endCol; k++) {
          ;(cellAt(r, k) as GsCellData).dataValidation = result.rule
          validated.add(`${r}:${k}`)
        }
      }
    }
  }

  // ---- Google checkboxes: TRUE/FALSE literals without a rule ------------------------
  if (family === 'google_export') {
    const restored = booleanCells.filter(([r, k]) => !validated.has(`${r}:${k}`))
    for (const [r, k] of restored) (cellAt(r, k) as GsCellData).dataValidation = { condition: { type: 'BOOLEAN' } }
    for (const box of rectangles(restored)) items.push({ kind: 'checkbox', outcome: 'converted', range: box, message: MESSAGES.checkbox() })
  }

  // ---- conditional formats ---------------------------------------------------------------
  const cfRules: Array<{ priority: number; order: number; rule: GsConditionalFormatRule }> = []
  let order = 0
  for (const block of children(top, 'conditionalFormatting')) {
    const ranges = parseSqref(block.attrs.sqref).map((r) => toGridRange(r, gid))
    const first = parseSqref(block.attrs.sqref)[0]
    for (const rule of children(block, 'cfRule')) {
      const priority = Number(rule.attrs.priority)
      const converted = conditionalRule(rule, ranges, first, styles, colors)
      if ('reason' in converted) {
        for (const r of parseSqref(block.attrs.sqref).map(clipped)) if (r) items.push({ kind: 'conditional_format', outcome: 'not_transferred', range: r, message: MESSAGES.conditionalFormat(converted.reason), detail: rule.attrs.type })
        continue
      }
      cfRules.push({ priority: Number.isFinite(priority) ? priority : 1e9, order: order++, rule: converted.rule })
    }
  }
  for (const ext of children(child(top, 'extLst'), 'ext')) {
    for (const block of descendants(ext, 'conditionalFormatting')) {
      const sq = parseSqref(child(block, 'sqref')?.text)
      for (const r of sq.map(clipped)) if (r) items.push({ kind: 'conditional_format', outcome: 'not_transferred', range: r, message: MESSAGES.conditionalFormat('القاعدة من صيغة Excel 2010 الموسّعة (أشرطة بيانات أو أيقونات أو مرجع إلى ورقة أخرى) ولا مقابل لها') })
    }
  }
  cfRules.sort((a, b) => a.priority - b.priority || a.order - b.order)

  // ---- filter ---------------------------------------------------------------------------
  let basicFilter: GsSheet['basicFilter']
  if (filterNode && filterRange) {
    basicFilter = { range: toGridRange(filterRange, gid) }
    if (filterHasCriteria) {
      const box = clipped(filterRange)
      for (const fc of children(filterNode, 'filterColumn')) {
        const col = (box?.startCol ?? 0) + Number(fc.attrs.colId ?? 0)
        if (box) items.push({ kind: 'filter_criteria', outcome: 'not_transferred', range: { startRow: box.startRow, endRow: box.endRow, startCol: col, endCol: col }, message: MESSAGES.filterCriteria('معايير الفلتر في ملف Excel لا تُقرأ في الإصدار الأول، وظهرت الصفوف التي كان يخفيها') })
      }
    }
  }

  // ---- tables ----------------------------------------------------------------------------
  const bandedRanges: GsBandedRange[] = []
  for (const tp of children(child(top, 'tableParts'), 'tablePart')) {
    const rel = rels.find((r) => r.id === (tp.attrs['r:id'] ?? tp.attrs.id))
    if (!rel || rel.external) continue
    const table = await pkg.tree(rel.target)
    if (!table) continue
    const range = parseRange(table.attrs.ref ?? '')
    const box = range ? clipped(range) : null
    if (!range || !box) continue
    const name = table.attrs.displayName ?? table.attrs.name ?? ''
    items.push({ kind: 'table', outcome: 'converted', range: box, message: family === 'google_export' ? MESSAGES.table() : MESSAGES.excelTable(), detail: name || undefined })
    const info = child(table, 'tableStyleInfo')
    const styleName = info?.attrs.name
    if (!styleName) continue
    const custom = styles.tableStyles.get(styleName)
    const headerRows = table.attrs.headerRowCount === '0' ? 0 : 1
    const stripes = info.attrs.showRowStripes !== '0'
    if (custom && (custom.header || custom.first || custom.second)) {
      const banded: GsBandedRange = { range: toGridRange(range, gid), rowProperties: {} }
      const props = banded.rowProperties as NonNullable<GsBandedRange['rowProperties']>
      if (headerRows > 0 && custom.header) props.headerColorStyle = { rgbColor: hexToGsColor(custom.header) }
      const firstColor = custom.first ?? '#ffffff'
      props.firstBandColorStyle = { rgbColor: hexToGsColor(firstColor) }
      props.secondBandColorStyle = { rgbColor: hexToGsColor(stripes ? (custom.second ?? firstColor) : firstColor) }
      bandedRanges.push(banded)
    } else if (!custom) {
      items.push({ kind: 'table', outcome: 'not_transferred', range: box, message: MESSAGES.tableStyleNotTransferred(styleName), detail: styleName })
    }
  }

  // ---- drawings: pictures, charts, shapes, slicers -----------------------------------------
  const charts: GsEmbeddedChart[] = []
  const slicers: GsSlicer[] = []
  for (const dr of children(top, 'drawing')) {
    const rel = rels.find((r) => r.id === (dr.attrs['r:id'] ?? dr.attrs.id))
    if (!rel || rel.external) continue
    const drawing = await pkg.tree(rel.target)
    for (const anchor of (drawing?.children ?? []).filter((n) => /Anchor$/.test(n.name))) {
      const from = child(anchor, 'from')
      const row = Number(child(from, 'row')?.text ?? 0) || 0
      const col = Number(child(from, 'col')?.text ?? 0) || 0
      const position = { sheetId: gid, overlayPosition: { anchorCell: { sheetId: gid, rowIndex: row, columnIndex: col } } }
      const at = { startRow: row, startCol: col, endRow: row, endCol: col }
      if (descendants(anchor, 'chart').length > 0) {
        const title = descendants(anchor, 'cNvPr')[0]?.attrs.name
        charts.push({ position, spec: title ? { title } : {} })
      } else if (descendants(anchor, 'slicer').length > 0) {
        slicers.push({ position, spec: {} })
      } else if (descendants(anchor, 'pic').length > 0) {
        items.push({ kind: 'drawing_image', outcome: 'not_transferred', range: at, message: MESSAGES.drawingImage(), detail: descendants(anchor, 'cNvPr')[0]?.attrs.descr || undefined })
      } else if (descendants(anchor, 'sp').length > 0 || descendants(anchor, 'grpSp').length > 0 || descendants(anchor, 'cxnSp').length > 0) {
        items.push({ kind: 'drawing_shape', outcome: 'not_transferred', range: at, message: MESSAGES.drawingShape() })
      }
    }
  }
  for (const control of descendants(child(top, 'controls'), 'control')) {
    const from = child(child(control, 'anchor'), 'from')
    const row = Number(child(from, 'row')?.text ?? 0) || 0
    const col = Number(child(from, 'col')?.text ?? 0) || 0
    items.push({ kind: 'drawing_shape', outcome: 'not_transferred', range: { startRow: row, startCol: col, endRow: row, endCol: col }, message: MESSAGES.drawingShape(), detail: control.attrs.name })
  }

  // ---- pivot tables -------------------------------------------------------------------------
  for (const rel of rels.filter((r) => relIs(r, REL.pivotTable) && !r.external)) {
    const pivot = await pkg.tree(rel.target)
    const loc = parseRange(child(pivot ?? undefined, 'location')?.attrs.ref ?? '')
    const box = loc ? clipped(loc) : null
    items.push({ kind: 'pivot_table', outcome: 'not_transferred', range: box, message: MESSAGES.pivotTable(), detail: pivot?.attrs.name })
  }

  // ---- sparklines, protection -------------------------------------------------------------------
  for (const ext of children(child(top, 'extLst'), 'ext')) {
    if (descendants(ext, 'sparklineGroup').length > 0) items.push({ kind: 'unsupported_feature', outcome: 'not_transferred', range: null, message: MESSAGES.sparklines() })
  }
  const protection = child(top, 'sheetProtection')
  if (protection && (protection.attrs.sheet === '1' || protection.attrs.sheet === 'true')) {
    items.push({ kind: 'protected_range', outcome: 'not_transferred', range: null, message: MESSAGES.protectedRange() })
  }
  for (const pr of children(child(top, 'protectedRanges'), 'protectedRange')) {
    for (const r of parseSqref(pr.attrs.sqref).map(clipped)) if (r) items.push({ kind: 'protected_range', outcome: 'not_transferred', range: r, message: MESSAGES.protectedRange(), detail: pr.attrs.name })
  }

  // ---- assemble --------------------------------------------------------------------------------
  const data: GsGridData[] = [{ startRow: 0, startColumn: 0, rowMetadata, columnMetadata }]
  for (const r of [...cells.keys()].sort((a, b) => a - b)) {
    const line = cells.get(r) as Map<number, GsCellData>
    const cols = [...line.keys()].sort((a, b) => a - b)
    const c0 = cols[0] as number
    const values: GsCellData[] = []
    for (const k of cols) values[k - c0] = line.get(k) as GsCellData
    for (let k = 0; k < values.length; k++) if (!values[k]) values[k] = {}
    data.push({ startRow: r, startColumn: c0, rowData: [{ values }] })
  }

  const pane = child(sheetView, 'pane')
  const frozen = pane && (pane.attrs.state === 'frozen' || pane.attrs.state === 'frozenSplit')
  const tab = colors.resolve(child(sheetPr, 'tabColor'))
  const sheet: GsSheet = {
    properties: {
      sheetId: gid,
      title: ctx.name,
      sheetType: 'GRID',
      gridProperties: {
        rowCount,
        columnCount,
        frozenRowCount: frozen ? Math.max(0, Math.round(Number(pane.attrs.ySplit ?? 0)) || 0) : 0,
        frozenColumnCount: frozen ? Math.max(0, Math.round(Number(pane.attrs.xSplit ?? 0)) || 0) : 0,
        hideGridlines: sheetView?.attrs.showGridLines === '0' || sheetView?.attrs.showGridLines === 'false',
      },
      rightToLeft: sheetView?.attrs.rightToLeft === '1' || sheetView?.attrs.rightToLeft === 'true',
    },
    data,
    merges: mergeRanges.map((m) => toGridRange(m, gid)),
    conditionalFormats: cfRules.map((x) => x.rule),
    charts,
    slicers,
    bandedRanges,
  }
  if (tab) (sheet.properties as NonNullable<GsSheet['properties']>).tabColorStyle = { rgbColor: hexToGsColor(tab) }
  if (basicFilter) sheet.basicFilter = basicFilter
  return { sheet, items, sawGoogleDummy, booleanCells }
}

/** `Sheet 2!A1` / `'Sheet 2'!A1` → `#gid=<id>&range=A1`; other targets (defined names) as `#name`. */
export function internalLink(location: string, gids: ReadonlyMap<string, number>): string {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(location.trim())
  if (m) {
    const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] as string)
    const gid = gids.get(sheet)
    if (gid !== undefined) return `#gid=${gid}&range=${(m[3] as string).replace(/\$/g, '')}`
  }
  return `#${location.trim()}`
}

function boundingBox(cells: Array<[number, number]>): PendingItem['range'] {
  let r0 = Infinity
  let c0 = Infinity
  let r1 = -1
  let c1 = -1
  for (const [r, c] of cells) {
    r0 = Math.min(r0, r)
    c0 = Math.min(c0, c)
    r1 = Math.max(r1, r)
    c1 = Math.max(c1, c)
  }
  return r1 < 0 ? null : { startRow: r0, startCol: c0, endRow: r1, endCol: c1 }
}

/** Consecutive runs of sorted unique numbers, as [first, last]. */
function runsOf(values: number[]): Array<[number, number]> {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  const out: Array<[number, number]> = []
  for (const v of sorted) {
    const last = out[out.length - 1]
    if (last && v === last[1] + 1) last[1] = v
    else out.push([v, v])
  }
  return out
}

/** Cells grouped into vertical runs per column, merged across adjacent equal runs. */
function rectangles(cells: Array<[number, number]>): Array<NonNullable<PendingItem['range']>> {
  const byCol = new Map<number, number[]>()
  for (const [r, c] of cells) byCol.set(c, [...(byCol.get(c) ?? []), r])
  const out: Array<NonNullable<PendingItem['range']>> = []
  for (const c of [...byCol.keys()].sort((a, b) => a - b)) {
    for (const [a, b] of runsOf(byCol.get(c) as number[])) {
      const prev = out.find((x) => x.endCol === c - 1 && x.startRow === a && x.endRow === b)
      if (prev) prev.endCol = c
      else out.push({ startRow: a, startCol: c, endRow: b, endCol: c })
    }
  }
  return out
}

/** An inline string (<is>) from its child nodes. */
function sharedStringFromNodes(nodes: XmlNode[], colors: XlsxColors, styles: StyleSheet): SharedString {
  const holder: XmlNode = { name: 'is', qname: 'is', attrs: {}, children: nodes, text: '' }
  return richTextOf(holder, colors, styles)
}

function dataValidationRule(
  a: XmlAttributes,
  formula1: string | undefined,
  formula2: string | undefined,
  family: OriginFamily,
): { rule: GsDataValidationRule } | { reason: string } {
  const type = a.type ?? 'none'
  const rule: GsDataValidationRule = {}
  const showError = a.showErrorMessage === '1' || a.showErrorMessage === 'true'
  rule.strict = showError && (a.errorStyle ?? 'stop') === 'stop'
  if (a.prompt && (a.showInputMessage === '1' || a.showInputMessage === 'true')) rule.inputMessage = a.prompt
  const operator = a.operator ?? 'between'
  const f1 = formula1?.trim()
  const f2 = formula2?.trim()
  switch (type) {
    case 'none':
      return { reason: 'القاعدة تقبل أي قيمة' }
    case 'list': {
      if (!f1) return { reason: 'القائمة فارغة' }
      // showDropDown="1" HIDES the in-cell arrow (§18.3.1.32).
      rule.showCustomUi = !(a.showDropDown === '1' || a.showDropDown === 'true')
      const quoted = QUOTED.exec(f1)
      if (quoted) {
        const values = (quoted[1] as string).replace(/""/g, '"').split(',').map((v) => v.trim()).filter((v) => v !== '')
        rule.condition = { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) }
      } else {
        rule.condition = { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `=${stripFuturePrefixes(f1)}` }] }
      }
      return { rule }
    }
    case 'whole':
    case 'decimal':
    case 'date': {
      const table = type === 'date' ? DV_DATE : DV_NUMBER
      const condType = table[operator]
      if (!condType) return { reason: `العامل ${operator} غير مدعوم لهذا النوع` }
      const v1 = operand(f1)
      if (!v1) return { reason: 'قيمة الشرط مفقودة' }
      const values = [v1]
      if (operator === 'between' || operator === 'notBetween') {
        const v2 = operand(f2)
        if (!v2) return { reason: 'قيمة الشرط الثانية مفقودة' }
        values.push(v2)
      }
      rule.condition = { type: condType, values }
      // OPEN: G27 — "whole number" becomes "number": Univer's decimal rule.
      return { rule }
    }
    case 'custom': {
      if (!f1) return { reason: 'معادلة الشرط مفقودة' }
      if (family === 'google_export' && GOOGLE_VALID_DATE.test(f1)) {
        rule.condition = { type: 'DATE_IS_VALID' }
        return { rule }
      }
      rule.condition = { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${stripFuturePrefixes(f1)}` }] }
      return { rule }
    }
    case 'time':
      return { reason: 'شروط الوقت غير مدعومة في التحقق من البيانات' }
    case 'textLength':
      return { reason: 'شروط طول النص غير مدعومة في التحقق من البيانات' }
    default:
      return { reason: `نوع الشرط ${type} غير مدعوم` }
  }
}

function conditionalRule(
  rule: XmlNode,
  ranges: GsConditionalFormatRule['ranges'],
  first: RangeRef | undefined,
  styles: StyleSheet,
  colors: XlsxColors,
): { rule: GsConditionalFormatRule } | { reason: string } {
  const type = rule.attrs.type ?? ''
  const formulas = children(rule, 'formula').map((f) => f.text.trim())
  const format = styles.dxfs[Number(rule.attrs.dxfId)] ?? undefined
  const boolean = (condition: GsBooleanCondition) => ({
    rule: { ranges, booleanRule: { condition, ...(format ? { format } : {}) } } as GsConditionalFormatRule,
  })
  const topLeft = first ? `${columnName(first.startCol)}${first.startRow + 1}` : 'A1'
  switch (type) {
    case 'expression': {
      const f = formulas[0]
      if (!f) return { reason: 'معادلة الشرط مفقودة' }
      return boolean({ type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${stripFuturePrefixes(f)}` }] })
    }
    case 'cellIs': {
      const op = rule.attrs.operator ?? 'equal'
      const [a, b] = formulas
      if (a === undefined) return { reason: 'قيمة الشرط مفقودة' }
      const literalA = QUOTED.exec(a)
      if (literalA && op === 'equal') return boolean({ type: 'TEXT_EQ', values: [{ userEnteredValue: (literalA[1] as string).replace(/""/g, '"') }] })
      const numeric = PLAIN_NUMBER.test(a) && (b === undefined || PLAIN_NUMBER.test(b))
      const numberType = CELLIS_NUMBER[op]
      if (numeric && numberType) {
        const values: GsConditionValue[] = [{ userEnteredValue: a }]
        if (b !== undefined && (op === 'between' || op === 'notBetween')) values.push({ userEnteredValue: b })
        return boolean({ type: numberType, values })
      }
      // A formula or text operand: the same test as a custom formula on the range's first cell.
      const sym = CELLIS_OPERATOR[op]
      if (sym) return boolean({ type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${topLeft}${sym}${stripFuturePrefixes(a)}` }] })
      if ((op === 'between' || op === 'notBetween') && b !== undefined) {
        const lo = stripFuturePrefixes(a)
        const hi = stripFuturePrefixes(b)
        const test = `AND(${topLeft}>=MIN(${lo},${hi}),${topLeft}<=MAX(${lo},${hi}))`
        return boolean({ type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: op === 'between' ? `=${test}` : `=NOT(${test})` }] })
      }
      return { reason: `العامل ${op} غير مدعوم` }
    }
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith': {
      const text = rule.attrs.text
      if (text === undefined) return { reason: 'نص الشرط مفقود' }
      return boolean({ type: CF_TEXT_TYPES[type] as GsConditionType, values: [{ userEnteredValue: text }] })
    }
    case 'containsBlanks':
      return boolean({ type: 'BLANK' })
    case 'notContainsBlanks':
      return boolean({ type: 'NOT_BLANK' })
    case 'timePeriod': {
      const period = rule.attrs.timePeriod
      const rel = period === 'today' ? 'TODAY' : period === 'yesterday' ? 'YESTERDAY' : period === 'tomorrow' ? 'TOMORROW' : null
      if (!rel) return { reason: `الفترة الزمنية ${period ?? ''} لا مقابل لها` }
      return boolean({ type: 'DATE_EQ', values: [{ relativeDate: rel }] })
    }
    case 'colorScale': {
      const scale = child(rule, 'colorScale')
      const cfvos = children(scale, 'cfvo')
      const cols = children(scale, 'color').map((c) => colors.resolve(c))
      if (cfvos.length < 2 || cols.length !== cfvos.length || cols.some((c) => !c)) return { reason: 'تعذّر قراءة ألوان التدرج' }
      const points: GsInterpolationPoint[] = []
      for (let i = 0; i < cfvos.length; i++) {
        const v = cfvos[i] as XmlNode
        const color = cols[i] as string
        const kind = v.attrs.type
        const p: GsInterpolationPoint = { colorStyle: { rgbColor: hexToGsColor(color) } }
        if (kind === 'min') p.type = 'MIN'
        else if (kind === 'max') p.type = 'MAX'
        else if (kind === 'num' || kind === 'percent' || kind === 'percentile' || kind === 'formula') {
          p.type = kind === 'num' || kind === 'formula' ? 'NUMBER' : kind === 'percent' ? 'PERCENT' : 'PERCENTILE'
          const val = (v.attrs.val ?? '').trim()
          p.value = kind === 'formula' || !PLAIN_NUMBER.test(val) ? `=${stripFuturePrefixes(val)}` : val
        } else return { reason: `نوع نقطة التدرج ${kind ?? ''} غير مدعوم` }
        points.push(p)
      }
      const gradientRule: NonNullable<GsConditionalFormatRule['gradientRule']> =
        points.length === 2 ? { minpoint: points[0], maxpoint: points[1] } : { minpoint: points[0], midpoint: points[1], maxpoint: points[2] }
      return { rule: { ranges, gradientRule } }
    }
    case 'dataBar':
      return { reason: 'أشرطة البيانات غير مدعومة' }
    case 'iconSet':
      return { reason: 'مجموعات الأيقونات غير مدعومة' }
    case 'top10':
      return { reason: 'قاعدة الأعلى/الأدنى قيمةً غير مدعومة' }
    case 'aboveAverage':
      return { reason: 'قاعدة فوق/تحت المتوسط غير مدعومة' }
    case 'duplicateValues':
    case 'uniqueValues':
      return { reason: 'قاعدة القيم المكررة أو الفريدة غير مدعومة' }
    case 'containsErrors':
    case 'notContainsErrors':
      return { reason: 'قاعدة الأخطاء غير مدعومة' }
    default:
      return { reason: `نوع القاعدة ${type} غير مدعوم` }
  }
}

function columnName(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}
