import { ImapFlow } from 'imapflow';
import bcrypt from 'bcryptjs';
import { pool, query } from './db.js';
import { encrypt } from './encryption.js';
import { getCpanelConfig } from './cpanelClient.js';
import { resolveForConnection } from './hostValidation.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const IMAP_TIMEOUT_MS = 15_000;

export class MailboxAuthenticationError extends Error {
  constructor() {
    super('Mailbox authentication failed');
    this.code = 'MAILBOX_AUTH_FAILED';
  }
}

// Keep an unavailable cPanel/IMAP service separate from an invalid password.
// Callers can return a maintenance response without turning an outage into a
// misleading credential failure (or silently falling back to a stale hash).
export class MailboxAuthenticationUnavailableError extends Error {
  constructor() {
    super('Mailbox authentication service is unavailable');
    this.code = 'MAILBOX_AUTH_UNAVAILABLE';
  }
}

export class MailboxProvisioningError extends Error {
  constructor() {
    super('Mailbox activation is required before first sign-in');
    this.code = 'MAILBOX_ACTIVATION_REQUIRED';
  }
}

export function normalizeMailboxEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function isConfiguredMailbox(email, config) {
  const domain = String(config?.domain || '').trim().toLowerCase();
  return !!domain && email.endsWith(`@${domain}`);
}

function defaultImapClient(options) {
  return new ImapFlow(options);
}

function isInvalidCredentialError(error) {
  return error?.authenticationFailed === true
    || error?.serverResponseCode === 'AUTHENTICATIONFAILED'
    || error?.serverResponseCode === 'AUTHORIZATIONFAILED'
    || /\[AUTHENTICATIONFAILED\]|authentication failed|invalid credentials|invalid (?:user|login|password)|login failed|password incorrect|\[AUTHORIZATIONFAILED\]/i.test(error?.message || '');
}

// Authenticate against the cPanel mailbox directly. This opens no mailbox and
// only proves the supplied credentials; mail synchronization happens after login.
export async function authenticateMailbox({ email, password }, {
  getConfig = getCpanelConfig,
  resolveHost = resolveForConnection,
  createClient = defaultImapClient,
} = {}) {
  const normalizedEmail = normalizeMailboxEmail(email);
  if (!normalizedEmail || typeof password !== 'string' || !password) return null;

  let client;
  try {
    const config = await getConfig();
    if (!config || !isConfiguredMailbox(normalizedEmail, config)) return null;
    const resolved = await resolveHost(config.host);
    const tls = { rejectUnauthorized: true };
    if (resolved.servername) tls.servername = resolved.servername;
    if (resolved.lookup && resolved.servername) {
      tls.lookup = resolved.lookup;
      tls.autoSelectFamily = true;
      tls.autoSelectFamilyAttemptTimeout = 1000;
    }
    client = createClient({
      host: resolved.lookup && resolved.servername ? resolved.servername : resolved.host,
      port: 993,
      secure: true,
      auth: { user: normalizedEmail, pass: password },
      tls,
      logger: false,
      connectionTimeout: IMAP_TIMEOUT_MS,
      greetingTimeout: IMAP_TIMEOUT_MS,
      socketTimeout: IMAP_TIMEOUT_MS,
      commandTimeout: IMAP_TIMEOUT_MS,
    });
    await client.connect();
    return { email: normalizedEmail, config };
  } catch (error) {
    if (isInvalidCredentialError(error)) throw new MailboxAuthenticationError();
    throw new MailboxAuthenticationUnavailableError();
  } finally {
    // Cleanup failures must not replace a successful authentication result.
    if (client) {
      try {
        await client.logout();
      } catch {
        try { client.close?.(); } catch { /* connection is already unusable */ }
      }
    }
  }
}

export async function getManagedMailboxAccount(userId, email) {
  const result = await query(
    `SELECT id FROM email_accounts
     WHERE user_id = $1 AND managed_mailbox = true AND lower(email_address) = $2
     ORDER BY created_at LIMIT 1`,
    [userId, email],
  );
  return result.rows[0] || null;
}

export async function getPendingManagedMailboxAccount(email) {
  const result = await query(
    `SELECT id FROM email_accounts
     WHERE user_id IS NULL AND managed_mailbox = true AND lower(email_address) = $1
     ORDER BY created_at LIMIT 1`,
    [email],
  );
  return result.rows[0] || null;
}

