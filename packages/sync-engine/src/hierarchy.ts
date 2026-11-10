// Row hierarchy of a synced sheet (spec §6.1, §8).
//
// Rows are given in display order. Identity is the uid (`__uid`), never the
// row number: every operation returns the same row objects (copied when a
// field changes) in a new order, with `level`, `parentUid` and the 1-based
// `position` recomputed. Basecamp allows one level of subtasks only, so a
// subtask is always directly under its to-do, and a to-do moves with its
// subtasks.

import type { LocalTask, TaskUid } from '@naf-sheets/shared'
import { fail, ok, type Result } from './errors'

export type HierarchyRow = Pick<LocalTask, 'uid' | 'parentUid' | 'level' | 'position'>

/**
 * Positions from display order: to-dos 1..n within the sheet, subtasks 1..m
 * within their to-do. A row object is copied only when something changes.
 */
export function renumber<T extends HierarchyRow>(rows: readonly T[]): T[] {
  let main = 0
  const children = new Map<TaskUid, number>()
  return rows.map((row) => {
    if (row.level === 0) {
      main += 1
      return row.position === main && row.parentUid === null ? row : { ...row, position: main, parentUid: null }
    }
    const key = row.parentUid ?? ''
    const n = (children.get(key) ?? 0) + 1
    children.set(key, n)
    return row.position === n ? row : { ...row, position: n }
  })
}

/** Every subtask sits under its own to-do, and no row claims a second level. */
export function isValidHierarchy(rows: readonly HierarchyRow[]): boolean {
  let currentParent: TaskUid | null = null
  for (const row of rows) {
    if (row.level === 0) {
      if (row.parentUid !== null) return false
      currentParent = row.uid
    } else if (currentParent === null || row.parentUid !== currentParent) {
      return false
    }
  }
  return true
}

function indexOf(rows: readonly HierarchyRow[], uid: TaskUid): number {
  return rows.findIndex((r) => r.uid === uid)
}

/** Tab: the row becomes the last subtask of the nearest to-do above it. */
export function indentRow<T extends HierarchyRow>(rows: readonly T[], uid: TaskUid): Result<T[]> {
  const idx = indexOf(rows, uid)
  const row = rows[idx]
  if (row === undefined) return fail('row_not_found')
  if (row.level === 1) return fail('third_level_not_allowed')
  if (rows.some((r) => r.level === 1 && r.parentUid === uid)) return fail('parent_has_subtasks')
  let parent: T | undefined
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = rows[i]
    if (candidate !== undefined && candidate.level === 0) {
      parent = candidate
      break
    }
  }
  if (parent === undefined) return fail('no_parent_above')
  const next = rows.map((r) => (r.uid === uid ? { ...r, level: 1 as const, parentUid: parent.uid } : r))
  return ok(renumber(next))
}

/**
 * Shift+Tab: the subtask becomes a to-do placed right after its former
 * to-do's remaining subtasks, so no other row changes parent.
 * OPEN: the spec does not say where an outdented middle subtask goes (OPEN_QUESTIONS.md).
 * A row that is already a to-do is left as it is.
 */
export function outdentRow<T extends HierarchyRow>(rows: readonly T[], uid: TaskUid): Result<T[]> {
  const idx = indexOf(rows, uid)
  const row = rows[idx]
  if (row === undefined) return fail('row_not_found')
  if (row.level === 0) return ok([...rows])
  const formerParent = row.parentUid
  const rest = rows.filter((_, i) => i !== idx)
  const parentIdx = rest.findIndex((r) => r.uid === formerParent)
  let insertAt = idx
  if (parentIdx >= 0) {
    insertAt = parentIdx + 1
    while (insertAt < rest.length && rest[insertAt]?.level === 1 && rest[insertAt]?.parentUid === formerParent) insertAt += 1
  }
  const outdented = { ...row, level: 0 as const, parentUid: null }
  return ok(renumber([...rest.slice(0, insertAt), outdented, ...rest.slice(insertAt)]))
}

/**
 * Drag a row to just before `beforeUid` (`null`: the end of the sheet).
 * - A to-do moves with all its subtasks, and may only land before another to-do or at the end.
 * - A subtask lands under the nearest to-do above its new place (it may change to-do).
 */
export function moveRow<T extends HierarchyRow>(rows: readonly T[], uid: TaskUid, beforeUid: TaskUid | null): Result<T[]> {
  const row = rows[indexOf(rows, uid)]
  if (row === undefined) return fail('row_not_found')
  if (beforeUid !== null && indexOf(rows, beforeUid) < 0) return fail('row_not_found')

  if (row.level === 0) {
    const family = new Set<TaskUid>([uid])
    for (const r of rows) if (r.level === 1 && r.parentUid === uid) family.add(r.uid)
    if (beforeUid !== null && family.has(beforeUid)) return ok([...rows])
    const block = rows.filter((r) => family.has(r.uid))
    const rest = rows.filter((r) => !family.has(r.uid))
    let insertAt = rest.length
    if (beforeUid !== null) {
      insertAt = indexOf(rest, beforeUid)
      if (rest[insertAt]?.level !== 0) return fail('invalid_move_target')
    }
    return ok(renumber([...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]))
  }

  if (beforeUid === uid) return ok([...rows])
  const rest = rows.filter((r) => r.uid !== uid)
  const insertAt = beforeUid === null ? rest.length : indexOf(rest, beforeUid)
  let parent: T | undefined
  for (let i = insertAt - 1; i >= 0; i--) {
    const candidate = rest[i]
    if (candidate !== undefined && candidate.level === 0) {
      parent = candidate
      break
    }
  }
  if (parent === undefined) return fail('subtask_needs_parent')
  const moved = row.parentUid === parent.uid ? row : { ...row, parentUid: parent.uid }
  return ok(renumber([...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)]))
}

/**
 * Sort by a column (§16-2): to-dos are ordered by `compare`, each keeping its
 * subtasks directly under it, which are ordered by the same `compare` among
 * themselves. Stable; identities (uids and the data they carry) never change.
 * OPEN: sorting subtasks within their to-do is our reading of §8 (#5).
 */
export function sortRows<T extends HierarchyRow>(rows: readonly T[], compare: (a: T, b: T) => number): T[] {
  const leading: T[] = [] // subtasks above any to-do: invalid input, kept first and untouched
  const families: Array<{ parent: T; children: T[] }> = []
  for (const row of rows) {
    const last = families[families.length - 1]
    if (row.level === 0) families.push({ parent: row, children: [] })
    else if (last !== undefined) last.children.push(row)
    else leading.push(row)
  }
  families.sort((a, b) => compare(a.parent, b.parent))
  const sorted: T[] = [...leading]
  for (const family of families) sorted.push(family.parent, ...[...family.children].sort(compare))
  return renumber(sorted)
}
