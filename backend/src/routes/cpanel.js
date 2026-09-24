import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { query } from '../services/db.js';
import {
  getCpanelConfig,
  saveCpanelConfig,
  testCpanelConnection,
  syncCpanelMailboxes,
} from '../services/cpanelClient.js';

const router = Router();
router.use(requireAdmin);

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
  return {
    ...mailbox,
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

router.put('/connection', async (req, res) => {
  let existing = null;
  try { existing = await getCpanelConfig({ includeToken: true }); } catch (error) {
    if (!/not configured/i.test(error.message)) throw error;
  }
  try {
    const config = await saveCpanelConfig(req.body, { existingToken: existing?.token || null });
    await audit(req.session.userId, 'connection_saved', true, { host: config.host, port: config.port, domain: config.domain });
    res.json({ config: publicConfig(config) });
  } catch (error) {
    await audit(req.session.userId, 'connection_saved', false, { error: error.message });
    res.status(400).json({ error: error.message });
  }
});

router.post('/connection/test', async (req, res) => {
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
  const result = await query(
    `SELECT id, email, domain, local_part, quota_bytes, quota_raw,
            disk_used_bytes, disk_used_raw, suspended, is_present, synced_at, updated_at
     FROM cpanel_mailboxes
     ORDER BY email ASC`,
  );
  const config = await getCpanelConfig();
  res.json({ domain: config?.domain || null, mailboxes: result.rows });
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
