#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const suite = arg('--suite', process.env.FILE_UAT_SUITE || 'tracer')
const base = arg('--base-url', process.env.FILE_UAT_URL || process.env.FILE_SERVICE_URL || '').replace(/\/$/, '')
const output = path.resolve(arg('--output', process.env.FILE_UAT_OUTPUT || `artifacts/file-pwa/f6/live-${suite}.json`))
const providerExpected = process.env.FILE_UAT_PROVIDER || ''
const primary = { id: process.env.FILE_UAT_DIRECT_USER_ID || process.env.FILE_PWA_UAT_USER_ID, email: process.env.FILE_UAT_EMAIL || 'f6-uat@example.test', token: process.env.FILE_UAT_ACCESS_TOKEN }
const other = { id: process.env.FILE_UAT_OTHER_USER_ID, email: process.env.FILE_UAT_OTHER_EMAIL || 'f6-other@example.test', token: process.env.FILE_UAT_OTHER_ACCESS_TOKEN }
const admin = { id: process.env.FILE_UAT_ADMIN_USER_ID, email: process.env.FILE_UAT_ADMIN_EMAIL || 'f6-admin@example.test', token: process.env.FILE_UAT_ADMIN_ACCESS_TOKEN }

if (!['tracer', 'full'].includes(suite)) throw new Error('--suite must be tracer or full')
if (!base) throw new Error('FILE_UAT_URL or --base-url is required')
if (!primary.id && !primary.token) throw new Error('FILE_UAT_ACCESS_TOKEN or FILE_UAT_DIRECT_USER_ID is required')

const checks = []
const contracts = {}
const redact = value => String(value)
  .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
  .replace(/(token|secret|cookie|provider[_-]?(?:file[_-]?)?id|email)\s*[:=]\s*[^,\s}]+/gi, '$1=[REDACTED]')
const record = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: redact(detail) })
  if (!ok) throw new Error(`${name}: ${detail}`)
  contracts[name] = true
}
const authHeaders = identity => identity.token
  ? { authorization: `Bearer ${identity.token}` }
  : { 'x-dev-user-id': identity.id, 'x-dev-email': identity.email }
const request = async (identity, method, route, body, options = {}) => {
  const headers = { ...authHeaders(identity), ...(options.headers || {}) }
  if (body !== undefined && !Buffer.isBuffer(body)) headers['content-type'] ||= 'application/json'
  if (body !== undefined && !headers['idempotency-key']) headers['idempotency-key'] = `f6-${crypto.randomUUID()}`
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) })
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  const expected = options.status ? response.status === options.status : response.ok
  const safeRoute = route.split('?')[0].replace(/\/(nodes|uploads|operations)\/[^/]+/g, '/$1/:id')
  checks.push({ name: `${method} ${safeRoute}`, ok: expected, status: response.status, request_id: response.headers.get('x-request-id') || null })
  if (!expected) throw new Error(`${method} ${safeRoute} returned HTTP ${response.status}`)
  return { payload, response }
}

