PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workstreams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  closure     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  summary       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id, started_at);

CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  timestamp    INTEGER NOT NULL,
  body         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, timestamp);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  body,
  content='entries',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', old.id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', old.id, old.body);
  INSERT INTO entries_fts(rowid, body) VALUES (new.id, new.body);
END;
