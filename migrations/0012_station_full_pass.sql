-- NAF Sheets — the station: the 15-minute full pass (CLAUDE.md §2, docs/station-plan.md §4.1).
-- Forward-only.
--
-- Basecamp announces no event for a subtask's date or title changed there, and
-- may not move its to-do's updated_at either: every FULL_PASS_MS a run reads the
-- subtasks of every to-do. This is when the last such run finished.
ALTER TABLE station_links ADD COLUMN last_full_at TEXT;
