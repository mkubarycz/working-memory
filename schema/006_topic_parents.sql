-- 006_topic_parents.sql
-- Adds parent/child links between topics, forming a DAG (each topic can
-- have 0 or more parents and 0 or more children). M:N join table only —
-- no schema changes to existing tables, no table rebuilds, no
-- foreign_keys gymnastics required.
--
-- Semantics enforced at the DB layer:
--   - PRIMARY KEY prevents duplicate (child, parent) rows.
--   - CHECK forbids self-links (child != parent).
--   - Soft delete via `deleted_at`, matching the rest of the schema.
--
-- Cycle prevention lives in the API layer (`addTopicParent`) — SQLite
-- has no native graph constraint; a recursive CTE walks the ancestor
-- closure of the proposed parent and rejects if the child appears.
--
-- Status is NOT cascaded. Closing a parent topic does not affect children.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topic_parents (
  child_slug   TEXT NOT NULL REFERENCES topics(slug) ON DELETE CASCADE,
  parent_slug  TEXT NOT NULL REFERENCES topics(slug) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  PRIMARY KEY (child_slug, parent_slug),
  CHECK (child_slug != parent_slug)
);

CREATE INDEX IF NOT EXISTS idx_topic_parents_child
  ON topic_parents(child_slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_topic_parents_parent
  ON topic_parents(parent_slug) WHERE deleted_at IS NULL;
