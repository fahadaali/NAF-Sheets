// The first sync of a tab linked to a list that already has tasks (owner
// decision 10, settled 2026-11-17): rows and Basecamp records are matched by
// title, then the link's reference says which side's values win.
//
//   file      matched pairs take the sheet's values; records only in Basecamp
//             stay there and are not added to the sheet (ignored by the link).
//   basecamp  matched pairs take Basecamp's values; records only in Basecamp
//             get rows.
//   merge     matched pairs take the sheet's values; records only in Basecamp
//             get rows.
//
// In every case rows only in the sheet are created in Basecamp, and nothing is
// deleted on either side. People always come from the sheet (decision 2-أ).

import type { TaskLevel, TaskUid } from '@naf-sheets/shared'
import { cellText } from './cells'
import type { TabRow } from './read'

export type FirstSyncReference = 'file' | 'basecamp' | 'merge'

export const FIRST_SYNC_REFERENCES: readonly FirstSyncReference[] = ['file', 'basecamp', 'merge']

export interface FirstSyncRemoteTodo {
  id: number
  content: string
}

export interface FirstSyncRemoteSubtask {
  id: number
  title: string
}

export interface FirstSyncPlan {
  /** A row and the Basecamp record with its title. */
  pairs: { uid: TaskUid; bcId: number; level: TaskLevel }[]
  /** Rows with no record of their title: created in Basecamp. */
  fileOnly: TaskUid[]
  /** Records with no row of their title (`todoId`: a subtask's to-do). */
  basecampOnly: { bcId: number; level: TaskLevel; todoId: number | null }[]
}

/**
 * Matches the tab's rows that are not in Basecamp yet with the list's records:
 * a to-do by its title, a subtask by its title under its matched (or already
 * synced) to-do; the first unused record of that title, in order. Records
 * already known to the link (`knownBcIds`) are left out.
 */
export function firstSyncPlan(
  rows: readonly TabRow[],
  remoteTodos: readonly FirstSyncRemoteTodo[],
  subtasksByTodo: ReadonlyMap<number, readonly FirstSyncRemoteSubtask[]>,
  knownBcIds: ReadonlySet<number> = new Set(),
): FirstSyncPlan {
  const plan: FirstSyncPlan = { pairs: [], fileOnly: [], basecampOnly: [] }
  const used = new Set<number>(knownBcIds)
  const todoOf = new Map<TaskUid, number>()
  for (const row of rows) if (row.level === 0 && row.bcId !== null) todoOf.set(row.uid, row.bcId)

  const take = <T extends { id: number }>(candidates: readonly T[], title: string, titleOf: (c: T) => string): T | undefined => {
    const want = cellText(title)
    if (want === '') return undefined
    const found = candidates.find((c) => !used.has(c.id) && cellText(titleOf(c)) === want)
    if (found) used.add(found.id)
    return found
  }

  for (const row of rows) {
    if (row.bcId !== null || row.title === '') continue
    if (row.level === 0) {
      const todo = take(remoteTodos, row.title, (t) => t.content)
      if (todo) {
        plan.pairs.push({ uid: row.uid, bcId: todo.id, level: 0 })
        todoOf.set(row.uid, todo.id)
      } else {
        plan.fileOnly.push(row.uid)
      }
    } else {
      const todoId = row.parentUid ? todoOf.get(row.parentUid) : undefined
      const sub = todoId !== undefined ? take(subtasksByTodo.get(todoId) ?? [], row.title, (s) => s.title) : undefined
      if (sub) plan.pairs.push({ uid: row.uid, bcId: sub.id, level: 1 })
      else plan.fileOnly.push(row.uid)
    }
  }

  for (const todo of remoteTodos) {
    if (!used.has(todo.id)) plan.basecampOnly.push({ bcId: todo.id, level: 0, todoId: null })
  }
  for (const [todoId, subs] of subtasksByTodo) {
    for (const sub of subs) if (!used.has(sub.id)) plan.basecampOnly.push({ bcId: sub.id, level: 1, todoId })
  }
  return plan
}
