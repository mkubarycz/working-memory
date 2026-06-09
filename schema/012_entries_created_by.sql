-- 012_entries_created_by.sql
-- Adds a `created_by` text column to `entries` identifying the actor behind
-- each entry. Conventional values: agent name (e.g. 'orchestrator',
-- 'executor'), 'system' (Working Memory itself), 'human' (rare direct write).
-- A trailing `*` marks rows populated by this data migration (best-guess
-- historical attribution); new writes never use the `*` suffix.
--
-- Data migration:
--   - rows whose body matches `^system:\s*` → created_by = 'system*', strip prefix
--   - all other existing rows → created_by = 'human*'
--
-- Plain ALTER TABLE — fits the runner's BEGIN/COMMIT wrapper.

ALTER TABLE entries ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entries_created_by ON entries(created_by);

-- Migrate rows with a `system:` body prefix.
UPDATE entries SET created_by = 'system*', body = TRIM(SUBSTR(body, 8))
  WHERE body LIKE 'system:%';

-- Assign best-guess attribution to all remaining un-attributed rows.
UPDATE entries SET created_by = 'human*'
  WHERE created_by = '';
