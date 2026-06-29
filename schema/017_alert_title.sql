-- 017_alert_title.sql
-- Add a friendly, short, editable title to alerts (same idea as topics /
-- topic-types). Defaults to '' so existing rows stay valid; the store derives
-- a sensible title from the description when one isn't supplied.
--
-- Plain ADD COLUMN under the runner's default BEGIN/COMMIT — no table rebuild,
-- no cascading-delete hazard (cf. schema/005_safe_topic_rebuild_template.sql).
-- The runner only applies unapplied versions, so this runs exactly once.

ALTER TABLE alerts ADD COLUMN title TEXT NOT NULL DEFAULT '';
