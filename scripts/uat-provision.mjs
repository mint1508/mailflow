import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { pool, query } from '/app/src/services/db.js';
import { createCpanelMailbox, getCpanelConfig, syncCpanelMailboxes } from '/app/src/services/cpanelClient.js';

const suffix = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const localPart = `uat-${suffix}`;
const password = `Uat-${crypto.randomBytes(12).toString('base64url')}!9`;
const admin = await query('SELECT id FROM users WHERE is_admin = true ORDER BY created_at LIMIT 1');
if (!admin.rows[0]?.id) throw new Error('No admin user available for UAT provisioning');
const actorUserId = admin.rows[0].id;

const mailbox = await createCpanelMailbox({ localPart, password, quotaMb: 1024 });
await syncCpanelMailboxes(actorUserId);
const config = await getCpanelConfig();
const token = crypto.randomBytes(32).toString('hex');
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const client = await pool.connect();
let accountId;
try {
  await client.query('BEGIN');
  const account = await client.query(
    `INSERT INTO email_accounts (
       user_id, name, email_address, color, protocol, imap_host, imap_port, imap_tls,
       smtp_host, smtp_port, smtp_tls, auth_user, smtp_auth_user, enabled, managed_mailbox
     ) VALUES (NULL,$1,$1,'#6366f1','imap',$2,993,true,$2,465,'SSL',$1,$1,false,true)
     RETURNING id`,
    [mailbox.email, config.host],
  );
  accountId = account.rows[0].id;
  await client.query(
    `INSERT INTO invites (email, token, created_by, expires_at, invite_type, mailbox_email, email_account_id, mailbox_role)
     VALUES ($1,$2,$3,$4,'mailbox_activation',$1,$5,'user')`,
    [mailbox.email, token, actorUserId, expiresAt, accountId],
  );
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
}

const registration = await fetch('http://127.0.0.1:3000/api/auth/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: mailbox.email, password, inviteToken: token }),
});
if (!registration.ok) throw new Error(`Mailflow registration failed: HTTP ${registration.status} ${await registration.text()}`);
await syncCpanelMailboxes(actorUserId);

const apiBase = String(process.env.AUTHENTIK_API_URL || '').replace(/\/$/, '');
const apiToken = process.env.AUTHENTIK_API_TOKEN;
const usersResponse = await fetch(`${apiBase}/core/users/?search=${encodeURIComponent(mailbox.email)}&page_size=100`, { headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' } });
if (!usersResponse.ok) throw new Error(`Authentik user lookup failed: HTTP ${usersResponse.status}`);
const users = await usersResponse.json();
const user = (users.results || []).find(candidate => String(candidate.username).toLowerCase() === mailbox.email.toLowerCase());
if (!user?.pk) throw new Error('Authentik lifecycle did not create the UAT user');
const passwordResponse = await fetch(`${apiBase}/core/users/${user.pk}/set_password/`, {
  method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});
if (!passwordResponse.ok) throw new Error(`Authentik password setup failed: HTTP ${passwordResponse.status} ${await passwordResponse.text()}`);

await fs.writeFile('/tmp/uat-credentials.json', JSON.stringify({ email: mailbox.email, password, quotaMb: mailbox.quotaMb }), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, email: mailbox.email, quotaMb: mailbox.quotaMb }));
