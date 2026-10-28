CREATE TABLE IF NOT EXISTS instance_oauth_clients (
  id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS instance_oauth_flows (
  proof_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES instance_access_requests(id) ON DELETE CASCADE,
  oauth_client_id TEXT NOT NULL REFERENCES instance_oauth_clients(id),
  params TEXT NOT NULL, code_hash TEXT UNIQUE, code_expires_at INTEGER,
  consumed_at INTEGER, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS instance_oauth_tokens (
  client_id TEXT PRIMARY KEY REFERENCES instance_clients(id),
  oauth_client_id TEXT NOT NULL REFERENCES instance_oauth_clients(id)
);
