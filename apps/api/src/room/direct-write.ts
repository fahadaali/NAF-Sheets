// The server-change path for a workbook with no live room session: exactly
// the body `updateLatestSnapshot` had before phase 6 (moved here unchanged).
// The room runs it inside its own lock, so a session cannot start halfway
// through; `updateLatestSnapshot` runs it directly only when the Worker has
// no room binding.

import type { Env } from '../env'
import { DEFAULT_SNAPSHOT_ORPHAN_AGE_MS, readSnapshot, writeSnapshotVersion } from '../snapshot'
import type { SnapshotChange, UpdateOptions, UpdateOutcome } from '../sync/workbook-writer'

export async function directUpdate<T>(
  env: Env,
  workbookId: string,
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
