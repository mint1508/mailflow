import { describe, expect, it } from 'vitest';
import { normalizeMailbox } from './cpanelClient.js';

describe('cPanel mailbox normalization', () => {
  it('normalizes the list_pops_with_disk shape', () => {
    expect(normalizeMailbox({
      user: 'support',
      domain: 'example.com',
      diskquota: '10 GB',
      diskused: '512 MB',
      suspended_login: 0,
    }, 'example.com')).toMatchObject({
      email: 'support@example.com',
      domain: 'example.com',
      localPart: 'support',
      quotaBytes: 10 * 1024 ** 3,
      diskUsedBytes: 512 * 1024 ** 2,
      suspended: false,
    });
  });

  it('accepts an explicit email and marks suspended rows', () => {
    expect(normalizeMailbox({
      email: 'Admin@Example.com',
      quota: 'unlimited',
      disk_used: 2048,
      suspended: true,
    }, 'example.com')).toMatchObject({
      email: 'admin@example.com',
      localPart: 'admin',
      quotaBytes: null,
      diskUsedBytes: 2048,
      suspended: true,
    });
  });

  it('ignores malformed rows without an email', () => {
    expect(normalizeMailbox({ user: '', domain: '' }, 'example.com')).toBeNull();
  });

  it('ignores rows returned for a different domain', () => {
    expect(normalizeMailbox({ user: 'support', domain: 'other.example' }, 'example.com')).toBeNull();
  });
});
