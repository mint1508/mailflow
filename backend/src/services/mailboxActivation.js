import crypto from 'crypto';
import { pool, query } from './db.js';
import { encrypt } from './encryption.js';
import { sendSystemEmail } from './mailer.js';
import { getCpanelConfig } from './cpanelClient.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(value, label) {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`${label} must be a valid email address`);
  return email;
}

function activationUrl(token) {
  if (!process.env.APP_URL) throw new Error('APP_URL is not configured');
  return `${process.env.APP_URL}/register?invite=${token}`;
}

async function deliverActivation({ contactEmail, mailboxEmail, url }) {
  const subject = `Activate your ${mailboxEmail} mailbox`;
  const text = [
    `Your MailFlow mailbox ${mailboxEmail} is ready.`,
    '',
    'Open the link below to choose your password and activate your account:',
    url,
    '',
    'This link expires in 7 days and can only be used once.',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;color:#1a1a1a;">
      <div style="margin-bottom:24px;font-size:22px;font-weight:700;">MailFlow</div>
      <h2 style="margin:0 0 12px;font-size:18px;">Your mailbox is ready</h2>
      <p style="color:#555;line-height:1.6;margin:0 0 12px;">Your email address is <strong>${mailboxEmail}</strong>.</p>
      <p style="color:#555;line-height:1.6;margin:0 0 24px;">Choose your password to activate MailFlow.</p>
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#7c6af7;color:white;border-radius:8px;text-decoration:none;font-weight:500;">Activate MailFlow</a>
      <p style="color:#999;font-size:12px;margin:24px 0 0;">This link expires in 7 days and can only be used once.</p>
    </div>`;
  await sendSystemEmail({ to: contactEmail, subject, text, html });
}

export async function createMailboxActivation({ actorUserId, mailbox, contactEmail }) {
  const cleanContactEmail = normalizeEmail(contactEmail, 'Contact email');
  const mailboxEmail = normalizeEmail(mailbox?.email, 'Mailbox email');
  const config = await getCpanelConfig();
  if (!config) throw new Error('cPanel connector is not configured');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const url = activationUrl(token);
  const client = await pool.connect();
  let account;
  try {
    await client.query('BEGIN');
    const userExists = await client.query('SELECT id FROM users WHERE lower(username) = $1', [mailboxEmail]);
    if (userExists.rows.length) throw new Error('A MailFlow user already exists for this mailbox');

    const duplicate = await client.query('SELECT id FROM email_accounts WHERE lower(email_address) = $1 FOR UPDATE', [mailboxEmail]);
    if (duplicate.rows.length) throw new Error('This mailbox is already linked to MailFlow');

    const accountResult = await client.query(
      `INSERT INTO email_accounts (
         user_id, name, email_address, color, protocol, imap_host, imap_port, imap_tls,
         smtp_host, smtp_port, smtp_tls, auth_user, auth_pass, smtp_auth_user,
         smtp_auth_pass, enabled, managed_mailbox
       ) VALUES ($1,$2,$2,'#6366f1','imap',$3,993,true,$3,465,'SSL',$2,$4,$2,$4,false,true)
       RETURNING id, email_address`,
      [null, mailboxEmail, config.host, encrypt(mailbox.password)],
    );
    account = accountResult.rows[0];
    await client.query(
      `INSERT INTO invites (email, token, created_by, expires_at, invite_type, mailbox_email, email_account_id)
       VALUES ($1,$2,$3,$4,'mailbox_activation',$5,$6)`,
      [cleanContactEmail, token, actorUserId, expiresAt, mailboxEmail, account.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  let emailSent = false;
  let emailError = null;
  try {
    await deliverActivation({ contactEmail: cleanContactEmail, mailboxEmail, url });
    emailSent = true;
  } catch (error) {
    emailError = error.message;
  }
  return { account, contactEmail: cleanContactEmail, activationUrl: url, emailSent, emailError, expiresAt };
}

export async function resendMailboxActivation(mailboxEmail) {
  const normalized = normalizeEmail(mailboxEmail, 'Mailbox email');
  const result = await query(
    `SELECT id, email, mailbox_email
     FROM invites
     WHERE invite_type = 'mailbox_activation' AND lower(mailbox_email) = $1 AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [normalized],
  );
  if (!result.rows.length) throw new Error('No pending activation was found for this mailbox');
  const invite = result.rows[0];
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const url = activationUrl(token);
  await query('UPDATE invites SET token = $1, expires_at = $2 WHERE id = $3', [token, expiresAt, invite.id]);
  await deliverActivation({ contactEmail: invite.email, mailboxEmail: invite.mailbox_email, url });
  return { activationUrl: url, contactEmail: invite.email, expiresAt };
}

