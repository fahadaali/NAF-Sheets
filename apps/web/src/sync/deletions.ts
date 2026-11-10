// Confirmed deletions of synced rows (spec §9.2.7, `SaveSnapshotRequest.
// confirmedDeletions`): the API deletes nothing in Basecamp unless the uid is
// listed in a save after the person confirmed the deletion dialog.
//
// A confirmed uid is sent with the next save in which the row is really gone.
// If an undo brought the row back before that save, the uid is dropped from
// the list: the deletion did not happen.

import type { SheetMeta, TaskUid } from '@naf-sheets/shared'
import type { IWorksheetData } from '@univerjs/core'
import { cellText, snapshotReader } from './cells'
import { sheetLayout } from './layout'

export class PendingDeletions {
  private readonly pending = new Set<TaskUid>()

  add(uids: Iterable<TaskUid>): void {
    for (const uid of uids) this.pending.add(uid)
  }

  get size(): number {
    return this.pending.size
  }

  list(): TaskUid[] {
    return [...this.pending]
  }

  /** Uids to send with a snapshot holding the task rows `present`; a confirmed row that is back (undo) leaves the list. */
  forSnapshot(present: ReadonlySet<TaskUid>): TaskUid[] {
    for (const uid of [...this.pending]) if (present.has(uid)) this.pending.delete(uid)
    return [...this.pending]
  }

  /** The save carrying `sent` succeeded. */
  acknowledge(sent: readonly TaskUid[]): void {
    for (const uid of sent) this.pending.delete(uid)
  }
}

type SnapshotLike = { sheets?: Record<string, Partial<IWorksheetData> | undefined> } | null | undefined

/** Every uid in the system column of the synced sheets of a snapshot. */
export function uidsInSnapshot(snapshot: unknown, metas: readonly SheetMeta[]): Set<TaskUid> {
  const out = new Set<TaskUid>()
  const sheets = (snapshot as SnapshotLike)?.sheets ?? {}
  for (const meta of metas) {
    const sheet = sheets[meta.univerSheetId]
    if (!sheet) continue
    const reader = snapshotReader(sheet)
    const layout = sheetLayout(reader, meta)
    if (!layout?.system) continue
    for (let row = layout.header + 1; row <= reader.lastRow(); row++) {
      const uid = cellText(reader.cell(row, layout.system.uid)).trim()
      if (uid !== '') out.add(uid)
    }
  }
  return out
}
