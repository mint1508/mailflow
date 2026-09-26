import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ pool: { connect: vi.fn() }, query: vi.fn() }));
vi.mock('./cpanelClient.js', () => ({
  getCpanelConfig: vi.fn(async () => ({ host: 'mail.example.test', domain: 'example.test' })),
  resetCpanelMailboxPassword: vi.fn(),
}));
vi.mock('./mailer.js', () => ({ sendSystemEmail: vi.fn().mockResolvedValue() }));
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(value => `encrypted:${value}`) }));

import { pool } from './db.js';
import { createExistingMailboxActivation } from './mailboxActivation.js';

describe('createExistingMailboxActivation', () => {
  beforeEach(() => {
    process.env.APP_URL = 'https://mail.example.test';
    pool.connect.mockReset();
  });

  it('rejects addresses that are not active in the configured cPanel inventory', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    pool.connect.mockResolvedValue(client);

    await expect(createExistingMailboxActivation({
      actorUserId: 'manager', mailboxEmail: 'other@example.test', contactEmail: 'owner@personal.test',
    })).rejects.toThrow('not an active mailbox');
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('never converts or transfers an account that already has an owner', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ email: 'user@example.test' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'account', user_id: 'victim', managed_mailbox: true }] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    pool.connect.mockResolvedValue(client);

    await expect(createExistingMailboxActivation({
      actorUserId: 'manager', mailboxEmail: 'user@example.test', contactEmail: 'attacker@personal.test',
    })).rejects.toThrow('already linked');
    expect(client.query.mock.calls.some(([sql]) => /SET\s+user_id\s*=\s*NULL/i.test(String(sql)))).toBe(false);
  });

  it('reuses only an ownerless pending account and removes stale credentials', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ email: 'user@example.test' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'pending', user_id: null, managed_mailbox: true }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    pool.connect.mockResolvedValue(client);

    await expect(createExistingMailboxActivation({
      actorUserId: 'manager', mailboxEmail: 'user@example.test', contactEmail: 'owner@personal.test',
    })).resolves.toMatchObject({ accountId: 'pending', emailSent: true });

    const credentialClear = client.query.mock.calls.find(([sql]) => String(sql).includes('auth_pass = NULL'));
    expect(credentialClear?.[0]).toContain('smtp_auth_pass = NULL');
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });
});
