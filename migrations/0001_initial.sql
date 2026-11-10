-- NAF Sheets — initial D1 schema (spec docs/spec.md §6.2, §14).
-- Migrations are forward-only: never edit this file once applied; add 0002_… instead.
--
-- ═══ PROPOSED DECISION — awaiting the owner's confirmation ═══
-- The spec's `users(id, naf_id_sub, name, email, role, created_at)` table is
-- replaced by naf-auth's `members` table, so identity has one source:
--   * `members.user_id` IS the `sub` issued by naf-id (no separate local id);
--   * naf-auth creates the row on first sign-in with role 'viewer' and later
--     updates only display_name / email / last_seen_at — never role or is_active;
--   * the platform roles admin / editor / viewer (spec §3) live in `members.role`;
--   * every `*_id` / `created_by` / `requested_by` / `resolved_by` column that
--     points at a person of this platform references `members(user_id)`.
-- Shape copied from node_modules/naf-auth/migrations/members.sql (v3.4.0).
-- If the owner rejects this, a follow-up migration must introduce `users` and
-- re-point the foreign keys; nothing else in the schema depends on the choice.
-- (apps/api/OPEN_QUESTIONS.md #1)
--
-- Conventions
--   * Ids of platform records are TEXT UUIDs; Basecamp ids are INTEGER.
--   * Platform timestamps are TEXT, ISO 8601 UTC with milliseconds
--     (`2026-11-10T08:00:00.000Z`, from Date#toISOString). `members` keeps
--     naf-auth's epoch seconds (MEMBERS_TIME_FORMAT = epoch, the default).
--   * Booleans are INTEGER 0/1 with a CHECK.
--   * Nothing is deleted in normal operation: rows carry archived_at /
--     trashed_at / removed_at instead, and foreign keys use the default
--     NO ACTION so a stray DELETE of a referenced row fails loudly.
--   * D1 enforces foreign keys.

-- ---------------------------------------------------------------------------
-- Identity (naf-auth)
-- ---------------------------------------------------------------------------

CREATE TABLE members (
  user_id      TEXT PRIMARY KEY,                       -- `sub` from naf-id
  display_name TEXT,
  email        TEXT,
  -- Platform role (spec §3). naf-auth itself puts no CHECK here on purpose
  -- (role vocabularies are per platform); this platform's vocabulary is fixed.
  role         TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
  perms        TEXT CHECK (perms IS NULL OR json_valid(perms)),   -- JSON, unused in phase 1
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_seen_at INTEGER,                                -- epoch seconds
  created_at   INTEGER NOT NULL                        -- epoch seconds
);

CREATE INDEX idx_members_email ON members(email);

-- ---------------------------------------------------------------------------
-- Workbooks, membership, sheets (spec §6.1–6.2, §7.1)
-- ---------------------------------------------------------------------------

CREATE TABLE workbooks (
  id                       TEXT PRIMARY KEY,
  title                    TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 200),
  owner_id                 TEXT NOT NULL REFERENCES members(user_id),
  bc_project_id            INTEGER,                    -- NULL until linked (§7.3 step 1)
  source                   TEXT NOT NULL CHECK (source IN ('blank', 'template', 'gsheets')),
  source_ref               TEXT,                       -- template id / Google spreadsheet id
  -- Version of the latest snapshot in R2 at workbooks/{id}/snapshots/{version}.json.
  -- Only ever moved forward by a conditional UPDATE (optimistic concurrency).
  current_snapshot_version INTEGER NOT NULL CHECK (current_snapshot_version >= 1),
  -- §9.3.9: what to do when a to-do list is created in the linked project.
  new_list_behavior        TEXT NOT NULL DEFAULT 'create_sheet' CHECK (new_list_behavior IN ('create_sheet', 'ignore')),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  archived_at              TEXT
);

CREATE INDEX idx_workbooks_owner ON workbooks(owner_id);
CREATE INDEX idx_workbooks_updated ON workbooks(updated_at);
-- One live workbook per Basecamp project: webhooks and reconciliation resolve
-- the workbook from the project id, so two would make sync ambiguous.
CREATE UNIQUE INDEX uq_workbooks_bc_project ON workbooks(bc_project_id)
  WHERE bc_project_id IS NOT NULL AND archived_at IS NULL;

-- The owner is workbooks.owner_id and is never listed here.
CREATE TABLE workbook_members (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id),
  user_id     TEXT NOT NULL REFERENCES members(user_id),
  role        TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  added_by    TEXT NOT NULL REFERENCES members(user_id),
  added_at    TEXT NOT NULL,
  PRIMARY KEY (workbook_id, user_id)
);

-- "Workbooks this user is a member of" (GET /api/workbooks).
CREATE INDEX idx_workbook_members_user ON workbook_members(user_id);

