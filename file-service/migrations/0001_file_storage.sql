CREATE TABLE IF NOT EXISTS file_store_meta (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS file_users (id text PRIMARY KEY, record jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS file_nodes (id text PRIMARY KEY, file_user_id text NOT NULL, parent_id text, record jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS file_nodes_owner_parent_idx ON file_nodes(file_user_id, parent_id);
CREATE TABLE IF NOT EXISTS file_uploads (id text PRIMARY KEY, file_user_id text NOT NULL, record jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS file_reservations (id text PRIMARY KEY, file_user_id text NOT NULL, record jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS file_audits (id text PRIMARY KEY, created_at timestamptz NOT NULL, record jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS file_idempotency (actor text NOT NULL, key text NOT NULL, operation text NOT NULL, record jsonb NOT NULL, PRIMARY KEY(actor, key, operation));
