#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const base = (process.env.FILE_SERVICE_URL || 'http://127.0.0.1:4310').replace(/\/$/, '')
const count = Number(process.env.FILE_UAT_USERS || 20)
const prefix = process.env.FILE_UAT_PREFIX || `uat-${Date.now()}`

async function request(userId, method, path, body, admin = false) {
  const headers = {
    'X-Dev-User-Id': userId,
    'X-Dev-Email': `${userId}@hippy.vn`,
  }
  if (admin) headers['X-Dev-Admin'] = 'true'
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['Idempotency-Key'] = crypto.randomUUID()
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

for (let index = 1; index <= count; index++) {
  const user = `${prefix}-${String(index).padStart(2, '0')}`
  const me = await request(user, 'GET', '/api/files/me')
  const folder = await request(user, 'POST', '/api/files/folders', {
    parent_id: me.home.id,
    name: `Pilot ${index}`,
  })
  const content = `hippy-file-pilot-${index}`
  const upload = await request(user, 'POST', '/api/files/uploads', {
    parent_id: folder.node.id,
    name: `evidence-${index}.txt`,
    size_bytes: Buffer.byteLength(content),
    mime_type: 'text/plain',
  })
  const first = Buffer.from(content).subarray(0, Math.max(1, Math.floor(content.length / 2)))
  await request(user, 'PATCH', `/api/files/uploads/${upload.upload_id}?finalize=false`, {
    data: first.toString('base64'), encoding: 'base64', finalize: false,
  })
  const status = await request(user, 'GET', `/api/files/uploads/${upload.upload_id}`)
  assert.equal(status.upload.expected_offset, first.length)
  const committed = await request(user, 'PATCH', `/api/files/uploads/${upload.upload_id}`, {
    data: Buffer.from(content).subarray(status.upload.expected_offset).toString('base64'), encoding: 'base64', finalize: true,
  })
  const search = await request(user, 'GET', `/api/files/search?q=evidence-${index}`)
  assert.equal(search.nodes.length, 1)
  const downloaded = await request(user, 'GET', `/api/files/nodes/${committed.node.id}/download`)
  assert.equal(downloaded.toString(), content)
  await request(user, 'PATCH', `/api/files/nodes/${committed.node.id}/star`, { starred: true })
  const starred = await request(user, 'GET', `/api/files/nodes?starred=true&parent_id=${encodeURIComponent(folder.node.id)}&limit=1`)
  assert.equal(starred.nodes[0].id, committed.node.id)
  const activity = await request(user, 'GET', `/api/files/nodes/${committed.node.id}/activity`)
  assert.ok(activity.events.some(event => event.action === 'node_star'))
  await request(user, 'POST', `/api/files/nodes/${committed.node.id}/trash`, {})
  const trash = await request(user, 'GET', '/api/files/nodes?state=trashed')
  assert.ok(trash.nodes.some(node => node.id === committed.node.id))
  await request(user, 'POST', `/api/files/nodes/${committed.node.id}/restore`, {})
}

const bulkUser = `${prefix}-01`
const bulkMe = await request(bulkUser, 'GET', '/api/files/me')
const bulkFolder = await request(bulkUser, 'POST', '/api/files/folders', { parent_id: bulkMe.home.id, name: 'Bulk outcome' })
const bulk = await request(bulkUser, 'POST', '/api/files/nodes/bulk', { action: 'trash', ids: [bulkFolder.node.id, 'missing-uat-node'] })
assert.equal(bulk.summary.succeeded, 1)
assert.equal(bulk.summary.failed, 1)

const target = `${prefix}-01`
const admin = `${prefix}-admin`
await request(admin, 'PATCH', `/api/admin/file-users/${target}`, { locked: true }, true)
const revoked = await fetch(`${base}/api/files/me`, {
  headers: { 'X-Dev-User-Id': target, 'X-Dev-Email': `${target}@hippy.vn` },
})
assert.equal(revoked.status, 403)
const revokedBody = await revoked.json()
assert.equal(revokedBody.error.code, 'file_access_revoked')

const health = await request(admin, 'GET', '/api/admin/file-health', undefined, true)
assert.equal(health.provider.type, 'fake-disk')
assert.equal(health.provider.simulated, true)
const audit = await request(admin, 'GET', '/api/admin/file-audit', undefined, true)
assert.ok(audit.events.length >= count * 5)

console.log(`UAT passed for ${count} users with fake-disk storage`)
