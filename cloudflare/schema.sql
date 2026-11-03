-- One row per independent practice. Private answers are returned only after
-- release; the database administrator can still access stored data.
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_expiry ON activities (expires_at);
