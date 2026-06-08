-- 011_workstream_topic_focus.sql
-- Adds a per-link `focused` flag to the workstream_topics junction so the
-- orchestrator (and panel) can mark a topic as the current
-- "let's coauthor this" subject within a workstream. Focus rides on the
-- existing link — a topic must be linked to a workstream to be focused
-- there. Clearing focus flips this flag to 0; it does NOT remove the link.
-- The partial index keeps lookups of "currently focused topics for a
-- workstream" cheap without bloating the index for the 99% non-focused
-- rows.
--
-- Plain ALTER TABLE — fits the runner's BEGIN/COMMIT wrapper, no
-- table-rebuild dance from 005_safe_topic_rebuild_template.sql required.

PRAGMA foreign_keys = ON;

ALTER TABLE workstream_topics
  ADD COLUMN focused INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ws_topics_focused
  ON workstream_topics(workstream_id) WHERE focused = 1;