CREATE TABLE sheets (
  id                                  TEXT PRIMARY KEY,
  workbook_id                         TEXT NOT NULL REFERENCES workbooks(id),
  univer_sheet_id                     TEXT NOT NULL,   -- key in IWorkbookData.sheets
  title                               TEXT NOT NULL CHECK (length(trim(title)) > 0),
  position                            INTEGER NOT NULL CHECK (position >= 1),   -- 1-based tab order
  sync_mode                           TEXT NOT NULL DEFAULT 'local' CHECK (sync_mode IN ('synced', 'local')),
  bc_todolist_id                      INTEGER,
  header_row                          INTEGER NOT NULL DEFAULT 1 CHECK (header_row >= 1),
  -- §8.1: automatic assignment of a to-do from its subtasks (on by default),
  -- and whether assignees of completed subtasks are excluded (off by default).
  auto_assign_parents                 INTEGER NOT NULL DEFAULT 1 CHECK (auto_assign_parents IN (0, 1)),
  exclude_completed_subtask_assignees INTEGER NOT NULL DEFAULT 0 CHECK (exclude_completed_subtask_assignees IN (0, 1)),
  created_at                          TEXT NOT NULL,
  -- A local sheet is never linked to a list.
  CHECK (sync_mode = 'synced' OR bc_todolist_id IS NULL)
);

CREATE INDEX idx_sheets_workbook ON sheets(workbook_id, position);
CREATE UNIQUE INDEX uq_sheets_univer_id ON sheets(workbook_id, univer_sheet_id);
-- A to-do list feeds exactly one sheet.
CREATE UNIQUE INDEX uq_sheets_bc_todolist ON sheets(bc_todolist_id) WHERE bc_todolist_id IS NOT NULL;

CREATE TABLE column_mappings (
  sheet_id            TEXT NOT NULL REFERENCES sheets(id),
  column_key          TEXT NOT NULL,
  field               TEXT NOT NULL CHECK (field IN ('title', 'assignees', 'due_on', 'starts_on', 'completed', 'notes', 'attachments', 'free')),
  -- Free columns only: append "header: value" to the to-do description (§7.3 step 4).
  free_to_description INTEGER NOT NULL DEFAULT 0 CHECK (free_to_description IN (0, 1)),
  -- Status column only: the cell value that means "completed" when the column is text (§7.3 step 6).
  completed_value     TEXT,
  PRIMARY KEY (sheet_id, column_key),
  CHECK (field = 'free' OR free_to_description = 0),
  CHECK (field = 'completed' OR completed_value IS NULL)
);

-- Each Basecamp field is fed by at most one column of a sheet.
CREATE UNIQUE INDEX uq_column_mappings_field ON column_mappings(sheet_id, field) WHERE field <> 'free';

-- ---------------------------------------------------------------------------
-- Tasks and their sync state (spec §6.1, §8, §9)
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  task_uid              TEXT PRIMARY KEY,              -- the hidden __uid column (§6.1)
  sheet_id              TEXT NOT NULL REFERENCES sheets(id),
  parent_uid            TEXT REFERENCES tasks(task_uid),
  level                 INTEGER NOT NULL CHECK (level IN (0, 1)),
  bc_recording_id       INTEGER,
  bc_type               TEXT CHECK (bc_type IN ('todo', 'subtask')),
  assign_mode           TEXT NOT NULL DEFAULT 'auto' CHECK (assign_mode IN ('auto', 'manual')),   -- level 0 only (§8.1)
  -- Denormalised from the sheet so the workbook list can show completion
  -- (§12.1) without reading snapshots. The snapshot stays the source of truth.
  completed             INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  last_synced_hash      TEXT,
  -- JSON of @naf-sheets/shared `SyncedBase`: the 3-way diff base (§9.1).
  last_synced_base_json TEXT CHECK (last_synced_base_json IS NULL OR json_valid(last_synced_base_json)),
  last_local_change_at  TEXT,
  last_remote_change_at TEXT,
  sync_state            TEXT NOT NULL DEFAULT 'unlinked' CHECK (sync_state IN ('synced', 'pending', 'error', 'conflict', 'unlinked')),
  last_error            TEXT,
  -- §9.3.10: archived / trashed / deleted in Basecamp; the row stays until a user removes it.
  remote_status         TEXT NOT NULL DEFAULT 'active' CHECK (remote_status IN ('active', 'archived', 'trashed', 'deleted')),
  trashed_at            TEXT,
  created_at            TEXT NOT NULL,
  -- Basecamp 5 has exactly one level of subtasks (§8).
  CHECK ((level = 0 AND parent_uid IS NULL) OR (level = 1 AND parent_uid IS NOT NULL)),
  -- A main row is a to-do, an indented row a subtask.
  CHECK (bc_type IS NULL OR (level = 0 AND bc_type = 'todo') OR (level = 1 AND bc_type = 'subtask')),
  CHECK ((bc_recording_id IS NULL) = (bc_type IS NULL))
);