export async function createExistingMailboxActivation({ actorUserId, mailboxEmail, contactEmail }) {
  const normalized = normalizeEmail(mailboxEmail, 'Mailbox email');
  const cleanContactEmail = normalizeEmail(contactEmail, 'Contact email');
  const config = await getCpanelConfig();
  if (!config) throw new Error('cPanel connector is not configured');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const url = activationUrl(token);
  const client = await pool.connect();
  let accountId;
  try {
    await client.query('BEGIN');
    const inventory = await client.query(
      `SELECT email FROM cpanel_mailboxes
       WHERE lower(email) = $1 AND lower(domain) = lower($2) AND is_present = true
       FOR UPDATE`,
      [normalized, config.domain],
    );
    if (!inventory.rows.length) {
      throw new Error('This address is not an active mailbox in the configured cPanel domain');
    }

    const existingUser = await client.query('SELECT id FROM users WHERE lower(username) = $1 FOR UPDATE', [normalized]);
    if (existingUser.rows.length) throw new Error('A MailFlow user already exists for this mailbox');

    const existingAccount = await client.query(
      `SELECT id, user_id, managed_mailbox FROM email_accounts
       WHERE lower(email_address) = $1 ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [normalized],
    );
    if (existingAccount.rows.length) {
      const pending = existingAccount.rows[0];
      if (pending.user_id || !pending.managed_mailbox) {
        throw new Error('This mailbox is already linked to MailFlow');
      }
      accountId = pending.id;
      await client.query(
        `UPDATE email_accounts
         SET auth_pass = NULL, smtp_auth_pass = NULL, enabled = false
         WHERE id = $1`,
        [accountId],
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO email_accounts (
           user_id, name, email_address, color, protocol, imap_host, imap_port, imap_tls,
           smtp_host, smtp_port, smtp_tls, auth_user, smtp_auth_user,
           enabled, managed_mailbox
         ) VALUES ($1,$2,$2,'#6366f1','imap',$3,993,true,$3,465,'SSL',$2,$2,false,true)
         RETURNING id`,
        [null, normalized, config.host],
      );
      accountId = inserted.rows[0].id;
    }
    await client.query(
      `UPDATE invites SET expires_at = NOW()
       WHERE invite_type = 'mailbox_activation' AND lower(mailbox_email) = $1 AND used_at IS NULL`,
      [normalized],
    );
    await client.query(
      `INSERT INTO invites (email, token, created_by, expires_at, invite_type, mailbox_email, email_account_id)
       VALUES ($1,$2,$3,$4,'mailbox_activation',$5,$6)`,
      [cleanContactEmail, token, actorUserId, expiresAt, normalized, accountId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  let emailSent = false;
  let emailError = null;
  try {
    await deliverActivation({ contactEmail: cleanContactEmail, mailboxEmail: normalized, url });
    emailSent = true;
  } catch (error) {
    emailError = error.message;
  }
  return { accountId, contactEmail: cleanContactEmail, activationUrl: url, emailSent, emailError, expiresAt };
}

export async function mailboxActivationState(mailboxEmails) {
  if (!mailboxEmails.length) return new Map();
  const result = await query(
    `SELECT DISTINCT ON (lower(ea.email_address))
            lower(ea.email_address) AS key, ea.id AS account_id, ea.user_id, ea.enabled,
            u.username, u.recovery_email,
            i.id AS invite_id, i.email AS contact_email, i.expires_at, i.used_at
     FROM email_accounts ea
     LEFT JOIN users u ON u.id = ea.user_id
     LEFT JOIN invites i ON i.email_account_id = ea.id AND i.invite_type = 'mailbox_activation'
     WHERE ea.managed_mailbox = true AND lower(ea.email_address) = ANY($1)
     ORDER BY lower(ea.email_address), i.created_at DESC`,
    [mailboxEmails.map(email => email.toLowerCase())],
  );
  return new Map(result.rows.map(row => [row.key, row]));
}

export async function sendManagedMailboxReset(mailboxEmail) {
  const normalized = normalizeEmail(mailboxEmail, 'Mailbox email');
  const result = await query(
    `SELECT u.id AS user_id, u.recovery_email
     FROM email_accounts ea
     JOIN users u ON u.id = ea.user_id
     WHERE ea.managed_mailbox = true AND lower(ea.email_address) = $1`,
    [normalized],
  );
  const target = result.rows[0];
  if (!target?.recovery_email) throw new Error('This mailbox has no recovery email');
  if (!process.env.APP_URL) throw new Error('APP_URL is not configured');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const url = `${process.env.APP_URL}/?reset_token=${rawToken}`;
  await sendSystemEmail({
    to: target.recovery_email,
    subject: `Reset your ${normalized} password`,
    text: `Reset the password for ${normalized} using this link. It expires in 1 hour.\n\n${url}`,
    html: `<div style="font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;color:#1a1a1a;"><h2>Reset your MailFlow password</h2><p>This changes the password for <strong>${normalized}</strong>.</p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#7c6af7;color:white;border-radius:8px;text-decoration:none;font-weight:500;">Reset password</a><p style="color:#999;font-size:12px;">This link expires in 1 hour.</p></div>`,
  });
  await query('DELETE FROM password_reset_tokens WHERE user_id = $1', [target.user_id]);
  await query(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [target.user_id, tokenHash, expiresAt],
  );
  return { contactEmail: target.recovery_email, expiresAt };
}
