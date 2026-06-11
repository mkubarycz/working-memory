-- 013_topic_type_body_template.sql
-- Add per-type markdown body template scaffold.
-- Additive ALTER TABLE — safe on live data; no FK cascade risk.
-- When a topic is created for a type that has a non-empty body_template, the
-- caller's body is reshaped via LLM to fit the template sections.  An empty
-- string (the default) preserves the existing verbatim-store behaviour.

ALTER TABLE topic_types ADD COLUMN body_template TEXT NOT NULL DEFAULT '';
