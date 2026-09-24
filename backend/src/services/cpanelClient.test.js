import { describe, expect, it } from 'vitest';
import { generateMailboxPassword, normalizeCpanelApiError, normalizeMailbox } from './cpanelClient.js';

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

describe('cPanel mailbox credentials', () => {
  it('generates a non-empty password of the requested length', () => {
    const password = generateMailboxPassword(24);
    expect(password).toHaveLength(24);
    // eslint-disable-next-line no-control-regex
    expect(password).not.toMatch(/[\u0000-\u001f\u007f]/);
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
