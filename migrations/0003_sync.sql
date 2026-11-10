-- NAF Sheets — two-way Basecamp sync, wave 3 (spec §7.3, §8, §9, §14).
-- Forward-only: nothing in 0001 / 0002 is changed or dropped; every new
-- column is nullable or has a default, so existing rows stay valid.
-- Code: apps/api/src/sync/. Open points: apps/api/OPEN_QUESTIONS.md "Sync (wave 3)".
--
-- Nothing here is ever deleted in normal operation: replaced assignees carry
-- `removed_at`, conflicts carry `resolved_at`, deletions and webhooks carry a
-- state. Basecamp ids are INTEGER, platform ids TEXT, timestamps ISO 8601 UTC.

-- ---------------------------------------------------------------------------
-- workbooks
-- ---------------------------------------------------------------------------

-- The link wizard's commit (§7.3) creates things in Basecamp before it can
-- write the snapshot and D1, and nothing in Basecamp is ever deleted. A commit
-- interrupted half-way leaves 'linking' with the project (and lists) it
-- already created, and a second commit resumes from there instead of creating
-- them twice. 'linked': refused by the wizard. NULL: never linked.
ALTER TABLE workbooks ADD COLUMN link_state TEXT CHECK (link_state IS NULL OR link_state IN ('linking', 'linked'));
-- sheets.id of the «غير مصنّف» sheet (§9.3.11), once created.
ALTER TABLE workbooks ADD COLUMN unclassified_sheet_id TEXT;
-- Last time a sync step for this workbook succeeded (outbound write or inbound apply).
ALTER TABLE workbooks ADD COLUMN last_sync_success_at TEXT;

-- ---------------------------------------------------------------------------
-- sheets / column_mappings: what readTasks needs besides the columns
-- ---------------------------------------------------------------------------

-- `SheetPlan.assigneeMatches` (§7.3 step 7): cell text → Basecamp person id or null.
ALTER TABLE sheets ADD COLUMN assignee_matches_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(assignee_matches_json));
-- `SheetPlan.completedValues` (§7.3 step 6) as a JSON array of strings; the
-- singular `completed_value` of 0001 cannot hold several values.
ALTER TABLE column_mappings ADD COLUMN completed_values_json TEXT CHECK (completed_values_json IS NULL OR json_valid(completed_values_json));

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------

-- Fingerprint of the row as last read from the sheet, so a save that did not
-- touch a row does not move its `last_local_change_at` (last-writer-wins, §9.1).
ALTER TABLE tasks ADD COLUMN local_hash TEXT;
-- The person whose token the next outbound write uses (§3): the last editor.
ALTER TABLE tasks ADD COLUMN pending_actor_id TEXT REFERENCES members(user_id);
-- Machine code of `last_error` (the Arabic message), e.g. 'row_missing'.
ALTER TABLE tasks ADD COLUMN last_error_code TEXT;
-- Basecamp's counters at the last read (§9.4: a change triggers a fetch).
ALTER TABLE tasks ADD COLUMN bc_subtasks_count INTEGER;
ALTER TABLE tasks ADD COLUMN bc_subtasks_completed_count INTEGER;
-- A short lease: one sync step per task at a time, so two queue messages for
-- the same task never create it twice in Basecamp (§9.1 idempotency).
ALTER TABLE tasks ADD COLUMN sync_lease_id TEXT;
ALTER TABLE tasks ADD COLUMN sync_lease_until TEXT;
ALTER TABLE tasks ADD COLUMN last_synced_at TEXT;

CREATE INDEX idx_tasks_sync_state ON tasks(sync_state, last_local_change_at);

-- task_assignees: replaced, never deleted.
ALTER TABLE task_assignees ADD COLUMN removed_at TEXT;

-- ---------------------------------------------------------------------------
-- bc_webhooks: state seen by reconciliation (§9.3.3, §9.4 sync health)
-- ---------------------------------------------------------------------------

ALTER TABLE bc_webhooks ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
ALTER TABLE bc_webhooks ADD COLUMN checked_at TEXT;
-- Set when Basecamp no longer has the webhook (404) and a new one replaced it.
ALTER TABLE bc_webhooks ADD COLUMN replaced_at TEXT;

