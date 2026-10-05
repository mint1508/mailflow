ALTER TABLE file_users ADD COLUMN IF NOT EXISTS source text;
CREATE INDEX IF NOT EXISTS file_users_source_idx ON file_users(source);
