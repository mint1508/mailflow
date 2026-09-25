import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../services/db.js', () => ({ query }));

import {
  beginImpersonation,
  expireImpersonation,
  getImpersonationState,
  requireAdmin,
  requireMailboxManager,
  stopImpersonation,
} from './auth.js';

function request(session = {}) {
  return { ip: '127.0.0.1', session: { ...session } };
}

describe('admin impersonation session helpers', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it('switches effective identity and records the original admin', async () => {
    const req = request({ userId: 'admin-id', username: 'admin' });
    const state = await beginImpersonation(req, { targetUserId: 'user-id', targetUsername: 'user' });
    expect(req.session).toMatchObject({
      userId: 'user-id',
      username: 'user',
      isAdmin: false,
      impersonatorUserId: 'admin-id',
      impersonatedUserId: 'user-id',
    });
    expect(state.targetUsername).toBe('user');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO auth_events'), expect.arrayContaining(['impersonation_start']));
  });

  it('restores the administrator on manual stop', async () => {
    const req = request({
      userId: 'user-id', username: 'user', isAdmin: false,
      impersonatorUserId: 'admin-id', impersonatorUsername: 'admin',
      impersonatedUserId: 'user-id', impersonatedUsername: 'user',
      impersonationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const state = await stopImpersonation(req);
    expect(state.originalAdminId).toBe('admin-id');
    expect(req.session).toMatchObject({ userId: 'admin-id', username: 'admin', isAdmin: true });
    expect(getImpersonationState(req)).toBeNull();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO auth_events'), expect.arrayContaining(['impersonation_stop']));
  });

  it('expires and restores an impersonation session', async () => {
    const req = request({
      userId: 'user-id', username: 'user', isAdmin: false,
      impersonatorUserId: 'admin-id', impersonatorUsername: 'admin',
      impersonatedUserId: 'user-id', impersonatedUsername: 'user',
      impersonationExpiresAt: new Date(Date.now() - 1).toISOString(),
    });
    expect(await expireImpersonation(req)).toBeNull();
    expect(req.session).toMatchObject({ userId: 'admin-id', username: 'admin', isAdmin: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO auth_events'), expect.arrayContaining(['impersonation_expired']));
  });

  it('blocks admin middleware while the effective session is impersonating', async () => {
    const req = request({
      userId: 'user-id', impersonatorUserId: 'admin-id', impersonatorUsername: 'admin',
      impersonatedUserId: 'user-id', impersonatedUsername: 'user',
      impersonationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    await requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks mailbox management while the effective session is impersonating', async () => {
    const req = request({
      userId: 'user-id', impersonatorUserId: 'admin-id', impersonatorUsername: 'admin',
      impersonatedUserId: 'user-id', impersonatedUsername: 'user',
      impersonationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    await requireMailboxManager(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
