-- NAF Sheets — the workbook dashboard («اللوحة»): custom widgets per workbook
-- (apps/api/src/dashboard/, contract packages/shared/src/api-dashboard.ts).
-- Forward-only, like every migration.
--
-- A widget only reads the workbook (it never writes a cell). Its whole
-- configuration (sheet, column or range, aggregation, group-by, display) is
-- one JSON object, validated by the API before it is stored. Nothing is ever
-- deleted: removing a widget sets removed_at, so it can be found again.
CREATE TABLE dashboard_widgets (
  id           TEXT PRIMARY KEY,
  workbook_id  TEXT NOT NULL REFERENCES workbooks(id),
  -- 0-based order among the workbook's live widgets.
  position     INTEGER NOT NULL CHECK (position >= 0),
  config_json  TEXT NOT NULL CHECK (json_valid(config_json)),
  created_by   TEXT NOT NULL REFERENCES members(user_id),
  created_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL REFERENCES members(user_id),
  updated_at   TEXT NOT NULL,
  removed_at   TEXT,
  removed_by   TEXT REFERENCES members(user_id)
);

CREATE INDEX idx_dashboard_widgets_live ON dashboard_widgets(workbook_id, removed_at, position);
