-- NAF Sheets — phase 5: attachments (spec §10) and comments (spec §12.1 item 5).
-- Forward-only: nothing in 0001–0003 is changed or dropped; every new column
-- is nullable or has a default, so existing rows stay valid.
-- Code: apps/api/src/phase5/. Open points: apps/api/OPEN_QUESTIONS.md
-- "Phase 5: attachments and comments".
--
-- Nothing here is ever deleted: a removed file keeps its row (`removed_at`)
-- and its R2 copy; `purge_after` only records when the copy may go.

-- ---------------------------------------------------------------------------
-- attachments (0001): the state of each file
-- ---------------------------------------------------------------------------

-- uploading  stored in R2; being sent to Basecamp
-- attached   in the to-do's description in Basecamp
-- local_only kept in the platform only (a subtask's file, §8 table)
-- failed     stored in R2; the Basecamp step failed (`last_error`)
ALTER TABLE attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'attached'
  CHECK (state IN ('uploading', 'attached', 'local_only', 'failed'));
-- 0: the platform holds no copy (a file found in Basecamp; `r2_key` is then a
-- reserved key no object is written to). Its download reads Basecamp.
ALTER TABLE attachments ADD COLUMN r2_stored INTEGER NOT NULL DEFAULT 1 CHECK (r2_stored IN (0, 1));
-- `description_attachments[].id` (rich_text.md), when Basecamp gave it.
ALTER TABLE attachments ADD COLUMN bc_attachment_id INTEGER;
-- Arabic message of a `failed` file (what happened, what to do), and its code.
ALTER TABLE attachments ADD COLUMN last_error TEXT;
ALTER TABLE attachments ADD COLUMN last_error_code TEXT;
-- Who removed the chip (NULL: it left the description in Basecamp), and from
-- when the R2 copy may be purged (removed_at + 30 days, §10). Nothing purges it
-- yet: deleting data needs the owner's decision (OPEN P4).
ALTER TABLE attachments ADD COLUMN removed_by TEXT REFERENCES members(user_id);
ALTER TABLE attachments ADD COLUMN purge_after TEXT;
ALTER TABLE attachments ADD COLUMN updated_at TEXT;

-- One live row per file of a task (the inbound extraction's key).
CREATE UNIQUE INDEX uq_attachments_task_sgid ON attachments(task_uid, bc_sgid)
  WHERE bc_sgid IS NOT NULL AND removed_at IS NULL;
CREATE INDEX idx_attachments_purge ON attachments(purge_after) WHERE purge_after IS NOT NULL;

-- ---------------------------------------------------------------------------
-- tasks: the comment counter of a to-do (§9.3.5 `comment_created`, §9.4)
-- ---------------------------------------------------------------------------

-- `comments_count` as last seen in Basecamp; NULL until known (and for subtasks).
ALTER TABLE tasks ADD COLUMN bc_comments_count INTEGER CHECK (bc_comments_count IS NULL OR bc_comments_count >= 0);
ALTER TABLE tasks ADD COLUMN bc_comments_seen_at TEXT;
