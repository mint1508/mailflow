import { query } from './db.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function buildAuthentikLifecycleProjection(rows, managedDomain) {
  const domain = normalizeEmail(managedDomain).replace(/^@/, '');
  return rows
    .map(row => ({
      email: normalizeEmail(row.email),
      name: String(row.display_name || row.email || '').trim(),
      active: row.is_present === true && row.suspended !== true,
    }))
    .filter(user => user.email && (!domain || user.email.endsWith(`@${domain}`)));
}

export function planAuthentikLifecycle(desiredUsers, existingUsers) {
  const existingByEmail = new Map();
  for (const user of existingUsers) {
    const email = normalizeEmail(user.email || user.username);
    if (email) existingByEmail.set(email, user);
  }

  const desiredEmails = new Set();
  const actions = [];
  for (const desired of desiredUsers) {
    desiredEmails.add(desired.email);
    const existing = existingByEmail.get(desired.email);
    if (!existing) {
      actions.push({ type: 'create', desired });
      continue;
    }
    const attributes = { ...(existing.attributes || {}), mailflow_managed: true };
    const needsUpdate = existing.is_active !== desired.active
      || normalizeEmail(existing.email) !== desired.email
      || existing.username !== desired.email
      || existing.attributes?.mailflow_managed !== true;
    if (needsUpdate) actions.push({ type: 'update', existing, desired, attributes });
  }

  for (const existing of existingUsers) {
    const email = normalizeEmail(existing.email || existing.username);
    if (existing.attributes?.mailflow_managed === true && !desiredEmails.has(email) && existing.is_active) {
      actions.push({ type: 'deactivate', existing });
    }
  }
  return actions;
}

function authentikConfig(env = process.env) {
  const baseUrl = String(env.AUTHENTIK_API_URL || '').trim().replace(/\/$/, '');
  const token = String(env.AUTHENTIK_API_TOKEN || '').trim();
  const managedDomain = String(env.AUTHENTIK_MANAGED_DOMAIN || '').trim().toLowerCase();
  if (!baseUrl || !token || !managedDomain) return null;
  return { baseUrl, token, managedDomain };
}

async function authentikRequest(config, path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(Number(process.env.AUTHENTIK_API_TIMEOUT_MS || 10000)),
  });
  if (!response.ok) throw new Error(`Authentik API ${options.method || 'GET'} ${path} returned HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

async function listAuthentikUsers(config, fetchImpl) {
  const users = [];
  let page = 1;
  while (true) {
    const result = await authentikRequest(config, `/core/users/?page=${page}&page_size=100`, {}, fetchImpl);
    users.push(...(result.results || []));
    if (!result.pagination?.next) break;
    page++;
  }
  return users;
}

export async function syncAuthentikLifecycle({ env = process.env, fetchImpl = fetch, queryImpl = query } = {}) {
  const config = authentikConfig(env);
  if (!config) return { skipped: true };

  const { rows } = await queryImpl(
    `SELECT lower(u.username) AS email, u.display_name, cm.is_present, cm.suspended
       FROM users u
       LEFT JOIN cpanel_mailboxes cm ON lower(cm.email) = lower(u.username)
      WHERE lower(u.username) LIKE $1
      ORDER BY lower(u.username)`,
    [`%@${config.managedDomain}`],
  );
  const desiredUsers = buildAuthentikLifecycleProjection(rows, config.managedDomain);
  const existingUsers = await listAuthentikUsers(config, fetchImpl);
  const actions = planAuthentikLifecycle(desiredUsers, existingUsers);
  const result = { created: 0, updated: 0, deactivated: 0, unchanged: desiredUsers.length };

  for (const action of actions) {
    if (action.type === 'create') {
      await authentikRequest(config, '/core/users/', {
        method: 'POST',
        body: JSON.stringify({
          username: action.desired.email,
          name: action.desired.name || action.desired.email,
          email: action.desired.email,
          is_active: action.desired.active,
          type: 'internal',
          path: 'users',
          attributes: { mailflow_managed: true },
        }),
      }, fetchImpl);
      result.created++;
      result.unchanged--;
    } else if (action.type === 'update') {
      await authentikRequest(config, `/core/users/${action.existing.pk}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          username: action.desired.email,
          name: action.desired.name || action.desired.email,
          email: action.desired.email,
          is_active: action.desired.active,
          attributes: action.attributes,
        }),
      }, fetchImpl);
      result.updated++;
      result.unchanged--;
    } else if (action.type === 'deactivate') {
      await authentikRequest(config, `/core/users/${action.existing.pk}/`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: false }),
      }, fetchImpl);
      result.deactivated++;
    }
  }
  return result;
}

export function startAuthentikLifecycleMonitor({ syncInventory, env = process.env } = {}) {
  if (typeof syncInventory !== 'function') throw new Error('syncInventory is required');
  const configured = Number(env.AUTHENTIK_LIFECYCLE_SYNC_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const interval = Math.min(Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS);
  const run = () => syncInventory().catch(error => console.warn('Authentik lifecycle monitor failed:', error.message));
  run();
  const timer = setInterval(run, interval);
  timer.unref?.();
  return timer;
}
