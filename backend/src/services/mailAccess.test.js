import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  getAccessibleAccount,
  getAccessibleAccountIds,
  getMailboxMembership,
  grantMailboxMembership,
  hasAccountAccess,
  revokeMailboxMembership,
  setPrimaryMailbox,
  updateMailboxMembership,
} from './mailAccess.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => query.mockReset());

describe('shared mailbox access', () => {
  it('lists direct owner accounts plus active memberships where read_send permits reading', async () => {
    query.mockResolvedValue({ rows: [{ account_id: ACCOUNT_ID }] });

    await expect(getAccessibleAccountIds(USER_ID)).resolves.toEqual([ACCOUNT_ID]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM email_accounts ea');
    expect(sql).toContain('FROM active_mailbox_memberships');
    expect(sql).toContain("mm.permission IN ('read', 'read_send')");
    expect(params).toEqual([USER_ID]);
  });

  it('requires read_send for a send-capability check', async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(hasAccountAccess(USER_ID, ACCOUNT_ID, { permission: 'read_send' })).resolves.toBe(false);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("mm.permission = 'read_send'");
    expect(params).toEqual([USER_ID, ACCOUNT_ID]);
  });

  it('does not query when a caller requests an unsupported permission', async () => {
    await expect(getAccessibleAccountIds(USER_ID, { permission: 'admin' })).rejects.toThrow('Unsupported mailbox permission');
    expect(query).not.toHaveBeenCalled();
  });

  it('loads an account through direct ownership or its active membership', async () => {
    const account = { id: ACCOUNT_ID, email_address: 'support@example.com' };
    query.mockResolvedValue({ rows: [account] });

    await expect(getAccessibleAccount(USER_ID, ACCOUNT_ID)).resolves.toEqual(account);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM active_mailbox_memberships');
    expect(sql).toContain('ea.user_id = $1');
    expect(params).toEqual([USER_ID, ACCOUNT_ID]);
  });

  it('treats revoked memberships as inaccessible', async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(getMailboxMembership(ACCOUNT_ID, USER_ID)).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toContain('revoked_at IS NULL');
  });

  it('grants or restores a membership without creating duplicate rows', async () => {
    const membership = { account_id: ACCOUNT_ID, user_id: USER_ID, permission: 'read_send', revoked_at: null };
    query.mockResolvedValue({ rows: [membership] });

    await expect(grantMailboxMembership({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      grantedBy: ACTOR_ID,
    })).resolves.toEqual(membership);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (account_id, user_id) DO UPDATE');
    expect(sql).toContain('revoked_at = NULL');
    expect(params).toEqual([ACCOUNT_ID, USER_ID, 'read_send', ACTOR_ID]);
  });

  it('updates and revokes only an active membership', async () => {
    query.mockResolvedValueOnce({ rows: [{ permission: 'read' }] });
    query.mockResolvedValueOnce({ rows: [{ revoked_at: '2026-09-25T00:00:00.000Z' }] });

    await expect(updateMailboxMembership({ accountId: ACCOUNT_ID, userId: USER_ID, permission: 'read' }))
      .resolves.toEqual({ permission: 'read' });
    await expect(revokeMailboxMembership({ accountId: ACCOUNT_ID, userId: USER_ID }))
      .resolves.toEqual({ revoked_at: '2026-09-25T00:00:00.000Z' });
    expect(query.mock.calls[0][0]).toContain('revoked_at IS NULL');
    expect(query.mock.calls[1][0]).toContain('revoked_at IS NULL');
  });

  it('sets a primary mailbox only when the user holds active membership', async () => {
    query.mockResolvedValue({ rows: [{ primary_email_account_id: ACCOUNT_ID }] });

    await expect(setPrimaryMailbox(USER_ID, ACCOUNT_ID)).resolves.toBe(ACCOUNT_ID);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM active_mailbox_memberships');
    expect(params).toEqual([USER_ID, ACCOUNT_ID]);
  });
});
