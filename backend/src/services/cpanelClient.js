import { query, withTransaction } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';

export const CPANEL_SETTINGS_KEY = 'cpanel_connector';
export const CPANEL_DEFAULT_PORT = 2083;
const REQUEST_TIMEOUT_MS = 15_000;

function cleanHost(value) {
  const host = String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!host || host.includes('/') || host.includes('@')) throw new Error('cPanel host must be a hostname');
  return host.toLowerCase();
}

function cleanDomain(value) {
  const domain = String(value || '').trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error('cPanel domain must be a valid hostname');
  }
  return domain;
}

export async function normalizeCpanelConfig(input, { tokenRequired = true } = {}) {
  const host = cleanHost(input?.host);
  const port = Number(input?.port || CPANEL_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('cPanel port must be between 1 and 65535');
  const username = String(input?.username || '').trim();
  if (!username || username.length > 255 || /\s/.test(username)) throw new Error('cPanel username is required');
  const domain = cleanDomain(input?.domain);
  const token = input?.token == null ? '' : String(input.token).trim();
  if (tokenRequired && !token) throw new Error('cPanel API token is required');

  const hostError = await validateHost(host);
  if (hostError) throw new Error(`cPanel host: ${hostError}`);
  return { host, port, username, domain, token };
}

export async function getCpanelConfig({ includeToken = false } = {}) {
  const result = await query('SELECT value FROM system_settings WHERE key = $1', [CPANEL_SETTINGS_KEY]);
  if (!result.rows.length) return null;
  let stored;
  try { stored = JSON.parse(result.rows[0].value); } catch { throw new Error('Stored cPanel configuration is corrupted'); }
  const token = stored.token ? decrypt(stored.token) : null;
  if (!token) throw new Error('Stored cPanel API token is unavailable; save the connector again');
  return {
    host: stored.host,
    port: stored.port || CPANEL_DEFAULT_PORT,
    username: stored.username,
    domain: stored.domain,
    ...(includeToken ? { token } : {}),
    tokenPresent: true,
    updatedAt: stored.updatedAt || null,
  };
}

export async function saveCpanelConfig(input, { existingToken = null } = {}) {
  const normalized = await normalizeCpanelConfig(input, { tokenRequired: !existingToken });
  const token = normalized.token || existingToken;
  if (!token) throw new Error('cPanel API token is required');
  const stored = {
    host: normalized.host,
    port: normalized.port,
    username: normalized.username,
    domain: normalized.domain,
    token: encrypt(token),
    updatedAt: new Date().toISOString(),
  };
  await query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [CPANEL_SETTINGS_KEY, JSON.stringify(stored)],
  );
  return { ...normalized, tokenPresent: true, token: undefined, updatedAt: stored.updatedAt };
}

function parseBytes(value) {
  if (value == null || value === '' || String(value).toLowerCase() === 'unlimited') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const text = String(value).trim().replace(/,/g, '');
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return Math.round(numeric);
  const match = text.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)$/i);
  if (!match) return null;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.round(Number(match[1]) * units[match[2].toLowerCase()]);
}

function firstValue(row, keys) {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null) return row[key];
  return null;
}

export function normalizeMailbox(row, configuredDomain) {
  const domain = String(firstValue(row, ['domain']) || configuredDomain).trim().toLowerCase();
  const explicitEmail = firstValue(row, ['email', 'email_address', 'address']);
  const localPart = String(firstValue(row, ['user', 'login', 'local_part', 'name']) || '').trim().toLowerCase();
  const email = String(explicitEmail || (localPart && domain ? `${localPart}@${domain}` : '')).trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  const at = email.lastIndexOf('@');
  const normalizedLocalPart = email.slice(0, at);
  const normalizedDomain = email.slice(at + 1) || domain;
  const quotaRaw = firstValue(row, ['diskquota', 'quota', 'quota_bytes', 'humandiskquota']);
  const diskUsedRaw = firstValue(row, ['diskused', 'disk_used', 'diskused_bytes', 'humandiskused']);
  const suspended = ['suspended', 'suspended_login', 'suspended_outgoing', 'suspended_incoming']
    .some(key => row?.[key] === true || row?.[key] === 1 || String(row?.[key]).toLowerCase() === '1' || String(row?.[key]).toLowerCase() === 'true');
  return {
    email,
    domain: normalizedDomain,
    localPart: normalizedLocalPart,
    quotaBytes: parseBytes(quotaRaw),
    quotaRaw: quotaRaw == null ? null : String(quotaRaw),
    diskUsedBytes: parseBytes(diskUsedRaw),
    diskUsedRaw: diskUsedRaw == null ? null : String(diskUsedRaw),
    suspended,
    raw: row && typeof row === 'object' ? row : {},
  };
}

