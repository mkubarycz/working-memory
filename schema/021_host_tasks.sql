-- Protected broker metadata is intentionally separate from document resources.
CREATE TABLE IF NOT EXISTS host_task_apps (
  id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS host_task_grants (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES host_task_apps(id),
  windows_sid TEXT NOT NULL, tenant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, generation INTEGER NOT NULL, revoked_at INTEGER,
  operation_hash TEXT NOT NULL, operation_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS host_task_runners (
  id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE,
  windows_sid TEXT NOT NULL, tenant_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS host_task_jobs (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES host_task_apps(id),
  grant_id TEXT REFERENCES host_task_grants(id), grant_generation INTEGER,
  grant_hash TEXT, request_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, operation_hash TEXT NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  manual_refresh INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  runner_id TEXT REFERENCES host_task_runners(id), lease_hash TEXT, lease_until INTEGER,
  result_json TEXT, result_hash TEXT, result_until INTEGER, blocked_reason TEXT,
  UNIQUE(app_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS host_task_active_scope
  ON host_task_jobs(app_id) WHERE state IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS host_task_awaiting_app
  ON host_task_jobs(app_id) WHERE state='awaiting-approval';
CREATE TABLE IF NOT EXISTS host_task_audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL,
  subject_id TEXT NOT NULL
);
