// Backup retention (owner decision 2026-11-10, OPEN_QUESTIONS.md B2 decided):
// keep the newest `keepDaily` complete runs, plus the first complete run of
// each of the last `keepMonthly` calendar months; remove the files of every
// other, older run from the BACKUPS bucket. Both numbers are settings (KV
// `SETTINGS`, `settings:backup-retention`; defaults 30 and 12).
//
// The approval covers old backup runs in the BACKUPS bucket and nothing else.
// The rules that keep it so:
//   - pruning runs only at the end of a run that succeeded, after that run's
//     manifest is read back from the bucket;
//   - a run counts as a keeper only when it succeeded *and* its manifest is in
//     the bucket; a failed, running or manifest-less run is never a keeper;
//   - the only bucket touched is the one passed in (env.BACKUPS); every key
//     removed is checked to lie under `d1/{pruned run}/` or to be a snapshot
//     copy `snapshots/…` that no remaining run lists; anything else throws
//     before a single delete;
//   - a snapshot copy is shared by every run that found it already present,
//     so it is removed only when no remaining run lists it. Runs made before
//     the lists existed (legacy) have none: while one of them remains, no
//     snapshot copy is removed at all;
//   - D1 rows are never deleted: the run's row gets `pruned_at`, and every
//     removal is written to `audit_log` *before* the objects are removed;
//   - live data (D1 tables, SNAPSHOTS, ATTACHMENTS, KV) is never written,
//     except the run's `backup_runs` row and the audit entries.

import { BACKUP_RETENTION_DEFAULTS, BACKUP_RETENTION_LIMITS } from '@naf-sheets/shared'
import type { BackupPruneSummary, BackupRetention } from '@naf-sheets/shared'
import { auditStatement } from '../audit'
import type { Env } from '../env'

const SETTINGS_KEY = 'settings:backup-retention'
/** Per-run list of the snapshot copies the run relies on (written by runBackup). */
export const SNAPSHOT_LIST_FILE = 'snapshot-copies.ndjson'
/** A run still marked `running` this long before the newest one is dead (a cron invocation lasts minutes). */
const STALE_RUNNING_MS = 24 * 3600_000
const DELETE_CHUNK = 1000

export function isValidRetention(value: unknown): value is BackupRetention {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const inRange = (n: unknown, r: { min: number; max: number }) => typeof n === 'number' && Number.isInteger(n) && n >= r.min && n <= r.max
  return inRange(v.keepDaily, BACKUP_RETENTION_LIMITS.keepDaily) && inRange(v.keepMonthly, BACKUP_RETENTION_LIMITS.keepMonthly)
}

/** The policy in force; the defaults when none was saved or the saved value is unreadable. */
export async function backupRetention(kv: KVNamespace): Promise<BackupRetention> {
  try {
    const raw = await kv.get(SETTINGS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown
      if (isValidRetention(parsed)) return { keepDaily: parsed.keepDaily, keepMonthly: parsed.keepMonthly }
    }
  } catch {
    // Unreadable: the defaults apply.
  }
  return { ...BACKUP_RETENTION_DEFAULTS }
}

export async function saveBackupRetention(kv: KVNamespace, retention: BackupRetention): Promise<BackupRetention> {
  await kv.put(SETTINGS_KEY, JSON.stringify({ keepDaily: retention.keepDaily, keepMonthly: retention.keepMonthly }))
  return backupRetention(kv)
}

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

export interface RunFacts {
  id: string
  startedAt: string
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  /** Succeeded and its manifest is in the bucket. */
  complete: boolean
  prunedAt: string | null
}

export type KeepReason = 'newest' | 'daily' | 'monthly'

export interface RetentionPlan {
  keep: Map<string, KeepReason[]>
  /** Runs whose files are removed, oldest first. */
  prune: RunFacts[]
}

const newestFirst = (a: RunFacts, b: RunFacts) => (a.startedAt === b.startedAt ? (a.id < b.id ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1)

/** `YYYY-MM` of an ISO time, `back` months earlier. */
function monthOf(iso: string, back = 0): string {
  const d = new Date(iso)
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1))
  return m.toISOString().slice(0, 7)
}

