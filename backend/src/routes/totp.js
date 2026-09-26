import { Router } from 'express';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt } from '../services/encryption.js';
import {
  MailboxAuthenticationUnavailableError,
  verifyUserCredential,
} from '../services/mailboxAuth.js';

const router = Router();
router.use(requireAuth);

// In-memory rate limiter for TOTP verification attempts (5 per 15 min per user)
const totpBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of totpBuckets) {
    if (now > bucket.resetAt) totpBuckets.delete(key);
  }
}, 5 * 60 * 1000);

function totpLimiter(req, res, next) {
  const key = req.session.userId;
  const now = Date.now();
  const bucket = totpBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    totpBuckets.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return next();
  }
  if (bucket.count >= 5) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  bucket.count++;
  next();
}

// Re-authenticate before issuing a new MFA secret so a stolen session cannot
// replace the account's second factor.
router.post('/setup', totpLimiter, async (req, res) => {
  if (!req.body?.password) return res.status(400).json({ error: 'Current password required' });
  const userResult = await query('SELECT id, username, password_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = userResult.rows[0];
  if (!user) return res.status(401).json({ error: 'User not found' });
  try {
    if (!await verifyUserCredential(user, req.body.password)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
  } catch (error) {
    if (error instanceof MailboxAuthenticationUnavailableError) {
      return res.status(503).json({ error: 'Mailbox authentication is temporarily unavailable. Please try again later.' });
    }
    throw error;
  }

  const secret = authenticator.generateSecret(20);
  const otpauthUrl = authenticator.keyuri(user.username, 'MailFlow', secret);
  const qrCode = await QRCode.toDataURL(otpauthUrl);

  // Hold the secret in the session until the user verifies it (10 min TTL)
  req.session.pendingTOTPSecret = secret;
  req.session.pendingTOTPExpiry = Date.now() + 10 * 60 * 1000;

  res.json({ secret, qrCode });
});

// POST /api/totp/enable — verify a code against the pending secret and save it
router.post('/enable', totpLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const secret = req.session.pendingTOTPSecret;
  const expiry = req.session.pendingTOTPExpiry;
  if (!secret) return res.status(400).json({ error: 'No pending setup found. Start over.' });
  if (!expiry || Date.now() > expiry) {
    delete req.session.pendingTOTPSecret;
    delete req.session.pendingTOTPExpiry;
    return res.status(400).json({ error: 'Setup session expired. Start over.' });
  }

  if (!authenticator.verify({ token: String(code).replace(/\s/g, ''), secret })) {
    return res.status(400).json({ error: 'Invalid code — check your device clock and try again.' });
  }

  await query(
    'UPDATE users SET totp_secret = $1, totp_enabled = true WHERE id = $2',
    [encrypt(secret), req.session.userId]
  );
  delete req.session.pendingTOTPSecret;
  delete req.session.pendingTOTPExpiry;

  res.json({ ok: true });
});

// POST /api/totp/cancel — discard a pending setup without enabling TOTP
router.post('/cancel', (req, res) => {
  delete req.session.pendingTOTPSecret;
  delete req.session.pendingTOTPExpiry;
  res.json({ ok: true });
});

// POST /api/totp/disable — disable 2FA after confirming password
router.post('/disable', totpLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const result = await query('SELECT id, username, password_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'User not found' });
  try {
    if (!await verifyUserCredential(user, password)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
  } catch (error) {
    if (error instanceof MailboxAuthenticationUnavailableError) {
      return res.status(503).json({ error: 'Mailbox authentication is temporarily unavailable. Please try again later.' });
    }
    throw error;
  }

  await query(
    'UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1',
    [req.session.userId]
  );

  res.json({ ok: true });
});

export default router;
