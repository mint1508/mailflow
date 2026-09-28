import bcrypt from 'bcryptjs';
import { pool, query } from './db.js';
import { encrypt } from './encryption.js';
import { resetCpanelMailboxPassword } from './cpanelClient.js';
import { MailboxAuthenticationUnavailableError, verifyUserCredential } from './mailboxAuth.js';
import { destroyUserSessions } from './sessionSecurity.js';

export class PasswordChangeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PasswordChangeError';
    this.status = status;
  }
}

export async function changeUserPassword({ userId, currentPassword, newPassword, imapManager }, deps = {}) {
  const dbPool = deps.pool || pool;
  const dbQuery = deps.query || query;
  const verifyCredential = deps.verifyUserCredential || verifyUserCredential;
  const changeMailboxPassword = deps.resetCpanelMailboxPassword || resetCpanelMailboxPassword;
  const hashPassword = deps.hashPassword || (password => bcrypt.hash(password, 12));
  const encryptPassword = deps.encrypt || encrypt;
  const revokeSessions = deps.destroyUserSessions || destroyUserSessions;

  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw new PasswordChangeError('Current password is required');
  }
  if (typeof newPassword !== 'string') {
    throw new PasswordChangeError('New password is required');
  }
  if (newPassword.length > 128) {
    throw new PasswordChangeError('Password must not exceed 128 characters');
  }
  // eslint-disable-next-line no-control-regex -- credentials must not contain control bytes
  if (/[\u0000-\u001f\u007f]/.test(newPassword)) {
    throw new PasswordChangeError('Password contains unsupported characters');
  }
  if (newPassword === currentPassword) {
    throw new PasswordChangeError('New password must be different from the current password');
  }

  const userResult = await dbQuery(
    'SELECT id, username, password_hash FROM users WHERE id = $1',
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) throw new PasswordChangeError('Not authenticated', 401);

  const managedResult = await dbQuery(
    `SELECT id, email_address FROM email_accounts
     WHERE user_id = $1 AND managed_mailbox = true AND lower(email_address) = lower($2)
     ORDER BY created_at LIMIT 1`,
    [user.id, user.username],
  );
  const managedAccount = managedResult.rows[0] || null;
  const minimumLength = managedAccount ? 12 : 8;
  if (newPassword.length < minimumLength) {
    throw new PasswordChangeError(`Password must be at least ${minimumLength} characters`);
  }

  let verified;
  try {
    verified = await verifyCredential(user, currentPassword);
  } catch (error) {
    if (error instanceof MailboxAuthenticationUnavailableError) {
      throw new PasswordChangeError('Mailbox authentication is temporarily unavailable. Please try again later.', 503);
    }
    throw error;
  }
  if (!verified) throw new PasswordChangeError('Current password is incorrect', 401);

  const passwordHash = await hashPassword(newPassword);
  let mailboxChanged = false;
  if (managedAccount) {
    try {
      await changeMailboxPassword(managedAccount.email_address, newPassword);
    } catch (error) {
      throw new PasswordChangeError(error?.message || 'Could not change the mailbox password', 502);
    }
    mailboxChanged = true;
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);
    if (managedAccount) {
      const updated = await client.query(
        `UPDATE email_accounts
         SET auth_user = $1, auth_pass = $2, smtp_auth_user = $1, smtp_auth_pass = $2,
             sync_error = NULL, enabled = true
         WHERE id = $3 AND user_id = $4 AND managed_mailbox = true
         RETURNING id`,
        [managedAccount.email_address, encryptPassword(newPassword), managedAccount.id, user.id],
      );
      if (!updated.rows.length) throw new Error('Managed mailbox account is no longer available');
    }
    await client.query('DELETE FROM trusted_devices WHERE user_id = $1', [user.id]);
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    if (mailboxChanged) {
      await changeMailboxPassword(managedAccount.email_address, currentPassword)
        .catch(rollbackError => console.error('Could not restore mailbox password after database failure:', rollbackError.message));
    }
    throw new PasswordChangeError('Failed to save the new password', 500);
  } finally {
    client.release();
  }

  await revokeSessions(user.id);

  if (managedAccount && imapManager) {
    imapManager.clearConnectCooldown?.(managedAccount.id);
    imapManager.disconnectAccount?.(managedAccount.id)
      .then(() => dbQuery('SELECT * FROM email_accounts WHERE id = $1', [managedAccount.id]))
      .then(result => result?.rows?.[0] && imapManager.connectAccount?.(result.rows[0]))
      .catch(error => console.error('Reconnect after password change failed:', error.message));
  }

  return { managedMailbox: !!managedAccount };
}
