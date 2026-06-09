-- 012_entries_created_by.sql
-- Adds a `created_by` text column to `entries` identifying the actor behind
-- each entry. Conventional values: agent name (e.g. 'orchestrator',
-- 'executor'), 'system' (Working Memory itself), 'human' (rare direct write).
--
-- Data migration: all pre-existing rows receive 'migration-tool*'. The trailing
-- `*` marks historical attribution written by this migration; new writes never
-- use the `*` suffix.
--
-- Plain ALTER TABLE — fits the runner's BEGIN/COMMIT wrapper.

ALTER TABLE entries ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entries_created_by ON entries(created_by);

-- Attribute all pre-existing rows to the migration tool.
UPDATE entries SET created_by = 'migration-tool*'
  WHERE created_by = '';
