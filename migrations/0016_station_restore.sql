-- NAF Sheets — the station: restoring from the link screen (owner, 2026-11-17;
-- docs/station-plan.md §4.3, §4.4). Forward-only; adds columns.
--
-- A subtask deleted from Basecamp for good (its row left the sheet) can be
-- created again from its snapshot; when it was, and as which new record.
ALTER TABLE station_deleted ADD COLUMN restored_at TEXT;
ALTER TABLE station_deleted ADD COLUMN restored_bc_id INTEGER;
