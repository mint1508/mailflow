-- cPanel connector configuration is kept in system_settings so the single
-- organization deployment has one encrypted token without exposing it to the UI.
-- This migration stores the last read-only mailbox inventory snapshot.

CREATE TABLE IF NOT EXISTS cpanel_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  domain VARCHAR(255) NOT NULL,
  local_part VARCHAR(255) NOT NULL,
  quota_bytes BIGINT,
  quota_raw VARCHAR(255),
  disk_used_bytes BIGINT,
  disk_used_raw VARCHAR(255),
  suspended BOOLEAN NOT NULL DEFAULT false,
  is_present BOOLEAN NOT NULL DEFAULT true,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cpanel_mailboxes_domain_idx
  ON cpanel_mailboxes (domain, email);

CREATE INDEX IF NOT EXISTS cpanel_mailboxes_present_idx
  ON cpanel_mailboxes (is_present, email);

CREATE TABLE IF NOT EXISTS cpanel_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  success BOOLEAN NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cpanel_audit_events_created_idx
  ON cpanel_audit_events (created_at DESC);
