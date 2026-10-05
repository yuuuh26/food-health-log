CREATE TABLE IF NOT EXISTS backups (backup_id TEXT PRIMARY KEY,app_id TEXT NOT NULL,schema_version INTEGER NOT NULL,created_at TEXT NOT NULL,received_at TEXT NOT NULL,device_id TEXT NOT NULL,record_count INTEGER NOT NULL,source_revision INTEGER NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,chunk_count INTEGER NOT NULL,verified_seq INTEGER);
CREATE TABLE IF NOT EXISTS backup_chunks (backup_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,backup_json TEXT NOT NULL,PRIMARY KEY(backup_id,chunk_index));
CREATE TABLE IF NOT EXISTS auth_config (app_id TEXT PRIMARY KEY,key_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions (session_id TEXT PRIMARY KEY,app_id TEXT NOT NULL,token_sha256 TEXT NOT NULL UNIQUE,device_name TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT NOT NULL,revoked_at TEXT);
CREATE TABLE IF NOT EXISTS auth_attempts (bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS backup_versions ON backups(app_id,verified_seq DESC);
CREATE INDEX IF NOT EXISTS session_lookup ON auth_sessions(app_id,token_sha256,revoked_at);