async function cpanelRequest(config, functionName, params = {}) {
  const url = new URL(`https://${config.host}:${config.port}/execute/Email/${functionName}`);
  url.searchParams.set('api.version', '1');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await safeFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `cpanel ${config.username}:${config.token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    }, { requireHttps: true });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`cPanel returned HTTP ${response.status}`);
    if (!body?.result || body.result.status !== 1) {
      const details = body?.result?.errors?.filter(Boolean).join('; ');
      throw new Error(details || 'cPanel rejected the API request');
    }
    return body.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('cPanel request timed out', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function testCpanelConnection(configInput) {
  let config;
  if (configInput?.host) {
    const saved = configInput.token ? null : await getCpanelConfig({ includeToken: true });
    config = await normalizeCpanelConfig({ ...configInput, token: configInput.token || saved?.token }, { tokenRequired: true });
  } else {
    config = await getCpanelConfig({ includeToken: true });
  }
  if (!config) throw new Error('cPanel connector is not configured');
  const result = await cpanelRequest(config, 'list_pops_with_disk', { domain: config.domain });
  return { ok: true, mailboxCount: Array.isArray(result.data) ? result.data.length : 0 };
}

export async function fetchCpanelMailboxes(configInput) {
  let config;
  if (configInput?.host) {
    const saved = configInput.token ? null : await getCpanelConfig({ includeToken: true });
    config = await normalizeCpanelConfig({ ...configInput, token: configInput.token || saved?.token }, { tokenRequired: true });
  } else {
    config = await getCpanelConfig({ includeToken: true });
  }
  if (!config) throw new Error('cPanel connector is not configured');
  const result = await cpanelRequest(config, 'list_pops_with_disk', { domain: config.domain });
  const rows = Array.isArray(result.data) ? result.data : [];
  return rows.map(row => normalizeMailbox(row, config.domain)).filter(Boolean);
}

export async function syncCpanelMailboxes(actorUserId = null) {
  const mailboxes = await fetchCpanelMailboxes();
  await withTransaction(async client => {
    const config = await getCpanelConfig();
    const domain = config.domain;
    await client.query('UPDATE cpanel_mailboxes SET is_present = false, updated_at = NOW() WHERE domain = $1', [domain]);
    for (const mailbox of mailboxes) {
      await client.query(
        `INSERT INTO cpanel_mailboxes
          (email, domain, local_part, quota_bytes, quota_raw, disk_used_bytes, disk_used_raw, suspended, is_present, raw, synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9::jsonb,NOW(),NOW())
         ON CONFLICT (email) DO UPDATE SET
           domain = EXCLUDED.domain,
           local_part = EXCLUDED.local_part,
           quota_bytes = EXCLUDED.quota_bytes,
           quota_raw = EXCLUDED.quota_raw,
           disk_used_bytes = EXCLUDED.disk_used_bytes,
           disk_used_raw = EXCLUDED.disk_used_raw,
           suspended = EXCLUDED.suspended,
           is_present = true,
           raw = EXCLUDED.raw,
           synced_at = NOW(),
           updated_at = NOW()`,
        [mailbox.email, mailbox.domain, mailbox.localPart, mailbox.quotaBytes, mailbox.quotaRaw, mailbox.diskUsedBytes, mailbox.diskUsedRaw, mailbox.suspended, JSON.stringify(mailbox.raw)],
      );
    }
    await client.query(
      `INSERT INTO cpanel_audit_events (actor_user_id, action, success, detail)
       VALUES ($1, 'inventory_sync', true, $2::jsonb)`,
      [actorUserId, JSON.stringify({ domain, mailboxCount: mailboxes.length })],
    );
  });
  return mailboxes;
}
