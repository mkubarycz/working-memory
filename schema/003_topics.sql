-- 003_topics.sql
-- Adds first-class Topics with M:N links to both workstreams and entries.
-- Topics carry a `status` (active|dormant|archived) and a `body`.
-- Soft delete (deleted_at) on topics AND on the join tables — link rows are
-- soft-deleted when a topic is soft-deleted (so a future restore is loss-
-- less). The FK ON DELETE CASCADE only matters if a hard delete ever
-- happens (e.g. dropping a workstream row outright); soft delete is the
-- normal path.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS topics (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  body         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

CREATE TABLE IF NOT EXISTS workstream_topics (
  workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  topic_slug    TEXT    NOT NULL REFERENCES topics(slug)    ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  PRIMARY KEY (workstream_id, topic_slug)
);

CREATE TABLE IF NOT EXISTS entry_topics (
  entry_id     INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  topic_slug   TEXT    NOT NULL REFERENCES topics(slug) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  PRIMARY KEY (entry_id, topic_slug)
);

CREATE INDEX IF NOT EXISTS idx_ws_topics_topic ON workstream_topics(topic_slug);
CREATE INDEX IF NOT EXISTS idx_entry_topics_topic ON entry_topics(topic_slug);
