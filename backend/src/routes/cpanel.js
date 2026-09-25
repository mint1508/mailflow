import { Router } from 'express';
import { requireAdmin, requireMailboxManager } from '../middleware/auth.js';
import { query } from '../services/db.js';
import {
  getCpanelConfig,
  saveCpanelConfig,
  testCpanelConnection,
  syncCpanelMailboxes,
  createCpanelMailbox,
  createCpanelMailboxes,
  resetCpanelMailboxPassword,
  updateCpanelMailboxQuota,
  setCpanelMailboxSuspended,
  deleteCpanelMailbox,
  getCpanelLimits,
  getCpanelTokenStatus,
  getCpanelTokenInventory,
  checkCpanelTokenInventory,
} from '../services/cpanelClient.js';
import {
  createMailboxActivation,
  createExistingMailboxActivation,
  mailboxActivationState,
  resendMailboxActivation,
  sendManagedMailboxReset,
} from '../services/mailboxActivation.js';

const router = Router();
router.use(requireMailboxManager);

function publicConfig(config) {
  if (!config) return { configured: false };
  const tokenStatus = getCpanelTokenStatus(config.tokenExpiresAt);
  return {
    configured: true,
    host: config.host,
    port: config.port,
    username: config.username,
    domain: config.domain,
    tokenExpiresAt: config.tokenExpiresAt || null,
    ...tokenStatus,
    tokenPresent: true,
    updatedAt: config.updatedAt,
  };
}

function publicMailbox(mailbox) {
  const safeMailbox = { ...mailbox };
  delete safeMailbox.raw;
  return {
    ...safeMailbox,
    quota_bytes: mailbox.quota_bytes ?? mailbox.quotaBytes ?? null,
    disk_used_bytes: mailbox.disk_used_bytes ?? mailbox.diskUsedBytes ?? null,
    is_present: mailbox.is_present ?? true,
  };
}

async function withActivationState(mailboxes) {
  const states = await mailboxActivationState(mailboxes.map(mailbox => mailbox.email));
  return mailboxes.map(mailbox => {
    const state = states.get(mailbox.email?.toLowerCase());
    return {
      ...publicMailbox(mailbox),
      account_id: state?.account_id || null,
      owner_user_id: state?.user_id || null,
      contact_email: state?.contact_email || state?.recovery_email || null,
      activation_expires_at: state?.expires_at || null,
      activation_status: state?.used_at && state.enabled
        ? 'active'
        : state?.invite_id ? 'pending' : 'unmanaged',
    };
  });
}

