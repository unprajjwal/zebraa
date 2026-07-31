-- Create migrations table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Create connections table
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_encrypted BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Create schema_cache table (reserved)
CREATE TABLE IF NOT EXISTS schema_cache (
  connection_id TEXT PRIMARY KEY,
  schema_data TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

-- Create saved_queries table (reserved)
CREATE TABLE IF NOT EXISTS saved_queries (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sql TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Create chat_history table (reserved)
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  query TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
