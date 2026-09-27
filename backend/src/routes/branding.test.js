import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  requireMailboxManager: (req, res, next) => {
    if (req.get('x-test-role') !== 'mod') return res.status(403).json({ error: 'Mailbox management access required' });
    req.session = { userId: 'mod-1' };
    next();
  },
}));

vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));

import express from 'express';
import brandingRoutes from './branding.js';
import { query } from '../services/db.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/branding', brandingRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }));

describe('branding settings', () => {
  it('serves default public branding and a dynamic manifest', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const branding = await fetch(`${base}/api/branding`);
    expect(branding.status).toBe(200);
    expect((await branding.json()).branding.name).toBe('MailFlow');
    const manifest = await fetch(`${base}/api/branding/manifest.json`);
    expect(manifest.status).toBe(200);
    expect((await manifest.json()).short_name).toBe('MailFlow');
  });

  it('allows a mailbox manager to save valid branding', async () => {
    query.mockResolvedValueOnce({ rows: [{ updated_at: '2026-01-01T00:00:00.000Z' }] });
    const response = await fetch(`${base}/api/branding`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-role': 'mod' },
      body: JSON.stringify({ name: 'Hippy Mail', shortName: 'Hippy', logo: null }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).branding.name).toBe('Hippy Mail');
  });

  it('rejects invalid logo formats', async () => {
    const response = await fetch(`${base}/api/branding`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-role': 'mod' },
      body: JSON.stringify({ name: 'Hippy Mail', shortName: 'Hippy', logo: 'data:image/svg+xml;base64,PHN2Zy8+' }),
    });
    expect(response.status).toBe(400);
  });
});
