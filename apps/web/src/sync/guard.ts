// Runtime protection of the hidden system columns of a synced sheet
// (spec §8: «أعمدة مخفية ومحمية … لا يحرّرها المستخدم»; sheet-model
// OPEN_QUESTIONS #1: the snapshot carries no protection rule, so the editor
// enforces it).
//
// Pure decisions over a command's id and params. The editor calls
// `guardCommand` before every command runs (public Facade event
// `BeforeCommandExecute`): it lets it through, refuses it with an Arabic
// message, or asks for the same command to run with a copy of its params
// (the original params object is never changed: shortcut params are shared
// between key presses, CLAUDE.md). `guardMutation` is the backstop for writes
// no command rule caught (e.g. a plugin writing cells directly).
//
// Rows move with their identity: whole-row moves and sorts are allowed, and a
// sort is widened so the system cells travel with their row.

import type { IRange } from '@univerjs/core'
import { t } from '../strings'
import { cellText, type CellReader } from './cells'
import type { SheetLayout, SystemColumns } from './layout'
import { systemColumnSet } from './layout'

/** core `RANGE_TYPE`. */
const RANGE = { NORMAL: 0, ROW: 1, COLUMN: 2, ALL: 3 } as const

export type GuardDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; message: string }
  /** Cancel, then run the same command with these params (a copy). */
  | { kind: 'replace'; params: Record<string, unknown> }

export interface GuardContext {
  layout: SheetLayout & { system: SystemColumns }
  reader: CellReader
  /** Current selections of the sheet, primary last. */
  selections: readonly IRange[]
}

const ALLOW: GuardDecision = { kind: 'allow' }
const refuse = (message: string): GuardDecision => ({ kind: 'refuse', message })

type Params = Record<string, unknown> | undefined

const isRange = (v: unknown): v is IRange =>
  typeof v === 'object' && v !== null && typeof (v as IRange).startRow === 'number' && typeof (v as IRange).startColumn === 'number'

/** Inclusive column span of a range (whole rows span every column). */
function columnSpan(range: IRange): [number, number] {
  if (range.rangeType === RANGE.ROW || range.rangeType === RANGE.ALL) return [0, Number.POSITIVE_INFINITY]
  return [range.startColumn, range.endColumn]
}

function rowSpan(range: IRange, reader: CellReader): [number, number] {
  if (range.rangeType === RANGE.COLUMN || range.rangeType === RANGE.ALL) return [0, Math.max(reader.lastRow(), 0)]
  return [range.startRow, range.endRow]
}

export function touchesSystem(range: IRange, system: SystemColumns): boolean {
  const [a, b] = columnSpan(range)
  return systemColumnSet(system).some((c) => c >= a && c <= b)
}

const anyTouches = (ranges: readonly IRange[], system: SystemColumns) => ranges.some((r) => touchesSystem(r, system))

/** The parts of `range` outside the system columns, as plain ranges. */
export function stripSystem(range: IRange, system: SystemColumns, reader: CellReader): IRange[] {
  const [rowStart, rowEnd] = rowSpan(range, reader)
  const columns = systemColumnSet(system)
  let [start, end] = columnSpan(range)
  if (!Number.isFinite(end)) end = Math.max(reader.lastColumn(), columns[columns.length - 1] as number)
  const out: IRange[] = []
  let from = start
  for (const c of columns) {
    if (c < from || c > end) continue
    if (c > from) out.push({ startRow: rowStart, endRow: rowEnd, startColumn: from, endColumn: c - 1, rangeType: RANGE.NORMAL })
    from = c + 1
  }
  if (from <= end) out.push({ startRow: rowStart, endRow: rowEnd, startColumn: from, endColumn: end, rangeType: RANGE.NORMAL })
  return out
}

function rangesOf(params: Params, key: string, ctx: GuardContext): IRange[] {
  const value = params?.[key]
  if (Array.isArray(value) && value.every(isRange)) return value
  if (isRange(value)) return [value]
  return [...ctx.selections]
}

const primary = (ctx: GuardContext): IRange | undefined => ctx.selections[ctx.selections.length - 1]