function audit(actorUserId, action, success, detail = {}) {
  return query(
    `INSERT INTO cpanel_audit_events (actor_user_id, action, success, detail)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [actorUserId, action, success, JSON.stringify(detail)],
  ).catch(error => console.warn('cPanel audit write failed:', error.message));
}

router.get('/connection', async (_req, res) => {
  const config = await getCpanelConfig();
  res.json({ config: publicConfig(config) });
});

router.put('/connection', requireAdmin, async (req, res) => {
  let existing = null;
  try { existing = await getCpanelConfig({ includeToken: true }); } catch (error) {
    if (!/not configured/i.test(error.message)) throw error;
  }
  try {
    const config = await saveCpanelConfig(req.body, { existingConfig: existing });
    await audit(req.session.userId, 'connection_saved', true, { host: config.host, port: config.port, domain: config.domain });
    res.json({ config: publicConfig(config) });
  } catch (error) {
    await audit(req.session.userId, 'connection_saved', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/connection/test', requireAdmin, async (req, res) => {
  try {
    const hasInlineConfig = req.body && Object.keys(req.body).length > 0;
    const result = await testCpanelConnection(hasInlineConfig ? req.body : undefined);
    await audit(req.session.userId, 'connection_test', true, { mailboxCount: result.mailboxCount });
    res.json(result);
  } catch (error) {
    await audit(req.session.userId, 'connection_test', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.get('/connection/tokens', requireAdmin, async (_req, res) => {
  res.json({ inventory: await getCpanelTokenInventory() });
});

router.post('/connection/tokens/check', requireAdmin, async (req, res) => {
  const inventory = await checkCpanelTokenInventory();
  await audit(req.session.userId, 'token_inventory_check', inventory.ok, {
    tokenCount: inventory.tokens.length,
    error: inventory.error || undefined,
  });
  res.json({ inventory });
});

router.get('/mailboxes', async (_req, res) => {
  const config = await getCpanelConfig();
  if (!config) return res.json({ domain: null, mailboxes: [], limits: getCpanelLimits() });
  const result = await query(
    `SELECT id, email, domain, local_part, quota_bytes, quota_raw,
            disk_used_bytes, disk_used_raw, suspended, is_present, synced_at, updated_at
     FROM cpanel_mailboxes
     WHERE domain = $1
     ORDER BY email ASC`,
    [config.domain],
  );
  res.json({ domain: config?.domain || null, mailboxes: await withActivationState(result.rows), limits: getCpanelLimits() });
});

router.post('/mailboxes/sync', async (req, res) => {
  try {
    const mailboxes = await syncCpanelMailboxes(req.session.userId);
    res.json({ ok: true, mailboxCount: mailboxes.length, mailboxes: await withActivationState(mailboxes), limits: getCpanelLimits() });
  } catch (error) {
    await audit(req.session.userId, 'inventory_sync', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes', async (req, res) => {
  let result = null;
  try {
    if (!req.body?.contactEmail) return res.status(400).json({ error: 'Contact email is required' });
    result = await createCpanelMailbox({ ...req.body, password: undefined });
    const activation = await createMailboxActivation({
      actorUserId: req.session.userId,
      mailbox: result,
      contactEmail: req.body.contactEmail,
    });
    await audit(req.session.userId, 'mailbox_created', true, { email: result.email, quotaMb: result.quotaMb, activationEmailSent: activation.emailSent });
    res.status(201).json({
      ok: true,
      mailbox: { email: result.email, quotaMb: result.quotaMb },
      activation: {
        contactEmail: activation.contactEmail,
        activationUrl: activation.activationUrl,
        emailSent: activation.emailSent,
        emailError: activation.emailError,
        expiresAt: activation.expiresAt,
      },
    });
  } catch (error) {
    if (result?.email) await deleteCpanelMailbox(result.email).catch(cleanupError => console.warn('Mailbox cleanup failed:', cleanupError.message));
    await audit(req.session.userId, 'mailbox_created', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/bulk', async (req, res) => {
  try {
    const result = await createCpanelMailboxes(req.body || {});
    const activated = [];
    for (const mailbox of result.created) {
      const item = req.body?.items?.[mailbox.index] || {};
      try {
        const activation = await createMailboxActivation({
          actorUserId: req.session.userId,
          mailbox,
          contactEmail: item.contactEmail,
        });
        activated.push({
          index: mailbox.index,
          email: mailbox.email,
          quotaMb: mailbox.quotaMb,
          contactEmail: activation.contactEmail,
          activationUrl: activation.activationUrl,
          emailSent: activation.emailSent,
          emailError: activation.emailError,
        });
      } catch (error) {
        await deleteCpanelMailbox(mailbox.email).catch(cleanupError => console.warn('Mailbox cleanup failed:', cleanupError.message));
        result.failed.push({ index: mailbox.index, input: mailbox.email, error: error.message });
      }
    }
    result.created = activated;
    await audit(req.session.userId, 'mailboxes_bulk_created', result.failed.length === 0, {
      requestedCount: result.requestedCount,
      createdCount: result.created.length,
      failedCount: result.failed.length,
    });
    res.json({ ok: result.failed.length === 0, ...result });
  } catch (error) {
    await audit(req.session.userId, 'mailboxes_bulk_created', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/:email/password', async (req, res) => {
  try {
    const result = await resetCpanelMailboxPassword(req.params.email, req.body?.password);
    await audit(req.session.userId, 'mailbox_password_reset', true, { email: result.email });
    res.json({ ok: true, mailbox: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_password_reset', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/:email/activation/resend', async (req, res) => {
  try {
    const result = await resendMailboxActivation(req.params.email);
    await audit(req.session.userId, 'mailbox_activation_resent', true, { email: req.params.email });
    res.json({ ok: true, activation: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_activation_resent', false, { email: req.params.email, error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/:email/activation', async (req, res) => {
  try {
    const result = await createExistingMailboxActivation({
      actorUserId: req.session.userId,
      mailboxEmail: req.params.email,
      contactEmail: req.body?.contactEmail,
    });
    await audit(req.session.userId, 'mailbox_activation_created', true, { email: req.params.email, activationEmailSent: result.emailSent });
    res.status(201).json({ ok: true, activation: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_activation_created', false, { email: req.params.email, error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/:email/reset-link', async (req, res) => {
  try {
    const result = await sendManagedMailboxReset(req.params.email);
    await audit(req.session.userId, 'mailbox_reset_link_sent', true, { email: req.params.email });
    res.json({ ok: true, reset: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_reset_link_sent', false, { email: req.params.email, error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.patch('/mailboxes/:email/quota', async (req, res) => {
  try {
    const result = await updateCpanelMailboxQuota(req.params.email, req.body?.quotaMb);
    await query(
      `UPDATE cpanel_mailboxes
       SET quota_bytes = $1, quota_raw = $2, updated_at = NOW()
       WHERE email = $3`,
      [result.quotaMb * 1024 * 1024, String(result.quotaMb), result.email],
    );
    await audit(req.session.userId, 'mailbox_quota_updated', true, { email: result.email, quotaMb: result.quotaMb });
    res.json({ ok: true, mailbox: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_quota_updated', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/:email/suspend', async (req, res) => {
  try {
    const result = await setCpanelMailboxSuspended(req.params.email, true);
    await audit(req.session.userId, 'mailbox_suspended', true, { email: result.email });
    res.json({ ok: true, mailbox: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_suspended', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/:email/unsuspend', async (req, res) => {
  try {
    const result = await setCpanelMailboxSuspended(req.params.email, false);
    await audit(req.session.userId, 'mailbox_unsuspended', true, { email: result.email });
    res.json({ ok: true, mailbox: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_unsuspended', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.delete('/mailboxes/:email', async (req, res) => {
  try {
    const result = await deleteCpanelMailbox(req.params.email);
    // The provider is authoritative for deletion; remove the local projection
    // only after cPanel confirms success so a failed mutation remains visible.
    await query('DELETE FROM cpanel_mailboxes WHERE email = $1', [result.email]);
    const managedAccount = await query(
      `SELECT id, user_id FROM email_accounts
       WHERE managed_mailbox = true AND lower(email_address) = lower($1)`,
      [result.email],
    );
    if (managedAccount.rows.length) {
      await query('DELETE FROM invites WHERE email_account_id = $1', [managedAccount.rows[0].id]);
      await query('DELETE FROM email_accounts WHERE id = $1', [managedAccount.rows[0].id]);
      await query(
        `DELETE FROM users u
         WHERE u.id = $1 AND lower(u.username) = lower($2)
           AND NOT EXISTS (SELECT 1 FROM email_accounts ea WHERE ea.user_id = u.id)`,
        [managedAccount.rows[0].user_id, result.email],
      );
    }
    await audit(req.session.userId, 'mailbox_deleted', true, { email: result.email });
    res.json({ ok: true, mailbox: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_deleted', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.get('/audit', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const result = await query(
    `SELECT id, action, success, detail, created_at
     FROM cpanel_audit_events ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  res.json({ events: result.rows });
});

export default router;
