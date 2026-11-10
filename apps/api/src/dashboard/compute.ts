// The dashboard's figures (contract: packages/shared/src/api-dashboard.ts).
//
// Pure over a loaded workbook: no IO here, so every rule is unit-tested.
//   - task sheets: the rows exactly as the sync engine reads them
//     (sheet-model `readTasks` through `readSheet`), with D1's row state;
//   - every sheet: plain cell values for custom widgets, a formula cell
//     counting with its computed value (`v`), never re-evaluated here.
//
// Nothing here writes the snapshot.

import type {
  CellLink,
  DashboardAggregation,
  DashboardAssignee,
  DashboardParentProgress,
  DashboardSheet,
  DashboardTask,
  DashboardTaskStatus,
  DashboardTotals,
  DashboardWeek,
  DashboardWidgetConfig,
  IsoDate,
  LocalTask,
  SheetPlan,
  WidgetGroup,
  WidgetResult,
} from '@naf-sheets/shared'
import { columnIndex, columnLetters, findSystemColumns, latinDigits, serialToIso } from '@naf-sheets/sheet-model'
import type { SheetSnapshot, WorkbookSnapshot } from '@naf-sheets/sheet-model'
import { readSheet } from '../sync/state'
import type { WorkbookState } from '../sync/state'
import type { SheetRow } from '../sync/store'
import { WIDGET_MESSAGES } from './errors'

/** Lists (overdue, due this week) carry at most this many rows; the totals count all of them. */
export const LIST_LIMIT = 50
/** Weeks shown in the timeline, around today. */
export const TIMELINE_LIMIT = 16
/** Groups of a widget; the rest are counted in `otherGroups`. */
export const GROUP_LIMIT = 50
/** Parents listed in subtask progress. */
export const PARENT_LIMIT = 50

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

function dayNumber(iso: IsoDate): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)
}