/**
 * Which runs stay and which are removed, `newest` being the run that just
 * succeeded. Pure: the caller has checked every manifest.
 *
 * OPEN: "the last 30 daily runs" is read as the 30 newest complete runs (one
 * a day under the daily cron); calendar months are UTC (a run at 00:23 UTC is
 * the same date in Riyadh). See OPEN_QUESTIONS.md B6.
 */
export function planRetention(runs: readonly RunFacts[], newest: RunFacts, policy: BackupRetention): RetentionPlan {
  const keep = new Map<string, KeepReason[]>()
  const mark = (id: string, reason: KeepReason) => keep.set(id, [...(keep.get(id) ?? []), reason])
  mark(newest.id, 'newest')
  // A run that started after `newest` (clock skew) is neither counted nor touched.
  const complete = runs.filter((r) => r.complete && r.prunedAt === null && r.startedAt <= newest.startedAt).sort(newestFirst)
  for (const r of complete.slice(0, policy.keepDaily)) mark(r.id, 'daily')
  const months = new Set(Array.from({ length: policy.keepMonthly }, (_, i) => monthOf(newest.startedAt, i)))
  const firstOfMonth = new Map<string, RunFacts>()
  for (const r of [...complete].reverse()) {
    const m = monthOf(r.startedAt)
    if (months.has(m) && !firstOfMonth.has(m)) firstOfMonth.set(m, r)
  }
  for (const r of firstOfMonth.values()) mark(r.id, 'monthly')

  const staleBefore = new Date(Date.parse(newest.startedAt) - STALE_RUNNING_MS).toISOString()
  const prune = runs
    .filter((r) => {
      if (keep.has(r.id) || r.prunedAt !== null || r.id === newest.id) return false
      // Only runs older than the one that just succeeded.
      if (!(r.startedAt < newest.startedAt)) return false
      if (r.status === 'skipped') return false // wrote nothing
      if (r.status === 'running') return r.startedAt < staleBefore
      return true
    })
    .sort((a, b) => -newestFirst(a, b))
  return { keep, prune }
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

export interface PruneOutcome extends BackupPruneSummary {
  kept: Array<{ id: string; as: KeepReason[] }>
  removed: Array<{ id: string; objects: number }>
  /** `deleted`, or why no snapshot copy was removed. */
  snapshotCopies: 'deleted' | 'none' | 'kept_legacy_runs' | 'kept_running_run'
  error: string | null
}

/** Refuses any key outside what this prune may remove — before the first delete. */
function assertRemovable(keys: readonly string[], allowed: (key: string) => boolean): void {
  for (const key of keys) if (!allowed(key)) throw new Error('retention: refused to delete a key outside the pruned runs')
}

async function listPrefix(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
    keys.push(...page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return keys
}

async function removeKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_CHUNK) await bucket.delete(keys.slice(i, i + DELETE_CHUNK))
}

/** The snapshot copies a run listed; null when it has no list (a run made before lists existed). */
async function snapshotList(bucket: R2Bucket, runId: string): Promise<Set<string> | null> {
  const object = await bucket.get(`d1/${runId}/${SNAPSHOT_LIST_FILE}`)
  if (!object) return null
  const keys = new Set<string>()
  for (const line of (await object.text()).split('\n')) {
    if (!line) continue
    const parsed = JSON.parse(line) as { key?: unknown }
    if (typeof parsed.key === 'string') keys.add(parsed.key)
  }
  return keys
}

interface RunRow {
  id: string
  started_at: string
  status: RunFacts['status']
  pruned_at: string | null
}

/**
 * Applies the policy after run `newestId` succeeded. Never throws: a failure
 * stops pruning (what was removed is logged) and is reported in the outcome.
 */
