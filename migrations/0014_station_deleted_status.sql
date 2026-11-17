-- NAF Sheets — the station: a record deleted in Basecamp is shown in «الحالة»
-- (owner, 2026-11-17; docs/station-plan.md §4.2). Forward-only; adds a column.
--
-- The row's «الحالة» reads «محذوفة في Basecamp» and its text is struck
-- through; what the cell held before is kept here, written back if the record
-- comes back (restored from Basecamp's trash).
ALTER TABLE station_tasks ADD COLUMN status_before_delete TEXT;
