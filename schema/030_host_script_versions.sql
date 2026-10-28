ALTER TABLE host_script_tasks ADD COLUMN published_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE host_script_jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE host_script_versions (
  task_id TEXT NOT NULL REFERENCES host_script_tasks(id),
  version INTEGER NOT NULL CHECK (version > 0),
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, version)
);

INSERT INTO host_script_versions (task_id, version, definition_json, definition_hash, created_at)
SELECT id, 1, definition_json, definition_hash, created_at FROM host_script_tasks;
