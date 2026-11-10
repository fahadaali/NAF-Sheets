-- NAF Sheets — phase 7: templates, the internal API's service tokens, backups
-- (spec §7.1, §13, §14, §15 phase 7). Forward-only, like every migration.

-- ---------------------------------------------------------------------------
-- Templates (§7.1 option 2: «قوالب يحفظها admin — أي ملف يُحوَّل إلى قالب»)
-- ---------------------------------------------------------------------------
-- A template is a frozen copy of a workbook's snapshot at the moment an admin
-- turned it into a template, cleaned of every tie to Basecamp (system columns,
-- platform marks): R2 `templates/{id}/snapshot.json`. Later edits to the
-- source workbook do not change the template (OPEN: apps/api/OPEN_QUESTIONS.md T1).
-- Nothing is ever deleted: an admin archives a template (archived_at).
CREATE TABLE templates (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 200),
  description        TEXT CHECK (description IS NULL OR length(description) <= 500),
  -- The workbook it was made from; kept for the record even if that workbook is archived.
  source_workbook_id TEXT REFERENCES workbooks(id),
  -- Which version of the source workbook's snapshot was copied.
  source_version     INTEGER,
  r2_key             TEXT NOT NULL UNIQUE,
  sheet_count        INTEGER NOT NULL CHECK (sheet_count >= 1),
  -- [{ univerSheetId, title, headerRow }] in tab order: the D1 `sheets` rows a
  -- workbook made from the template starts with (all local, §7.3 links later).
  sheets_json        TEXT NOT NULL CHECK (json_valid(sheets_json)),
  created_by         TEXT NOT NULL REFERENCES members(user_id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  archived_at        TEXT,
  archived_by        TEXT REFERENCES members(user_id)
);

CREATE INDEX idx_templates_live ON templates(archived_at, title);

-- ---------------------------------------------------------------------------
-- Service tokens of the internal API (§13 «محمية برموز خدمة»): /api/v1/*
-- ---------------------------------------------------------------------------
-- Only the SHA-256 of a token is stored; the token itself is shown once, to
-- the admin who created it. A token is revoked, never deleted.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 100),
  token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  -- First characters of the token, to tell tokens apart in the admin list.
  token_prefix TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES members(user_id),
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT REFERENCES members(user_id)
);

-- ---------------------------------------------------------------------------
-- Backups (§14 «نسخ احتياطي: لقطات R2 بإصدارات + تصدير D1 يومي»)
-- ---------------------------------------------------------------------------
-- One row per run of the daily backup (src/phase7/backup.ts). The export
-- itself lives in the BACKUPS R2 bucket under `d1/{run id}/`.
CREATE TABLE backup_runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  -- Tables, row counts, bytes, snapshot inventory; never cell content.
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  error        TEXT
);

CREATE INDEX idx_backup_runs_started ON backup_runs(started_at);
