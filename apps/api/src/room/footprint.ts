// What an op touches, and when two concurrent ops conflict (spec §11; the
// room's conflict rule is in packages/shared/src/room-protocol.ts).
//
// Two ops conflict when either is structural, or when they touch the same
// thing of the same kind: overlapping cells, overlapping row or column
// properties, the same sheet's own properties, workbook properties, or the
// same plugin data on the same sheet. Ops that do not conflict commute, so
// applying them in either order gives the same workbook.

import { dashboardMutationProblem, roomMutationClass } from '@naf-sheets/shared'
import type { RoomMutation } from '@naf-sheets/shared'

/** Inclusive bounds; MAX stands for "to the end" (whole rows / columns). */
export interface Span {
  sheet: string
  r0: number
  r1: number
  c0: number
  c1: number
}

export interface Footprint {
  structural: boolean
  cells: Span[]
  /** Row-property spans: only r0..r1 matter. */
  rows: Span[]
  /** Column-property spans: only c0..c1 matter. */
  columns: Span[]
  /** `sheet:<id>`, `workbook`, `<plugin>:<sheet id>`. */
  keys: string[]
}

const MAX = 2 ** 31

/** Footprint of a reset (a server change that replaced the whole state): conflicts with everything. */
export const STRUCTURAL: Footprint = { structural: true, cells: [], rows: [], columns: [], keys: [] }

