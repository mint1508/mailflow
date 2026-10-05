import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createApp } from '../../src/server.js'

const defaults = {
  authMode: 'mock',
  providerType: 'fake-disk',
  uploadGraceMs: 300_000,
  trashRetentionDays: 30,
  rateLimitPerMinute: 1_000,
  maxUploadBytes: 1_000_000,
  defaultQuotaBytes: 1_000_000,
  webOrigin: 'http://localhost:3000',
  lifecycleSyncSecret: 'fixture-only-secret',
  providerRetryAttempts: 3,
  providerRetryBaseMs: 1,
  syntheticMaxBytes: 1024 ** 3,
  dbUrl: '',
  redisUrl: '',
}

// Use a real ephemeral HTTP port so request streaming, headers and response
// completion follow the same path as production. No shared data survives stop().
export async function startFileAppFixture(overrides = {}, context) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-pwa-test-'))
  let server
  try {
    const app = await createApp({ ...defaults, ...overrides, dataDir })
    server = http.createServer(app.handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    let sequence = 0
    let stopped = false

    async function request(method, route, body, extraHeaders = {}) {
      const headers = {
        'x-dev-user-id': 'fixture-user',
        'x-dev-email': 'fixture@example.test',
        ...extraHeaders,
      }
      const hasBody = body !== undefined
      const raw = body instanceof Uint8Array || typeof body === 'string'
      if (hasBody) {
        headers['content-type'] ??= raw ? 'application/octet-stream' : 'application/json'
        if (!Object.hasOwn(headers, 'idempotency-key')) headers['idempotency-key'] = `fixture-${++sequence}`
      }
      const response = await fetch(new URL(route, baseUrl), {
        method,
        headers,
        body: !hasBody ? undefined : raw ? body : JSON.stringify(body),
      })
      const bytes = Buffer.from(await response.arrayBuffer())
      let json = null
      if (response.headers.get('content-type')?.includes('application/json') && bytes.length) json = JSON.parse(bytes.toString())
      return { status: response.status, headers: Object.fromEntries(response.headers), json, body: bytes }
    }

    async function stop() {
      if (stopped) return
      stopped = true
      try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
      finally { await fs.rm(dataDir, { recursive: true, force: true }) }
    }

    const fixture = { app, server, baseUrl, dataDir, request, call: request, stop }
    context?.after(() => stop())
    return fixture
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    await fs.rm(dataDir, { recursive: true, force: true })
    throw error
  }
}
