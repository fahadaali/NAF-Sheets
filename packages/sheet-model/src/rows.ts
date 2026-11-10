// Reordering rows inside a sheet, with the semantics of Univer's own sort
// (`ReorderRangeCommand`, sheets-formula `_reorderFormula`, sheets
// `handleReorderRangeCommon`):
// - whole rows move: values, rich text, styles, the platform's cell data, the
//   system columns (so identity moves with the row), and the row's settings;
// - a formula in a moved row has its relative references shifted by the row
//   offset (`offsetFormula`); shared formulas (`si`) touching the moved rows
//   are first written out in full, as Univer does; its cached value is dropped
//   so the engine computes it again;
// - formulas elsewhere keep their addresses (a reference to D5 reads whatever
//   row 5 holds afterwards), exactly as after a sort;
// - notes follow their cell; validation, conditional-format and range
//   protection ranges follow the content row by row; the filter range must
//   stay one block.
// Anything else that is tied to row positions makes the operation refuse.
//
// Rows are never inserted or removed: the sheet's other rows and every
// address outside the reordered rows stay as they are.
// OPEN: sort semantics rather than insert semantics (OPEN_QUESTIONS.md #3);
// cached values of other formulas (#16); row settings move with the row (#17).

import { hasFormula, rowCells, setCell, type SheetSnapshot, type WorkbookSnapshot } from './cells'
import { fail, ok, type Result } from './errors'
import { offsetFormula } from './formula-refs'
import { readNotes, writeNotes, writeResource, readResource } from './resources'
import {
  FORMULA_TYPE_ARRAY,
  RANGE_TYPE,
  RESOURCE,
  ROW_INDEPENDENT_RESOURCES,
  type ICellData,
  type IRange,
  type UniverSheetNote,
} from './univer'

/** After the reorder, row `to` holds what row `from` held before; `from: null` leaves it empty. */
export interface RowMove {
  to: number
  from: number | null
}

export interface ReorderResult {
  /** Rows whose content changed, ascending. */
  rows: number[]
  /** Notes of rows whose content left the sheet (a source that is no destination). */
  removedNotes: Array<{ fromRow: number; column: number; note: UniverSheetNote }>
}

const RANGE_RESOURCES: readonly string[] = [RESOURCE.DATA_VALIDATION, RESOURCE.CONDITIONAL_FORMATTING, RESOURCE.RANGE_PROTECTION]

function isArrayFormula(cell: ICellData): boolean {
  return Boolean(cell.ref) || cell.ft === FORMULA_TYPE_ARRAY || cell.fd === 1
}

/**
 * Rows of `[start, end]` after the reorder: rows outside the reordered set
 * stay; a reordered row is in it when the row whose content it receives was.
 */
function remapRowSpan(start: number, end: number, affected: readonly number[], source: ReadonlyMap<number, number | null>): Array<[number, number]> {
  const holes: number[] = []
  const extras: number[] = []
  for (const t of affected) {
    const from = source.get(t) ?? null
    const included = from !== null && from >= start && from <= end
    const inside = t >= start && t <= end
    if (inside && !included) holes.push(t)
    if (!inside && included) extras.push(t)
  }
  const intervals: Array<[number, number]> = []
  let cursor = start
  for (const h of holes.sort((a, b) => a - b)) {
    if (h > cursor) intervals.push([cursor, h - 1])
    cursor = h + 1
  }
  if (cursor <= end) intervals.push([cursor, end])
  for (const e of extras) intervals.push([e, e])
  intervals.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const iv of intervals) {
    const last = merged[merged.length - 1]
    if (last !== undefined && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1])
    else merged.push([iv[0], iv[1]])
  }
  return merged
}

function remapRange(range: IRange, affected: readonly number[], source: ReadonlyMap<number, number | null>): IRange[] {
  if (range.rangeType === RANGE_TYPE.COLUMN || range.rangeType === RANGE_TYPE.ALL) return [range]
  return remapRowSpan(range.startRow, range.endRow, affected, source).map(([startRow, endRow]) => ({ ...range, startRow, endRow }))
}

/**
 * Writes shared formulas (`si`) of the given groups out in full, cell by cell,
 * the way Univer derives them (`moveFormulaRefOffset` from the group's first
 * cell). Mutates `sheet`. False when one cannot be derived.
 */
