#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import { execFile } from 'node:child_process'

const credentialsPath = process.argv[2]
const outputPath = process.argv[3]
const loginHint = process.argv[4] || ''
const port = Number(process.env.FILE_GOOGLE_OAUTH_PORT || 53682)

if (!credentialsPath || !outputPath) {
  console.error('Usage: node scripts/google-drive-authorize.mjs <oauth-client.json> <output-secret.json> [google-email]')
  process.exit(1)
}

const input = JSON.parse(await fs.readFile(credentialsPath, 'utf8'))
const client = input.installed || input.web
if (!client?.client_id || !client?.client_secret) throw new Error('OAuth client JSON is missing client credentials.')

// Google desktop OAuth clients register the loopback redirect under localhost.
// Keep the callback host aligned with that registration; the listener still
// binds locally and never exposes the authorization code beyond this machine.
const redirectUri = `http://localhost:${port}/oauth2/callback`
const state = crypto.randomBytes(32).toString('base64url')
const verifier = crypto.randomBytes(64).toString('base64url')
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
const authorize = new URL(client.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth')
authorize.search = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.file',
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'true',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  ...(loginHint ? { login_hint: loginHint } : {}),
})

let resolveCompletion
let rejectCompletion
const completion = new Promise((resolve, reject) => {
  resolveCompletion = resolve
  rejectCompletion = reject
})
const servers = []
let settled = false
let processingCallback = false
let timer

function closeServers() {
  for (const server of servers) {
    server.close()
  }
}

function finish(error) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  closeServers()
  if (error) rejectCompletion(error)
  else resolveCompletion()
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, redirectUri)
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Google OAuth callback listener is ready.')
    }
    if (url.pathname !== '/oauth2/callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not found')
    }
    if (processingCallback) {
      res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('OAuth callback is already being processed.')
    }
    processingCallback = true
    try {
      if (url.searchParams.get('state') !== state) throw new Error('OAuth state did not match.')
      if (url.searchParams.get('error')) throw new Error(`Google authorization failed: ${url.searchParams.get('error')}`)
      const code = url.searchParams.get('code')
      if (!code) throw new Error('Google callback did not include an authorization code.')
      const response = await fetch(client.token_uri || 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }),
      })
      const tokens = await response.json()
      if (!response.ok || !tokens.refresh_token) throw new Error('Google did not issue an offline refresh token. Revoke the prior grant and try again.')
      await fs.writeFile(outputPath, JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: tokens.refresh_token, scope: tokens.scope, account_email: loginHint }, null, 2), { mode: 0o600 })
      await fs.chmod(outputPath, 0o600)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<h1>Hippy Drive connected</h1><p>You can close this tab and return to Codex.</p>')
      finish()
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end(error.message)
      finish(error)
    }
  })
}

function listenOnLoopback(host) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port, host, ipv6Only: host === '::1' }, () => {
      server.removeListener('error', reject)
      servers.push(server)
      resolve(host)
    })
  })
}

const listeners = await Promise.allSettled([
  listenOnLoopback('127.0.0.1'),
  listenOnLoopback('::1'),
])
const activeHosts = listeners
  .filter((result) => result.status === 'fulfilled')
  .map((result) => result.value)

if (activeHosts.length === 0) {
  throw new AggregateError(
    listeners.map((result) => result.reason).filter(Boolean),
    `Could not listen for Google OAuth on port ${port}.`,
  )
}

timer = setTimeout(() => finish(new Error('OAuth authorization timed out.')), 10 * 60_000)
console.log(`Waiting for Google authorization at ${redirectUri}`)
console.log(`Loopback listeners active on: ${activeHosts.join(', ')}`)
console.log('If the browser does not open, visit this URL:')
console.log(authorize.toString())
if (process.env.FILE_GOOGLE_AUTH_URL_OUTPUT) {
  await fs.writeFile(process.env.FILE_GOOGLE_AUTH_URL_OUTPUT, `${authorize}\n`, { mode: 0o600 })
}
if (process.env.FILE_GOOGLE_SKIP_BROWSER_OPEN !== 'true') {
  execFile('open', [authorize.toString()], () => {})
}

await completion
console.log(`Google Drive credential saved securely to ${outputPath}`)
