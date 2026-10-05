import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { query } from '/app/src/services/db.js';
import { resetCpanelMailboxPassword, syncCpanelMailboxes } from '/app/src/services/cpanelClient.js';

const email = process.env.UAT_EMAIL || 'uat-muo24muj8248@hippy.vn';
const password = `Uat-${crypto.randomBytes(12).toString('base64url')}!9`;
const inviteToken = crypto.randomBytes(32).toString('hex');

const account = await query(
  'SELECT id, user_id FROM email_accounts WHERE lower(email_address) = $1',
  [email],
);
if (!account.rows[0]) throw new Error(`Pending account not found: ${email}`);
if (account.rows[0].user_id) throw new Error(`Account is already activated: ${email}`);

const admin = await query('SELECT id FROM users WHERE is_admin = true ORDER BY created_at LIMIT 1');
if (!admin.rows[0]?.id) throw new Error('No admin user available');

await resetCpanelMailboxPassword(email, password);
const invite = await query(
  `UPDATE invites
      SET token = $1, expires_at = NOW() + INTERVAL '7 days', used_at = NULL, used_by = NULL
    WHERE lower(mailbox_email) = $2 AND used_at IS NULL
    RETURNING id`,
  [inviteToken, email],
);
if (!invite.rows[0]) throw new Error(`Pending invite not found: ${email}`);

const registration = await fetch('http://127.0.0.1:3000/api/auth/register', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
  },
  body: JSON.stringify({ username: email, password, inviteToken }),
});
if (!registration.ok) {
  throw new Error(`Mailflow registration failed: HTTP ${registration.status} ${await registration.text()}`);
}

await syncCpanelMailboxes(admin.rows[0].id);

const apiBase = String(process.env.AUTHENTIK_API_URL || '').replace(/\/$/, '');
const apiToken = process.env.AUTHENTIK_API_TOKEN;
if (!apiBase || !apiToken) throw new Error('Authentik API configuration is missing');

const usersResponse = await fetch(
  `${apiBase}/core/users/?search=${encodeURIComponent(email)}&page_size=100`,
  { headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' } },
);
if (!usersResponse.ok) throw new Error(`Authentik lookup failed: HTTP ${usersResponse.status}`);
const users = await usersResponse.json();
const user = (users.results || []).find(candidate => (
  String(candidate.username).toLowerCase() === email.toLowerCase()
));
if (!user?.pk) throw new Error('Authentik lifecycle did not create the UAT user');

const passwordResponse = await fetch(`${apiBase}/core/users/${user.pk}/set_password/`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ password }),
});
if (!passwordResponse.ok) {
  throw new Error(`Authentik password setup failed: HTTP ${passwordResponse.status}`);
}

await fs.writeFile(
  '/tmp/uat-credentials.json',
  `${JSON.stringify({ email, password }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify({ ok: true, email, authentikPk: user.pk }));
