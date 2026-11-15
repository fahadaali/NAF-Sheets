-- NAF Sheets — the station (docs/station-plan.md §2, §6.1, §6.2, §7).
-- Forward-only: the workbook-editor tables stay until the old code is removed.
--
-- A link joins one Google spreadsheet to one Basecamp project; each linked
-- tab is one to-do list. Every synced task keeps its last synced base here
-- (the sheet holds only its uid, as row developer metadata).

CREATE TABLE station_links (
  id               TEXT PRIMARY KEY,
  spreadsheet_id   TEXT NOT NULL,
  title            TEXT NOT NULL,
  bc_project_id    INTEGER NOT NULL,
  bc_todoset_id    INTEGER NOT NULL,
  -- Tab holding the job titles and names (§6.1); «المسميات» by default.
  roles_tab        TEXT NOT NULL DEFAULT 'المسميات',
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  -- Secret path segment of the Drive notification address (/webhooks/google/:secret).
  notify_secret    TEXT NOT NULL UNIQUE,
  -- Drive `modifiedTime` last synced; the minute check compares with it.
  last_modified    TEXT,
  last_sync_at     TEXT,
  last_error       TEXT,
  -- A sync runs alone per link: lease until this time (ISO); `resync` asks the holder to run again.
  lock_until       TEXT,
  resync           INTEGER NOT NULL DEFAULT 0 CHECK (resync IN (0, 1)),
  created_by       TEXT NOT NULL REFERENCES members(user_id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_station_links_project ON station_links(bc_project_id);

CREATE TABLE station_tabs (
  link_id          TEXT NOT NULL REFERENCES station_links(id) ON DELETE CASCADE,
  -- Google's numeric sheetId (stable across renames).
  google_sheet_id  INTEGER NOT NULL,
  title            TEXT NOT NULL,
  bc_todolist_id   INTEGER,
  PRIMARY KEY (link_id, google_sheet_id)
);
-- One list is fed by one tab only (§2).
CREATE UNIQUE INDEX idx_station_tabs_list ON station_tabs(bc_todolist_id) WHERE bc_todolist_id IS NOT NULL;

CREATE TABLE station_tasks (
  uid              TEXT PRIMARY KEY,
  link_id          TEXT NOT NULL REFERENCES station_links(id) ON DELETE CASCADE,
  google_sheet_id  INTEGER NOT NULL,
  level            INTEGER NOT NULL CHECK (level IN (0, 1)),
  parent_uid       TEXT,
  bc_id            INTEGER,
  -- SyncedBase JSON (packages/shared), NULL until the first successful sync.
  base_json        TEXT CHECK (base_json IS NULL OR json_valid(base_json)),
  -- To-do: counts last seen in the list read, to know when to read its subtasks.
  subtasks_count   INTEGER,
  subtasks_done    INTEGER,
  deleted_remotely INTEGER NOT NULL DEFAULT 0 CHECK (deleted_remotely IN (0, 1)),
  -- 0: a subtask created in Basecamp whose people match no title in the roles
  -- tab; its «القسم» is empty and Basecamp's people are kept until a title is
  -- chosen in the sheet (decision 2-أ never clears people by omission).
  assign_from_sheet INTEGER NOT NULL DEFAULT 1 CHECK (assign_from_sheet IN (0, 1)),
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_station_tasks_link ON station_tasks(link_id, google_sheet_id);
CREATE UNIQUE INDEX idx_station_tasks_bc ON station_tasks(bc_id) WHERE bc_id IS NOT NULL;

-- Subtasks deleted from Basecamp because their row left the sheet: Basecamp
-- deletes subtasks for good, so the full record is kept here first (§4.4).
CREATE TABLE station_deleted (
  uid              TEXT NOT NULL,
  link_id          TEXT NOT NULL,
  bc_type          TEXT NOT NULL,
  bc_id            INTEGER NOT NULL,
  snapshot_json    TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  deleted_at       TEXT NOT NULL
);

-- One person's name as written in a roles tab → Basecamp person, for every link (§6.1).
CREATE TABLE station_names (
  name             TEXT PRIMARY KEY,
  bc_person_id     INTEGER NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  updated_by       TEXT,
  updated_at       TEXT NOT NULL
);

-- Open problems that stop rows from syncing, and whether the admin was emailed (§6.2).
CREATE TABLE station_alerts (
  key              TEXT PRIMARY KEY,
  link_id          TEXT,
  alert_json       TEXT NOT NULL CHECK (json_valid(alert_json)),
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  emailed_at       TEXT,
  resolved_at      TEXT
);
CREATE INDEX idx_station_alerts_open ON station_alerts(resolved_at, emailed_at);

-- Drive push channels, renewed before they expire (Google caps a file channel at one day).
CREATE TABLE station_channels (
  link_id          TEXT PRIMARY KEY REFERENCES station_links(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL,
  resource_id      TEXT NOT NULL,
  expires_at       TEXT NOT NULL
);

-- Sync history per link, for the link screen (§6).
CREATE TABLE station_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id          TEXT NOT NULL,
  at               TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('to_basecamp', 'to_sheet', 'none')),
  action           TEXT NOT NULL,
  task_uid         TEXT,
  detail_json      TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
);
CREATE INDEX idx_station_log_link ON station_log(link_id, at);
