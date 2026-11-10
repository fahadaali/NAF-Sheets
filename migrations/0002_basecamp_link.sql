-- NAF Sheets — Basecamp account linking (spec §3, §6.2, §9.5, §14; Appendix A-2, A-7).
-- Forward-only: adds what the per-user link, the service token and the
-- naf-id ↔ Basecamp people matching need and 0001_initial.sql does not have.
-- Nothing in 0001 is changed or dropped; every new column is nullable or has a
-- default, so existing rows stay valid.
-- Code: apps/api/src/basecamp-link/.

-- ---------------------------------------------------------------------------
-- user_basecamp_links (each user's own token, §3)
-- ---------------------------------------------------------------------------

-- Basecamp name of the linked person, for "linked as …" (GET /api/basecamp/link).
ALTER TABLE user_basecamp_links ADD COLUMN bc_person_name TEXT;
-- When `status` or the tokens last changed (refresh, expiry, revocation).
ALTER TABLE user_basecamp_links ADD COLUMN updated_at TEXT;
-- OPEN: `encrypted_tokens` is NOT NULL in 0001 and SQLite cannot drop a NOT
-- NULL without rebuilding the table. A revoked or expired link keeps its row
-- with `encrypted_tokens = ''`: the empty string means "no token held"
-- (apps/api/OPEN_QUESTIONS.md, "Basecamp link" B6).

-- ---------------------------------------------------------------------------
-- integrations (the service token, §3: webhooks, read-only reconciliation,
-- member caches — never a write on a user's behalf)
-- ---------------------------------------------------------------------------

ALTER TABLE integrations ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked'));
-- The Basecamp person whose token this is (from /my/profile.json).
ALTER TABLE integrations ADD COLUMN bc_person_id INTEGER;
ALTER TABLE integrations ADD COLUMN updated_at TEXT;
-- The admin who last (re)connected it; `created_by` stays the first one.
ALTER TABLE integrations ADD COLUMN updated_by TEXT REFERENCES members(user_id);

-- ---------------------------------------------------------------------------
-- People caches (§8.2, §9.5)
-- ---------------------------------------------------------------------------

-- The contract's BcPerson carries both (packages/shared/src/api-integrations.ts).
-- `personable_type` is an open set (User, Agent, Integration, Tombstone…): no CHECK.
ALTER TABLE bc_people_cache ADD COLUMN personable_type TEXT;
ALTER TABLE bc_people_cache ADD COLUMN client INTEGER NOT NULL DEFAULT 0 CHECK (client IN (0, 1));
-- §9.5: a person removed from the project may still be assigned to tasks and
-- is shown as a grey chip, so the row is marked, never deleted.
ALTER TABLE bc_people_cache ADD COLUMN removed_at TEXT;

-- Same rule for the account-wide cache.
ALTER TABLE bc_account_people_cache ADD COLUMN removed_at TEXT;

-- ---------------------------------------------------------------------------
-- naf-id member ↔ Basecamp person (§3: automatic by email, manual by admin)
-- ---------------------------------------------------------------------------

-- One row per member once a decision exists. A manual row with a NULL person
-- records "this member has no Basecamp person", so the automatic match never
-- overrides an admin's decision. Rows are replaced, never deleted.
CREATE TABLE bc_person_matches (
  user_id      TEXT PRIMARY KEY REFERENCES members(user_id),
  bc_person_id INTEGER,
  source       TEXT NOT NULL CHECK (source IN ('email', 'manual')),
  -- The admin who decided; NULL for an automatic match.
  matched_by   TEXT REFERENCES members(user_id),
  matched_at   TEXT NOT NULL,
  CHECK (source = 'manual' OR (bc_person_id IS NOT NULL AND matched_by IS NULL)),
  CHECK (source = 'email' OR matched_by IS NOT NULL)
);

-- A Basecamp person is matched to at most one member.
CREATE UNIQUE INDEX uq_bc_person_matches_person ON bc_person_matches(bc_person_id) WHERE bc_person_id IS NOT NULL;
