CREATE TABLE IF NOT EXISTS instance_features (
  feature TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);
