import { Router } from 'express';
import { query } from '../services/db.js';
import { requireMailboxManager } from '../middleware/auth.js';

const router = Router();
const DEFAULT_BRANDING = { name: 'MailFlow', shortName: 'MailFlow', logo: null };
const MAX_NAME_LENGTH = 80;
const MAX_SHORT_NAME_LENGTH = 30;
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_RE = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i;

function cleanBranding(value) {
  const parsed = (() => {
    try { return value ? JSON.parse(value) : {}; } catch { return {}; }
  })();
  const name = String(parsed.name || DEFAULT_BRANDING.name).trim().slice(0, MAX_NAME_LENGTH) || DEFAULT_BRANDING.name;
  const shortName = String(parsed.shortName || name).trim().slice(0, MAX_SHORT_NAME_LENGTH) || name.slice(0, MAX_SHORT_NAME_LENGTH);
  const logo = typeof parsed.logo === 'string' && LOGO_RE.test(parsed.logo) ? parsed.logo : null;
  return { name, shortName, logo };
}

async function readBranding() {
  const result = await query("SELECT value, updated_at FROM system_settings WHERE key = 'branding'");
  const branding = cleanBranding(result.rows[0]?.value);
  return { ...branding, updatedAt: result.rows[0]?.updated_at || null };
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') throw new Error('Branding settings are required');
  const name = String(body.name ?? '').trim();
  const shortName = String(body.shortName ?? '').trim();
  if (!name || name.length > MAX_NAME_LENGTH) throw new Error(`App name must be between 1 and ${MAX_NAME_LENGTH} characters`);
  if (!shortName || shortName.length > MAX_SHORT_NAME_LENGTH) throw new Error(`Short name must be between 1 and ${MAX_SHORT_NAME_LENGTH} characters`);
  let logo = body.logo == null || body.logo === '' ? null : String(body.logo);
  if (logo) {
    const match = logo.match(LOGO_RE);
    if (!match) throw new Error('Logo must be a PNG, JPEG, or WebP image');
    const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64').length;
    if (bytes > MAX_LOGO_BYTES) throw new Error('Logo must be 512 KB or smaller');
  }
  return { name, shortName, logo };
}

router.get('/', async (_req, res) => {
  res.json({ branding: await readBranding() });
});

router.get('/logo', async (_req, res) => {
  const branding = await readBranding();
  if (!branding.logo) return res.redirect('/icon-512.png');
  const match = branding.logo.match(LOGO_RE);
  if (!match) return res.redirect('/icon-512.png');
  res.set('Cache-Control', 'no-store');
  res.type(match[1]);
  res.send(Buffer.from(match[2].replace(/\s/g, ''), 'base64'));
});

router.get('/manifest.json', async (_req, res) => {
  const branding = await readBranding();
  res.set('Cache-Control', 'no-store');
  res.json({
    name: branding.name,
    short_name: branding.shortName,
    description: `${branding.name} unified inbox`,
    start_url: '/',
    display: 'standalone',
    background_color: '#0f0f11',
    theme_color: '#7c6af7',
    orientation: 'portrait-primary',
    protocol_handlers: [{ protocol: 'mailto', url: '/?mailto=%s' }],
    icons: [
      { src: '/api/branding/logo', sizes: '512x512', type: branding.logo ? branding.logo.match(LOGO_RE)?.[1] : 'image/png', purpose: 'maskable any' },
    ],
  });
});

router.patch('/', requireMailboxManager, async (req, res) => {
  try {
    const branding = validatePayload(req.body);
    const result = await query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('branding', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
       RETURNING updated_at`,
      [JSON.stringify(branding)],
    );
    res.json({ ok: true, branding: { ...branding, updatedAt: result.rows[0]?.updated_at || null } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