function expandSharedFormulas(sheet: SheetSnapshot, groups: ReadonlySet<string>): boolean {
  if (groups.size === 0) return true
  const masters = new Map<string, { row: number; column: number; f: string }>()
  const members: Array<{ row: number; column: number; cell: ICellData; si: string }> = []
  const rows = Object.keys(sheet.cellData ?? {})
    .map(Number)
    .sort((a, b) => a - b)
  for (const r of rows) {
    const line = rowCells(sheet, r)
    for (const c of Object.keys(line).map(Number).sort((a, b) => a - b)) {
      const cell = line[c]
      const si = cell?.si
      if (cell === undefined || si === undefined || si === null || !groups.has(si)) continue
      members.push({ row: r, column: c, cell, si })
      if (cell.f && !masters.has(si)) masters.set(si, { row: r, column: c, f: cell.f })
    }
  }
  for (const m of members) {
    const master = masters.get(m.si)
    if (master === undefined) return false
    const f = m.cell.f ? m.cell.f : offsetFormula(master.f, m.column - master.column, m.row - master.row)
    if (f === null) return false
    const next: ICellData = { ...m.cell, f }
    delete next.si
    setCell(sheet, m.row, m.column, next)
  }
  return true
}

/**
 * Reorders whole rows of one sheet. Mutates `workbook` (callers work on a
 * copy) and refuses before changing anything it cannot move faithfully:
 * merged cells or array formulas in the rows, a formula it cannot read, a
 * filter that would split, or another plugin's data tied to this sheet.
 */
