-- 008_topic_types_table.sql
-- Promote topic types from a TS-only registry to a proper DB table. The
-- previous design (v0.7.0/v0.7.1) kept the canonical list in `src/topicTypes.ts`
-- and hand-synced the values into `package.json` enums via a build script. That
-- worked, but it meant adding a new type was a code change with a release
-- attached. Adding it as a DB row is more honest about what a topic_type is:
-- runtime config.
--
-- Migration 009 (separate file) adds the FK from `topics.topic_type` to
-- `topic_types(id)` via a table rebuild. We keep that in its own file because
-- the rebuild has to bypass the runner's BEGIN/COMMIT wrapper, while this
-- migration is perfectly happy inside one.
--
-- Seeded with the three values that exist in live data:
--   - 'topic'   — default for every legacy row (v007 backfill).
--   - 'feature' — registered in v0.7.1 (one live row promoted).
--   - 'task'    — registered briefly in v0.7.0 before v0.7.1 narrowed the
--                 TS enum; five live rows already use this value.
-- All three timestamps are identical (migration time) — the column is just
-- there so future tools can sort/filter.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topic_types (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  icon         TEXT NOT NULL,
  description  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT OR IGNORE INTO topic_types (id, label, icon, description, created_at, updated_at)
WITH stamp(ts) AS (SELECT CAST(strftime('%s','now') AS INTEGER))
SELECT 'topic',   'Topic',   'symbol-misc', 'A durable subject — notes, references, evolving knowledge.', ts, ts FROM stamp
UNION ALL
SELECT 'feature', 'Feature', 'rocket',      'A user-visible capability to design, build, and ship.',     ts, ts FROM stamp
UNION ALL
SELECT 'task',    'Task',    'checklist',   'A discrete unit of work, usually a child of a Feature.',    ts, ts FROM stamp;