export async function pruneBackups(env: Env, bucket: R2Bucket, newestId: string, at: string): Promise<PruneOutcome> {
  const db = env.DB
  const policy = await backupRetention(env.SETTINGS)
  const outcome: PruneOutcome = {
    at,
    byRunId: newestId,
    runsRemoved: 0,
    objectsRemoved: 0,
    snapshotCopiesRemoved: 0,
    runsKept: 0,
    message: null,
    kept: [],
    removed: [],
    snapshotCopies: 'none',
    error: null,
  }
  try {
    const { results } = await db.prepare(`SELECT id, started_at, status, pruned_at FROM backup_runs`).all<RunRow>()
    const newestRow = results.find((r) => r.id === newestId)
    // Only after the newest run succeeded and its manifest is really there.
    if (!newestRow || newestRow.status !== 'succeeded' || !(await bucket.head(`d1/${newestId}/manifest.json`))) {
      outcome.error = 'newest_incomplete'
      return outcome
    }
    const facts: RunFacts[] = []
    for (const r of results) {
      const complete = r.status === 'succeeded' && r.pruned_at === null && (r.id === newestId || (await bucket.head(`d1/${r.id}/manifest.json`)) !== null)
      facts.push({ id: r.id, startedAt: r.started_at, status: r.status, complete, prunedAt: r.pruned_at })
    }
    const newest = facts.find((f) => f.id === newestId) as RunFacts
    const plan = planRetention(facts, newest, policy)
    outcome.kept = [...plan.keep.entries()].map(([id, as]) => ({ id, as }))
    outcome.runsKept = plan.keep.size

    // Snapshot copies: read every list before anything is removed.
    const pruned = new Set(plan.prune.map((r) => r.id))
    const remaining = facts.filter((f) => !pruned.has(f.id) && f.prunedAt === null)
    let candidates = new Set<string>()
    for (const r of plan.prune) for (const key of (await snapshotList(bucket, r.id)) ?? []) candidates.add(key)
    const protectedKeys = new Set<string>()
    let legacy = false
    for (const r of remaining) {
      const list = await snapshotList(bucket, r.id)
      if (list === null) {
        // A complete run without a list may rely on any copy.
        if (r.complete) legacy = true
        continue
      }
      for (const key of list) protectedKeys.add(key)
    }
    const otherRunning = remaining.some((r) => r.status === 'running' && r.id !== newestId)
    if (legacy) {
      candidates = new Set()
      outcome.snapshotCopies = 'kept_legacy_runs'
    } else if (otherRunning) {
      candidates = new Set()
      outcome.snapshotCopies = 'kept_running_run'
    }
    const copies = [...candidates].filter((k) => !protectedKeys.has(k)).sort()

    for (const run of plan.prune) {
      const prefix = `d1/${run.id}/`
      const keys = await listPrefix(bucket, prefix)
      assertRemovable(keys, (k) => k.startsWith(prefix) && run.id.length > 0)
      // Logged before the removal: a removal is never unrecorded.
      await auditStatement(
        db,
        {
          actorId: null,
          action: 'backup.prune',
          entityType: 'backup_run',
          entityId: run.id,
          workbookId: null,
          details: { startedAt: run.startedAt, status: run.status, objects: keys.length, prefix, byRun: newestId, policy },
        },
        at,
      ).run()
      await removeKeys(bucket, keys)
      await db
        .prepare(`UPDATE backup_runs SET pruned_at = ?2, pruned_objects = ?3, pruned_by_run = ?4 WHERE id = ?1 AND pruned_at IS NULL`)
        .bind(run.id, at, keys.length, newestId)
        .run()
      outcome.removed.push({ id: run.id, objects: keys.length })
      outcome.runsRemoved += 1
      outcome.objectsRemoved += keys.length
    }

    if (copies.length > 0) {
      assertRemovable(copies, (k) => k.startsWith('snapshots/') && !protectedKeys.has(k))
      await auditStatement(
        db,
        {
          actorId: null,
          action: 'backup.prune.snapshot_copies',
          entityType: 'backup_bucket',
          entityId: 'snapshots',
          workbookId: null,
          details: { byRun: newestId, count: copies.length, keys: copies },
        },
        at,
      ).run()
      await removeKeys(bucket, copies)
      outcome.snapshotCopiesRemoved = copies.length
      outcome.snapshotCopies = 'deleted'
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.name : 'unknown'
    console.error(`backup retention after ${newestId} stopped (${outcome.error})`)
  }
  if (outcome.error !== null) outcome.message = PRUNE_STOPPED
  return outcome
}

const PRUNE_STOPPED =
  'توقف حذف النسخ الاحتياطية القديمة قبل أن يكتمل، ولم يُحذف إلا ما سُجّل في سجل التدقيق. سيُعاد تطبيق سياسة الاحتفاظ بعد النسخة الناجحة التالية؛ وإن تكرّر فراجع سجلات الخادم وفق docs/backups.md.'
