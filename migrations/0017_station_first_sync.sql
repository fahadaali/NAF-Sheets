-- NAF Sheets — the station: the first sync of a tab linked to a list that
-- already has tasks (owner decision 10, settled 2026-11-17). Forward-only; adds columns.
--
-- station_tabs.first_sync: the reference chosen in the wizard ('file',
-- 'basecamp' or 'merge') until the tab's first run has matched its rows with
-- the list's records by title; NULL afterwards (and for a new list).
-- station_tasks.ignored: a record that was only in Basecamp when the file was
-- the reference: the link leaves it there, never adds a row for it and never
-- deletes it.
ALTER TABLE station_tabs ADD COLUMN first_sync TEXT CHECK (first_sync IS NULL OR first_sync IN ('file', 'basecamp', 'merge'));
ALTER TABLE station_tasks ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1));
