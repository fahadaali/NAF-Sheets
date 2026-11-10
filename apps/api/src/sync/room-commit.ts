// Outbound detection after the workbook room commits (spec §9.2.1–2, §11):
// installed as the room's outbound seam by the Worker entry (src/index.ts).
//
// A room commit can hold the edits of several people and of the server
// (inbound sync, the link wizard). Basecamp is written with the token of the
// person who made the change (spec §3), so each changed row is credited to the
// last person whose edit touched it:
//
// - Edits are walked from the newest back. A cell edit touches the rows its
//   cells are on, at the positions they had when it was made; those are the
//   committed positions as long as no structural edit (rows inserted, removed,
//   moved, sorted; a server reload) came after it.
// - A server edit is never credited to a person. A row only the server changed
//   is left to the server change that wrote it (inbound sync records its own
//   `local_hash`), and so is any row behind a server reload.
// - A row behind a person's structural edit, or changed with no edit on its
//   cells (a formula result, a note), is credited to the commit's last author.
//   OPEN: apps/api/OPEN_QUESTIONS.md R17.
// - A commit with no edit by a person needs no detection.
//
// Confirmed deletions (spec §9.2.7) travel on the op that removes the rows and
// are credited to that op's author.

import type { Env } from '../env'
import type { RoomCommitted, RoomEdit } from '../room/outbound-seam'
import { detectAfterSave } from './detect'
import type { RowAttribution, RowAuthor, RowLocation } from './detect'

export interface CommitAuthors {
  attribution: RowAttribution
  /** The last person to edit in the commit; null when only the server did. */
  lastUser: string | null
  /** uid → the person who confirmed its deletion (the latest confirmation wins). */
  deletionsBy: Map<string, string>
}

function touchesRow(edit: RoomEdit, location: RowLocation): boolean {
  return edit.footprint.cells.some((s) => s.sheet === location.sheet && s.r0 <= location.row && location.row <= s.r1)
}

/** Who changed what in one commit (pure). */
export function commitAuthors(edits: readonly RoomEdit[]): CommitAuthors {
  let lastUser: string | null = null
  const deletionsBy = new Map<string, string>()
  for (const edit of edits) {
    if (edit.origin !== 'user') continue
    lastUser = edit.userId
    for (const uid of edit.confirmedDeletions ?? []) deletionsBy.set(uid, edit.userId)
  }

  const fallback = (): RowAuthor => (lastUser === null ? { kind: 'server' } : { kind: 'fallback', userId: lastUser })

  const attribution: RowAttribution = {
    authorOf(location) {
      let serverTouched = false
      for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i]!
        if (edit.footprint.structural) {
          // Positions before this edit no longer match the committed rows.
          if (edit.origin === 'server') return { kind: 'server' }
          return fallback()
        }
        if (location === null || !touchesRow(edit, location)) continue
        if (edit.origin === 'user') return { kind: 'user', userId: edit.userId }
        serverTouched = true
      }
      if (serverTouched) return { kind: 'server' }
      return fallback()
    },
  }
  return { attribution, lastUser, deletionsBy }
}

/** The room's outbound seam: detection for one commit. Never throws (spec §9.2: sync problems are row states). */
export async function detectAfterRoomCommit(env: Env, event: RoomCommitted): Promise<void> {
  const authors = commitAuthors(event.edits)
  if (authors.lastUser === null) return
  await detectAfterSave(env, {
    workbookId: event.workbookId,
    actorUserId: authors.lastUser,
    snapshot: event.snapshot,
    version: event.version,
    attribution: authors.attribution,
    deletionsBy: authors.deletionsBy,
  })
}
