-- NAF Sheets — the station: notifications reach everyone (owner, 2026-11-15).
-- Forward-only.
--
-- Every project member is on each to-do's «When done, notify» list and among
-- its subscribers. The key records for whom that was last done (sorted person
-- ids), so it is redone only when the project's members change.
ALTER TABLE station_tasks ADD COLUMN notify_key TEXT;
