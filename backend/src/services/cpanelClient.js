import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';

export const CPANEL_SETTINGS_KEY = 'cpanel_connector';
export const CPANEL_DEFAULT_PORT = 2083;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_MAILBOXES = 15;
const DEFAULT_MAX_QUOTA_MB = 10 * 1024;
const MAX_CPANEL_ERROR_LENGTH = 500;

function sameEndpoint(left, right) {
  return left?.host === right?.host
    && Number(left?.port || CPANEL_DEFAULT_PORT) === Number(right?.port || CPANEL_DEFAULT_PORT)
    && left?.username === right?.username
    && left?.domain === right?.domain;
}

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

function cleanLocalPart(value) {
  const localPart = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,63}[a-z0-9])?$/.test(localPart)) {
    throw new Error('Mailbox name must use letters, numbers, dots, hyphens, or underscores');
  }
  return localPart;
}

function normalizeQuotaMb(value) {
  const quotaMb = Number(value);
  const maxQuotaMb = Number(process.env.CPANEL_MAX_QUOTA_MB || DEFAULT_MAX_QUOTA_MB);
  if (!Number.isInteger(quotaMb) || quotaMb < 1 || quotaMb > maxQuotaMb) {
    throw new Error(`Mailbox quota must be between 1 and ${maxQuotaMb} MB`);
  }
  return quotaMb;
}

function validateMailboxPassword(value) {
  const password = String(value || '');
  // Passwords must not contain control characters that can corrupt exports/logs.
  // eslint-disable-next-line no-control-regex
  if (password.length < 12 || password.length > 128 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new Error('Mailbox password must be between 12 and 128 characters');
  }
  return password;
}

export function generateMailboxPassword(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^*-_';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
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

export async function saveCpanelConfig(input, { existingConfig = null } = {}) {
  const normalized = await normalizeCpanelConfig(input, { tokenRequired: false });
  const token = normalized.token || (sameEndpoint(normalized, existingConfig) ? existingConfig?.token : null);
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

async function resolveCpanelConfig(configInput) {
  if (!configInput?.host) return getCpanelConfig({ includeToken: true });

  const normalized = await normalizeCpanelConfig(configInput, { tokenRequired: false });
  if (normalized.token) return normalized;

  const saved = await getCpanelConfig({ includeToken: true });
  if (!saved || !sameEndpoint(normalized, saved)) {
    throw new Error('A new cPanel API token is required when the connection target changes');
  }
  return { ...normalized, token: saved.token };
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

const INVENTORY_ROW_KEYS = [
  'email', 'email_address', 'address', 'user', 'login', 'local_part', 'name', 'domain',
  'diskquota', 'quota', 'quota_bytes', 'humandiskquota', 'diskused', 'disk_used',
  'diskused_bytes', 'humandiskused', 'suspended', 'suspended_login',
  'suspended_outgoing', 'suspended_incoming',
];

export function normalizeMailbox(row, configuredDomain) {
  const domain = String(firstValue(row, ['domain']) || configuredDomain).trim().toLowerCase();
  const explicitEmail = firstValue(row, ['email', 'email_address', 'address']);
  const localPart = String(firstValue(row, ['user', 'login', 'local_part', 'name']) || '').trim().toLowerCase();
  const email = String(explicitEmail || (localPart && domain ? `${localPart}@${domain}` : '')).trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  const at = email.lastIndexOf('@');
  const normalizedLocalPart = email.slice(0, at);
  const normalizedDomain = email.slice(at + 1) || domain;
  if (normalizedDomain !== String(configuredDomain || '').trim().toLowerCase()) return null;
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
    raw: INVENTORY_ROW_KEYS.reduce((safe, key) => {
      if (row?.[key] !== undefined && row?.[key] !== null) safe[key] = row[key];
      return safe;
    }, {}),
  };
}

function collectCpanelErrorText(value, output = [], seen = new Set()) {
  if (value == null || output.length >= 10) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) output.push(text);
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectCpanelErrorText(item, output, seen);
    return output;
  }
  for (const key of ['message', 'error', 'errors', 'messages', 'reason', 'statusmsg']) {
    if (value[key] !== undefined) collectCpanelErrorText(value[key], output, seen);
  }
  return output;
}

function extractCpanelResult(body) {
  if (body?.result && typeof body.result === 'object') return body.result;
  if (body?.cpanelresult?.result && typeof body.cpanelresult.result === 'object') return body.cpanelresult.result;
  if (body?.cpanelresult && typeof body.cpanelresult === 'object') return body.cpanelresult;
  if (body && typeof body === 'object' && ('status' in body || 'data' in body || 'errors' in body)) return body;
  return null;
}