export type ClassifyResult = { ok: true; footprint: Footprint } | { ok: false; detail: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX

/** A Univer IRange → span; rangeType ROW (1) spans every column, COLUMN (2) every row, ALL (3) both. */
function spanOf(sheet: string, range: unknown): Span | null {
  if (!isObject(range)) return null
  const type = range.rangeType
  // RANGE_TYPE: ROW (1) = whole rows, so every column; COLUMN (2) = every row; ALL (3) = both.
  const everyColumn = type === 1 || type === 3
  const everyRow = type === 2 || type === 3
  const r0 = everyRow ? 0 : range.startRow
  const r1 = everyRow ? MAX : range.endRow
  const c0 = everyColumn ? 0 : range.startColumn
  const c1 = everyColumn ? MAX : range.endColumn
  const isBound = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX
  if (!isBound(r0) || !isBound(r1) || !isBound(c0) || !isBound(c1) || r1 < r0 || c1 < c0) return null
  return { sheet, r0, r1, c0, c1 }
}

function spansOf(sheet: string, ranges: unknown): Span[] | null {
  if (!Array.isArray(ranges) || ranges.length === 0) return null
  const out: Span[] = []
  for (const r of ranges) {
    const span = spanOf(sheet, r)
    if (!span) return null
    out.push(span)
  }
  return out
}

/** Cells of a cell-value matrix `{ row: { column: cell } }`: one span per run of adjacent columns in a row. */
function matrixSpans(sheet: string, matrix: unknown): Span[] | null {
  if (!isObject(matrix)) return null
  const out: Span[] = []
  for (const [rowKey, row] of Object.entries(matrix)) {
    const r = Number(rowKey)
    if (!isIndex(r) || !isObject(row)) return null
    const columns = Object.keys(row).map(Number)
    if (columns.some((c) => !isIndex(c))) return null
    columns.sort((a, b) => a - b)
    let start = -1
    let prev = -2
    for (const c of columns) {
      if (c !== prev + 1) {
        if (start >= 0) out.push({ sheet, r0: r, r1: r, c0: start, c1: prev })
        start = c
      }
      prev = c
    }
    if (start >= 0) out.push({ sheet, r0: r, r1: r, c0: start, c1: prev })
  }
  return out
}

/** Row or column indices given as the keys of an object (`rowData`, `columnData`). */
function keySpans(sheet: string, data: unknown, axis: 'rows' | 'columns'): Span[] | null {
  if (!isObject(data)) return null
  const out: Span[] = []
  for (const key of Object.keys(data)) {
    const i = Number(key)
    if (!isIndex(i)) return null
    out.push(axis === 'rows' ? { sheet, r0: i, r1: i, c0: 0, c1: MAX } : { sheet, r0: 0, r1: MAX, c0: i, c1: i })
  }
  return out
}

const PLUGIN_PREFIX: Record<string, string> = {
  'data-validation.mutation.': 'dv',
  'sheet.mutation.add-conditional-rule': 'cf',
  'sheet.mutation.delete-conditional-rule': 'cf',
  'sheet.mutation.set-conditional-rule': 'cf',
  'sheet.mutation.move-conditional-rule': 'cf',
  'sheet.mutation.set-filter-range': 'filter',
  'sheet.mutation.set-filter-criteria': 'filter',
  'sheet.mutation.remove-filter': 'filter',
  'sheet.mutation.re-calc-filter': 'filter',
  'sheets.mutation.': 'link',
  'sheet.mutation.update-note': 'note',
  'sheet.mutation.remove-note': 'note',
  'sheet.mutation.update-note-position': 'note',
  'sheet.mutation.toggle-note-popup': 'note',
}

function pluginOf(id: string): string | null {
  for (const [prefix, plugin] of Object.entries(PLUGIN_PREFIX)) if (id === prefix || (prefix.endsWith('.') && id.startsWith(prefix))) return plugin
  return null
}

function empty(): Footprint {
  return { structural: false, cells: [], rows: [], columns: [], keys: [] }
}

/**
 * Footprint of one mutation, after checking that it is one the room accepts
 * and that it targets workbook `unitId`.
 */
export function classifyMutation(m: RoomMutation, unitId: string): ClassifyResult {
  const kind = roomMutationClass(m.id)
  if (kind === null) return { ok: false, detail: `mutation ${m.id} is not accepted` }
  const p = m.params
  if (!isObject(p)) return { ok: false, detail: `${m.id}: params must be an object` }
  if (p.unitId !== unitId) return { ok: false, detail: `${m.id}: another unit` }
  // Notes name the sheet `sheetId`; every other sheet mutation `subUnitId`.
  const sheet = typeof p.subUnitId === 'string' ? p.subUnitId : typeof p.sheetId === 'string' ? p.sheetId : null
  const fp = empty()

  switch (kind) {
    case 'structural':
      fp.structural = true
      return { ok: true, footprint: fp }
    case 'workbook':
      fp.keys.push('workbook')
      return { ok: true, footprint: fp }
    default:
      break
  }
  if (sheet === null || sheet === '') return { ok: false, detail: `${m.id}: no sheet` }

  switch (kind) {
    case 'sheet':
      fp.keys.push(`sheet:${sheet}`)
      return { ok: true, footprint: fp }
    case 'resource': {
      const plugin = pluginOf(m.id)
      if (plugin === null) return { ok: false, detail: `${m.id}: unknown plugin` }
      fp.keys.push(`${plugin}:${sheet}`)
      return { ok: true, footprint: fp }
    }
    case 'cells': {
      let spans: Span[] | null
      if (m.id === 'sheet.mutation.set-range-values') spans = matrixSpans(sheet, p.cellValue)
      else if (m.id === 'sheet.mutation.set.numfmt') {
        if (!isObject(p.values)) return { ok: false, detail: `${m.id}: values` }
        spans = []
        for (const entry of Object.values(p.values)) {
          const s = isObject(entry) ? spansOf(sheet, entry.ranges) : null
          if (!s) return { ok: false, detail: `${m.id}: ranges` }
          spans.push(...s)
        }
      } else spans = spansOf(sheet, p.ranges)
      if (!spans) return { ok: false, detail: `${m.id}: cells` }
      fp.cells.push(...spans)
      return { ok: true, footprint: fp }
    }
    case 'rows': {
      let spans: Span[] | null
      if (m.id === 'sheet.mutation.set-row-data') spans = keySpans(sheet, p.rowData, 'rows')
      else if (m.id === 'sheet.mutation.set-worksheet-row-auto-height') {
        const info = p.rowsAutoHeightInfo
        spans = Array.isArray(info) && info.every((i) => isObject(i) && isIndex(i.row))
          ? info.map((i) => ({ sheet, r0: (i as { row: number }).row, r1: (i as { row: number }).row, c0: 0, c1: MAX }))
          : null
      } else spans = spansOf(sheet, p.ranges)
      if (!spans) return { ok: false, detail: `${m.id}: rows` }
      fp.rows.push(...spans)
      return { ok: true, footprint: fp }
    }
    case 'columns': {
      const spans = m.id === 'sheet.mutation.set-col-data' ? keySpans(sheet, p.columnData, 'columns') : spansOf(sheet, p.ranges)
      if (!spans) return { ok: false, detail: `${m.id}: columns` }
      fp.columns.push(...spans)
      return { ok: true, footprint: fp }
    }
  }
}

/** Above this many spans a kind is kept as one bounding span per sheet (conservative). */
const MAX_SPANS = 2000

function compact(spans: Span[]): Span[] {
  if (spans.length <= MAX_SPANS) return spans
  const bySheet = new Map<string, Span>()
  for (const s of spans) {
    const b = bySheet.get(s.sheet)
    if (!b) bySheet.set(s.sheet, { ...s })
    else {
      b.r0 = Math.min(b.r0, s.r0)
      b.r1 = Math.max(b.r1, s.r1)
      b.c0 = Math.min(b.c0, s.c0)
      b.c1 = Math.max(b.c1, s.c1)
    }
  }
  return [...bySheet.values()]
}

/**
 * Footprint of a whole op, or the first reason it cannot be accepted.
 *
 * `dashboardSheetId`: the workbook's dashboard sheet «اللوحة» (the engine's
 * `dashboardSheetId`, '' when none). An op that would remove, rename, hide or
 * move it, put a sheet before it, add a second one, or write into it is
 * refused like any other invalid op (the editor refuses these before they are
 * sent; this is the backstop). Row heights and column widths on it pass.
 */
export function classifyOp(mutations: readonly RoomMutation[], unitId: string, dashboardSheetId = ''): ClassifyResult {
  const fp = empty()
  for (const m of mutations) {
    const one = classifyMutation(m, unitId)
    if (!one.ok) return one
    const problem = dashboardMutationProblem(m.id, m.params, dashboardSheetId, roomMutationClass)
    if (problem !== null) return { ok: false, detail: `${m.id}: the dashboard sheet (${problem})` }
    fp.structural ||= one.footprint.structural
    fp.cells.push(...one.footprint.cells)
    fp.rows.push(...one.footprint.rows)
    fp.columns.push(...one.footprint.columns)
    for (const k of one.footprint.keys) if (!fp.keys.includes(k)) fp.keys.push(k)
  }
  if (fp.structural) return { ok: true, footprint: STRUCTURAL }
  fp.cells = compact(fp.cells)
  fp.rows = compact(fp.rows)
  fp.columns = compact(fp.columns)
  return { ok: true, footprint: fp }
}

const overlap = (a: Span, b: Span) => a.sheet === b.sheet && a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1
const rowsOverlap = (a: Span, b: Span) => a.sheet === b.sheet && a.r0 <= b.r1 && b.r0 <= a.r1
const columnsOverlap = (a: Span, b: Span) => a.sheet === b.sheet && a.c0 <= b.c1 && b.c0 <= a.c1

function anyPair(a: Span[], b: Span[], test: (x: Span, y: Span) => boolean): boolean {
  for (const x of a) for (const y of b) if (test(x, y)) return true
  return false
}

export function footprintsConflict(a: Footprint, b: Footprint): boolean {
  if (a.structural || b.structural) return true
  if (a.keys.some((k) => b.keys.includes(k))) return true
  return anyPair(a.cells, b.cells, overlap) || anyPair(a.rows, b.rows, rowsOverlap) || anyPair(a.columns, b.columns, columnsOverlap)
}

/** True when `cell` lies in one of the footprint's cell spans. */
export function footprintTouchesCell(fp: Footprint, cell: { sheetId: string; row: number; column: number }): boolean {
  if (fp.structural) return true
  return fp.cells.some((s) => s.sheet === cell.sheetId && s.r0 <= cell.row && cell.row <= s.r1 && s.c0 <= cell.column && cell.column <= s.c1)
}
