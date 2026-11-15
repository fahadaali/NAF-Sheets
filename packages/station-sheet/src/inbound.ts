// Basecamp → the sheet: the sync engine's inbound actions as cell edits.
//
// - Title of a to-do: its own row and the repeated title on each of its
//   subtask rows (decision 4).
// - Completion: «منجزة», or back to «جارية» (decision 3).
// - Due date: written as `YYYY-MM-DD` text for USER_ENTERED, so the column's
//   own date format applies.
// - Assignees: the sheet is the reference (decision 2-أ). Nothing is written.
//   The engine also proposes people for a to-do in automatic mode (its
//   subtasks' union, spec §8.1), which is no change at all; a real change made
//   in Basecamp is detected by the caller against the last synced base.
// - Notes, start date, order, attachments: no column in the sheet; ignored.
// - Created, moved, deleted or restored records need rows inserted, moved or
//   marked: returned in `structural` for the caller.

import type { InboundAction, TaskUid } from '@naf-sheets/shared'
import type { TabColumns } from './columns'
import type { CellEdit, TabRow } from './read'
import { statusAfterRemoteCompletion } from './status'

export interface InboundEditsResult {
  edits: CellEdit[]
  structural: Exclude<InboundAction, { type: 'update_row' }>[]
  /** Update actions for rows not in the sheet (the caller re-reads the tab). */
  unknownRows: TaskUid[]
}

export function inboundEdits(rows: readonly TabRow[], columns: TabColumns, actions: readonly InboundAction[]): InboundEditsResult {
  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const out: InboundEditsResult = { edits: [], structural: [], unknownRows: [] }
  for (const action of actions) {
    if (action.type !== 'update_row') {
      out.structural.push(action)
      continue
    }
    const row = byUid.get(action.uid)
    if (row === undefined) {
      out.unknownRows.push(action.uid)
      continue
    }
    const f = action.fields
    if (f.title !== undefined) {
      if (row.level === 0) {
        out.edits.push({ row: row.row, column: columns.main, value: f.title })
        for (const sub of rows) {
          if (sub.parentUid === row.uid) out.edits.push({ row: sub.row, column: columns.main, value: f.title })
        }
      } else {
        out.edits.push({ row: row.row, column: columns.sub, value: f.title })
      }
    }
    if (f.dueOn !== undefined) out.edits.push({ row: row.row, column: columns.due, value: f.dueOn })
    if (f.completed !== undefined) {
      const next = statusAfterRemoteCompletion(row.status, f.completed)
      if (next !== null) out.edits.push({ row: row.row, column: columns.status, value: next })
    }
  }
  return out
}
