// Phase 7 contract (spec §15 phase 7): templates (§7.1), the internal API for
// the NAF ecosystem (§13), service tokens for it, and backups (§14).
// Every error body is `ApiError` (./api.ts).

import type { IsoDate, IsoDateTime, SyncState, TaskLevel } from './domain'

// ---------------------------------------------------------------------------
// Backups (§14), admin only
// ---------------------------------------------------------------------------

export interface BackupRunSummary {
  id: string
  startedAt: IsoDateTime
  finishedAt: IsoDateTime | null
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  tables: number
  rows: number
  snapshots: number
  /** Arabic, for the admin; null when the run succeeded. */
  message: string | null
  /** When the retention policy removed this run's files from the backups bucket (its record stays). */
  prunedAt: IsoDateTime | null
}

/**
 * Backup retention (owner decision 2026-11-10): the newest `keepDaily`
 * complete runs, plus the first complete run of each of the last
 * `keepMonthly` calendar months. Older runs' files are removed from the
 * backups bucket only, after a run succeeded; nothing else is ever deleted.
 */
export interface BackupRetention {
  /** 1–365. */
  keepDaily: number
  /** 0–120. */
  keepMonthly: number
}

export const BACKUP_RETENTION_DEFAULTS: BackupRetention = { keepDaily: 30, keepMonthly: 12 }
export const BACKUP_RETENTION_LIMITS = { keepDaily: { min: 1, max: 365 }, keepMonthly: { min: 0, max: 120 } } as const

/** What the latest pruning removed (after the run `byRunId` succeeded). */
export interface BackupPruneSummary {
  at: IsoDateTime
  byRunId: string
  runsRemoved: number
  objectsRemoved: number
  snapshotCopiesRemoved: number
  /** Complete runs kept after it. */
  runsKept: number
  /** Arabic, for the admin, when pruning stopped short (nothing unsafe was removed); null otherwise. */
  message: string | null
}

/** GET /api/admin/backups — the latest runs, newest first. */
export interface BackupRunsResponse {
  /** False when the Worker has no BACKUPS bucket bound: no backup runs at all. */
  configured: boolean
  runs: BackupRunSummary[]
  retention: BackupRetention
  /** Null until a successful run has applied the policy. */
  lastPrune: BackupPruneSummary | null
}
export interface BackupRetentionResponse {
  retention: BackupRetention
}