export async function updateManagedMailboxCredentials({ accountId, userId, email, password, passwordHash }, { dbPool = pool } = {}) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE email_accounts
       SET auth_user = $1, auth_pass = $2, smtp_auth_user = $1, smtp_auth_pass = $2,
           sync_error = NULL, enabled = true
       WHERE id = $3 AND user_id = $4 AND managed_mailbox = true
       RETURNING id`,
      [email, encrypt(password), accountId, userId],
    );
    if (!updated.rows.length) throw new MailboxProvisioningError();
    if (passwordHash) {
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Re-authentication has to follow the same credential policy as sign-in. A
// managed mailbox is verified live over IMAP; local and break-glass accounts
// retain their bcrypt credential path.
export async function verifyUserCredential(user, password, {
  lookupManagedAccount = getManagedMailboxAccount,
  authenticate = authenticateMailbox,
  comparePassword = bcrypt.compare,
} = {}) {
  if (!user || typeof password !== 'string' || !password) return false;
  const email = normalizeMailboxEmail(user.username);
  if (email && await lookupManagedAccount(user.id, email)) {
    return !!await authenticate({ email, password });
  }
  return !!user.password_hash && await comparePassword(password, user.password_hash);
}

// A successful IMAP login is proof that the person controls the configured
// mailbox. It may claim only the pending managed account created by a mailbox
// manager; arbitrary cPanel mailboxes must not bypass invite-only registration.
export async function provisionMailboxUser({ email, password, passwordHash, config }, { dbPool = pool } = {}) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);

    const existingUser = await client.query(
      `SELECT id, username, display_name, avatar, is_admin, can_manage_mailboxes, totp_enabled
       FROM users WHERE lower(username) = $1 FOR UPDATE`,
      [email],
    );
    if (existingUser.rows.length) {
      const account = await client.query(
        `SELECT id FROM email_accounts
         WHERE user_id = $1 AND managed_mailbox = true AND lower(email_address) = $2
         ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [existingUser.rows[0].id, email],
      );
      // A concurrent local registration may use the mailbox as its username.
      // Possession of that mailbox must never sign someone into that unrelated
      // local account merely because the username collides.
      if (!account.rows[0]) {
        throw new MailboxProvisioningError();
      }
      await client.query('COMMIT');
      return { user: existingUser.rows[0], account: account.rows[0], created: false };
    }

    const existingAccounts = await client.query(
      `SELECT id, managed_mailbox, user_id FROM email_accounts
       WHERE lower(email_address) = $1 ORDER BY created_at FOR UPDATE`,
      [email],
    );
    // The activation workflow creates this pending record before the owner
    // signs in. Never take an account that already belongs to someone else.
    const managedAccount = existingAccounts.rows.find(account => account.managed_mailbox && account.user_id === null);
    if (!managedAccount) {
      throw new MailboxProvisioningError();
    }

    const userResult = await client.query(
      `INSERT INTO users (username, password_hash, is_admin)
       VALUES ($1, $2, false)
       RETURNING id, username, display_name, avatar, is_admin, can_manage_mailboxes, totp_enabled`,
      [email, passwordHash],
    );
    const user = userResult.rows[0];
    const encryptedPassword = encrypt(password);
    const accountResult = await client.query(
      `UPDATE email_accounts
       SET user_id = $1, name = $2, imap_host = $3, imap_port = 993, imap_tls = true,
           smtp_host = $3, smtp_port = 465, smtp_tls = 'SSL', auth_user = $2,
           auth_pass = $4, smtp_auth_user = $2, smtp_auth_pass = $4,
           sync_error = NULL, enabled = true, managed_mailbox = true
       WHERE id = $5 AND user_id IS NULL AND managed_mailbox = true
       RETURNING id`,
      [user.id, email, config.host, encryptedPassword, managedAccount.id],
    );
    const account = accountResult.rows[0];
    if (!account) {
      throw new MailboxProvisioningError();
    }
    await client.query(
      `INSERT INTO mailbox_memberships (account_id, user_id, permission)
       VALUES ($1, $2, 'read_send')
       ON CONFLICT (account_id, user_id) DO UPDATE SET
         permission = 'read_send', revoked_at = NULL, updated_at = NOW()`,
      [account.id, user.id],
    );
    await client.query('UPDATE users SET primary_email_account_id = $1 WHERE id = $2', [account.id, user.id]);
    await client.query(
      `UPDATE invites SET used_by = $1, used_at = NOW()
       WHERE invite_type = 'mailbox_activation' AND lower(mailbox_email) = $2
         AND used_at IS NULL`,
      [user.id, email],
    );
    await client.query('COMMIT');
    return { user, account, created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
