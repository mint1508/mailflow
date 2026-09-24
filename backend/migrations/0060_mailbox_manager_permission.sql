-- Scoped permission for mailbox provisioning and cPanel inventory access.
-- Keep this separate from is_admin so mailbox operators cannot manage users,
-- authentication policy, SSO, or system SMTP settings.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_manage_mailboxes BOOLEAN NOT NULL DEFAULT false;
