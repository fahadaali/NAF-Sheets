// The room's reads and commits of workbook snapshots. A commit follows the
// browser save (PUT /api/workbooks/:id/snapshot) exactly: write R2 version
// N+1 only if absent, then move D1 forward only from N.

import type { Env } from '../env'
import { snapshotKey, writeSnapshotVersion } from '../snapshot'

/** D1's committed version of a live (not archived) workbook, or null. */
export async function currentVersion(env: Env, workbookId: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT current_snapshot_version AS v FROM workbooks WHERE id = ?1 AND archived_at IS NULL')
    .bind(workbookId)
    .first<{ v: number }>()
  return row?.v ?? null
}

/** The committed snapshot `version`, with its size in characters, or null when absent or not a JSON object. */
export async function readSnapshotText(env: Env, workbookId: string, version: number): Promise<{ snapshot: Record<string, unknown>; chars: number } | null> {
  const object = await env.SNAPSHOTS.get(snapshotKey(workbookId, version))
  if (!object) return null
  const text = await object.text()
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return { snapshot: parsed as Record<string, unknown>, chars: text.length }
}

export type CommitResult =
  | { status: 'committed'; version: number; base: number }
  /** The workbook is gone or archived; nothing was written. */
  | { status: 'gone' }
  /** Another writer took the next version first; nothing was committed. Try again. */
  | { status: 'busy' }

/**
 * Commits `body` as the version after D1's current one. The room's state is
 * the newest state of an open workbook, so it is committed on top of
 * whatever D1 holds; `base` says which version that was (the caller compares
 * it with the version its state was built on to detect a foreign save).
 */
export async function commitOnTop(env: Env, workbookId: string, body: string, savedBy: string, orphanAgeMs: number): Promise<CommitResult> {
  const base = await currentVersion(env, workbookId)
  if (base === null) return { status: 'gone' }
  const next = base + 1
  const written = await writeSnapshotVersion(env, { workbookId, version: next, savedBy }, body, {
    orphanAgeMs,
    stillUncommitted: async () => (await currentVersion(env, workbookId)) === base,
  })
  if (!written) return { status: 'busy' }
  const moved = await env.DB.prepare(
    `UPDATE workbooks SET current_snapshot_version = ?1, updated_at = ?2
     WHERE id = ?3 AND current_snapshot_version = ?4 AND archived_at IS NULL`,
  )
    .bind(next, new Date().toISOString(), workbookId, base)
    .run()
  if (moved.meta.changes !== 1) return { status: 'busy' }
  return { status: 'committed', version: next, base }
}
