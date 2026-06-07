-- 007_topic_type.sql
-- Adds a discriminator to topics. Default 'topic' keeps every existing row valid
-- and backfills implicitly. No CHECK constraint on the value — the canonical
-- list of valid types lives in src/topicTypes.ts (config registry), not in the
-- DB. This keeps adding a new type a one-file change and avoids a table rebuild
-- every time. ALTER TABLE ADD COLUMN with a literal DEFAULT is a SQLite fast
-- path (no rewrite), so we sidestep the cascade trap documented in
-- 005_safe_topic_rebuild_template.sql.

PRAGMA foreign_keys = ON;

ALTER TABLE topics
  ADD COLUMN topic_type TEXT NOT NULL DEFAULT 'topic';

CREATE INDEX IF NOT EXISTS idx_topics_type
  ON topics(topic_type) WHERE deleted_at IS NULL;
