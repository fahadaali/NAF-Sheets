-- NAF Sheets — the station: unlinking keeps the sync record (owner, 2026-11-17).
-- Forward-only; adds columns, deletes nothing.
--
-- Unlinking stops syncing and marks the link; its tabs, tasks (the synced
-- bases) and history stay. Linking the same file to the same project again
-- takes the link back, so nothing is created twice in Basecamp. A tab left
-- out of that new link is marked the same way and kept.
ALTER TABLE station_links ADD COLUMN unlinked_at TEXT;
ALTER TABLE station_tabs ADD COLUMN unlinked_at TEXT;
