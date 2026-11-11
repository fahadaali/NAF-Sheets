-- NAF Sheets — apps/api OPEN_QUESTIONS.md «Before the first real Basecamp link» Q1.
-- Forward-only: nothing earlier is changed or dropped; the new column is nullable.
--
-- The notes column a notes picture's file was tracked under (column key, upper
-- case). Changing a sheet's notes column must never take files out of
-- Basecamp: only a picture a person removed from the notes cell does. A row
-- tracked under another column than the sheet's notes column now is not
-- tracked (src/images/notes-images.ts); its file stays in Basecamp.
-- NULL: a row from before this migration, read as tracked under the current column.
ALTER TABLE attachments ADD COLUMN notes_column TEXT;
