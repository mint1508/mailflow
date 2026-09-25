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
} from '../services/cpanelClient.js';

const router = Router();
router.use(requireMailboxManager);

function publicConfig(config) {
  if (!config) return { configured: false };
  return {
    configured: true,
    host: config.host,
    port: config.port,
    username: config.username,
    domain: config.domain,
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
  res.json({ domain: config?.domain || null, mailboxes: result.rows, limits: getCpanelLimits() });
});

router.post('/mailboxes/sync', async (req, res) => {
  try {
    const mailboxes = await syncCpanelMailboxes(req.session.userId);
    res.json({ ok: true, mailboxCount: mailboxes.length, mailboxes: mailboxes.map(publicMailbox) });
  } catch (error) {
    await audit(req.session.userId, 'inventory_sync', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes', async (req, res) => {
  try {
    const result = await createCpanelMailbox(req.body || {});
    await audit(req.session.userId, 'mailbox_created', true, { email: result.email, quotaMb: result.quotaMb });
    res.status(201).json({ ok: true, mailbox: result });
  } catch (error) {
    await audit(req.session.userId, 'mailbox_created', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/mailboxes/bulk', async (req, res) => {
  try {
    const result = await createCpanelMailboxes(req.body || {});
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
