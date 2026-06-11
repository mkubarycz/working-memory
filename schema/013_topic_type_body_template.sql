-- Adds a body_template column to topic_types.
-- Plain ALTER TABLE — no rebuild needed, no FK cascade risk.
ALTER TABLE topic_types ADD COLUMN body_template TEXT NOT NULL DEFAULT '';
