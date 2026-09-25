import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  consumeRateLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  verifyUserCredential: vi.fn(),
  beginImpersonation: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../middleware/auth.js', () => ({
  beginImpersonation: mocks.beginImpersonation,
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../services/rateLimiter.js', () => ({
  consume: mocks.consumeRateLimit,
  reset: mocks.resetRateLimit,
}));
vi.mock('../services/mailboxAuth.js', () => ({
  MailboxAuthenticationUnavailableError: class MailboxAuthenticationUnavailableError extends Error {},
  verifyUserCredential: mocks.verifyUserCredential,
}));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(), encrypt: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(), invalidateConnectionPolicyCache: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn() } }));
vi.mock('../utils/uuid.js', () => ({ uuidParam: () => (_req, _res, next) => next() }));

import adminRoutes from './admin.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId: ADMIN_ID, username: 'admin@example.test', save: callback => callback() };
    next();
  });
  app.use('/api/admin', adminRoutes);
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.consumeRateLimit.mockResolvedValue({ limited: false, resetMs: 1 });
  mocks.query.mockImplementation(async (sql) => {
    if (sql.includes('password_hash, totp_enabled')) {
      return { rows: [{ id: ADMIN_ID, username: 'admin@example.test', password_hash: 'hash', totp_enabled: false }] };
    }
    if (sql.includes('SELECT id, username FROM users')) return { rows: [{ id: TARGET_ID, username: 'member@example.test' }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  mocks.verifyUserCredential.mockResolvedValue(true);
  mocks.beginImpersonation.mockResolvedValue({ targetUserId: TARGET_ID, expiresAt: '2030-01-01T00:00:00.000Z' });
});

function request(body) {
  return fetch(`${base}/api/admin/users/${TARGET_ID}/impersonate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/users/:id/impersonate', () => {
  it('requires the administrator password before looking up users', async () => {
    const response = await request({});
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('requires re-authentication before switching the effective user', async () => {
    mocks.verifyUserCredential.mockResolvedValue(false);
    const response = await request({ password: 'wrong-password' });
    expect(response.status).toBe(401);
    expect(mocks.beginImpersonation).not.toHaveBeenCalled();
  });

  it('starts an audited, session-bound impersonation after re-authentication', async () => {
    const response = await request({ password: 'correct-password' });
    expect(response.status).toBe(200);
    expect(mocks.verifyUserCredential).toHaveBeenCalledWith(expect.objectContaining({ id: ADMIN_ID }), 'correct-password');
    expect(mocks.beginImpersonation).toHaveBeenCalledWith(expect.any(Object), {
      targetUserId: TARGET_ID,
      targetUsername: 'member@example.test',
    });
    expect(mocks.resetRateLimit).toHaveBeenCalledWith(`admin-impersonation:${ADMIN_ID}`);
  });
});
