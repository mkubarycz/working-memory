-- Protected generic host-script definitions, grants, and jobs; never document CRUD.
CREATE TABLE IF NOT EXISTS host_script_tasks (
  id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS host_script_grants (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES host_script_tasks(id),
  app_id TEXT NOT NULL REFERENCES host_task_apps(id), definition_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS host_script_jobs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES host_script_tasks(id),
  app_id TEXT REFERENCES host_task_apps(id), grant_id TEXT REFERENCES host_script_grants(id),
  parameters_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
  idempotency_key TEXT, payload_hash TEXT, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  lease_hash TEXT, lease_until INTEGER, result_json TEXT, error TEXT, result_until INTEGER,
  UNIQUE(app_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS host_script_active_app
  ON host_script_jobs(app_id) WHERE app_id IS NOT NULL AND state IN ('queued','running');
