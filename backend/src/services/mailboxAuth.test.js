import { describe, expect, it, vi } from 'vitest';
vi.mock('./encryption.js', () => ({ encrypt: vi.fn(value => `encrypted:${value}`) }));
import {
  authenticateMailbox,
  MailboxAuthenticationError,
  MailboxAuthenticationUnavailableError,
  provisionMailboxUser,
  updateManagedMailboxCredentials,
  verifyUserCredential,
} from './mailboxAuth.js';

const config = { host: 'mail.example.test', domain: 'example.test' };
const resolved = { host: '203.0.113.10' };

describe('authenticateMailbox', () => {
  it('uses TLS IMAP with the full configured mailbox address and closes the client', async () => {
    const client = { connect: vi.fn(), logout: vi.fn() };
    const createClient = vi.fn(() => client);

    await expect(authenticateMailbox(
      { email: ' User@Example.Test ', password: 'secret' },
      { getConfig: vi.fn().mockResolvedValue(config), resolveHost: vi.fn().mockResolvedValue(resolved), createClient },
    )).resolves.toEqual({ email: 'user@example.test', config });

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      host: '203.0.113.10', port: 993, secure: true,
      auth: { user: 'user@example.test', pass: 'secret' },
      tls: { rejectUnauthorized: true },
    }));
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it('does not attempt IMAP for an address outside the configured cPanel domain', async () => {
    const createClient = vi.fn();
    await expect(authenticateMailbox(
      { email: 'user@other.test', password: 'secret' },
      { getConfig: vi.fn().mockResolvedValue(config), resolveHost: vi.fn(), createClient },
    )).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('classifies rejected credentials separately from a mail service outage', async () => {
    const rejected = Object.assign(new Error('[AUTHENTICATIONFAILED] Invalid credentials'), { authenticationFailed: true });
    await expect(authenticateMailbox(
      { email: 'user@example.test', password: 'wrong' },
      { getConfig: vi.fn().mockResolvedValue(config), resolveHost: vi.fn().mockResolvedValue(resolved), createClient: () => ({ connect: vi.fn().mockRejectedValue(rejected), logout: vi.fn() }) },
    )).rejects.toBeInstanceOf(MailboxAuthenticationError);

    await expect(authenticateMailbox(
      { email: 'user@example.test', password: 'secret' },
      { getConfig: vi.fn().mockResolvedValue(config), resolveHost: vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')), createClient: vi.fn() },
    )).rejects.toBeInstanceOf(MailboxAuthenticationUnavailableError);
  });
});

describe('verifyUserCredential', () => {
  it('uses live IMAP only for a managed mailbox and uses bcrypt for a local account', async () => {
    const managedAuthenticate = vi.fn().mockResolvedValue({ email: 'admin@example.test' });
    await expect(verifyUserCredential(
      { id: 'managed-user', username: 'admin@example.test', password_hash: 'stale' }, 'live-secret',
      { lookupManagedAccount: vi.fn().mockResolvedValue({ id: 'account' }), authenticate: managedAuthenticate, comparePassword: vi.fn() },
    )).resolves.toBe(true);
    expect(managedAuthenticate).toHaveBeenCalledWith({ email: 'admin@example.test', password: 'live-secret' });

    const comparePassword = vi.fn().mockResolvedValue(true);
    await expect(verifyUserCredential(
      { id: 'break-glass', username: 'operator', password_hash: 'hash' }, 'local-secret',
      { lookupManagedAccount: vi.fn(), authenticate: vi.fn(), comparePassword },
    )).resolves.toBe(true);
    expect(comparePassword).toHaveBeenCalledWith('local-secret', 'hash');
  });
});

describe('provisionMailboxUser', () => {
  it('claims a pending mailbox, grants owner access, and sets it as primary', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // no MailFlow user
        .mockResolvedValueOnce({ rows: [{ id: 'pending-account', managed_mailbox: true, user_id: null }] })
        .mockResolvedValueOnce({ rows: [{ id: 'new-user', username: 'user@example.test' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'pending-account' }] })
        .mockResolvedValueOnce({}) // membership
        .mockResolvedValueOnce({}) // primary account
        .mockResolvedValueOnce({}) // consume invites
        .mockResolvedValueOnce({}), // COMMIT
      release: vi.fn(),
    };

    await expect(provisionMailboxUser(
      { email: 'user@example.test', password: 'secret', passwordHash: 'hash', config },
      { dbPool: { connect: vi.fn().mockResolvedValue(client) } },
    )).resolves.toMatchObject({
      user: { id: 'new-user' }, account: { id: 'pending-account' }, created: true,
    });

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO mailbox_memberships'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('primary_email_account_id'))).toBe(true);
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('never transfers a managed mailbox that already has an owner', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'owned-account', managed_mailbox: true, user_id: 'victim' }] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    await expect(provisionMailboxUser(
      { email: 'user@example.test', password: 'secret', passwordHash: 'hash', config },
      { dbPool: { connect: vi.fn().mockResolvedValue(client) } },
    )).rejects.toThrow('activation is required');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO users'))).toBe(false);
  });

  it('refuses to claim a concurrent local account that only shares the mailbox username', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({ rows: [{ id: 'local-user', username: 'user@example.test' }] })
        .mockResolvedValueOnce({ rows: [] }) // no managed account belongs to that user
        .mockResolvedValueOnce({}), // ROLLBACK
      release: vi.fn(),
    };
    await expect(provisionMailboxUser(
      { email: 'user@example.test', password: 'secret', passwordHash: 'hash', config },
      { dbPool: { connect: vi.fn().mockResolvedValue(client) } },
    )).rejects.toThrow('activation is required');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('does not self-provision an arbitrary cPanel mailbox without a pending managed account', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // no MailFlow user
        .mockResolvedValueOnce({ rows: [] }) // no pending managed account
        .mockResolvedValueOnce({}), // ROLLBACK
      release: vi.fn(),
    };
    await expect(provisionMailboxUser(
      { email: 'user@example.test', password: 'secret', passwordHash: 'hash', config },
      { dbPool: { connect: vi.fn().mockResolvedValue(client) } },
    )).rejects.toThrow('activation is required');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('updateManagedMailboxCredentials', () => {
  it('updates mailbox and fallback hash in one transaction', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'account' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    await updateManagedMailboxCredentials(
      { accountId: 'account', userId: 'user', email: 'user@example.test', password: 'secret', passwordHash: 'hash' },
      { dbPool: { connect: vi.fn().mockResolvedValue(client) } },
    );
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 2).join(' ')))
      .toEqual(['BEGIN', 'UPDATE email_accounts', 'UPDATE users', 'COMMIT']);
  });
});