CREATE INDEX idx_tasks_sheet ON tasks(sheet_id, level, sync_state);
CREATE INDEX idx_tasks_parent ON tasks(parent_uid) WHERE parent_uid IS NOT NULL;
-- Idempotent creation (§9.1): one row per Basecamp recording; also the webhook lookup.
CREATE UNIQUE INDEX uq_tasks_bc_recording ON tasks(bc_recording_id) WHERE bc_recording_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- People: Basecamp caches and external contacts (spec §8.2, §9.5)
-- ---------------------------------------------------------------------------

CREATE TABLE bc_people_cache (
  bc_project_id INTEGER NOT NULL,
  bc_person_id  INTEGER NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  avatar_url    TEXT,
  refreshed_at  TEXT NOT NULL,
  PRIMARY KEY (bc_project_id, bc_person_id)
);

CREATE INDEX idx_bc_people_cache_email ON bc_people_cache(email);

-- Everyone in the Basecamp account (case 1 of §8.2).
CREATE TABLE bc_account_people_cache (
  bc_person_id    INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT,
  avatar_url      TEXT,
  personable_type TEXT,
  client          INTEGER NOT NULL DEFAULT 0 CHECK (client IN (0, 1)),
  refreshed_at    TEXT NOT NULL
);

CREATE INDEX idx_bc_account_people_cache_email ON bc_account_people_cache(email);

CREATE TABLE external_contacts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  organization TEXT,
  email        TEXT,
  phone        TEXT,
  note         TEXT,
  created_by   TEXT NOT NULL REFERENCES members(user_id),
  created_at   TEXT NOT NULL,
  archived_at  TEXT
);

CREATE INDEX idx_external_contacts_name ON external_contacts(name);