// cPanel has returned errors as arrays, strings, and nested objects across API versions.
// Keep the useful part of the provider response while avoiding raw bodies in the UI/audit log.
export function normalizeCpanelApiError(body, { httpStatus = null, token = '' } = {}) {
  const result = extractCpanelResult(body);
  const values = collectCpanelErrorText([
    result?.errors,
    result?.messages,
    body?.errors,
    body?.messages,
    body?.error,
    body?.message,
  ]);
  const unique = [...new Set(values)];
  const redact = text => token ? text.split(token).join('[redacted]') : text;
  const details = unique.map(redact).join('; ').slice(0, MAX_CPANEL_ERROR_LENGTH);
  const status = Number(httpStatus);

  if (status >= 400) {
    return details ? `cPanel returned HTTP ${status}: ${details}` : `cPanel returned HTTP ${status}`;
  }
  if (details) return `cPanel rejected the API request: ${details}`;
  if (body == null) return 'cPanel returned an invalid or non-JSON response. Check the host, port, and API token.';
  return 'cPanel rejected the API request without a reason. Check the cPanel username, API token, and domain.';
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
    const responseText = await response.text();
    let body = null;
    try {
      body = responseText ? JSON.parse(responseText) : null;
    } catch {
      // Some cPanel auth failures return plain text instead of JSON; preserve only
      // that bounded text so the caller can see the provider's reason.
      const trimmed = responseText.trim();
      if (trimmed && !/^<!doctype html|^<html[\s>]/i.test(trimmed)) {
        body = { message: trimmed.slice(0, MAX_CPANEL_ERROR_LENGTH) };
      }
    }
    if (!response.ok) throw new Error(normalizeCpanelApiError(body, { httpStatus: response.status, token: config.token }));
    const result = extractCpanelResult(body);
    if (!result || Number(result.status) !== 1) {
      throw new Error(normalizeCpanelApiError(body, { token: config.token }));
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('cPanel request timed out', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getProvisioningContext() {
  const config = await getCpanelConfig({ includeToken: true });
  if (!config) throw new Error('cPanel connector is not configured');
  const current = await fetchCpanelMailboxes(config);
  const maxMailboxes = Number(process.env.CPANEL_MAX_MAILBOXES || DEFAULT_MAX_MAILBOXES);
  return { config, current, maxMailboxes };
}

export async function createCpanelMailbox({ localPart, password, quotaMb }) {
  const { config, current, maxMailboxes } = await getProvisioningContext();
  if (current.length >= maxMailboxes) throw new Error(`Mailbox limit reached (${maxMailboxes})`);
  const cleanPart = cleanLocalPart(localPart);
  if (current.some(mailbox => mailbox.localPart === cleanPart)) throw new Error('Mailbox already exists');
  const cleanPassword = password ? validateMailboxPassword(password) : generateMailboxPassword();
  const cleanQuota = normalizeQuotaMb(quotaMb);
  await cpanelRequest(config, 'add_pop', {
    email: cleanPart,
    password: cleanPassword,
    quota: cleanQuota,
    domain: config.domain,
  });
  return { email: `${cleanPart}@${config.domain}`, password: cleanPassword, quotaMb: cleanQuota };
}

async function resolveMailboxTarget(email) {
  const config = await getCpanelConfig({ includeToken: true });
  if (!config) throw new Error('cPanel connector is not configured');
  const normalized = String(email || '').trim().toLowerCase();
  const expectedSuffix = `@${config.domain}`;
  if (!normalized.endsWith(expectedSuffix)) throw new Error('Mailbox must belong to the configured cPanel domain');
  const localPart = cleanLocalPart(normalized.slice(0, -expectedSuffix.length));
  return { config, localPart, email: `${localPart}${expectedSuffix}` };
}

export async function resetCpanelMailboxPassword(email, password) {
  const { config, localPart } = await resolveMailboxTarget(email);
  const cleanPassword = password ? validateMailboxPassword(password) : generateMailboxPassword();
  await cpanelRequest(config, 'passwd_pop', { email: localPart, password: cleanPassword, domain: config.domain });
  return { email: `${localPart}@${config.domain}`, password: cleanPassword };
}

export async function setCpanelMailboxSuspended(email, suspended) {
  const { config, localPart } = await resolveMailboxTarget(email);
  await cpanelRequest(config, suspended ? 'suspend_login' : 'unsuspend_login', {
    email: localPart,
    domain: config.domain,
  });
  return { email: `${localPart}@${config.domain}`, suspended };
}

export async function deleteCpanelMailbox(email) {
  const { config, localPart } = await resolveMailboxTarget(email);
  await cpanelRequest(config, 'delete_pop', { email: localPart, domain: config.domain });
  return { email: `${localPart}@${config.domain}` };
}

export async function testCpanelConnection(configInput) {
  const config = await resolveCpanelConfig(configInput);
  if (!config) throw new Error('cPanel connector is not configured');
  const result = await cpanelRequest(config, 'list_pops_with_disk', { domain: config.domain });
  return { ok: true, mailboxCount: Array.isArray(result.data) ? result.data.length : 0 };
}

export async function fetchCpanelMailboxes(configInput) {
  const config = await resolveCpanelConfig(configInput);
  if (!config) throw new Error('cPanel connector is not configured');
  const result = await cpanelRequest(config, 'list_pops_with_disk', { domain: config.domain });
  const rows = Array.isArray(result.data) ? result.data : [];
  return rows.map(row => normalizeMailbox(row, config.domain)).filter(Boolean);
}

export async function syncCpanelMailboxes(actorUserId = null) {
  const config = await getCpanelConfig({ includeToken: true });
  if (!config) throw new Error('cPanel connector is not configured');
  const mailboxes = await fetchCpanelMailboxes(config);
  await withTransaction(async client => {
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
