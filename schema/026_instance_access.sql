CREATE TABLE IF NOT EXISTS instance_clients (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE,
  access TEXT NOT NULL CHECK(access IN ('read','write')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS instance_access_requests (
  id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, label TEXT NOT NULL,
  client_id TEXT REFERENCES instance_clients(id),
  access TEXT NOT NULL CHECK(access IN ('read','write')),
  source TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','consumed')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
