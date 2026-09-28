import { describe, expect, it, vi } from 'vitest';
import { changeUserPassword, PasswordChangeError } from './passwordChange.js';

function transactionClient({ managedUpdate = true } = {}) {
  return {
    query: vi.fn(async sql => {
      if (/UPDATE email_accounts/.test(sql)) return { rows: managedUpdate ? [{ id: 'account-1' }] : [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

describe('changeUserPassword', () => {
  it('changes a local user password and revokes sessions', async () => {
    const client = transactionClient();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', username: 'operator', password_hash: 'old-hash' }] })
      .mockResolvedValueOnce({ rows: [] });
    const destroyUserSessions = vi.fn();

    const result = await changeUserPassword({
      userId: 'user-1', currentPassword: 'old-password', newPassword: 'new-password',
    }, {
      pool: { connect: vi.fn(async () => client) }, query,
      verifyUserCredential: vi.fn(async () => true),
      hashPassword: vi.fn(async () => 'new-hash'),
      destroyUserSessions,
    });

    expect(result).toEqual({ managedMailbox: false });
    expect(client.query).toHaveBeenCalledWith(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      ['new-hash', 'user-1'],
    );
    expect(destroyUserSessions).toHaveBeenCalledWith('user-1');
  });

  it('changes cPanel and stored IMAP/SMTP credentials for a managed mailbox', async () => {
    const client = transactionClient();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', username: 'user@example.test', password_hash: 'old-hash' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'user@example.test' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1' }] });
    const resetCpanelMailboxPassword = vi.fn(async () => ({}));
    const disconnectAccount = vi.fn(async () => {});
    const connectAccount = vi.fn(async () => {});

    const result = await changeUserPassword({
      userId: 'user-1', currentPassword: 'old-password-123', newPassword: 'new-password-456',
      imapManager: { clearConnectCooldown: vi.fn(), disconnectAccount, connectAccount },
    }, {
      pool: { connect: vi.fn(async () => client) }, query,
      verifyUserCredential: vi.fn(async () => true),
      resetCpanelMailboxPassword,
      hashPassword: vi.fn(async () => 'new-hash'),
      encrypt: vi.fn(value => `encrypted:${value}`),
      destroyUserSessions: vi.fn(),
    });

    expect(result).toEqual({ managedMailbox: true });
    expect(resetCpanelMailboxPassword).toHaveBeenCalledWith('user@example.test', 'new-password-456');
    expect(client.query).toHaveBeenCalledWith(expect.stringMatching(/UPDATE email_accounts/), [
      'user@example.test', 'encrypted:new-password-456', 'account-1', 'user-1',
    ]);
    await vi.waitFor(() => expect(connectAccount).toHaveBeenCalledWith({ id: 'account-1' }));
  });

  it('rejects an incorrect current password before changing anything', async () => {
    const resetCpanelMailboxPassword = vi.fn();
    const pool = { connect: vi.fn() };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', username: 'user@example.test', password_hash: 'old-hash' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'user@example.test' }] });

    await expect(changeUserPassword({
      userId: 'user-1', currentPassword: 'wrong-password', newPassword: 'new-password-456',
    }, {
      pool, query, verifyUserCredential: vi.fn(async () => false), resetCpanelMailboxPassword,
    })).rejects.toMatchObject({ name: 'PasswordChangeError', status: 401 });

    expect(resetCpanelMailboxPassword).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('requires the stronger mailbox password length', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', username: 'user@example.test', password_hash: 'old-hash' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1', email_address: 'user@example.test' }] });

    await expect(changeUserPassword({
      userId: 'user-1', currentPassword: 'old-password-123', newPassword: 'shortpass',
    }, { query })).rejects.toEqual(expect.objectContaining({
      name: 'PasswordChangeError',
      message: 'Password must be at least 12 characters',
    }));
  });

  it('uses a typed validation error for identical passwords', async () => {
    await expect(changeUserPassword({
      userId: 'user-1', currentPassword: 'same-password', newPassword: 'same-password',
    })).rejects.toBeInstanceOf(PasswordChangeError);
  });
});
