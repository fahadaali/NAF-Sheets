-- NAF Sheets — the station: the one-click suggestion in alert emails
-- (docs/station-plan.md §6.2; owner, 2026-11-17). Forward-only; adds a column.
--
-- Each link remembers, per title in its roles tab, the last names that were
-- all mapped to Basecamp people (JSON object title → names as written). When
-- a title's name changes to an unmapped one, the alert suggests the person the
-- previous name was mapped to: «هل هو …؟ تأكيد».
ALTER TABLE station_links ADD COLUMN roles_json TEXT CHECK (roles_json IS NULL OR json_valid(roles_json));
