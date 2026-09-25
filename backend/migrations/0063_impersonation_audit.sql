-- Preserve structured context for sensitive authentication events such as
-- administrator impersonation. Existing events remain valid with an empty object.
ALTER TABLE auth_events
  ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_auth_events_impersonation
  ON auth_events (event_type, created_at DESC)
  WHERE event_type IN ('impersonation_start', 'impersonation_stop', 'impersonation_expired');
