import { describe, expect, it, vi } from 'vitest';
import { buildAuthentikLifecycleProjection, planAuthentikLifecycle, syncAuthentikLifecycle } from './authentikLifecycle.js';

describe('Authentik lifecycle projection', () => {
  it('uses Mailflow users as the allow-list and cPanel status as activation state', () => {
    expect(buildAuthentikLifecycleProjection([
      { email: 'Active@Hippy.vn', display_name: 'Active', is_present: true, suspended: false },
      { email: 'suspended@hippy.vn', display_name: '', is_present: true, suspended: true },
      { email: 'missing@hippy.vn', display_name: null, is_present: null, suspended: null },
      { email: 'external@example.com', display_name: 'External', is_present: true, suspended: false },
    ], 'hippy.vn')).toEqual([
      { email: 'active@hippy.vn', name: 'Active', active: true },
      { email: 'suspended@hippy.vn', name: 'suspended@hippy.vn', active: false },
      { email: 'missing@hippy.vn', name: 'missing@hippy.vn', active: false },
    ]);
  });

  it('creates missing users, updates changed users, and deactivates removed managed users', () => {
    const desired = [
      { email: 'new@hippy.vn', name: 'New', active: true },
      { email: 'restore@hippy.vn', name: 'Restore', active: true },
    ];
    const existing = [
      { pk: 1, username: 'restore@hippy.vn', email: 'restore@hippy.vn', is_active: false, attributes: { note: 'keep' } },
      { pk: 2, username: 'gone@hippy.vn', email: 'gone@hippy.vn', is_active: true, attributes: { mailflow_managed: true } },
      { pk: 3, username: 'external@example.com', email: 'external@example.com', is_active: true, attributes: {} },
    ];
    expect(planAuthentikLifecycle(desired, existing)).toEqual([
      { type: 'create', desired: desired[0] },
      { type: 'update', existing: existing[0], desired: desired[1], attributes: { note: 'keep', mailflow_managed: true } },
      { type: 'deactivate', existing: existing[1] },
    ]);
  });
});

describe('Authentik lifecycle sync', () => {
  it('reconciles through the API without sending passwords', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (!options.method) return new Response(JSON.stringify({ results: [], pagination: { next: 0 } }), { status: 200 });
      return new Response(JSON.stringify({ pk: 10 }), { status: 200 });
    });
    const result = await syncAuthentikLifecycle({
      env: { AUTHENTIK_API_URL: 'https://auth.test/api/v3', AUTHENTIK_API_TOKEN: 'secret', AUTHENTIK_MANAGED_DOMAIN: 'hippy.vn' },
      fetchImpl,
      queryImpl: vi.fn(async () => ({ rows: [{ email: 'user@hippy.vn', display_name: 'User', is_present: true, suspended: false }] })),
    });
    expect(result).toMatchObject({ created: 1, updated: 0, deactivated: 0 });
    expect(calls[1].options.headers.authorization).toBe('Bearer secret');
    const body = JSON.parse(calls[1].options.body);
    expect(body).toMatchObject({ username: 'user@hippy.vn', is_active: true, attributes: { mailflow_managed: true } });
    expect(JSON.stringify(body)).not.toContain('password');
  });
});