function isoOfDay(n: number): IsoDate {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The week containing `day`: Sunday to Saturday, the Saudi working week.
 * OPEN (D2): the week's first day.
 */
export function weekOf(day: IsoDate): { start: IsoDate; end: IsoDate } {
  const n = dayNumber(day)
  // 1970-01-01 was a Thursday: (n + 4) % 7 is 0 on Sunday.
  const start = n - ((((n + 4) % 7) + 7) % 7)
  return { start: isoOfDay(start), end: isoOfDay(start + 6) }
}

export function statusOf(task: { completed: boolean; dueOn: string | null }, today: IsoDate): DashboardTaskStatus {
  if (task.completed) return 'done'
  if (task.dueOn !== null && task.dueOn < today) return 'overdue'
  return 'open'
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

interface Cell {
  v?: unknown
  t?: number | null
  f?: string | null
  si?: string | null
  s?: unknown
  p?: { body?: { dataStream?: string } } | null
}

function cellAt(sheet: SheetSnapshot, row: number, column: number): Cell | undefined {
  const line = (sheet.cellData as Record<number, Record<number, Cell | undefined> | undefined> | undefined)?.[row]
  return line?.[column] ?? undefined
}

function hasFormula(cell: Cell | undefined): boolean {
  return Boolean(cell?.f) || (cell?.si !== undefined && cell?.si !== null && cell?.si !== '')
}

/** Text of a cell as sheet-model reads it: rich text first, else the value; '' when empty. */
export function cellText(cell: Cell | undefined): string {
  if (!cell) return ''
  const stream = cell.p?.body?.dataStream
  if (stream) return stream.replace(/\r\n$/, '').replace(/\r/g, '\n')
  const v = cell.v
  if (v === undefined || v === null) return ''
  if (cell.t === 3 || typeof v === 'boolean') return v === true || v === 1 || v === '1' || String(v).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE'
  return String(v)
}

function numberPattern(workbook: WorkbookSnapshot, cell: Cell | undefined): string {
  const s = cell?.s
  const style = typeof s === 'string' ? (workbook.styles?.[s] as { n?: { pattern?: string } } | undefined) : (s as { n?: { pattern?: string } } | undefined)
  return style?.n?.pattern ?? ''
}

const looksLikeDatePattern = (pattern: string) => /[yd]/i.test(pattern.replace(/"[^"]*"/g, ''))

/** A label for grouping: the text shown, with a date-formatted serial as YYYY-MM-DD. */
function labelOf(workbook: WorkbookSnapshot, cell: Cell | undefined): string {
  if (cell && typeof cell.v === 'number' && looksLikeDatePattern(numberPattern(workbook, cell))) {
    const iso = serialToIso(cell.v, workbook.dateSystem)
    if (iso) return iso
  }
  return cellText(cell).trim()
}

export type CellValue = { kind: 'empty' } | { kind: 'number'; value: number } | { kind: 'text' } | { kind: 'uncomputed' }

/**
 * A cell as a widget reads it. A formula cell is read through its computed
 * value (`v`); one without a value yet is `uncomputed`. Text that is a plain
 * number («1,250»، «٣٤») counts as that number; any other text is `text`.
 */
export function readValue(cell: Cell | undefined): CellValue {
  if (!cell) return { kind: 'empty' }
  const formula = hasFormula(cell)
  const v = cell.v
  if (v === undefined || v === null || v === '') {
    if (formula) return { kind: 'uncomputed' }
    return cellText(cell).trim() === '' ? { kind: 'empty' } : { kind: 'text' }
  }
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'number', value: v } : { kind: 'text' }
  if (typeof v === 'boolean' || cell.t === 3) return { kind: 'text' }
  const text = latinDigits(String(v)).trim()
  if (text === '') return { kind: 'empty' }
  const plain = text.replace(/[,٬\s]/g, '').replace(/٫/g, '.')
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(plain)) return { kind: 'number', value: Number(plain) }
  return { kind: 'text' }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function a1(row: number, column: number): string {
  return `${columnLetters(column)}${row + 1}`
}

export function rangeA1(startRow: number, startColumn: number, endRow: number, endColumn: number): string {
  const start = a1(startRow, startColumn)
  return startRow === endRow && startColumn === endColumn ? start : `${start}:${a1(endRow, endColumn)}`
}

export interface Place {
  sheetId: string
  row: number
  column: number
}

/**
 * One link for a set of cells: the bounding range of the cells in the sheet
 * that holds most of them (the editor selects one range). OPEN (D3): cells
 * scattered over rows select the rows between them too.
 */
export function linkFor(places: readonly Place[], order: readonly string[] = []): CellLink | null {
  if (places.length === 0) return null
  const bySheet = new Map<string, Place[]>()
  for (const p of places) bySheet.set(p.sheetId, [...(bySheet.get(p.sheetId) ?? []), p])
  let best: string | null = null
  for (const [sheetId, list] of bySheet) {
    const current = best === null ? null : (bySheet.get(best) ?? [])
    if (current === null || list.length > current.length || (list.length === current.length && order.indexOf(sheetId) < order.indexOf(best ?? ''))) best = sheetId
  }
  const list = bySheet.get(best ?? '') ?? []
  const rows = list.map((p) => p.row)
  const columns = list.map((p) => p.column)
  return { sheetId: best ?? '', range: rangeA1(Math.min(...rows), Math.min(...columns), Math.max(...rows), Math.max(...columns)) }
}

// ---------------------------------------------------------------------------
// Task sheets
// ---------------------------------------------------------------------------

interface TaskColumns {
  title: number
  assignees: number | null
  due: number | null
  completed: number | null
}

function columnsOf(plan: SheetPlan): TaskColumns | null {
  const of = (field: string): number | null => {
    const mapping = plan.columns.find((c) => c.field === field)
    return mapping ? columnIndex(mapping.columnKey) : null
  }
  const title = of('title')
  if (title === null) return null
  return { title, assignees: of('assignees'), due: of('due_on'), completed: of('completed') }
}

/** 0-based row of each task uid in the sheet. */
function rowsOfUids(sheet: SheetSnapshot, headerRow: number): Map<string, number> {
  const out = new Map<string, number>()
  const system = findSystemColumns(sheet, headerRow)
  if (!system.ok || system.value === null) return out
  const uidColumn = system.value.uid
  for (const key of Object.keys(sheet.cellData ?? {})) {
    const row = Number(key)
    if (!Number.isInteger(row) || row <= headerRow) continue
    const uid = cellText(cellAt(sheet, row, uidColumn)).trim()
    if (uid !== '' && !out.has(uid)) out.set(uid, row)
  }
  return out
}

interface TaskRow {
  task: LocalTask
  sheet: SheetRow
  row: number
  columns: TaskColumns
  status: DashboardTaskStatus
  names: Array<{ key: string; kind: DashboardAssignee['kind']; name: string }>
}

interface TaskSheet {
  sheet: SheetRow
  columns: TaskColumns
  rows: TaskRow[]
  issues: number
}

/** The task sheets of a workbook and their live rows (deleted in Basecamp left out, as in the files list). */
export function readTaskSheets(state: WorkbookState, today: IsoDate): TaskSheet[] {
  const out: TaskSheet[] = []
  const names = state.directory.block
  for (const sheet of state.sheets) {
    const plan = state.plans.get(sheet.id)
    if (!plan) continue
    const columns = columnsOf(plan)
    const snap = state.snapshot.sheets[sheet.univer_sheet_id] as SheetSnapshot | undefined
    if (!columns || !snap) continue
    const read = readSheet(state, sheet)
    if (!read.ok) continue
    const rowOf = rowsOfUids(snap, plan.headerRow - 1)
    // Names written in the cell that match nobody (§9.5): still someone's work.
    const unmatched = new Map<string, string[]>()
    for (const issue of read.value.issues) {
      if ((issue.code === 'unknown_assignee' || issue.code === 'ambiguous_assignee') && issue.uid && issue.detail) {
        unmatched.set(issue.uid, [...(unmatched.get(issue.uid) ?? []), issue.detail.trim()])
      }
    }
    const rows: TaskRow[] = []
    for (const task of read.value.tasks) {
      if (task.deletedRemotely) continue
      const row = rowOf.get(task.uid)
      if (row === undefined) continue
      const taskNames: TaskRow['names'] = task.assignees.map((a) =>
        a.kind === 'external'
          ? { key: `ext:${a.externalContactId}`, kind: 'external' as const, name: names.externalContacts.get(a.externalContactId)?.name ?? a.externalContactId }
          : { key: `bc:${a.bcPersonId}`, kind: 'bc_person' as const, name: names.personNames.get(a.bcPersonId) ?? String(a.bcPersonId) },
      )
      for (const name of unmatched.get(task.uid) ?? []) if (name !== '') taskNames.push({ key: `name:${name}`, kind: 'unmatched', name })
      rows.push({ task, sheet, row, columns, status: statusOf(task, today), names: taskNames })
    }
    const issueRows = new Set(read.value.issues.filter((i) => i.code !== 'unknown_assignee' && i.code !== 'ambiguous_assignee').map((i) => i.row))
    out.push({ sheet, columns, rows, issues: issueRows.size })
  }
  return out
}

export interface Automatic {
  totals: DashboardTotals
  sheets: DashboardSheet[]
  overdue: DashboardTask[]
  dueThisWeek: DashboardTask[]
  assignees: DashboardAssignee[]
  timeline: DashboardWeek[]
  timelineTruncated: boolean
  subtasks: { total: number; done: number; link: CellLink | null; parents: DashboardParentProgress[] }
  /** uid → title and link, for the activity list. */
  rowsByUid: Map<string, { title: string; link: CellLink }>
}

function titleLink(r: TaskRow): CellLink {
  return { sheetId: r.sheet.univer_sheet_id, range: a1(r.row, r.columns.title) }
}

function place(r: TaskRow, column: number | null): Place {
  return { sheetId: r.sheet.univer_sheet_id, row: r.row, column: column ?? r.columns.title }
}

function dashboardTask(r: TaskRow): DashboardTask {
  return {
    uid: r.task.uid,
    sheetId: r.sheet.univer_sheet_id,
    sheetTitle: r.sheet.title,
    title: r.task.title,
    level: r.task.level,
    status: r.status,
    dueOn: r.task.dueOn,
    assignees: r.names.map((n) => n.name),
    link: titleLink(r),
  }
}

/**
 * Every automatic figure. Completion counts to-dos (level 0), like the files
 * list and Basecamp's own list progress; overdue, this week, the timeline and
 * the people count every row (to-dos and subtasks). A to-do whose assignees
 * are the automatic union of its subtasks' (§8.1) is not counted again for them.
 */
export function computeAutomatic(state: WorkbookState, today: IsoDate): Automatic {
  const order = sheetOrder(state)
  const taskSheets = readTaskSheets(state, today)
  const week = weekOf(today)
  const all = taskSheets.flatMap((s) => s.rows)
  const todos = all.filter((r) => r.task.level === 0)

  // Per sheet, in tab order; plain sheets too (custom widgets read them).
  const bySheet = new Map(taskSheets.map((s) => [s.sheet.univer_sheet_id, s]))
  const sheets: DashboardSheet[] = []
  for (const sheetId of order) {
    const ts = bySheet.get(sheetId)
    const meta = state.sheets.find((s) => s.univer_sheet_id === sheetId)
    const title = meta?.title ?? String((state.snapshot.sheets[sheetId] as { name?: unknown } | undefined)?.name ?? '')
    const headerRow = meta?.header_row ?? 1
    const columns = headerColumns(state.snapshot.sheets[sheetId] as SheetSnapshot | undefined, headerRow - 1)
    if (!ts) {
      sheets.push({ sheetId, title, kind: 'plain', todos: 0, done: 0, open: 0, overdue: 0, completion: null, issues: 0, link: { sheetId, range: 'A1' }, columns, headerRow })
      continue
    }
    const t = ts.rows.filter((r) => r.task.level === 0)
    const done = t.filter((r) => r.status === 'done').length
    const overdue = t.filter((r) => r.status === 'overdue').length
    sheets.push({
      sheetId,
      title,
      kind: 'tasks',
      todos: t.length,
      done,
      open: t.length - done - overdue,
      overdue,
      completion: t.length > 0 ? done / t.length : null,
      issues: ts.issues,
      link: linkFor(t.map((r) => place(r, r.columns.completed)), order) ?? { sheetId, range: a1(ts.sheet.header_row - 1, ts.columns.title) },
      columns,
      headerRow,
    })
  }

  const overdueRows = all.filter((r) => r.status === 'overdue').sort((a, b) => (a.task.dueOn ?? '').localeCompare(b.task.dueOn ?? ''))
  const weekRows = all
    .filter((r) => r.status !== 'done' && r.task.dueOn !== null && r.task.dueOn >= today && r.task.dueOn <= week.end)
    .sort((a, b) => (a.task.dueOn ?? '').localeCompare(b.task.dueOn ?? ''))
  const done = todos.filter((r) => r.status === 'done').length
  const totals: DashboardTotals = {
    todos: todos.length,
    done,
    completion: todos.length > 0 ? done / todos.length : null,
    overdue: overdueRows.length,
    dueThisWeek: weekRows.length,
    undated: all.filter((r) => r.status !== 'done' && r.task.dueOn === null).length,
    completionLink: linkFor(todos.map((r) => place(r, r.columns.completed)), order),
    overdueLink: linkFor(overdueRows.map((r) => place(r, r.columns.due)), order),
    dueThisWeekLink: linkFor(weekRows.map((r) => place(r, r.columns.due)), order),
  }

  // People.
  const hasSubtasks = new Set(all.filter((r) => r.task.level === 1 && r.task.parentUid).map((r) => r.task.parentUid as string))
  const people = new Map<string, DashboardAssignee & { places: Place[] }>()
  for (const r of all) {
    if (r.task.level === 0 && r.task.assignMode === 'auto' && hasSubtasks.has(r.task.uid)) continue
    const seen = new Set<string>()
    for (const n of r.names) {
      if (seen.has(n.key)) continue
      seen.add(n.key)
      const entry = people.get(n.key) ?? { key: n.key, kind: n.kind, name: n.name, done: 0, open: 0, overdue: 0, link: null, places: [] }
      entry[r.status] += 1
      entry.places.push(place(r, r.columns.assignees))
      people.set(n.key, entry)
    }
  }
  const assignees = [...people.values()]
    .map(({ places, ...a }) => ({ ...a, link: linkFor(places, order) }))
    .sort((a, b) => b.done + b.open + b.overdue - (a.done + a.open + a.overdue) || a.name.localeCompare(b.name, 'ar'))

  // Timeline by week of due date.
  const dated = all.filter((r) => r.task.dueOn !== null)
  const weeks = new Map<IsoDate, DashboardWeek & { places: Place[] }>()
  for (const r of dated) {
    const start = weekOf(r.task.dueOn as IsoDate).start
    const entry = weeks.get(start) ?? { weekStart: start, done: 0, open: 0, overdue: 0, link: null, places: [] }
    entry[r.status] += 1
    entry.places.push(place(r, r.columns.due))
    weeks.set(start, entry)
  }
  let timeline: DashboardWeek[] = []
  let timelineTruncated = false
  if (weeks.size > 0) {
    const starts = [...weeks.keys()].sort()
    const first = dayNumber(starts[0] as IsoDate)
    const last = dayNumber(starts[starts.length - 1] as IsoDate)
    const all: DashboardWeek[] = []
    for (let n = first; n <= last; n += 7) {
      const key = isoOfDay(n)
      const w = weeks.get(key)
      all.push(w ? { weekStart: w.weekStart, done: w.done, open: w.open, overdue: w.overdue, link: linkFor(w.places, order) } : { weekStart: key, done: 0, open: 0, overdue: 0, link: null })
    }
    timeline = all
    if (all.length > TIMELINE_LIMIT) {
      timelineTruncated = true
      // Keep the window around this week: a quarter before, the rest after.
      const current = all.findIndex((w) => w.weekStart >= week.start)
      const anchor = current === -1 ? all.length - 1 : current
      const from = Math.max(0, Math.min(anchor - Math.floor(TIMELINE_LIMIT / 4), all.length - TIMELINE_LIMIT))
      timeline = all.slice(from, from + TIMELINE_LIMIT)
    }
  }

  // Subtasks.
  const subtasks = all.filter((r) => r.task.level === 1)
  const parents: DashboardParentProgress[] = []
  for (const parent of todos) {
    const own = subtasks.filter((s) => s.task.parentUid === parent.task.uid)
    if (own.length === 0) continue
    parents.push({
      uid: parent.task.uid,
      sheetId: parent.sheet.univer_sheet_id,
      title: parent.task.title,
      done: own.filter((s) => s.status === 'done').length,
      total: own.length,
      link: titleLink(parent),
    })
  }

  const rowsByUid = new Map(all.map((r) => [r.task.uid, { title: r.task.title, link: titleLink(r) }]))
  return {
    totals,
    sheets,
    overdue: overdueRows.slice(0, LIST_LIMIT).map(dashboardTask),
    dueThisWeek: weekRows.slice(0, LIST_LIMIT).map(dashboardTask),
    assignees,
    timeline,
    timelineTruncated,
    subtasks: {
      total: subtasks.length,
      done: subtasks.filter((s) => s.status === 'done').length,
      link: linkFor(subtasks.map((s) => place(s, s.columns.title)), order),
      parents: parents.slice(0, PARENT_LIMIT),
    },
    rowsByUid,
  }
}

/** Columns offered to a widget: up to the last used column, at most this many. */
export const COLUMN_LIMIT = 60
const SYSTEM_HEADER_TEXTS = new Set(['__uid', '__parent_uid', '__level'])

/** The sheet's columns with their header text; system columns left out. */
export function headerColumns(sheet: SheetSnapshot | undefined, headerRow: number): Array<{ key: string; header: string }> {
  if (!sheet) return []
  let last = -1
  for (const line of Object.values(sheet.cellData ?? {})) for (const key of Object.keys(line ?? {})) last = Math.max(last, Number(key))
  const out: Array<{ key: string; header: string }> = []
  for (let c = 0; c <= Math.min(last, COLUMN_LIMIT - 1); c++) {
    const header = cellText(cellAt(sheet, headerRow, c)).replace(/\s+/g, ' ').trim()
    if (SYSTEM_HEADER_TEXTS.has(header)) continue
    out.push({ key: columnLetters(c), header })
  }
  return out
}

/** Univer sheet ids in tab order (the snapshot's `sheetOrder`, then any sheet it leaves out). */
export function sheetOrder(state: Pick<WorkbookState, 'snapshot'>): string[] {
  const ids = Object.keys(state.snapshot.sheets)
  const listed = (state.snapshot.sheetOrder ?? []).filter((id) => ids.includes(id))
  return [...listed, ...ids.filter((id) => !listed.includes(id))]
}

// ---------------------------------------------------------------------------
// Custom widgets
// ---------------------------------------------------------------------------

/** Data rows of a sheet: below its header row, up to the last row holding a cell. */
function dataRows(sheet: SheetSnapshot, headerRow: number): number[] {
  return Object.keys(sheet.cellData ?? {})
    .map(Number)
    .filter((r) => Number.isInteger(r) && r > headerRow)
    .sort((a, b) => a - b)
}

export interface ParsedRange {
  startRow: number
  startColumn: number
  endRow: number
  endColumn: number
}

const CELL = /^([A-Z]{1,3})([1-9]\d{0,6})$/

/** `B4` or `B4:C10` (a reversed pair normalised); null for anything else. */
export function parseRange(text: string): ParsedRange | null {
  const parts = text.trim().toUpperCase().split(':')
  if (parts.length > 2) return null
  const cell = (s: string) => {
    const m = CELL.exec(s)
    if (!m?.[1] || !m[2]) return null
    const column = columnIndex(m[1])
    return column === null ? null : { row: Number(m[2]) - 1, column }
  }
  const a = cell(parts[0] ?? '')
  const b = parts.length === 2 ? cell(parts[1] ?? '') : a
  if (!a || !b) return null
  return { startRow: Math.min(a.row, b.row), startColumn: Math.min(a.column, b.column), endRow: Math.max(a.row, b.row), endColumn: Math.max(a.column, b.column) }
}

/** A column letter (`A` … `ZZZ`) → 0-based index, or null. */
export function parseColumn(text: string): number | null {
  const t = text.trim().toUpperCase()
  return /^[A-Z]{1,3}$/.test(t) ? columnIndex(t) : null
}

/** At most this many cells are read for one widget (a range like A1:ZZZ9999999 is refused before reading). */
export const MAX_WIDGET_CELLS = 200_000

class Accumulator {
  sum = 0
  numbers = 0
  min: number | null = null
  max: number | null = null
  cells = 0
  skipped = 0
  uncomputed = 0
  places: Place[] = []

  add(value: CellValue, p: Place): void {
    if (value.kind === 'empty') return
    if (value.kind === 'uncomputed') {
      this.uncomputed += 1
      return
    }
    this.cells += 1
    this.places.push(p)
    if (value.kind === 'text') {
      this.skipped += 1
      return
    }
    this.sum += value.value
    this.numbers += 1
    this.min = this.min === null ? value.value : Math.min(this.min, value.value)
    this.max = this.max === null ? value.value : Math.max(this.max, value.value)
  }

  result(aggregation: DashboardAggregation): number | null {
    switch (aggregation) {
      case 'count':
        return this.cells
      case 'sum':
        return this.numbers > 0 ? this.sum : null
      case 'average':
        return this.numbers > 0 ? this.sum / this.numbers : null
      case 'min':
        return this.min
      case 'max':
        return this.max
    }
  }
}

/** For `count`, text cells are not "skipped": they are what is counted. */
function skippedFor(aggregation: DashboardAggregation, acc: Accumulator): number {
  return aggregation === 'count' ? 0 : acc.skipped
}

/**
 * One widget over the snapshot. `headerRowOf` gives a sheet's 1-based header
 * row (D1 `sheets.header_row`; 1 for a sheet D1 does not know).
 */
export function evaluateWidget(
  snapshot: WorkbookSnapshot,
  config: DashboardWidgetConfig,
  headerRowOf: (univerSheetId: string) => number,
  widgetId: string | null = null,
): WidgetResult {
  const sheet = snapshot.sheets[config.sheetId] as SheetSnapshot | undefined
  if (!sheet) return { widgetId, ok: false, message: WIDGET_MESSAGES.sheet_missing }
  const header = Math.max(0, headerRowOf(config.sheetId) - 1)

  // The cells read, as (row, column) pairs.
  let rows: number[]
  let columns: number[]
  if (config.source.kind === 'column') {
    const column = parseColumn(config.source.column)
    if (column === null) return { widgetId, ok: false, message: WIDGET_MESSAGES.invalid_source }
    rows = dataRows(sheet, header)
    columns = [column]
  } else {
    const range = parseRange(config.source.range)
    if (!range) return { widgetId, ok: false, message: WIDGET_MESSAGES.invalid_source }
    const width = range.endColumn - range.startColumn + 1
    const height = range.endRow - range.startRow + 1
    if (width * height > MAX_WIDGET_CELLS) return { widgetId, ok: false, message: WIDGET_MESSAGES.range_too_large }
    // Only rows that hold a cell are visited.
    rows = Object.keys(sheet.cellData ?? {})
      .map(Number)
      .filter((r) => Number.isInteger(r) && r >= range.startRow && r <= range.endRow)
      .sort((a, b) => a - b)
    columns = []
    for (let c = range.startColumn; c <= range.endColumn; c++) columns.push(c)
  }
  const groupColumn = config.groupBy === null ? null : parseColumn(config.groupBy)
  if (config.groupBy !== null && groupColumn === null) return { widgetId, ok: false, message: WIDGET_MESSAGES.invalid_group }

  const total = new Accumulator()
  const groups = new Map<string, Accumulator>()
  for (const row of rows) {
    const label = groupColumn === null ? null : labelOf(snapshot, cellAt(sheet, row, groupColumn))
    for (const column of columns) {
      const value = readValue(cellAt(sheet, row, column))
      const p = { sheetId: config.sheetId, row, column }
      total.add(value, p)
      if (label !== null && value.kind !== 'empty') {
        const acc = groups.get(label) ?? new Accumulator()
        acc.add(value, p)
        groups.set(label, acc)
      }
    }
  }

  let list: WidgetGroup[] | null = null
  let otherGroups = 0
  if (groupColumn !== null) {
    const all = [...groups.entries()].map(([label, acc]) => ({ label, value: acc.result(config.aggregation), cells: acc.cells, link: linkFor(acc.places) }))
    list = all.slice(0, GROUP_LIMIT)
    otherGroups = Math.max(0, all.length - GROUP_LIMIT)
  }

  const link: CellLink | null =
    config.source.kind === 'range'
      ? { sheetId: config.sheetId, range: rangeA1(...rangeCorners(config.source.range)) }
      : rows.length > 0
        ? { sheetId: config.sheetId, range: rangeA1(rows[0] as number, columns[0] as number, rows[rows.length - 1] as number, columns[0] as number) }
        : null
  return {
    widgetId,
    ok: true,
    value: total.result(config.aggregation),
    cells: total.cells,
    skipped: skippedFor(config.aggregation, total),
    uncomputed: total.uncomputed,
    groups: list,
    otherGroups,
    groupLimit: GROUP_LIMIT,
    link,
  }
}

function rangeCorners(text: string): [number, number, number, number] {
  const r = parseRange(text) as ParsedRange
  return [r.startRow, r.startColumn, r.endRow, r.endColumn]
}
