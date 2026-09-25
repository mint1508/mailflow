import { query } from '../services/db.js';

export const IMPERSONATION_TTL_MS = 15 * 60 * 1000;

function sessionImpersonation(req) {
  const session = req.session;
  if (!session?.impersonatorUserId || !session.impersonatedUserId || !session.impersonationExpiresAt) return null;
  return {
    originalAdminId: session.impersonatorUserId,
    originalAdminUsername: session.impersonatorUsername || null,
    targetUserId: session.impersonatedUserId,
    targetUsername: session.impersonatedUsername || null,
    expiresAt: new Date(session.impersonationExpiresAt).toISOString(),
  };
}

async function auditImpersonation(req, eventType, state, reason = null) {
  try {
    await query(
      `INSERT INTO auth_events (event_type, username, user_id, ip, success, detail)
       VALUES ($1, $2, $3, $4, true, $5::jsonb)`,
      [
        eventType,
        state.originalAdminUsername || null,
        state.originalAdminId,
        req.ip || null,
        JSON.stringify({
          targetUserId: state.targetUserId,
          targetUsername: state.targetUsername,
          reason,
          expiresAt: state.expiresAt,
        }),
      ],
    );
    return true;
  } catch (error) {
    console.error(`[auth] Failed to log ${eventType}:`, error.message);
    return false;
  }
}

function restoreOriginalSession(session, state) {
  session.userId = state.originalAdminId;
  session.username = state.originalAdminUsername;
  session.isAdmin = true;
  delete session.canManageMailboxes;
  delete session.impersonatorUserId;
  delete session.impersonatorUsername;
  delete session.impersonatedUserId;
  delete session.impersonatedUsername;
  delete session.impersonationExpiresAt;
}

export function getImpersonationState(req) {
  return sessionImpersonation(req);
}

export async function beginImpersonation(req, { targetUserId, targetUsername }) {
  if (sessionImpersonation(req)) {
    throw Object.assign(new Error('Stop the current impersonation session first'), { status: 409 });
  }
  const startedAt = Date.now();
  const state = {
    originalAdminId: req.session.userId,
    originalAdminUsername: req.session.username || null,
    targetUserId,
    targetUsername,
    expiresAt: new Date(startedAt + IMPERSONATION_TTL_MS).toISOString(),
  };
  req.session.impersonatorUserId = state.originalAdminId;
  req.session.impersonatorUsername = state.originalAdminUsername;
  req.session.impersonatedUserId = targetUserId;
  req.session.impersonatedUsername = targetUsername;
  req.session.impersonationExpiresAt = state.expiresAt;
  req.session.userId = targetUserId;
  req.session.username = targetUsername;
  req.session.isAdmin = false;
  req.session.canManageMailboxes = false;
  if (!await auditImpersonation(req, 'impersonation_start', state)) {
    restoreOriginalSession(req.session, state);
    throw Object.assign(new Error('Could not record the impersonation audit event'), { status: 503 });
  }
  return state;
}

// Restore the original admin when the time limit is reached. This is deliberately
// idempotent because both the global API middleware and /auth/me call it.
export async function expireImpersonation(req) {
  const state = sessionImpersonation(req);
  if (!state || Date.parse(state.expiresAt) > Date.now()) return state;
  restoreOriginalSession(req.session, state);
  await auditImpersonation(req, 'impersonation_expired', state, 'ttl');
  return null;
}

export async function stopImpersonation(req, reason = 'manual') {
  const state = sessionImpersonation(req);
  if (!state) return null;
  restoreOriginalSession(req.session, state);
  await auditImpersonation(req, 'impersonation_stop', state, reason);
  return state;
}

export async function requireAuth(req, res, next) {
  await expireImpersonation(req);
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query('SELECT id FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Always verifies against the DB so a revoked admin can't keep using
// a stale session. The extra query is cheap and only hits admin routes.
export async function requireAdmin(req, res, next) {
  await expireImpersonation(req);
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (sessionImpersonation(req)) {
    return res.status(403).json({ error: 'Admin access is unavailable while impersonating another user' });
  }
  try {
    const result = await query(
      'SELECT is_admin FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Mailbox managers may operate the cPanel connector without receiving the
// broader user, authentication, SSO, and system-settings admin powers.
export async function requireMailboxManager(req, res, next) {
  await expireImpersonation(req);
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (sessionImpersonation(req)) {
    return res.status(403).json({ error: 'Mailbox management access is unavailable while impersonating another user' });
  }
  try {
    const result = await query(
      'SELECT is_admin, can_manage_mailboxes FROM users WHERE id = $1',
      [req.session.userId],
    );
    const user = result.rows[0];
    if (!user?.is_admin && !user?.can_manage_mailboxes) {
      return res.status(403).json({ error: 'Mailbox management access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}
