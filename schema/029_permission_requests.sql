ALTER TABLE instance_access_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'access'
  CHECK (purpose IN ('access', 'permissions'));