/** Columns a pasted clipboard covers: tab-separated text, else the first HTML table row. */
export function pastedColumnCount(params: Params): number {
  const text = typeof params?.textContent === 'string' ? params.textContent : ''
  let count = 0
  if (text) for (const line of text.split(/\r?\n/)) count = Math.max(count, line.split('\t').length)
  const html = typeof params?.htmlContent === 'string' ? params.htmlContent : ''
  if (html) {
    const row = /<tr[\s\S]*?<\/tr>/i.exec(html)?.[0]
    if (row) {
      let cells = 0
      for (const m of row.matchAll(/<t[dh]\b([^>]*)>/gi)) cells += Number(/colspan\s*=\s*"?(\d+)/i.exec(m[1] ?? '')?.[1] ?? 1)
      count = Math.max(count, cells)
    }
  }
  return Math.max(count, 1)
}

/** True when a row holds a system cell or is the header row (where the system headers live). */
function rowCarriesSystem(row: number, ctx: GuardContext): boolean {
  if (row === ctx.layout.header) return true
  return systemColumnSet(ctx.layout.system).some((c) => cellText(ctx.reader.cell(row, c)) !== '')
}

function isBetweenSystem(column: number, system: SystemColumns): boolean {
  const cols = systemColumnSet(system)
  return column > (cols[0] as number) && column <= (cols[cols.length - 1] as number)
}

function matrixColumns(value: unknown): Array<[number, number, unknown]> {
  const out: Array<[number, number, unknown]> = []
  if (typeof value !== 'object' || value === null) return out
  for (const [r, line] of Object.entries(value as Record<string, unknown>)) {
    if (typeof line !== 'object' || line === null) continue
    for (const [c, cell] of Object.entries(line as Record<string, unknown>)) out.push([Number(r), Number(c), cell])
  }
  return out
}

const SELECTION_WRITES = new Set([
  'sheet.command.copy-down',
  'sheet.command.copy-right',
  'sheet.command.refill',
  'sheet.command.auto-clear-content',
  'sheet.command.split-text-to-columns',
  'sheet.command.text-to-number',
  'sheet.command.paste',
  'sheet.command.optional-paste',
  'sheet.command.paste-value',
  'sheet.command.paste-format',
  'sheet.command.paste-besides-border',
  'sheet.command.paste-col-width',
  'sheet.command.set-selected-cols-visible',
])

/** Decision for a command (CommandType.COMMAND) on a synced sheet with system columns. */
export function guardCommand(id: string, params: Params, ctx: GuardContext): GuardDecision {
  const { system } = ctx.layout
  switch (id) {
    case 'sheet.command.set-range-values': {
      if (isRange(params?.range)) return touchesSystem(params.range, system) ? refuse(t.guard.systemColumns) : ALLOW
      const cells = matrixColumns(params?.value)
      if (cells.length > 0) return cells.some(([, c]) => systemColumnSet(system).includes(c)) ? refuse(t.guard.systemColumns) : ALLOW
      return anyTouches(ctx.selections, system) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.command.clear-selection-content':
    case 'sheet.command.clear-selection-all':
    case 'sheet.command.clear-selection-format': {
      const ranges = rangesOf(params, 'ranges', ctx)
      if (!anyTouches(ranges, system)) return ALLOW
      const stripped = ranges.flatMap((r) => stripSystem(r, system, ctx.reader))
      if (stripped.length === 0) return refuse(t.guard.systemColumns)
      return { kind: 'replace', params: { ...(params ?? {}), ranges: stripped } }
    }
    case 'sheet.command.auto-fill': {
      const target = params?.targetRange
      return isRange(target) && touchesSystem(target, system) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.command.paste-by-short-key': {
      const at = primary(ctx)
      if (!at) return ALLOW
      const [start, end] = columnSpan(at)
      const width = pastedColumnCount(params)
      const covered: IRange = { ...at, rangeType: RANGE.NORMAL, startColumn: start, endColumn: Math.max(end, start + width - 1) }
      if (!Number.isFinite(end)) return refuse(t.guard.paste)
      return touchesSystem(covered, system) ? refuse(t.guard.paste) : ALLOW
    }
    case 'sheet.command.delete-range-move-left':
    case 'sheet.command.insert-range-move-right': {
      const cols = systemColumnSet(system)
      for (const r of rangesOf(params, 'range', ctx)) {
        if (columnSpan(r)[0] > (cols[cols.length - 1] as number)) continue
        const [a, b] = rowSpan(r, ctx.reader)
        for (let row = a; row <= b; row++) if (rowCarriesSystem(row, ctx)) return refuse(t.guard.shiftCells)
      }
      return ALLOW
    }
    case 'sheet.command.delete-range-move-up':
    case 'sheet.command.insert-range-move-down':
      return anyTouches(rangesOf(params, 'range', ctx), system) ? refuse(t.guard.systemColumns) : ALLOW
    case 'sheet.command.insert-col':
    case 'sheet.command.insert-col-by-range': {
      const range = params?.range
      return isRange(range) && isBetweenSystem(range.startColumn, system) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.command.remove-col':
    case 'sheet.command.remove-col-by-range': {
      const range = isRange(params?.range) ? [params.range] : ctx.selections.slice(-1)
      return anyTouches(range, system) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.command.move-cols': {
      const from = params?.fromRange
      const to = params?.toRange
      const moved = isRange(params?.range) ? [params.range] : ctx.selections.filter((s) => isRange(from) && s.startColumn <= from.startColumn && from.startColumn <= s.endColumn)
      if (anyTouches(moved, system) || (isRange(from) && touchesSystem(from, system))) return refuse(t.guard.systemColumns)
      return isRange(to) && isBetweenSystem(to.startColumn, system) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.command.move-range': {
      const from = params?.fromRange
      const to = params?.toRange
      return (isRange(from) && touchesSystem(from, system)) || (isRange(to) && touchesSystem(to, system)) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.command.set-col-visible-on-cols':
      return anyTouches(rangesOf(params, 'ranges', ctx), system) ? refuse(t.guard.unhide) : ALLOW
    // OPEN: a flat sort widened to whole rows; subtasks may leave their to-do (OPEN_QUESTIONS.md #35).
    case 'sheet.command.sort-range': {
      const range = params?.range
      if (!isRange(range)) return ALLOW
      const cols = systemColumnSet(system)
      const last = cols[cols.length - 1] as number
      if (range.rangeType === RANGE.ROW || range.rangeType === RANGE.ALL) return ALLOW
      if (range.startColumn === 0 && range.endColumn >= last) return ALLOW
      return { kind: 'replace', params: { ...(params ?? {}), range: { ...range, rangeType: RANGE.NORMAL, startColumn: 0, endColumn: Math.max(range.endColumn, last) } } }
    }
    default:
      if (SELECTION_WRITES.has(id)) {
        if (!anyTouches(ctx.selections, system)) return ALLOW
        return refuse(id === 'sheet.command.set-selected-cols-visible' ? t.guard.unhide : id.includes('paste') ? t.guard.paste : t.guard.systemColumns)
      }
      return ALLOW
  }
}

const CONTENT_KEYS = ['v', 'p', 'f', 'si'] as const

/** True when writing `next` over the stored cell changes its content (style alone does not count). */
function changesContent(stored: unknown, next: unknown): boolean {
  const a = (stored ?? {}) as Record<string, unknown>
  if (next === null || next === undefined) return CONTENT_KEYS.some((k) => a[k] !== undefined && a[k] !== null && a[k] !== '')
  const b = next as Record<string, unknown>
  return CONTENT_KEYS.some((k) => {
    if (!(k in b)) return false
    const was = a[k] ?? null
    const now = b[k] ?? null
    return k === 'v' || k === 'si' || k === 'f' ? String(was ?? '') !== String(now ?? '') : JSON.stringify(was) !== JSON.stringify(now)
  })
}

/**
 * OPEN: cancelling a mutation may leave its command partly applied (OPEN_QUESTIONS.md #35).
 * Backstop for mutations (CommandType.MUTATION) that reached the model
 * without a command rule refusing them. The caller skips it for undo / redo,
 * collaboration and the editor's own writes.
 */
export function guardMutation(id: string, params: Params, ctx: GuardContext): GuardDecision {
  const { system } = ctx.layout
  const columns = systemColumnSet(system)
  const writes = (matrix: unknown) =>
    matrixColumns(matrix).some(([row, column, cell]) => columns.includes(column) && changesContent(ctx.reader.cell(row, column), cell))
  switch (id) {
    case 'sheet.mutation.set-range-values':
      return writes(params?.cellValue) ? refuse(t.guard.systemColumns) : ALLOW
    case 'sheet.mutation.move-range': {
      const from = params?.from as { value?: unknown } | undefined
      const to = params?.to as { value?: unknown } | undefined
      return writes(from?.value) || writes(to?.value) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.mutation.remove-col':
    case 'sheet.mutation.set-col-visible':
      return rangesOf(params, id.endsWith('visible') ? 'ranges' : 'range', { ...ctx, selections: [] }).some((r) => touchesSystem(r, system))
        ? refuse(t.guard.systemColumns)
        : ALLOW
    case 'sheet.mutation.insert-col': {
      const range = params?.range
      return isRange(range) && isBetweenSystem(range.startColumn, system) ? refuse(t.guard.systemColumns) : ALLOW
    }
    case 'sheet.mutation.move-columns': {
      const source = params?.sourceRange
      const target = params?.targetRange
      if (isRange(source) && touchesSystem(source, system)) return refuse(t.guard.systemColumns)
      return isRange(target) && isBetweenSystem(target.startColumn, system) ? refuse(t.guard.systemColumns) : ALLOW
    }
    default:
      return ALLOW
  }
}
