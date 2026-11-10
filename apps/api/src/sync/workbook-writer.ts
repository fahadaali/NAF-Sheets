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
// Phase 6 seam: once the WorkbookRoom holds the live state of an open
// workbook, a server change must reach the open editors instead of making
// their next save fail with 409. The room work replaces the body of
// `updateLatestSnapshot` (same signature) to run `change` inside the room
// when a session is active; callers do not change.

import type { Env } from '../env'
import { DEFAULT_SNAPSHOT_ORPHAN_AGE_MS, readSnapshot, writeSnapshotVersion } from '../snapshot'

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
  const attempts = options.attempts ?? 3
  const db = env.DB
  const currentVersion = async (): Promise<number | null> =>
    (await db.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1 AND archived_at IS NULL').bind(workbookId).first<{ v: number }>())?.v ?? null

  for (let attempt = 0; attempt < attempts; attempt++) {
    const base = await currentVersion()
    if (base === null) return { status: 'not_found' }
    const snapshot = await readSnapshot(env, workbookId, base)
    if (snapshot === null) return { status: 'not_found' }

    const outcome = await change(snapshot, base)
    if (outcome.snapshot === null) return { status: 'unchanged', version: base, result: outcome.result }

    const next = base + 1
    const written = await writeSnapshotVersion(env, { workbookId, version: next, savedBy }, JSON.stringify(outcome.snapshot), {
      orphanAgeMs: options.orphanAgeMs ?? DEFAULT_SNAPSHOT_ORPHAN_AGE_MS,
      stillUncommitted: async () => (await currentVersion()) === base,
    })
    if (!written) continue

    const moved = await db
      .prepare(
        `UPDATE workbooks SET current_snapshot_version = ?1, updated_at = ?2
         WHERE id = ?3 AND current_snapshot_version = ?4 AND archived_at IS NULL`,
      )
      .bind(next, new Date().toISOString(), workbookId, base)
      .run()
    if (moved.meta.changes === 1) return { status: 'written', version: next, result: outcome.result }
    // Another writer moved D1 between our R2 write and this UPDATE: our object
    // at `next` is now an orphan that the next save may replace; start over.
  }
  return { status: 'contended' }
}
