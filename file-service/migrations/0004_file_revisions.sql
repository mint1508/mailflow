CREATE TABLE IF NOT EXISTS file_revisions (
  id text PRIMARY KEY,
  file_user_id text NOT NULL,
  node_id text NOT NULL,
  provider_revision_id text NOT NULL,
  revision_number integer,
  name text,
  mime_type text,
  size_bytes bigint,
  checksum text,
  created_at timestamptz,
  created_by text,
  record jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS file_revisions_owner_node_created_idx
  ON file_revisions(file_user_id, node_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS file_revisions_provider_idx
  ON file_revisions(file_user_id, node_id, provider_revision_id);
