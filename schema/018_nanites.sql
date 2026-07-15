-- 018_nanites.sql
-- The "background tasks" engine (roadmap 12.2): nanites.
--
-- A *nanite* is a highly structured, headless subagent defined entirely in the
-- DB (no markdown files). It carries: typed inputs, an allow-listed tool set, a
-- model, instructions, and a structured output. It is idempotent, one-shot, and
-- conversation-free. Its work product is surfaced through the alerts framework
-- (schema/016_alerts.sql).
--
-- Two new tables only (`nanites` config + `nanite_runs` audit). A plain
-- `CREATE TABLE IF NOT EXISTS` under the runner's default BEGIN/COMMIT is safe:
-- there is no table rebuild here and therefore no cascading-delete hazard
-- (cf. schema/005_safe_topic_rebuild_template.sql). The one FK
-- (nanite_runs.nanite_id -> nanites.id) points at a table created in this same
-- migration, so nothing pre-existing can cascade.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nanites (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'nanite',
  trigger_phrase  TEXT    NOT NULL DEFAULT '',
  instructions    TEXT    NOT NULL,
  -- Nullable: null means "let the runner pick a sensible default model".
  model           TEXT,
  -- JSON array of tool names the runner is allowed to expose / dispatch.
  tool_allowlist  TEXT    NOT NULL DEFAULT '[]',
  -- JSON schema (or null) describing the typed inputs / structured output.
  input_schema    TEXT,
  output_schema   TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nanites_enabled
  ON nanites(enabled) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS nanite_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nanite_id   INTEGER NOT NULL REFERENCES nanites(id) ON DELETE CASCADE,
  status      TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  started_at  INTEGER,
  ended_at    INTEGER,
  -- JSON blob with the run's structured result (tool-call count, summary, …).
  result      TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nanite_runs_nanite
  ON nanite_runs(nanite_id, id DESC);
