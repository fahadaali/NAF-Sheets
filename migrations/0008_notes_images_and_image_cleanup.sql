-- NAF Sheets — owner decisions of 2026-11-11 on pictures (apps/api
-- OPEN_QUESTIONS.md "Images" I7 and I9). Forward-only: nothing earlier is
-- changed or dropped; every new column is nullable.

-- ---------------------------------------------------------------------------
-- I7: a picture removed from a to-do's notes cell leaves its description
-- ---------------------------------------------------------------------------

-- Why a removed file was removed, when the platform needs to know:
--   notes_image  its picture left the notes cell (src/images/notes-images.ts);
--                the file is sent again if the picture comes back (Ctrl+Z).
-- NULL: every other removal (the attachment editor's chip, or Basecamp).
ALTER TABLE attachments ADD COLUMN removed_reason TEXT
  CHECK (removed_reason IS NULL OR removed_reason = 'notes_image');

-- ---------------------------------------------------------------------------
-- I9: clean-up of picture files nothing references (src/images/cleanup.ts)
-- ---------------------------------------------------------------------------

-- Every stored snapshot object already read for picture references. Snapshot
-- objects are create-only, so each is read once. `source`: the bucket it was
-- read from (SNAPSHOTS, or a copy in BACKUPS whose original is missing).
CREATE TABLE image_ref_scans (
  source        TEXT NOT NULL CHECK (source IN ('snapshots', 'backups')),
  snapshot_key  TEXT NOT NULL,
  etag          TEXT NOT NULL,
  uploaded_at   TEXT NOT NULL,
  scanned_at    TEXT NOT NULL,
  refs          INTEGER NOT NULL CHECK (refs >= 0),
  PRIMARY KEY (source, snapshot_key)
);

-- Every picture id some scanned snapshot refers to. A picture listed here is
-- never cleaned up: snapshot versions are never deleted, so the version that
-- refers to it can always be restored. Rows are never deleted.
CREATE TABLE image_refs (
  image_id       TEXT PRIMARY KEY CHECK (length(image_id) = 32),
  workbook_id    TEXT NOT NULL,
  first_seen_key TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL
);
