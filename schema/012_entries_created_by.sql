-- 012_entries_created_by.sql
-- Adds a `created_by` text column to `entries` identifying the actor behind
-- each entry. Conventional values: agent name (e.g. 'orchestrator',
-- 'executor'), 'system' (Working Memory itself), 'human' (rare direct write).
-- A trailing `*` marks rows populated by this data migration (best-guess
-- historical attribution); new writes never use the `*` suffix.
--
-- Data migration strategy: scan each row's body for a known `<actor>:` prefix.
-- If one matches, set created_by = '<actor>*' and strip the prefix from body.
-- Known prefixes: system, chat, agent.
-- Rows that match no known prefix fall back to 'migration-tool*'.
--
-- Plain ALTER TABLE — fits the runner's BEGIN/COMMIT wrapper.

ALTER TABLE entries ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entries_created_by ON entries(created_by);

-- Migrate rows with known actor-prefix patterns.
-- Each UPDATE only touches rows still un-attributed (created_by = '').

-- system: <body>  (prefix length 7)
UPDATE entries SET created_by = 'system*', body = TRIM(SUBSTR(body, 8))
  WHERE created_by = '' AND body LIKE 'system:%';

-- chat: <body>  (prefix length 5)
UPDATE entries SET created_by = 'chat*', body = TRIM(SUBSTR(body, 6))
  WHERE created_by = '' AND body LIKE 'chat:%';

-- agent: <body>  (prefix length 6)
UPDATE entries SET created_by = 'agent*', body = TRIM(SUBSTR(body, 7))
  WHERE created_by = '' AND body LIKE 'agent:%';

-- Rows that matched no known prefix: generic migration marker.
UPDATE entries SET created_by = 'migration-tool*'
  WHERE created_by = '';
