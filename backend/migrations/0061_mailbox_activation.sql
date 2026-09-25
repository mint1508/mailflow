ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS invite_type VARCHAR(32) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS mailbox_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email_account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL;

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS managed_mailbox BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_invites_mailbox_email
  ON invites (mailbox_email)
  WHERE mailbox_email IS NOT NULL;

UPDATE email_accounts ea
SET managed_mailbox = true
FROM cpanel_mailboxes cm
WHERE lower(ea.email_address) = lower(cm.email);
