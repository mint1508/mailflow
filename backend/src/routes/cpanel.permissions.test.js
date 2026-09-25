import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  requireMailboxManager: (req, res, next) => {
    const role = req.get('x-test-role');
    if (role !== 'admin' && role !== 'mod') {
      return res.status(403).json({ error: 'Mailbox management access required' });
    }
    req.session = { userId: `${role}-1` };
    next();
  },
  requireAdmin: (req, res, next) => {
    if (req.get('x-test-role') !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
}));

vi.mock('../services/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
}));

vi.mock('../services/cpanelClient.js', () => ({
  getCpanelConfig: vi.fn(async () => ({
    host: 'cpanel.example.test', port: 2083, username: 'owner', domain: 'example.test', updatedAt: null,
  })),
  saveCpanelConfig: vi.fn(async input => input),
  testCpanelConnection: vi.fn(async () => ({ ok: true, mailboxCount: 0 })),
  syncCpanelMailboxes: vi.fn(async () => []),
  createCpanelMailbox: vi.fn(async () => ({ email: 'new@example.test', quotaMb: 1024 })),
  createCpanelMailboxes: vi.fn(async () => ({ requestedCount: 0, created: [], failed: [] })),
  resetCpanelMailboxPassword: vi.fn(async email => ({ email })),
  updateCpanelMailboxQuota: vi.fn(async (email, quotaMb) => ({ email, quotaMb })),
  setCpanelMailboxSuspended: vi.fn(async (email, suspended) => ({ email, suspended })),
  deleteCpanelMailbox: vi.fn(async email => ({ email })),
  getCpanelLimits: vi.fn(() => ({ maxMailboxes: 15, maxQuotaMb: 10240 })),
  getCpanelTokenStatus: vi.fn(() => ({ tokenExpired: false })),
  getCpanelTokenInventory: vi.fn(async () => ({ tokens: [] })),
  checkCpanelTokenInventory: vi.fn(async () => ({ ok: true, tokens: [] })),
}));

vi.mock('../services/mailboxActivation.js', () => ({
  createMailboxActivation: vi.fn(async () => ({
    contactEmail: 'owner@example.test', activationUrl: 'https://example.test/activate', emailSent: true, expiresAt: null,
  })),
  createExistingMailboxActivation: vi.fn(async () => ({ emailSent: true })),
  mailboxActivationState: vi.fn(async () => new Map()),
  resendMailboxActivation: vi.fn(async () => ({ emailSent: true })),
  sendManagedMailboxReset: vi.fn(async () => ({ emailSent: true })),
}));

vi.mock('../services/mailAccess.js', () => ({
  listMailboxMemberships: vi.fn(async () => []),
  grantMailboxMembership: vi.fn(async input => ({ ...input })),
  updateMailboxMembership: vi.fn(async input => ({ ...input })),
  revokeMailboxMembership: vi.fn(async input => ({ ...input })),
}));

import express from 'express';
import cpanelRoutes from './cpanel.js';
import { query } from '../services/db.js';

function request(path, { role = 'mod', method = 'GET', body } = {}) {
  return fetch(`${base}/api/cpanel${path}`, {
    method,
    headers: {
      'x-test-role': role,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cpanel', cpanelRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockClear();
  query.mockResolvedValue({ rows: [] });
});

const adminOnly = [
  ['GET', '/connection'],
  ['PUT', '/connection', { host: 'cpanel.example.test' }],
  ['POST', '/connection/test', {}],
  ['GET', '/connection/tokens'],
  ['POST', '/connection/tokens/check', {}],
  ['POST', '/mailboxes/user%40example.test/password', { password: 'secret' }],
  ['POST', '/mailboxes/user%40example.test/reset-link', {}],
  ['DELETE', '/mailboxes/user%40example.test'],
];

describe('cPanel mailbox-manager permissions', () => {
  it.each(adminOnly)('denies mod access to %s %s', async (method, path, body) => {
    const response = await request(path, { method, body });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Admin access required' });
  });

  it.each(adminOnly)('allows admin access past the permission gate for %s %s', async (method, path, body) => {
    const response = await request(path, { role: 'admin', method, body });
    expect(response.status).not.toBe(403);
  });

  const modAllowed = [
    ['GET', '/mailboxes'],
    ['POST', '/mailboxes/sync', {}],
    ['POST', '/mailboxes', { contactEmail: 'owner@example.test' }],
    ['POST', '/mailboxes/bulk', { items: [] }],
    ['POST', '/mailboxes/user%40example.test/activation', { contactEmail: 'owner@example.test' }],
    ['POST', '/mailboxes/user%40example.test/activation/resend', {}],
    ['PATCH', '/mailboxes/user%40example.test/quota', { quotaMb: 1024 }],
    ['POST', '/mailboxes/user%40example.test/suspend', {}],
    ['POST', '/mailboxes/user%40example.test/unsuspend', {}],
    ['GET', '/audit'],
  ];

  it.each(modAllowed)('allows mod access to %s %s', async (method, path, body) => {
    const response = await request(path, { method, body });
    expect(response.status).not.toBe(403);
  });
});
