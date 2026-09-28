ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS mailbox_role VARCHAR(16) NOT NULL DEFAULT 'user';

UPDATE invites
SET mailbox_role = 'user'
WHERE mailbox_role IS NULL OR mailbox_role NOT IN ('user', 'mod');
