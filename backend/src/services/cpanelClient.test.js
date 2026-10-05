import { describe, expect, it } from 'vitest';
import { buildFileLifecycleProjection, generateMailboxPassword, getCpanelTokenStatus, normalizeBulkMailboxInput, normalizeCpanelApiError, normalizeCpanelConfig, normalizeCpanelToken, normalizeMailbox } from './cpanelClient.js';

describe('file storage lifecycle projection', () => {
  it('projects only linked users and revokes when no active cPanel mailbox remains', () => {
    const rows = [
      { app_user_id: 'u1', email: 'active@hippy.vn', is_present: true, suspended: false, quota_bytes: 10 },
      { app_user_id: 'u1', email: 'suspended@hippy.vn', is_present: true, suspended: true, quota_bytes: 20 },
      { app_user_id: 'u2', email: 'gone@hippy.vn', is_present: false, suspended: false, quota_bytes: 30 },
      { app_user_id: null, email: 'unlinked@hippy.vn', is_present: true, suspended: false, quota_bytes: 40 },
    ];
    expect(buildFileLifecycleProjection(rows)).toEqual([
      { id: 'u1', email: 'active@hippy.vn', source: 'cpanel', status: 'active', file_quota_bytes: 20 },
      { id: 'u2', email: 'gone@hippy.vn', source: 'cpanel', status: 'deleted', file_quota_bytes: 30 },
    ]);
  });
});

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

  it('treats numeric cPanel disk quotas as megabytes', () => {
    expect(normalizeMailbox({
      user: 'support',
      domain: 'example.com',
      diskquota: '1024.00',
      diskused: 0,
      humandiskquota: '1 GB',
      humandiskused: 'None',
    }, 'example.com')).toMatchObject({
      quotaBytes: 1024 * 1024 ** 2,
      diskUsedBytes: 0,
    });
  });

  it('ignores malformed rows without an email', () => {
    expect(normalizeMailbox({ user: '', domain: '' }, 'example.com')).toBeNull();
  });

  it('ignores rows returned for a different domain', () => {
    expect(normalizeMailbox({ user: 'support', domain: 'other.example' }, 'example.com')).toBeNull();
  });
});

describe('cPanel mailbox credentials', () => {
  it('generates a non-empty password of the requested length', () => {
    const password = generateMailboxPassword(24);
    expect(password).toHaveLength(24);
    // eslint-disable-next-line no-control-regex
    expect(password).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe('bulk mailbox input', () => {
  it('accepts a full email and applies the default quota', () => {
    const mailbox = normalizeBulkMailboxInput({ email: 'Support@Example.com' }, { domain: 'example.com' });
    expect(mailbox).toMatchObject({ localPart: 'support', quotaMb: 1024 });
    expect(mailbox.password).toHaveLength(20);
  });

  it('rejects a mailbox from another domain', () => {
    expect(() => normalizeBulkMailboxInput({ email: 'support@other.example' }, { domain: 'example.com' }))
      .toThrow('Mailbox must belong to example.com');
  });
});

describe('cPanel API error normalization', () => {
  it('includes array errors returned by UAPI', () => {
    expect(normalizeCpanelApiError({ result: { status: 0, errors: ['Access denied'] } }))
      .toBe('cPanel rejected the API request: Access denied');
  });

  it('handles string messages and redacts the API token', () => {
    expect(normalizeCpanelApiError({ result: { status: 0, messages: 'token abc123 is invalid' } }, { token: 'abc123' }))
      .toBe('cPanel rejected the API request: token [redacted] is invalid');
  });

  it('understands top-level and legacy cPanel result envelopes', () => {
    expect(normalizeCpanelApiError({ status: 0, errors: ['Access denied'] }))
      .toBe('cPanel rejected the API request: Access denied');
    expect(normalizeCpanelApiError({ cpanelresult: { status: 0, errors: ['Access denied'] } }))
      .toBe('cPanel rejected the API request: Access denied');
  });

  it('reports non-JSON and HTTP failures without exposing the response body', () => {
    expect(normalizeCpanelApiError(null)).toMatch(/invalid or non-JSON/);
    expect(normalizeCpanelApiError({ result: { errors: ['Forbidden'] } }, { httpStatus: 403 }))
      .toBe('cPanel returned HTTP 403: Forbidden');
    expect(normalizeCpanelApiError({ message: 'Access denied' }, { httpStatus: 403 }))
      .toBe('cPanel returned HTTP 403: Access denied');
  });
});

describe('cPanel API token expiry', () => {
  it('normalizes token inventory metadata without exposing token secrets', () => {
    expect(normalizeCpanelToken({
      name: 'mailflow',
      create_time: 1609372800,
      expires_at: null,
      readonly: 1,
      has_full_access: 1,
      token: 'must-not-be-returned',
    })).toEqual({
      name: 'mailflow',
      createdAt: '2020-12-31T00:00:00.000Z',
      expiresAt: null,
      expired: false,
      readonly: true,
      hasFullAccess: true,
    });
  });

  it('normalizes a date-only expiry and reports the remaining window', async () => {
    await expect(normalizeCpanelConfig({
      host: 'mail.example.com',
      port: 2083,
      username: 'cpuser',
      domain: 'example.com',
      token: 'token',
      tokenExpiresAt: '2026-10-15',
    }, { tokenRequired: true })).resolves.toMatchObject({ tokenExpiresAt: '2026-10-15' });
    expect(getCpanelTokenStatus('2026-10-15', new Date('2026-09-25T12:00:00Z')))
      .toMatchObject({ tokenExpired: false, tokenExpiresSoon: true, tokenExpiryDays: 20 });
  });

  it('rejects malformed expiry values', async () => {
    await expect(normalizeCpanelConfig({
      host: 'mail.example.com', port: 2083, username: 'cpuser', domain: 'example.com', token: 'token', tokenExpiresAt: 'tomorrow',
    }, { tokenRequired: true })).rejects.toThrow('expiration must be a valid date');
    expect(getCpanelTokenStatus('2026-09-24', new Date('2026-09-25T12:00:00Z')).tokenExpired).toBe(true);
  });
});