-- The single source of a task's assignees (§8.1, §8.2).
-- The spec writes PRIMARY KEY (task_uid, kind, bc_person_id, external_contact_id),
-- but one of the two ids is always NULL and SQLite treats NULLs as distinct in a
-- key, so uniqueness is enforced by the expression index below instead.
CREATE TABLE task_assignees (
  task_uid            TEXT NOT NULL REFERENCES tasks(task_uid),
  kind                TEXT NOT NULL CHECK (kind IN ('bc_person', 'external', 'follower')),
  bc_person_id        INTEGER,
  external_contact_id TEXT REFERENCES external_contacts(id),
  source              TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  notify_email        INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0, 1)),
  CHECK (
    (kind IN ('bc_person', 'follower') AND bc_person_id IS NOT NULL AND external_contact_id IS NULL)
    OR (kind = 'external' AND external_contact_id IS NOT NULL AND bc_person_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_task_assignees ON task_assignees(task_uid, kind, IFNULL(bc_person_id, -1), IFNULL(external_contact_id, ''));
CREATE INDEX idx_task_assignees_person ON task_assignees(bc_person_id) WHERE bc_person_id IS NOT NULL;
CREATE INDEX idx_task_assignees_external ON task_assignees(external_contact_id) WHERE external_contact_id IS NOT NULL;

CREATE TABLE email_notifications (
  id                  TEXT PRIMARY KEY,
  task_uid            TEXT NOT NULL REFERENCES tasks(task_uid),
  external_contact_id TEXT NOT NULL REFERENCES external_contacts(id),
  type                TEXT NOT NULL CHECK (type IN ('assigned', 'reminder', 'overdue')),
  sent_at             TEXT,
  provider_message_id TEXT,
  -- OPEN: the status vocabulary depends on the email provider (spec §17-7; apps/api/OPEN_QUESTIONS.md #14).
  status              TEXT NOT NULL,
  error               TEXT
);

CREATE INDEX idx_email_notifications_task ON email_notifications(task_uid);
CREATE INDEX idx_email_notifications_contact ON email_notifications(external_contact_id);

-- Requests to add a person to the Basecamp project when the user lacks the
-- right to do it (§8.2 case 1).
CREATE TABLE access_requests (
  id           TEXT PRIMARY KEY,
  workbook_id  TEXT NOT NULL REFERENCES workbooks(id),
  requested_by TEXT NOT NULL REFERENCES members(user_id),
  bc_person_id INTEGER NOT NULL,
  -- OPEN: vocabulary proposed here, not given by the spec (apps/api/OPEN_QUESTIONS.md #14).
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TEXT NOT NULL,
  resolved_by  TEXT REFERENCES members(user_id),
  resolved_at  TEXT,
  CHECK (status = 'pending' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE INDEX idx_access_requests_workbook ON access_requests(workbook_id, status);

-- ---------------------------------------------------------------------------
-- Attachments (spec §10)
-- ---------------------------------------------------------------------------

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  task_uid    TEXT NOT NULL REFERENCES tasks(task_uid),
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL CHECK (length(filename) > 0),
  size        INTEGER NOT NULL CHECK (size >= 0),
  mime        TEXT,
  bc_sgid     TEXT,
  bc_blob_url TEXT,
  origin      TEXT NOT NULL CHECK (origin IN ('local', 'basecamp')),
  -- NULL only for files that came from Basecamp (their uploader may not be a member here).
  created_by  TEXT REFERENCES members(user_id),
  created_at  TEXT NOT NULL,
  -- Chip removed by a user; the R2 copy is kept 30 days (§10).
  removed_at  TEXT,
  CHECK (origin = 'basecamp' OR created_by IS NOT NULL)
);

CREATE INDEX idx_attachments_task ON attachments(task_uid);

-- ---------------------------------------------------------------------------
-- Sync log and import reports (spec §7.2, §9)
-- ---------------------------------------------------------------------------

CREATE TABLE sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uid    TEXT REFERENCES tasks(task_uid),
  workbook_id TEXT NOT NULL REFERENCES workbooks(id),
  direction   TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  action      TEXT NOT NULL,
  field       TEXT,
  old_value   TEXT,
  new_value   TEXT,
  -- members.user_id, or a system actor such as the automatic rule of §8.1.
  actor       TEXT NOT NULL,
  -- OPEN: vocabulary to be fixed with the sync engine (phase 3/4; apps/api/OPEN_QUESTIONS.md #14).
  status      TEXT NOT NULL,
  error       TEXT,
  at          TEXT NOT NULL
);

CREATE INDEX idx_sync_log_workbook ON sync_log(workbook_id, at);
CREATE INDEX idx_sync_log_task ON sync_log(task_uid, at) WHERE task_uid IS NOT NULL;

CREATE TABLE import_reports (
  id           TEXT PRIMARY KEY,
  workbook_id  TEXT NOT NULL REFERENCES workbooks(id),
  gsheet_id    TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_import_reports_workbook ON import_reports(workbook_id);

-- ---------------------------------------------------------------------------
-- Integrations and Basecamp links (spec §3, §9.3, §14)
-- Tokens are AES-GCM ciphertext; the key lives in Worker secrets only.
-- ---------------------------------------------------------------------------

CREATE TABLE integrations (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL CHECK (provider IN ('basecamp', 'google')),
  account_id       TEXT NOT NULL,
  encrypted_tokens TEXT NOT NULL,
  expires_at       TEXT,
  created_by       TEXT NOT NULL REFERENCES members(user_id),
  created_at       TEXT NOT NULL,
  UNIQUE (provider, account_id)
);

-- Each user's own Basecamp token, so their edits appear under their name (§3).
CREATE TABLE user_basecamp_links (
  user_id          TEXT PRIMARY KEY REFERENCES members(user_id),
  bc_person_id     INTEGER NOT NULL,
  bc_account_id    INTEGER NOT NULL,
  encrypted_tokens TEXT NOT NULL,
  expires_at       TEXT,
  linked_at        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked'))
);

-- One Basecamp person is linked to at most one platform member at a time.
CREATE UNIQUE INDEX uq_user_basecamp_links_person ON user_basecamp_links(bc_account_id, bc_person_id)
  WHERE status = 'active';

-- Webhooks registered on linked projects (§9.3.1–2). The secret is the last
-- path segment of /webhooks/basecamp/:secret; it is how a delivery is matched.
CREATE TABLE bc_webhooks (
  bc_webhook_id INTEGER PRIMARY KEY,
  bc_project_id INTEGER NOT NULL,
  secret        TEXT NOT NULL UNIQUE CHECK (length(secret) >= 32),
  types_json    TEXT NOT NULL CHECK (json_valid(types_json)),
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_bc_webhooks_project ON bc_webhooks(bc_project_id);

-- ---------------------------------------------------------------------------
-- Audit log (spec §14): append-only record of deletions, linking and
-- permission changes. No foreign keys on purpose — an audit row must never
-- block, or be blocked by, anything that happens to the rows it describes.
-- `action` has no CHECK: the vocabulary grows phase by phase and SQLite cannot
-- alter a CHECK without rebuilding the table. Names are dotted, e.g.
-- 'workbook.create', 'workbook.members.replace'.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor_id     TEXT,                                   -- members.user_id; NULL = system
  action       TEXT NOT NULL CHECK (length(action) > 0),
  entity_type  TEXT NOT NULL CHECK (length(entity_type) > 0),
  entity_id    TEXT NOT NULL,
  workbook_id  TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id, at);
CREATE INDEX idx_audit_log_workbook ON audit_log(workbook_id, at) WHERE workbook_id IS NOT NULL;
CREATE INDEX idx_audit_log_actor ON audit_log(actor_id, at) WHERE actor_id IS NOT NULL;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
