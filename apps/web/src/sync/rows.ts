// Task rows of a synced sheet as the system columns describe them, and the
// hierarchy rules the editor enforces while a person moves, inserts and
// removes rows (spec §8). The rules themselves are @naf-sheets/sync-engine's
// (one level of subtasks, a subtask right under its to-do, a to-do moves with
// its subtasks); this module only applies them to row indexes.

import { ERROR_MESSAGES } from '@naf-sheets/sync-engine'
import type { TaskLevel, TaskUid } from '@naf-sheets/shared'
import { t } from '../strings'
import { cellText, type CellReader } from './cells'
import type { SheetLayout, SystemColumns } from './layout'

/** A row that carries a task identity. `row` is 0-based. */
export interface TaskRow {
  row: number
  uid: TaskUid
  parentUid: TaskUid | null
  level: TaskLevel
}

function levelOf(value: unknown): TaskLevel | null {
  if (value === 0 || value === '0') return 0
  if (value === 1 || value === '1') return 1
  return null
}

/**
 * Every row below the header with a uid and a valid level, in sheet order.
 * Rows sharing a uid are left out, like sheet-model's `readSystemRows`.
 */
export function readTaskRows(reader: CellReader, layout: Pick<SheetLayout, 'header' | 'system'>): TaskRow[] {
  const system = layout.system
  if (!system) return []
  const candidates: TaskRow[] = []
  const seen = new Map<TaskUid, number>()
  const last = reader.lastRow()
  for (let row = layout.header + 1; row <= last; row++) {
    const uid = cellText(reader.cell(row, system.uid)).trim()
    if (uid === '') continue
    seen.set(uid, (seen.get(uid) ?? 0) + 1)
    const level = levelOf(reader.cell(row, system.level)?.v)
    if (level === null) continue
    const parent = cellText(reader.cell(row, system.parentUid)).trim()
    candidates.push({ row, uid, level, parentUid: level === 1 && parent !== '' ? parent : null })
  }
  return candidates.filter((r) => (seen.get(r.uid) ?? 0) === 1)
}

/** The to-do `uid` and the subtasks right under it (a valid family is contiguous). */
export function familyRows(rows: readonly TaskRow[], uid: TaskUid): TaskRow[] {
  const index = rows.findIndex((r) => r.uid === uid)
  const head = rows[index]
  if (!head || head.level !== 0) return head ? [head] : []
  const out = [head]
  for (let i = index + 1; i < rows.length; i++) {
    const r = rows[i] as TaskRow
    if (r.level !== 1 || r.parentUid !== uid || r.row !== (out[out.length - 1] as TaskRow).row + 1) break
    out.push(r)
  }
  return out
}

/** Subtask count and done count per to-do («3 من 5»); `isDone` reads a row's status. */
export function progressByTodo(rows: readonly TaskRow[], isDone: (row: number) => boolean): Map<TaskUid, { done: number; total: number }> {
  const out = new Map<TaskUid, { done: number; total: number }>()
  for (const r of rows) {
    if (r.level !== 1 || r.parentUid === null) continue
    const entry = out.get(r.parentUid) ?? { done: 0, total: 0 }
    entry.total += 1
    if (isDone(r.row)) entry.done += 1
    out.set(r.parentUid, entry)
  }
  return out
}

// ---------------------------------------------------------------------------
// New rows
// ---------------------------------------------------------------------------

export interface Identity {
  uid: TaskUid
  parentUid: TaskUid | null
  level: TaskLevel
}

/**
 * Level and parent of a row that just got a title. A to-do by default (as
 * sheet-model's `ensureSystemColumns`); a subtask of the to-do whose family
 * it sits inside, so a row inserted between two subtasks does not split the
 * family (which the server would refuse as `invalid_hierarchy`).
 * OPEN: apps/web/OPEN_QUESTIONS.md #36.
 */
export function newRowIdentity(rows: readonly TaskRow[], row: number, uid: TaskUid): Identity {
  let above: TaskRow | undefined
  let below: TaskRow | undefined
  for (const r of rows) {
    if (r.row < row) above = r
    else if (r.row > row && below === undefined) below = r
  }
  if (below && below.level === 1 && below.parentUid !== null && above && (above.uid === below.parentUid || above.parentUid === below.parentUid)) {
    return { uid, parentUid: below.parentUid, level: 1 }
  }
  return { uid, parentUid: null, level: 0 }
}

/** The three system cells of a row, as sheet-model writes them (`writeSystemCells`). */
export function systemCells(system: SystemColumns, identity: Identity): Record<number, { v: string | number | null; t?: number }> {
  return {
    [system.uid]: { v: identity.uid, t: 1 },
    [system.parentUid]: identity.parentUid === null ? { v: null } : { v: identity.parentUid, t: 1 },
    [system.level]: { v: identity.level, t: 2 },
  }
}

// ---------------------------------------------------------------------------
// Moving rows (drag by the row header)
// ---------------------------------------------------------------------------

export type MovePlan =
  | { kind: 'allow' }
  /** Move the rows `start..end` instead (a to-do takes its subtasks along). */
  | { kind: 'extend'; start: number; end: number }
  | { kind: 'refuse'; message: string }
  /** The target lies inside what moves: nothing to do. */
  | { kind: 'ignore' }

