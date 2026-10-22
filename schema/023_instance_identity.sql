CREATE TABLE IF NOT EXISTS instance_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL, password_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS instance_owner_sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, revoked_at INTEGER
);
