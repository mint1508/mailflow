import crypto from 'node:crypto'

const base64url = value => Buffer.from(value).toString('base64url')
const cookieValue = (req, name) => String(req.headers.cookie || '').split(';').map(v => v.trim().split('=')).find(([key]) => key === name)?.[1]
const bearer = req => { const value = req.headers.authorization || ''; return value.startsWith('Bearer ') ? value.slice(7) : null }
const timingEqual = (left, right) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && crypto.timingSafeEqual(a, b) }
const hasAudience = (claim, expected) => Array.isArray(claim) ? claim.includes(expected) : claim === expected
const jwtClaims = token => {
  try {
    const parts = String(token || '').split('.'); if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch { return null }
}

export function createAuthenticator(config) {
  const pending = new Map(); const sessions = new Map(); const stateTtlMs = 10 * 60_000; const sessionTtlMs = 8 * 60 * 60_000; const maxEntries = 1000
  const prune = map => { const stamp = Date.now(); for (const [key, value] of map) if (value.expiresAt <= stamp) map.delete(key); while (map.size >= maxEntries) map.delete(map.keys().next().value) }
  const sign = value => crypto.createHmac('sha256', config.sessionSecret || '').update(value).digest('base64url')
  const sessionCookie = (value, clear = false) => `hippy_file_session=${value}; Path=/; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}${clear ? '; Max-Age=0' : `; Max-Age=${Math.floor(sessionTtlMs / 1000)}`}`
  async function identityForToken(token, expectedSubject) {
    const tokenClaims = jwtClaims(token)
    // Authentik access tokens are JWTs in production, while a few OIDC test
    // providers return opaque tokens. Enforce the configured audience whenever
    // one is present, and validate standard time/issuer claims when available.
    // An opaque access token has no local audience claim. The code flow is
    // still bound to the already-validated ID-token subject; bearer requests
    // must carry a JWT with the configured audience.
    if (!expectedSubject && config.oidcAudience && (!tokenClaims || !hasAudience(tokenClaims.aud, config.oidcAudience))) return null
    if (tokenClaims) {
      const now = Math.floor(Date.now() / 1000)
      if (tokenClaims.exp !== undefined && (!Number.isFinite(Number(tokenClaims.exp)) || Number(tokenClaims.exp) <= now)) return null
      if (tokenClaims.nbf !== undefined && Number.isFinite(Number(tokenClaims.nbf)) && Number(tokenClaims.nbf) > now) return null
      if (config.oidcIssuer && tokenClaims.iss && tokenClaims.iss !== config.oidcIssuer) return null
    }
    const response = await fetch(config.oidcUserinfoUrl, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }); if (!response.ok) return null
    const info = await response.json(); if (!info.sub || (config.oidcIssuer && info.iss && info.iss !== config.oidcIssuer)) return null
    if (expectedSubject && info.sub !== expectedSubject) return null
    const permissions = Array.isArray(info.permissions) ? info.permissions : []
    return { id: info.sub, email: info.email, admin: permissions.some(p => p.startsWith('files:admin')), permissions, stepUp: Number(info.auth_time || 0) * 1000 > Date.now() - 10 * 60_000 }
  }
  async function authenticate(req) {
    if (config.authMode === 'mock') { const userId = req.headers['x-dev-user-id']; if (!userId) return null; return { id: String(userId), email: String(req.headers['x-dev-email'] || `${userId}@hippy.vn`), admin: req.headers['x-dev-admin'] === 'true', permissions: String(req.headers['x-dev-permissions'] || '').split(',').filter(Boolean), stepUp: req.headers['x-dev-step-up'] === 'true' } }
    const token = bearer(req); if (token) return identityForToken(token)
    const signed = cookieValue(req, 'hippy_file_session'); if (!signed) return null
    const [sessionId, signature] = signed.split('.'); if (!sessionId || !signature || !timingEqual(signature, sign(sessionId))) return null
    prune(sessions); return sessions.get(sessionId)?.actor || null
  }
  function loginUrl() {
    if (config.authMode !== 'oidc' || !config.oidcAuthorizationUrl || !config.oidcClientId || !config.oidcRedirectUri || !config.sessionSecret) throw new Error('OIDC browser flow is not configured.')
    prune(pending); const state = base64url(crypto.randomBytes(32)); const verifier = base64url(crypto.randomBytes(48)); const challenge = base64url(crypto.createHash('sha256').update(verifier).digest()); pending.set(state, { verifier, expiresAt: Date.now() + stateTtlMs })
    const url = new URL(config.oidcAuthorizationUrl); url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', config.oidcClientId); url.searchParams.set('redirect_uri', config.oidcRedirectUri); url.searchParams.set('scope', 'openid email profile'); url.searchParams.set('state', state); url.searchParams.set('code_challenge', challenge); url.searchParams.set('code_challenge_method', 'S256'); return url.toString()
  }
  async function callback(code, state) {
    prune(pending); const request = pending.get(state); pending.delete(state); if (!request || !code) return null
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.oidcRedirectUri, client_id: config.oidcClientId, code_verifier: request.verifier }); if (config.oidcClientSecret) form.set('client_secret', config.oidcClientSecret)
    const tokenResponse = await fetch(config.oidcTokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(5000) }); if (!tokenResponse.ok) return null
    const tokenSet = await tokenResponse.json(); if (!tokenSet.access_token || !tokenSet.id_token) return null
    const claims = jwtClaims(tokenSet.id_token); const now = Math.floor(Date.now() / 1000)
    if (!claims?.sub || !hasAudience(claims.aud, config.oidcClientId) || (config.oidcIssuer && claims.iss !== config.oidcIssuer) || (claims.exp && claims.exp <= now)) return null
    const actor = await identityForToken(tokenSet.access_token, claims.sub); if (!actor) return null
    prune(sessions); const sessionId = base64url(crypto.randomBytes(32)); sessions.set(sessionId, { actor, expiresAt: Date.now() + sessionTtlMs }); return sessionCookie(`${sessionId}.${sign(sessionId)}`)
  }
  function logout(req) { const signed = cookieValue(req, 'hippy_file_session'); const sessionId = signed?.split('.')[0]; if (sessionId) sessions.delete(sessionId); return sessionCookie('', true) }
  return Object.assign(authenticate, { loginUrl, callback, logout, _pending: pending, _sessions: sessions })
}
