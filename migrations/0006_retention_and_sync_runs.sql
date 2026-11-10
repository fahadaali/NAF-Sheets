-- NAF Sheets — backup retention (owner decision 2026-11-10, B2) and the
-- reconciliation's run lease and continuation (L3). Forward-only.

-- ---------------------------------------------------------------------------
-- Backup retention (src/phase7/retention.ts, docs/backups.md §6)
-- ---------------------------------------------------------------------------
-- A backup run whose objects were removed from the BACKUPS bucket by the
-- retention policy. The row itself is never deleted: it stays as the record
-- of the run and of its removal (also written to audit_log, 'backup.prune').
ALTER TABLE backup_runs ADD COLUMN pruned_at TEXT;
-- How many BACKUPS objects of the run were removed.
ALTER TABLE backup_runs ADD COLUMN pruned_objects INTEGER;
-- The run whose successful completion removed them.
ALTER TABLE backup_runs ADD COLUMN pruned_by_run TEXT;

-- ---------------------------------------------------------------------------
-- Background jobs: one lease per job, and where an interrupted run resumes
-- ---------------------------------------------------------------------------
-- `reconciliation` (src/sync/inbound/reconcile.ts): a run holds the lease
-- while it works, so two runs never overlap (a cron firing while the last one
-- still runs, or «مزامنة الآن» for every workbook). A run that reaches its time
-- budget stops between lists and stores where it stopped in `cursor_json`;
-- the next run starts there.
CREATE TABLE sync_jobs (
  name         TEXT PRIMARY KEY,
  lease_id     TEXT,
  lease_until  TEXT,
  cursor_json  TEXT CHECK (cursor_json IS NULL OR json_valid(cursor_json)),
  started_at   TEXT,
  finished_at  TEXT,
  updated_at   TEXT NOT NULL
);