export function reorderRows(workbook: WorkbookSnapshot, sheetId: string, moves: readonly RowMove[]): Result<ReorderResult> {
  const sheet = workbook.sheets[sheetId]
  if (sheet === undefined) return fail('sheet_not_found')
  const source = new Map<number, number | null>()
  const dest = new Map<number, number>()
  for (const m of moves) {
    if (source.has(m.to)) throw new Error(`reorderRows: row ${m.to} is a destination twice`)
    source.set(m.to, m.from)
  }
  for (const m of moves) {
    if (m.from === null) continue
    if (!source.has(m.from) || dest.has(m.from)) throw new Error(`reorderRows: row ${m.from} is not a reordered row or is used twice`)
    dest.set(m.from, m.to)
  }
  const affected = [...source.keys()].sort((a, b) => a - b)
  if (moves.every((m) => m.from === m.to)) return ok({ rows: [], removedNotes: [] })
  const affectedSet = new Set(affected)

  // --- Checks that touch nothing.
  for (const m of sheet.mergeData ?? []) {
    for (let r = m.startRow; r <= m.endRow; r++) if (affectedSet.has(r)) return fail('merged_cells')
  }
  const sharedGroups = new Set<string>()
  for (const r of affected) {
    for (const cell of Object.values(rowCells(sheet, r))) {
      if (cell === undefined || cell === null) continue
      if (hasFormula(cell) && isArrayFormula(cell)) return fail('unsupported_formula')
      if (cell.si !== undefined && cell.si !== null && cell.si !== '') sharedGroups.add(cell.si)
    }
  }
  const filter = readResource(workbook, RESOURCE.FILTER)
  if (filter !== undefined && !filter.ok) return fail('unsupported_resource', RESOURCE.FILTER)
  const filterData = filter?.ok ? ((filter.value as Record<string, unknown>)[sheetId] as { ref?: IRange; cachedFilteredOut?: number[] } | undefined) : undefined
  let newFilterRef: IRange | undefined
  if (filterData?.ref !== undefined) {
    const spans = remapRange(filterData.ref, affected, source)
    if (spans.length !== 1) return fail('range_split', RESOURCE.FILTER)
    newFilterRef = spans[0]
  }
  for (const entry of workbook.resources ?? []) {
    const handled = entry.name === RESOURCE.NOTE || entry.name === RESOURCE.FILTER || RANGE_RESOURCES.includes(entry.name)
    if (handled || ROW_INDEPENDENT_RESOURCES.has(entry.name)) continue
    if (typeof entry.data === 'string' && entry.data.includes(JSON.stringify(sheetId))) return fail('unsupported_resource', entry.name)
  }
  for (const name of RANGE_RESOURCES) {
    const parsed = readResource(workbook, name)
    if (parsed !== undefined && !parsed.ok) return fail('unsupported_resource', name)
  }

  // --- Formulas: expand shared groups, then shift the moved ones (still on a copy of the rows).
  const work: SheetSnapshot = { cellData: structuredClone(sheet.cellData ?? {}) }
  if (!expandSharedFormulas(work, sharedGroups)) return fail('unsupported_formula')
  const moved = new Map<number, Record<number, ICellData>>()
  for (const t of affected) {
    const from = source.get(t) ?? null
    if (from === null) {
      moved.set(t, {})
      continue
    }
    const line: Record<number, ICellData> = {}
    for (const [key, cell] of Object.entries(rowCells(work, from))) {
      if (cell === undefined || cell === null) continue
      if (cell.f && from !== t) {
        const f = offsetFormula(cell.f, 0, t - from)
        if (f === null) return fail('unsupported_formula')
        const next: ICellData = { ...cell, f }
        delete next.v
        delete next.t
        line[Number(key)] = next
      } else {
        line[Number(key)] = cell
      }
    }
    moved.set(t, line)
  }

  // --- Commit.
  // Shared formulas outside the reordered rows were expanded too: keep them.
  for (const [r, line] of Object.entries(work.cellData ?? {})) {
    const row = Number(r)
    if (affectedSet.has(row)) continue
    ;(sheet.cellData as Record<number, unknown>)[row] = line
  }
  const oldRowData = new Map(affected.map((r) => [r, sheet.rowData?.[r]]))
  for (const t of affected) {
    const line = moved.get(t) ?? {}
    sheet.cellData ??= {}
    if (Object.keys(line).length > 0) (sheet.cellData as Record<number, unknown>)[t] = line
    else delete (sheet.cellData as Record<number, unknown>)[t]
    const from = source.get(t) ?? null
    const settings = from === null ? undefined : oldRowData.get(from)
    if (settings !== undefined && settings !== null) {
      sheet.rowData ??= {}
      ;(sheet.rowData as Record<number, unknown>)[t] = settings
    } else if (sheet.rowData !== undefined) {
      delete (sheet.rowData as Record<number, unknown>)[t]
    }
  }

  const removedNotes: ReorderResult['removedNotes'] = []
  const notes = readNotes(workbook, sheetId)
  if (Object.keys(notes).length > 0) {
    const next: typeof notes = {}
    for (const [r, cols] of Object.entries(notes)) {
      const row = Number(r)
      for (const [c, note] of Object.entries(cols)) {
        const column = Number(c)
        let target: number | undefined = row
        if (affectedSet.has(row)) target = dest.get(row)
        if (target === undefined) {
          removedNotes.push({ fromRow: row, column, note })
          continue
        }
        next[String(target)] ??= {}
        ;(next[String(target)] as Record<string, UniverSheetNote>)[c] = { ...note, row: target, col: column }
      }
    }
    writeNotes(workbook, sheetId, next)
  }

  for (const name of RANGE_RESOURCES) {
    const parsed = readResource(workbook, name)
    if (parsed === undefined || !parsed.ok) continue
    const all = parsed.value as Record<string, unknown>
    const rules = all[sheetId]
    if (!Array.isArray(rules)) continue
    const nextRules = (rules as Array<{ ranges?: IRange[] }>)
      .map((rule) => ({ ...rule, ranges: (rule.ranges ?? []).flatMap((range) => remapRange(range, affected, source)) }))
      .filter((rule) => rule.ranges.length > 0)
    writeResource(workbook, name, { ...all, [sheetId]: nextRules })
  }

  if (filter?.ok && filterData !== undefined) {
    const nextFilter: Record<string, unknown> = { ...filterData }
    if (newFilterRef !== undefined) nextFilter.ref = newFilterRef
    if (Array.isArray(filterData.cachedFilteredOut)) {
      nextFilter.cachedFilteredOut = filterData.cachedFilteredOut
        .map((r) => (affectedSet.has(r) ? dest.get(r) : r))
        .filter((r): r is number => r !== undefined)
        .sort((a, b) => a - b)
    }
    writeResource(workbook, RESOURCE.FILTER, { ...(filter.value as Record<string, unknown>), [sheetId]: nextFilter })
  }

  return ok({ rows: affected, removedNotes })
}