-- ---------------------------------------------------------------------------
-- Field conflicts (§9.1: logged, shown on the cell, the other value restorable)
-- ---------------------------------------------------------------------------

CREATE TABLE sync_conflicts (
  id                TEXT PRIMARY KEY,
  workbook_id       TEXT NOT NULL REFERENCES workbooks(id),
  sheet_id          TEXT NOT NULL REFERENCES sheets(id),
  task_uid          TEXT NOT NULL REFERENCES tasks(task_uid),
  field             TEXT NOT NULL CHECK (field IN ('title', 'assignees', 'dueOn', 'startsOn', 'completed', 'notesHtml', 'position', 'listId')),
  local_value_json  TEXT NOT NULL CHECK (json_valid(local_value_json)),
  remote_value_json TEXT NOT NULL CHECK (json_valid(remote_value_json)),
  winner            TEXT NOT NULL CHECK (winner IN ('local', 'remote')),
  local_changed_at  TEXT,
  remote_updated_at TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  resolved_at       TEXT,
  resolution        TEXT CHECK (resolution IS NULL OR resolution IN ('restored', 'dismissed')),
  resolved_by       TEXT REFERENCES members(user_id),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

CREATE INDEX idx_sync_conflicts_workbook ON sync_conflicts(workbook_id, resolved_at);
CREATE INDEX idx_sync_conflicts_task ON sync_conflicts(task_uid, resolved_at);

-- ---------------------------------------------------------------------------
-- Row deletions (§9.2.7, §16 scenarios 3 and 10)
-- ---------------------------------------------------------------------------

-- requested      the person removed the row and confirmed the dialog
-- executed       the to-do is in Basecamp's trash / the subtask was deleted
-- covered        a subtask that went to the trash with its to-do
-- undo_requested the row came back (Ctrl+Z): untrash or re-create
-- undone, cancelled  closed
-- `snapshot_json` is the full subtask as fetched right before its permanent
-- DELETE; it is also written to sync_log before the call.
CREATE TABLE task_deletions (
  id             TEXT PRIMARY KEY,
  task_uid       TEXT NOT NULL REFERENCES tasks(task_uid),
  workbook_id    TEXT NOT NULL REFERENCES workbooks(id),
  state          TEXT NOT NULL CHECK (state IN ('requested', 'executed', 'covered', 'undo_requested', 'undone', 'cancelled')),
  requested_by   TEXT NOT NULL REFERENCES members(user_id),
  requested_at   TEXT NOT NULL,
  covered_by_uid TEXT,
  action_json    TEXT CHECK (action_json IS NULL OR json_valid(action_json)),
  snapshot_json  TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
  executed_at    TEXT,
  undone_at      TEXT,
  updated_at     TEXT NOT NULL
);

-- At most one open deletion per task.
CREATE UNIQUE INDEX uq_task_deletions_open ON task_deletions(task_uid)
  WHERE state IN ('requested', 'executed', 'covered', 'undo_requested');
CREATE INDEX idx_task_deletions_workbook ON task_deletions(workbook_id, state);

-- ---------------------------------------------------------------------------
-- Dead letters (§9.2.8) and the account's sync state (§9.2.9)
-- ---------------------------------------------------------------------------

-- One row per message given up after its last attempt (also sent to the DLQ).
CREATE TABLE sync_dead_letters (
  id          TEXT PRIMARY KEY,
  queue       TEXT NOT NULL,
  workbook_id TEXT,
  task_uid    TEXT,
  attempts    INTEGER NOT NULL,
  error_code  TEXT NOT NULL,
  body_json   TEXT NOT NULL CHECK (json_valid(body_json)),
  created_at  TEXT NOT NULL,
  retried_at  TEXT
);

CREATE INDEX idx_sync_dead_letters_open ON sync_dead_letters(retried_at);

-- `Reason: Account Inactive` stops the whole account's sync until an admin resumes it.
CREATE TABLE sync_accounts (
  bc_account_id INTEGER PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  reason        TEXT,
  changed_at    TEXT NOT NULL
);