const artifact = { schema_version: 1, ok: false, suite, provider: null, started_at: new Date().toISOString(), checks, contracts, evidence_policy: 'redacted-no-identities-tokens-provider-ids-or-content' }
let folderId
try {
  const healthResponse = await fetch(`${base}/health`)
  const health = await healthResponse.json()
  record('health', healthResponse.ok && health.ok, `HTTP ${healthResponse.status}`)
  artifact.provider = health.provider_type || health.provider?.type || 'unknown'
  if (providerExpected) record('provider type', artifact.provider === providerExpected, `expected=${providerExpected} actual=${artifact.provider}`)

  const { payload: meBefore } = await request(primary, 'GET', '/api/files/me')
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const { payload: folder } = await request(primary, 'POST', '/api/files/folders', { parent_id: meBefore.home.id, name: `F6-UAT-${stamp}` })
  folderId = folder.node.id
  const content = Buffer.from(`Hippy Files F6 UAT ${stamp}\n`)
  const checksum = crypto.createHash('sha256').update(content).digest('hex')
  const { payload: intent } = await request(primary, 'POST', '/api/files/uploads', { parent_id: folderId, name: `f6-uat-${stamp}.png`, size_bytes: content.length, mime_type: 'image/png' })
  const split = Math.max(1, Math.floor(content.length / 2))
  const first = content.subarray(0, split)
  await request(primary, 'PATCH', `/api/files/uploads/${intent.upload_id}?finalize=false`, first, { headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes 0-${first.length - 1}/${content.length}` } })
  const { payload: status } = await request(primary, 'GET', `/api/files/uploads/${intent.upload_id}`)
  record('resumable upload status', status.upload.expected_offset === first.length, `offset=${status.upload.expected_offset}`)
  const rest = content.subarray(status.upload.expected_offset)
  const { payload: committed } = await request(primary, 'PATCH', `/api/files/uploads/${intent.upload_id}?finalize=true`, rest, { headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${status.upload.expected_offset}-${content.length - 1}/${content.length}` } })
  const nodeId = committed.node.id
  record('provider-confirmed finalize', committed.node.size_bytes === content.length, `size=${committed.node.size_bytes}`)

  const { payload: downloaded } = await request(primary, 'GET', `/api/files/nodes/${nodeId}/download`)
  record('download checksum', crypto.createHash('sha256').update(downloaded).digest('hex') === checksum)
  const { payload: previewed } = await request(primary, 'GET', `/api/files/nodes/${nodeId}/preview`)
  record('authorized preview checksum', crypto.createHash('sha256').update(previewed).digest('hex') === checksum)
  await request(primary, 'PATCH', `/api/files/nodes/${nodeId}/star`, { starred: true })
  const { payload: starred } = await request(primary, 'GET', `/api/files/nodes?starred=true&parent_id=${encodeURIComponent(folderId)}&limit=1`)
  record('durable star', starred.nodes.some(node => node.id === nodeId))
  const { payload: activity } = await request(primary, 'GET', `/api/files/nodes/${nodeId}/activity?limit=20`)
  record('redacted activity', activity.events.some(event => event.action === 'node_star') && activity.events.every(event => !('metadata' in event) && !('provider_file_id' in event)))
  const { payload: firstPage } = await request(primary, 'GET', `/api/files/nodes?parent_id=${encodeURIComponent(folderId)}&limit=1`)
  record('cursor page shape', Boolean(firstPage.page) && typeof firstPage.page.has_more === 'boolean')
  const { payload: bulk } = await request(primary, 'POST', '/api/files/nodes/bulk', { action: 'trash', ids: [nodeId, 'missing-f6-uat-node'] })
  record('bulk partial outcomes', bulk.summary.succeeded === 1 && bulk.summary.failed === 1 && Array.isArray(bulk.outcomes))
  await request(primary, 'POST', '/api/files/nodes/bulk', { action: 'restore', ids: [nodeId] })

  if (other.id || other.token) {
    await request(other, 'GET', `/api/files/nodes/${nodeId}/download`, undefined, { status: 404 })
    await request(other, 'GET', `/api/files/nodes/${nodeId}/preview`, undefined, { status: 404 })
    record('cross-user isolation', true)
  } else if (providerExpected === 'google-drive') throw new Error('A second user credential is required for live-provider isolation evidence')

  const overQuota = await request(primary, 'POST', '/api/files/uploads', { parent_id: folderId, name: 'must-not-fit.bin', size_bytes: Number(meBefore.quota.quota_bytes) + 1, mime_type: 'application/octet-stream' }, { status: 409 })
  record('hard quota', overQuota.payload?.error?.code === 'file_quota_exceeded')

  if (suite === 'full') {
    const cancelIntent = await request(primary, 'POST', '/api/files/uploads', { parent_id: folderId, name: 'cancel.bin', size_bytes: 4, mime_type: 'application/octet-stream' })
    const cancelKey = `f6-cancel-${crypto.randomUUID()}`
    const canceled = await request(primary, 'POST', `/api/files/uploads/${cancelIntent.payload.upload_id}/cancel`, {}, { headers: { 'idempotency-key': cancelKey } })
    const replay = await request(primary, 'POST', `/api/files/uploads/${cancelIntent.payload.upload_id}/cancel`, {}, { headers: { 'idempotency-key': cancelKey } })
    record('idempotent upload cancel', canceled.payload.upload.state === 'canceled' && replay.response.headers.get('idempotency-replayed') === 'true')
    if (admin.id || admin.token) {
      const adminHeaders = admin.id ? { 'x-dev-admin': 'true', 'x-dev-step-up': 'true' } : {}
      const maintenance = await request(admin, 'POST', '/api/admin/file-maintenance', {}, { headers: adminHeaders })
      record('maintenance accepted', [200, 202].includes(maintenance.response.status))
      const reconcile = await request(admin, 'POST', '/api/admin/file-reconcile', {}, { headers: adminHeaders })
      record('reconcile non-destructive', reconcile.response.status === 202 || reconcile.payload.destructive_actions === 0)
      if (maintenance.response.status === 202 && maintenance.payload.operation?.id) {
        const operation = await request(admin, 'GET', `/api/files/operations/${maintenance.payload.operation.id}`, undefined, { headers: adminHeaders })
        record('worker operation status redacted', operation.payload.operation && !('payload' in operation.payload.operation))
      }
    } else if (providerExpected === 'google-drive') throw new Error('Admin credentials are required for full live worker evidence')
  }
  artifact.ok = true
} catch (error) {
  artifact.error = redact(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  if (folderId) {
    try { await request(primary, 'POST', `/api/files/nodes/${folderId}/trash`, {}) } catch { artifact.cleanup = 'failed' }
  }
  artifact.cleanup ||= 'attempted'
  artifact.finished_at = new Date().toISOString()
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ ok: artifact.ok, suite, provider: artifact.provider, output, checks: checks.length }))
}
