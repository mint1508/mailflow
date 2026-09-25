-- Shared mailbox access foundation.
--
-- `email_accounts.user_id` remains as a compatibility/legacy owner pointer while
-- mailbox_memberships becomes the authorization source of truth. A mailbox is one
-- connection and may have many active members; it must not be copied per user.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_break_glass BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS primary_email_account_id UUID
    REFERENCES email_accounts(id) ON DELETE SET NULL;

-- Pending cPanel mailboxes are represented by an account row before a MailFlow
-- user accepts its activation invitation. Keep the old FK and make only the
-- ownership pointer nullable; existing rows are not changed by this migration.
DO $$
DECLARE
  is_required BOOLEAN;
BEGIN
  SELECT a.attnotnull INTO is_required
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relname = 'email_accounts'
     AND a.attname = 'user_id'
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF COALESCE(is_required, false) THEN
    ALTER TABLE email_accounts ALTER COLUMN user_id DROP NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mailbox_memberships (
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(16) NOT NULL DEFAULT 'read_send'
    CHECK (permission IN ('read', 'read_send')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS mailbox_memberships_user_active_idx
  ON mailbox_memberships (user_id, account_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS mailbox_memberships_account_active_idx
  ON mailbox_memberships (account_id, user_id)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE VIEW active_mailbox_memberships AS
SELECT account_id, user_id, permission, granted_by, created_at, updated_at
  FROM mailbox_memberships
 WHERE revoked_at IS NULL;

-- Existing private accounts retain their current access after the resolver cutover.
-- A conflict is deliberately left untouched so a prior explicit membership grant
-- (for example, a future read-only grant) is not widened by a rerun.
INSERT INTO mailbox_memberships (account_id, user_id, permission)
SELECT id, user_id, 'read_send'
  FROM email_accounts
 WHERE user_id IS NOT NULL
ON CONFLICT (account_id, user_id) DO NOTHING;

-- Normalize uniqueness at the database boundary. Refuse to install the index over
-- ambiguous legacy data rather than silently choosing an owner or deleting mail.
DO $$
DECLARE
  has_duplicate BOOLEAN;
BEGIN
  IF EXISTS (
    SELECT lower(btrim(email_address))
      FROM email_accounts
     WHERE email_address IS NOT NULL
     GROUP BY lower(btrim(email_address))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add normalized email uniqueness: duplicate email_accounts.email_address rows exist';
  END IF;
  IF to_regclass('public.cpanel_mailboxes') IS NOT NULL THEN
    EXECUTE $query$
      SELECT EXISTS (
        SELECT lower(btrim(email))
          FROM cpanel_mailboxes
         WHERE email IS NOT NULL
         GROUP BY lower(btrim(email))
        HAVING COUNT(*) > 1
      )
    $query$ INTO has_duplicate;
  END IF;
  IF COALESCE(has_duplicate, false) THEN
    RAISE EXCEPTION 'Cannot add normalized email uniqueness: duplicate cpanel_mailboxes.email rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS email_accounts_normalized_email_uidx
  ON email_accounts (lower(btrim(email_address)));

DO $$
BEGIN
  IF to_regclass('public.cpanel_mailboxes') IS NOT NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS cpanel_mailboxes_normalized_email_uidx ON cpanel_mailboxes (lower(btrim(email)))';
  END IF;
END $$;

COMMENT ON COLUMN users.is_break_glass IS
  'Local emergency administrator identity. This flag never grants mailbox content access by itself.';
COMMENT ON COLUMN users.primary_email_account_id IS
  'Optional default mailbox connection for this user; content access still requires an active membership.';
COMMENT ON TABLE mailbox_memberships IS
  'Authorization source for shared mailbox connections. Active rows are exposed by active_mailbox_memberships.';
