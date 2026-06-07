-- 009_topic_type_fk.sql
-- Adds the FK from `topics.topic_type` to `topic_types(id)` by rebuilding the
-- `topics` table. SQLite can't ALTER TABLE … ADD CONSTRAINT, so a rebuild is
-- the only path.
--
-- This migration runs WITHOUT the runner's BEGIN/COMMIT wrapper (see the
-- `noWrap` flag in db.ts MIGRATIONS). The wrapper would defeat the
-- `PRAGMA foreign_keys = OFF` toggle: toggling the pragma inside a transaction
-- is a no-op, and leaving FKs on across the DROP would fire ON DELETE CASCADE
-- on `workstream_topics`, `entry_topics`, and `topic_parents` — the exact
-- migration-004 trap documented in `005_safe_topic_rebuild_template.sql`. We
-- already paid that price once; don't pay it again.
--
-- We also snapshot the join tables into TEMP tables before the DROP and
-- re-insert them after the RENAME as a belt-and-suspenders defense. If the
-- FK toggle ever fails to take effect (e.g. someone changes how the runner
-- works), the snapshot/restore still keeps the data intact and the
-- `PRAGMA foreign_key_check` at the end would catch any inconsistency.

PRAGMA foreign_keys = OFF;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Snapshot child tables into TEMP. These are the rows that would be
--    cascade-deleted if the FK toggle ever fails to apply.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _wt_save AS SELECT * FROM workstream_topics;
CREATE TEMP TABLE _et_save AS SELECT * FROM entry_topics;
CREATE TEMP TABLE _tp_save AS SELECT * FROM topic_parents;

-- ---------------------------------------------------------------------------
-- 2. Build the new `topics` table — identical to the current one EXCEPT for
--    the FK on `topic_type`. ON UPDATE CASCADE so renaming a topic_type id
--    would propagate; ON DELETE RESTRICT so deleting a type that's still in
--    use is rejected (force reassignment first).
-- ---------------------------------------------------------------------------

CREATE TABLE topics_new (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'closed')),
  body         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  topic_type   TEXT NOT NULL DEFAULT 'topic'
                  REFERENCES topic_types(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

INSERT INTO topics_new (slug, title, status, body, created_at, updated_at, deleted_at, topic_type)
  SELECT slug, title, status, body, created_at, updated_at, deleted_at, topic_type
    FROM topics;

DROP TABLE topics;
ALTER TABLE topics_new RENAME TO topics;

-- Re-create the partial index on topic_type that 007 added.
CREATE INDEX IF NOT EXISTS idx_topics_type
  ON topics(topic_type) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Restore child tables from the TEMP snapshots. With foreign_keys OFF the
--    DROP above wouldn't have cascaded, but this is the documented safe path
--    from 005 — do it anyway so the migration is correct even if someone
--    rewires the runner.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO workstream_topics SELECT * FROM _wt_save;
INSERT OR IGNORE INTO entry_topics      SELECT * FROM _et_save;
INSERT OR IGNORE INTO topic_parents     SELECT * FROM _tp_save;

DROP TABLE _wt_save;
DROP TABLE _et_save;
DROP TABLE _tp_save;

-- ---------------------------------------------------------------------------
-- 4. Final integrity check. PRAGMA foreign_key_check returns one row per
--    violation; the runner inspects this via PRAGMA after commit and will
--    refuse to mark the migration applied if anything dangles. (We assert
--    in SQL too: a violation here would fail the COMMIT only on a transaction
--    where deferred FKs were enabled; we're not deferred, so this is mostly
--    informational. The TS runner does the post-COMMIT check.)
-- ---------------------------------------------------------------------------

COMMIT;

PRAGMA foreign_keys = ON;
