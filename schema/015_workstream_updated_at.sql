-- 015_workstream_updated_at.sql
-- Add a generic last-modified timestamp to `workstreams` so the Active-tab
-- recency sort reacts to *any* change — most importantly a section move
-- (queue/progress/backlog), which only flips `status` and writes no journal
-- entry. Before this, listWorkstreams' 'last-activity-desc' key was
-- COALESCE(MAX(entry.timestamp), opened_at), so a just-moved workstream kept
-- its old position. With `updated_at` folded into the sort key, moving a
-- workstream stamps it "now" and it floats to the top of its new section.
--
-- Safe DDL: `workstreams` is the parent of `sessions`/`entries` via ON DELETE
-- CASCADE foreign keys, so a table rebuild risks the cascade-wipe documented
-- in 005_safe_topic_rebuild_template.sql. A bare ALTER ADD COLUMN touches no
-- child rows and is the correct tool here — no rebuild.
--
-- Idempotency: the migration version tracker (schema_migrations) guarantees
-- this file runs at most once, so a plain ALTER is fine; re-running would only
-- happen if the tracker row were missing.
ALTER TABLE workstreams ADD COLUMN updated_at INTEGER;

-- Backfill legacy rows with a sane value: prefer closed_at (the last known
-- mutation for archived rows) else opened_at.
UPDATE workstreams
   SET updated_at = COALESCE(updated_at, closed_at, opened_at);
