-- 019_nanite_acceptance.sql
-- Acceptance-criteria validation for nanites (roadmap 12.2).
--
-- After a nanite finishes its tool-calling loop the runner runs a JUDGE step:
-- one extra LM call (same model) that scores how well the final output meets
-- the nanite's acceptance criteria. `acceptance_criteria` is the human-written
-- rubric; `acceptance_threshold` is the minimum confidence (0-100) required to
-- count the run as succeeded.
--
-- Two additive `ALTER TABLE ... ADD COLUMN` statements only — no table rebuild,
-- so there is no cascading-delete hazard (cf.
-- schema/005_safe_topic_rebuild_template.sql) and the runner's default
-- BEGIN/COMMIT wrap is fine. Existing rows backfill to the DEFAULTs.

PRAGMA foreign_keys = ON;

ALTER TABLE nanites ADD COLUMN acceptance_criteria  TEXT    NOT NULL DEFAULT '';
ALTER TABLE nanites ADD COLUMN acceptance_threshold INTEGER NOT NULL DEFAULT 60;
