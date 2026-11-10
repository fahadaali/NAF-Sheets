// Server-side writes to a workbook's snapshot (link wizard, inbound sync,
// conflict restore). The one way the API changes a workbook it did not
// receive from a browser.
//
// `change` is a pure function of the latest snapshot (e.g. sheet-model's
// `applyInbound` or `ensureSystemColumns`). It is re-run on a fresh read when
// a browser save or another server write wins the race, so it must not have
// side effects. Commit follows PUT /api/workbooks/:id/snapshot exactly: write
// R2 version N+1 only if absent, then move D1 forward only from N.
//
// Phase 6: every call goes through the workbook's room (src/room.ts), which
// runs it inside its own lock. With editors connected, `change` runs on the
// room's live state, is committed, and reaches the open editors as an op (or
// a reload when rows, sheets or plugin data changed) instead of making their
// next save fail. With nobody connected, the room runs the pre-phase-6 path
// (src/room/direct-write.ts) unchanged. Callers do not change.
//
// `change` always runs here, in the caller's isolate (the room calls it back
// over RPC), so its result and any error it throws reach the caller as they
// are. Never call this from inside the room: it would wait on itself.

import type { Env } from '../env'
import { directUpdate } from '../room/direct-write'
import type { RemoteChange } from '../room'
import { DEFAULT_SNAPSHOT_ORPHAN_AGE_MS } from '../snapshot'

export interface SnapshotChange<T> {
  /** The new snapshot, or null to write nothing (e.g. every action was refused). */
  snapshot: unknown | null
  result: T
}

export type UpdateOutcome<T> =
  | { status: 'written'; version: number; result: T }
  | { status: 'unchanged'; version: number; result: T }
  | { status: 'not_found' }
  /** Lost the race `attempts` times in a row; nothing was written. */
  | { status: 'contended' }

export interface UpdateOptions {
  /** Default 3. */
  attempts?: number
  orphanAgeMs?: number
}

export async function updateLatestSnapshot<T>(
  env: Env,
  workbookId: string,
  /** members.user_id recorded as the snapshot's author; a system write names the acting user or 'system'. */
  savedBy: string,
  change: (snapshot: unknown, version: number) => SnapshotChange<T> | Promise<SnapshotChange<T>>,
  options: UpdateOptions = {},
): Promise<UpdateOutcome<T>> {
  // A Worker without the room binding (none in this repository) keeps the direct path.
  if (!env.WORKBOOK_ROOM) return directUpdate(env, workbookId, savedBy, change, options)

  let last: { result: T } | null = null
  let thrown: { error: unknown } | null = null
  const remote: RemoteChange = async (snapshot, version) => {
    try {
      const out = await change(snapshot, version)
      last = { result: out.result }
      return { ok: true, snapshot: out.snapshot }
    } catch (error) {
      thrown = { error }
      return { ok: false }
    }
  }

  const room = env.WORKBOOK_ROOM.get(env.WORKBOOK_ROOM.idFromName(workbookId))
  const outcome = await room.serverChange(
    { workbookId, savedBy, attempts: options.attempts ?? 3, orphanAgeMs: options.orphanAgeMs ?? DEFAULT_SNAPSHOT_ORPHAN_AGE_MS },
    remote,
  )
  if (thrown !== null) throw (thrown as { error: unknown }).error
  switch (outcome.status) {
    case 'written':
    case 'unchanged': {
      if (last === null) throw new Error(`updateLatestSnapshot: room answered ${outcome.status} without running the change`)
      return { status: outcome.status, version: outcome.version, result: (last as { result: T }).result }
    }
    case 'not_found':
      return { status: 'not_found' }
    case 'contended':
      return { status: 'contended' }
    case 'change_failed':
      throw new Error('updateLatestSnapshot: the change failed in the room')
  }
}