/**
 * Rows `start..end` moved to just before row `to` (row indexes before the
 * move, as Univer's `MoveRowsCommand` takes them).
 * - A to-do moves with all its subtasks (spec §8), and may land only before
 *   another to-do, a row that is not a task, or the end — never between the
 *   subtasks of another to-do (engine `invalid_move_target`).
 * - Subtasks may be reordered within their own to-do only: a move to another
 *   to-do is a hierarchy change sync does not support (engine warning
 *   `hierarchy_change_unsupported`). OPEN: OPEN_QUESTIONS.md #49.
 */
export function planRowMove(rows: readonly TaskRow[], start: number, end: number, to: number): MovePlan {
  const block = rows.filter((r) => r.row >= start && r.row <= end)
  if (block.length === 0) {
    const target = rows.find((r) => r.row === to)
    // Plain rows dropped between the subtasks of a to-do would split the family.
    if (target && target.level === 1 && rows.some((r) => r.row === to - 1 && (r.level === 1 || r.uid === target.parentUid))) {
      return { kind: 'refuse', message: ERROR_MESSAGES.invalid_move_target }
    }
    return { kind: 'allow' }
  }
  const todos = block.filter((r) => r.level === 0)
  let last = end
  for (const todo of todos) for (const member of familyRows(rows, todo.uid)) last = Math.max(last, member.row)
  if (to >= start && to <= last + 1) return { kind: 'ignore' }
  const moved = rows.filter((r) => r.row >= start && r.row <= last)
  const movedUids = new Set(moved.map((r) => r.uid))
  // Subtasks that move without their to-do.
  const strays = moved.filter((r) => r.level === 1 && (r.parentUid === null || !movedUids.has(r.parentUid)))

  if (todos.length > 0) {
    if (strays.length > 0) return { kind: 'refuse', message: t.guard.moveMixed }
    const target = rows.find((r) => r.row === to)
    if (target && target.level === 1) return { kind: 'refuse', message: ERROR_MESSAGES.invalid_move_target }
    return last === end ? { kind: 'allow' } : { kind: 'extend', start, end: last }
  }

  // Only subtasks: all of one to-do, staying inside that to-do's family.
  const parents = new Set(strays.map((r) => r.parentUid))
  if (parents.size !== 1) return { kind: 'refuse', message: t.guard.moveMixed }
  const parentUid = [...parents][0] as TaskUid
  const family = familyRows(rows, parentUid)
  const head = family[0]
  const tail = family[family.length - 1]
  if (!head || !tail || to <= head.row || to > tail.row + 1) return { kind: 'refuse', message: t.guard.moveSubtaskAcross }
  return { kind: 'allow' }
}

// ---------------------------------------------------------------------------
// Removing rows (spec §9.2.7)
// ---------------------------------------------------------------------------

export interface RowSpan {
  start: number
  end: number
}

export interface RemovalPlan {
  /** What to remove, subtasks of removed to-dos included, merged and sorted. */
  spans: RowSpan[]
  /** True when subtasks were added to what the person selected. */
  extended: boolean
  /** To-dos removed (each with its subtasks). */
  todos: Array<{ row: TaskRow; subtasks: TaskRow[] }>
  /** Subtasks removed on their own (their to-do stays). */
  subtasks: TaskRow[]
  /** Every uid that leaves the sheet: the confirmed deletions. */
  uids: TaskUid[]
}

function mergeSpans(spans: readonly RowSpan[]): RowSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: RowSpan[] = []
  for (const s of sorted) {
    const prev = out[out.length - 1]
    if (prev && s.start <= prev.end + 1) prev.end = Math.max(prev.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Null when the spans hold no task row (nothing to ask). */
export function planRemoval(rows: readonly TaskRow[], spans: readonly RowSpan[]): RemovalPlan | null {
  const inSpans = (row: number) => spans.some((s) => row >= s.start && row <= s.end)
  const selected = rows.filter((r) => inSpans(r.row))
  if (selected.length === 0) return null
  const extra: RowSpan[] = []
  const todos: RemovalPlan['todos'] = []
  const removedTodo = new Set<TaskUid>()
  for (const r of selected) {
    if (r.level !== 0) continue
    const family = familyRows(rows, r.uid)
    const subtasks = family.slice(1)
    todos.push({ row: r, subtasks })
    removedTodo.add(r.uid)
    const tail = family[family.length - 1] as TaskRow
    if (!inSpans(tail.row) || subtasks.some((s) => !inSpans(s.row))) extra.push({ start: r.row, end: tail.row })
  }
  const subtasks = selected.filter((r) => r.level === 1 && (r.parentUid === null || !removedTodo.has(r.parentUid)))
  const merged = mergeSpans([...spans, ...extra])
  const uids = [...todos.flatMap((f) => [f.row.uid, ...f.subtasks.map((s) => s.uid)]), ...subtasks.map((s) => s.uid)]
  return { spans: merged, extended: extra.length > 0, todos, subtasks, uids: [...new Set(uids)] }
}
