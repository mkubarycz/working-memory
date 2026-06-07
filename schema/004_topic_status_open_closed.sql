-- 004_topic_status_open_closed.sql
-- Collapse topics.status from {active, dormant, archived} to {open, closed}.
--
-- Mapping:
--   active   -> open
--   dormant  -> open
--   archived -> closed
--
-- The v003 column was plain TEXT (no CHECK), so the data UPDATEs alone would
-- suffice for correctness. But SQLite can't ALTER a column's DEFAULT in place,
-- and we want a CHECK to enforce the new vocabulary going forward — so we
-- rebuild the table with the standard create-copy-drop-rename pattern.
--
-- `workstream_topics.topic_slug` and `entry_topics.topic_slug` both FK to
-- `topics(slug) ON DELETE CASCADE`. We use `PRAGMA defer_foreign_keys = ON`
-- to defer FK enforcement to COMMIT — by then the new `topics` table holds
-- the same slugs, so the FKs from the join tables resolve cleanly.

PRAGMA defer_foreign_keys = ON;

UPDATE topics SET status = 'open'   WHERE status IN ('active', 'dormant');
UPDATE topics SET status = 'closed' WHERE status = 'archived';

CREATE TABLE topics_new (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'closed')),
  body         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

INSERT INTO topics_new (slug, title, status, body, created_at, updated_at, deleted_at)
  SELECT slug, title, status, body, created_at, updated_at, deleted_at
    FROM topics;

DROP TABLE topics;
ALTER TABLE topics_new RENAME TO topics;
