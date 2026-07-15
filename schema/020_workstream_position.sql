-- 020_workstream_position.sql
-- Manual drag-and-drop ordering of the Active tab (feature
-- active-tab-drag-drop-ordering, v12.2.1). Adds a per-workstream sort key so
-- the Queue / In Progress / Backlog sections can be hand-ordered and the order
-- survives reloads (a derived recency sort can't persist a manual arrangement).
--
-- `position` is a REAL so we can insert between two neighbours by averaging
-- their positions (fractional indexing) without renumbering the whole section.
-- Position ASC = top of the section.
--
-- Safe DDL: `workstreams` is the parent of `sessions`/`entries` via ON DELETE
-- CASCADE foreign keys, so a table rebuild risks the cascade-wipe documented in
-- 005_safe_topic_rebuild_template.sql. A bare ALTER ADD COLUMN touches no child
-- rows and is the correct tool here — no rebuild.
--
-- Idempotency: the schema_migrations tracker guarantees this file runs at most
-- once, so a plain ALTER is fine.

PRAGMA foreign_keys = ON;

ALTER TABLE workstreams ADD COLUMN position REAL NOT NULL DEFAULT 0;

-- Backfill so the CURRENT visual order of the Active tab is preserved. The tab
-- orders each section by last activity (updated_at DESC, opened_at DESC,
-- id DESC). We assign an ascending position within each Active section
-- (queue / backlog / everything-else-as-progress) matching that order, so
-- position ASC reproduces today's top-to-bottom layout. Closed rows all keep
-- the DEFAULT 0 — they don't participate in Active-tab ordering.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY CASE
        WHEN status IN ('queue', 'backlog') THEN status
        ELSE 'progress'
      END
      ORDER BY updated_at DESC, opened_at DESC, id DESC
    ) AS rn
  FROM workstreams
  WHERE deleted_at IS NULL
    AND status != 'closed'
)
UPDATE workstreams
   SET position = (SELECT rn FROM ranked WHERE ranked.id = workstreams.id)
 WHERE id IN (SELECT id FROM ranked);
