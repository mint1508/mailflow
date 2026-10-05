import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../src/server.js'

async function fixture(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hippy-file-'))
  const app = await createApp({ dataDir: dir, authMode: 'mock', uploadGraceMs: 300000, trashRetentionDays: 30, rateLimitPerMinute: 1000, maxUploadBytes: 1000000, defaultQuotaBytes: 10, webOrigin: 'http://localhost:3000', lifecycleSyncSecret: 'sync-test-secret', providerRetryAttempts: 3, providerRetryBaseMs: 1, syntheticMaxBytes: 1024 ** 3, ...overrides })
  async function call(method, url, body, extra = {}) {
    const headers = { 'x-dev-user-id': 'u1', 'x-dev-email': 'one@hippy.vn', ...extra }
    const raw = Buffer.isBuffer(body)
    if (body !== undefined) { headers['content-type'] = raw ? 'application/octet-stream' : 'application/json'; if (!Object.hasOwn(extra, 'idempotency-key')) headers['idempotency-key'] = `k-${Math.random()}` }
    const encoded = body === undefined ? undefined : raw ? body : Buffer.from(JSON.stringify(body))
    const req = new Request(`http://localhost${url}`, { method, headers, body: encoded })
    const request = { method, url, headers: Object.fromEntries(req.headers), socket: { remoteAddress: 'test' }, async *[Symbol.asyncIterator]() { if (encoded !== undefined) yield encoded } }
    return new Promise(resolve => { const response = { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers) }, end(value) { let json = null; if (value) try { json = JSON.parse(Buffer.isBuffer(value) ? value.toString() : value) } catch {}; resolve({ status: this.status, headers: this.headers, json, body: Buffer.isBuffer(value) ? value : Buffer.from(value || '') }) } }; app.handler(request, response) })
  }
  return { call, app }
}

test('creates user, folder, upload and downloads fake provider bytes', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); assert.equal(me.status, 200); const root = me.json.home.id
  const folder = await call('POST', '/api/files/folders', { name: 'Docs', parent_id: root }); assert.equal(folder.status, 201)
  const intent = await call('POST', '/api/files/uploads', { name: 'hello.txt', parent_id: folder.json.node.id, size_bytes: 5, mime_type: 'text/plain' }); assert.equal(intent.status, 201)
  const uploaded = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'hello', finalize: true }); assert.equal(uploaded.status, 200)
  const downloaded = await call('GET', `/api/files/nodes/${uploaded.json.node.id}/download`); assert.equal(downloaded.status, 200); assert.equal(downloaded.body.toString(), 'hello'); assert.match(downloaded.headers['content-disposition'], /hello\.txt/)
})

test('resumable upload exposes authoritative offset, rejects gaps and releases reservation on cancel', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); const intent = await call('POST', '/api/files/uploads', { name:'resume.bin', parent_id:me.json.home.id, size_bytes:6 })
  const id = intent.json.upload_id
  assert.equal((await call('GET', `/api/files/uploads/${id}`)).json.upload.expected_offset, 0)
  assert.equal((await call('PATCH', `/api/files/uploads/${id}`, Buffer.from('abc'), {'content-type':'application/octet-stream','content-range':'bytes 1-3/6'})).status, 409)
  assert.equal((await call('PATCH', `/api/files/uploads/${id}`, Buffer.from('abc'), {'content-type':'application/octet-stream','content-range':'bytes 0-2/6'})).status, 200)
  const canceled = await call('POST', `/api/files/uploads/${id}/cancel`, {}, {'idempotency-key':'cancel-resume'})
  assert.equal(canceled.status, 200); assert.equal(canceled.json.upload.state, 'canceled')
})

test('resumable upload rejects ranges beyond the declared upload without advancing offset', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const uploadId = (await call('POST', '/api/files/uploads', { name: 'strict-range.bin', parent_id: me.json.home.id, size_bytes: 6 })).json.upload_id
  const offset = async () => (await call('GET', `/api/files/uploads/${uploadId}`)).json.upload.received_bytes

  assert.equal((await call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('abcdefg'), { 'content-range': 'bytes 0-6/7', 'content-length': '7' })).status, 422)
  assert.equal(await offset(), 0)

  assert.equal((await call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('abcdefg'), { 'content-range': 'bytes 0-6/6', 'content-length': '7' })).status, 422)
  assert.equal(await offset(), 0)

  assert.equal((await call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('abc'), { 'content-range': 'bytes 0-2/*', 'content-length': '3' })).status, 422)
  assert.equal(await offset(), 0)

  assert.equal((await call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('ab'), { 'content-range': 'bytes 0-2/6', 'content-length': '2' })).status, 422)
  assert.equal(await offset(), 0)

  const short = await call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('ab'), { 'content-range': 'bytes 0-2/6' })
  assert.equal(short.status, 422)
  assert.equal(await offset(), 0)

  const accepted = await call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('abc'), { 'content-range': 'bytes 0-2/6' })
  assert.equal(accepted.status, 200)
  assert.equal(await offset(), 3)
})

test('terminal uploads reject append and finalize before reading the body or calling the provider', async () => {
  for (const terminalState of ['canceled', 'failed', 'expired']) {
    const { call, app } = await fixture(); const me = await call('GET', '/api/files/me')
    const uploadId = (await call('POST', '/api/files/uploads', { name: `${terminalState}.bin`, parent_id: me.json.home.id, size_bytes: 3 })).json.upload_id
    await app.store.transaction(state => { state.uploads.find(upload => upload.id === uploadId).state = terminalState })
    let providerCalls = 0
    const originalAppendStream = app.provider.appendStream.bind(app.provider)
    app.provider.appendStream = async (...args) => { providerCalls++; return originalAppendStream(...args) }

    const append = await call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('abc'), { 'content-range': 'bytes 0-2/3' })
    assert.equal(append.status, 409); assert.equal(append.json.error.details.upload_state, terminalState)
    const finalize = await call('PATCH', `/api/files/uploads/${uploadId}`, { finalize: true })
    assert.equal(finalize.status, 409); assert.equal(finalize.json.error.details.upload_state, terminalState)
    assert.equal(providerCalls, 0)
  }
})

test('cancel wins the transaction race and prevents a later append from reviving the upload', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const uploadId = (await call('POST', '/api/files/uploads', { name: 'race.bin', parent_id: me.json.home.id, size_bytes: 3 })).json.upload_id
  const cancel = call('POST', `/api/files/uploads/${uploadId}/cancel`, {}, { 'idempotency-key': 'cancel-race' })
  const append = call('PATCH', `/api/files/uploads/${uploadId}`, Buffer.from('abc'), { 'content-range': 'bytes 0-2/3' })
  assert.equal((await cancel).status, 200)
  assert.equal((await append).status, 409)
  const upload = await call('GET', `/api/files/uploads/${uploadId}`)
  assert.equal(upload.json.upload.state, 'canceled'); assert.equal(upload.json.upload.received_bytes, 0)
})

test('bulk lifecycle returns deterministic per-item outcomes', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); const folder = await call('POST', '/api/files/folders', {name:'bulk',parent_id:me.json.home.id})
  const result = await call('POST', '/api/files/nodes/bulk', {action:'trash',ids:[folder.json.node.id,'missing']}, {'idempotency-key':'bulk-once'})
  assert.equal(result.status, 200); assert.equal(result.json.summary.succeeded, 1); assert.equal(result.json.summary.failed, 1)
  const replay = await call('POST', '/api/files/nodes/bulk', {action:'trash',ids:[folder.json.node.id,'missing']}, {'idempotency-key':'bulk-once'}); assert.equal(replay.headers['idempotency-replayed'],'true')
})

test('previews owned safe images and denies unsafe or cross-user access', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const intent = await call('POST', '/api/files/uploads', { name: 'pixel.png', parent_id: me.json.home.id, size_bytes: 4, mime_type: 'image/png' })
  const done = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'PNG!', finalize: true })
  const preview = await call('GET', `/api/files/nodes/${done.json.node.id}/preview`)
  assert.equal(preview.status, 200); assert.equal(preview.headers['content-type'], 'image/png'); assert.equal(preview.headers['x-content-type-options'], 'nosniff'); assert.equal(preview.body.toString(), 'PNG!')
  const other = await call('GET', `/api/files/nodes/${done.json.node.id}/preview`, undefined, { 'x-dev-user-id': 'u2', 'x-dev-email': 'two@hippy.vn' })
  assert.equal(other.status, 404)
  const unsafeIntent = await call('POST', '/api/files/uploads', { name: 'active.svg', parent_id: me.json.home.id, size_bytes: 4, mime_type: 'image/svg+xml' })
  const unsafe = await call('PATCH', `/api/files/uploads/${unsafeIntent.json.upload_id}`, { data: '<svg', finalize: true })
  const rejected = await call('GET', `/api/files/nodes/${unsafe.json.node.id}/preview`)
  assert.equal(rejected.status, 415); assert.equal(rejected.json.error.code, 'file_preview_unsupported')
  assert.equal((await call('GET', `/api/files/nodes/${unsafe.json.node.id}/download`)).status, 200)
})

test('records, downloads and restores file revisions and serves owner-scoped thumbnails', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const firstBytes = Buffer.from('first')
  const firstIntent = await call('POST', '/api/files/uploads', { name: 'revision.png', parent_id: me.json.home.id, size_bytes: firstBytes.length, mime_type: 'image/png' })
  const first = await call('PATCH', `/api/files/uploads/${firstIntent.json.upload_id}?finalize=true`, firstBytes, { 'content-range': `bytes 0-${firstBytes.length - 1}/${firstBytes.length}` })
  assert.equal(first.status, 200)
  const nodeId = first.json.node.id
  const secondBytes = Buffer.from('second')
  const secondIntent = await call('POST', '/api/files/uploads', { target_node_id: nodeId, size_bytes: secondBytes.length, mime_type: 'image/png' })
  const second = await call('PATCH', `/api/files/uploads/${secondIntent.json.upload_id}?finalize=true`, secondBytes, { 'content-range': `bytes 0-${secondBytes.length - 1}/${secondBytes.length}` })
  assert.equal(second.status, 200); assert.equal(second.json.node.id, nodeId)
  const revisions = await call('GET', `/api/files/nodes/${nodeId}/revisions`)
  assert.equal(revisions.status, 200); assert.equal(revisions.json.revisions.length, 2)
  const old = revisions.json.revisions.find(revision => revision.revision_number === 1)
  const oldDownload = await call('GET', `/api/files/nodes/${nodeId}/revisions/${old.id}/download`)
  assert.deepEqual(oldDownload.body, firstBytes)
  const thumbnail = await call('GET', `/api/files/nodes/${nodeId}/thumbnail`)
  assert.equal(thumbnail.status, 200); assert.deepEqual(thumbnail.body, secondBytes)
  const restored = await call('POST', `/api/files/nodes/${nodeId}/revisions/${old.id}/restore`, {})
  assert.equal(restored.status, 200)
  const current = await call('GET', `/api/files/nodes/${nodeId}/download`)
  assert.deepEqual(current.body, firstBytes)
  assert.equal((await call('GET', `/api/files/nodes/${nodeId}/revisions`)).json.revisions.length, 3)
  const overwriteBytes = Buffer.from('overwrite')
  const overwriteIntent = await call('POST', '/api/files/uploads', { target_node_id: nodeId, upload_mode: 'overwrite', size_bytes: overwriteBytes.length, mime_type: 'image/png' })
  const overwritten = await call('PATCH', `/api/files/uploads/${overwriteIntent.json.upload_id}?finalize=true`, overwriteBytes, { 'content-range': `bytes 0-${overwriteBytes.length - 1}/${overwriteBytes.length}` })
  assert.equal(overwritten.status, 200); assert.equal(overwritten.json.node.id, nodeId)
  assert.equal((await call('GET', `/api/files/nodes/${nodeId}/revisions`)).json.revisions.length, 1)
  assert.deepEqual((await call('GET', `/api/files/nodes/${nodeId}/download`)).body, overwriteBytes)
  assert.equal((await call('GET', `/api/files/nodes/${nodeId}/revisions`, undefined, { 'x-dev-user-id': 'u2', 'x-dev-email': 'two@hippy.vn' })).status, 404)
})

test('accepts raw binary chunks and finalizes without base64 buffering', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const intent = await call('POST', '/api/files/uploads', { name: 'raw.bin', parent_id: me.json.home.id, size_bytes: 6 })
  const first = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}?finalize=false`, Buffer.from([0, 1, 2])); assert.equal(first.status, 200); assert.equal(first.json.upload.received_bytes, 3)
  const done = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}?finalize=true`, Buffer.from([3, 4, 255])); assert.equal(done.status, 200)
  const downloaded = await call('GET', `/api/files/nodes/${done.json.node.id}/download`); assert.deepEqual(downloaded.body, Buffer.from([0, 1, 2, 3, 4, 255]))
})

test('enforces hard quota', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); const over = await call('POST', '/api/files/uploads', { name: 'big', parent_id: me.json.home.id, size_bytes: 11 }); assert.equal(over.status, 409); assert.equal(over.json.error.code, 'file_quota_exceeded')
})

test('requires authentication and mutation idempotency keys', async () => {
  const { call } = await fixture()
  const unauth = await call('GET', '/api/files/me', undefined, { 'x-dev-user-id': '' }); assert.equal(unauth.status, 401)
  const me = await call('GET', '/api/files/me')
  const missing = await call('POST', '/api/files/folders', { name: 'No key', parent_id: me.json.home.id }, { 'idempotency-key': '' }); assert.equal(missing.status, 422)
})

test('trash keeps bytes charged and restore preserves content', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const intent = await call('POST', '/api/files/uploads', { name: 'data', parent_id: me.json.home.id, size_bytes: 5 })
  const done = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: '12345', finalize: true })
  await call('POST', `/api/files/nodes/${done.json.node.id}/trash`, {})
  const afterTrash = await call('GET', '/api/files/me'); assert.equal(afterTrash.json.quota.used_bytes, 5)
  const restored = await call('POST', `/api/files/nodes/${done.json.node.id}/restore`, {}); assert.equal(restored.status, 200)
})

test('admin can lock another user and locked user is revoked', async () => {
  const { call } = await fixture(); await call('GET', '/api/files/me')
  const locked = await call('PATCH', '/api/admin/file-users/u1', { locked: true }, { 'x-dev-user-id': 'admin', 'x-dev-email': 'admin@hippy.vn', 'x-dev-admin': 'true' }); assert.equal(locked.status, 200)
  const denied = await call('GET', '/api/files/me'); assert.equal(denied.status, 403); assert.equal(denied.json.error.code, 'file_access_revoked')
})

test('health aliases and CORS preflight support separate web origin', async () => {
  const { call } = await fixture()
  const health = await call('GET', '/health'); assert.equal(health.status, 200); assert.equal(health.json.provider_type, 'fake-disk'); assert.equal(health.headers['access-control-allow-origin'], 'http://localhost:3000')
  const preflight = await call('OPTIONS', '/api/files/me'); assert.equal(preflight.status, 204); assert.match(preflight.headers['access-control-allow-methods'], /PATCH/)
})

test('lists trashed nodes and recent nodes for UI', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const folder = await call('POST', '/api/files/folders', { name: 'Trash me', parent_id: me.json.home.id })
  await call('POST', `/api/files/nodes/${folder.json.node.id}/trash`, {})
  const trash = await call('GET', '/api/files/nodes?state=trashed'); assert.equal(trash.status, 200); assert.equal(trash.json.nodes[0].name, 'Trash me')
  const recent = await call('GET', '/api/files/nodes?recent=true&limit=5'); assert.equal(recent.status, 200); assert.ok(Array.isArray(recent.json.nodes))
})

test('prevents moving a folder into its descendant', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const parent = await call('POST', '/api/files/folders', { name: 'Parent', parent_id: me.json.home.id })
  const child = await call('POST', '/api/files/folders', { name: 'Child', parent_id: parent.json.node.id })
  const cycle = await call('PATCH', `/api/files/nodes/${parent.json.node.id}`, { parent_id: child.json.node.id }); assert.equal(cycle.status, 422); assert.equal(cycle.json.error.code, 'file_validation_failed')
})

test('requires folder parents for folder creation, upload intents and moves', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const intent = await call('POST', '/api/files/uploads', { name: 'parent.bin', parent_id: me.json.home.id, size_bytes: 1 })
  const file = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'x', finalize: true })
  assert.equal((await call('POST', '/api/files/folders', { name: 'nested', parent_id: file.json.node.id })).status, 422)
  assert.equal((await call('POST', '/api/files/uploads', { name: 'bad.bin', parent_id: file.json.node.id, size_bytes: 1 })).status, 422)
  const folder = await call('POST', '/api/files/folders', { name: 'Folder', parent_id: me.json.home.id })
  assert.equal((await call('PATCH', `/api/files/nodes/${file.json.node.id}`, { parent_id: file.json.node.id })).status, 422)
  assert.equal((await call('PATCH', `/api/files/nodes/${file.json.node.id}`, { parent_id: folder.json.node.id })).status, 200)
})

test('trash lists roots and requires restoring trashed ancestors first', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const parent = await call('POST', '/api/files/folders', { name: 'Parent', parent_id: me.json.home.id })
  const child = await call('POST', '/api/files/folders', { name: 'Child', parent_id: parent.json.node.id })
  await call('POST', `/api/files/nodes/${parent.json.node.id}/trash`, {})
  const trash = await call('GET', '/api/files/nodes?state=trashed'); assert.equal(trash.status, 200); assert.deepEqual(trash.json.nodes.map(node => node.id), [parent.json.node.id])
  assert.equal((await call('POST', `/api/files/nodes/${child.json.node.id}/restore`, {})).status, 409)
  assert.equal((await call('POST', `/api/files/nodes/${parent.json.node.id}/restore`, {})).status, 200)
  const active = await call('GET', `/api/files/nodes?parent_id=${parent.json.node.id}`); assert.equal(active.json.nodes[0].id, child.json.node.id)
})

test('denies cross-user IDOR for list, mutate and download', async () => {
  const { call } = await fixture(); const first = await call('GET', '/api/files/me')
  const intent = await call('POST', '/api/files/uploads', { name: 'private', parent_id: first.json.home.id, size_bytes: 1 })
  const done = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'x', finalize: true })
  const other = { 'x-dev-user-id': 'u2', 'x-dev-email': 'two@hippy.vn' }
  await call('GET', '/api/files/me', undefined, other)
  const listed = await call('GET', `/api/files/nodes?parent_id=${first.json.home.id}`, undefined, other); assert.equal(listed.status, 404)
  const mutated = await call('PATCH', `/api/files/nodes/${done.json.node.id}`, { name: 'stolen' }, other); assert.equal(mutated.status, 404)
  const downloaded = await call('GET', `/api/files/nodes/${done.json.node.id}/download`, undefined, other); assert.equal(downloaded.status, 404)
})

test('serializes concurrent quota reservations at the hard limit', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const results = await Promise.all([call('POST', '/api/files/uploads', { name: 'a', parent_id: me.json.home.id, size_bytes: 6 }), call('POST', '/api/files/uploads', { name: 'b', parent_id: me.json.home.id, size_bytes: 6 })])
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]); assert.equal(results.find(r => r.status === 409).json.error.code, 'file_quota_exceeded')
})

test('same idempotency key has stable retry response', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); const headers = { 'idempotency-key': 'stable-key' }
  assert.equal((await call('POST', '/api/files/folders', { name: 'Once', parent_id: me.json.home.id }, headers)).status, 201)
  const retry1 = await call('POST', '/api/files/folders', { name: 'Once', parent_id: me.json.home.id }, headers)
  const retry2 = await call('POST', '/api/files/folders', { name: 'Once', parent_id: me.json.home.id }, headers)
  assert.equal(retry1.status, 409); assert.equal(retry1.json.error.code, retry2.json.error.code); assert.equal(retry1.json.error.message, retry2.json.error.message); assert.equal(retry1.json.error.retryable, true)
})

test('upload idempotency key replays the original intent', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); const headers = { 'idempotency-key': 'upload-replay' }
  const first = await call('POST', '/api/files/uploads', { name: 'replay.bin', parent_id: me.json.home.id, size_bytes: 2 }, headers)
  const second = await call('POST', '/api/files/uploads', { name: 'replay.bin', parent_id: me.json.home.id, size_bytes: 2 }, headers)
  assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal(second.json.upload_id, first.json.upload_id); assert.equal(second.headers['idempotency-replayed'], 'true')
})

test('normalizes provider outage and reports degraded health', async () => {
  const { call, app } = await fixture(); const me = await call('GET', '/api/files/me'); const intent = await call('POST', '/api/files/uploads', { name: 'queued', parent_id: me.json.home.id, size_bytes: 1 })
  app.store.state.provider.available = false
  const failed = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'x', finalize: true }); assert.equal(failed.status, 503); assert.equal(failed.json.error.code, 'file_provider_unavailable'); assert.equal(failed.json.error.retryable, true)
  const health = await call('GET', '/health'); assert.equal(health.status, 200); assert.equal(health.json.status, 'degraded'); assert.equal(health.json.ok, false)
  const adminHealth = await call('GET', '/api/admin/file-health', undefined, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true' }); assert.equal(adminHealth.json.provider.simulated, true); assert.equal(adminHealth.json.provider.available, false)
})

test('admin audit records actor, subject, action and request ID', async () => {
  const { call } = await fixture(); await call('GET', '/api/files/me')
  await call('PATCH', '/api/admin/file-users/u1', { quota_bytes: 9 }, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-request-id': 'req-audit-test' })
  const audit = await call('GET', '/api/admin/file-audit', undefined, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true' }); const event = audit.json.events.find(e => e.request_id === 'req-audit-test')
  assert.equal(event.actor_app_user_id, 'admin'); assert.equal(event.subject_file_user_id, 'u1'); assert.equal(event.action, 'admin_user_update')
})

test('admin export preserves user and node metadata', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); await call('POST', '/api/files/folders', { name: 'Exported', parent_id: me.json.home.id })
  const exported = await call('POST', '/api/admin/file-export', { user_id: 'u1' }, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-dev-step-up': 'true' })
  assert.equal(exported.status, 200); assert.equal(exported.json.user.email, 'one@hippy.vn'); assert.ok(exported.json.nodes.some(n => n.name === 'Exported' && n.kind === 'folder'))
})

test('allows accepted upload only inside revoke grace', async () => {
  const { call } = await fixture({ uploadGraceMs: 20 }); const me = await call('GET', '/api/files/me'); const intent = await call('POST', '/api/files/uploads', { name: 'grace', parent_id: me.json.home.id, size_bytes: 2 })
  await call('PATCH', '/api/admin/file-users/u1', { locked: true }, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true' })
  const inside = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'a' }); assert.equal(inside.status, 200)
  await new Promise(resolve => setTimeout(resolve, 30))
  const outside = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'b', finalize: true }); assert.equal(outside.status, 403); assert.equal(outside.json.error.code, 'file_access_revoked')
})

test('commits zero-byte uploads safely', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); const intent = await call('POST', '/api/files/uploads', { name: 'empty', parent_id: me.json.home.id, size_bytes: 0 })
  const done = await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { finalize: true }); assert.equal(done.status, 200); assert.equal(done.json.node.size_bytes, 0)
})

test('health probes do not consume the user API rate-limit bucket', async () => {
  const { call } = await fixture({ rateLimitPerMinute: 2 })
  for (let index = 0; index < 20; index++) assert.equal((await call('GET', index % 2 ? '/health' : '/healthz')).status, 200)
  assert.equal((await call('GET', '/api/files/me')).status, 200)
  assert.equal((await call('GET', '/api/files/me')).status, 200)
  assert.equal((await call('GET', '/api/files/me')).status, 429)
})

test('secure lifecycle sync idempotently creates, updates and revokes users', async () => {
  const { call } = await fixture(); const secret = { 'x-lifecycle-sync-secret': 'sync-test-secret', 'x-dev-user-id': '' }
  assert.equal((await call('POST', '/api/internal/lifecycle-sync', { users: [{ id: 'mail-1', email: 'mail@hippy.vn', status: 'active', file_quota_bytes: 99 }] }, { 'x-lifecycle-sync-secret': 'wrong', 'x-dev-user-id': '' })).status, 401)
  const created = await call('POST', '/api/internal/lifecycle-sync', { users: [{ id: 'mail-1', email: 'mail@hippy.vn', status: 'active', file_quota_bytes: 99 }] }, secret); assert.equal(created.json.created, 1)
  const projectedLogin = await call('GET', '/api/files/me', undefined, { 'x-dev-user-id': 'mail-1', 'x-dev-email': 'mail@hippy.vn' }); assert.equal(projectedLogin.status, 200); assert.ok(projectedLogin.json.home.id)
  const updated = await call('POST', '/api/internal/lifecycle-sync', { users: [{ id: 'mail-1', email: 'new@hippy.vn', status: 'suspended', file_quota_bytes: 50 }] }, secret); assert.equal(updated.json.updated, 1)
  const users = await call('GET', '/api/admin/file-users', undefined, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true' }); const user = users.json.users.find(u => u.id === 'mail-1'); assert.equal(user.status, 'suspended'); assert.equal(user.quota_bytes, 50); assert.ok(user.revoked_at)
})

test('admin mailbox inventory excludes synthetic and test identities', async () => {
  const { call, app } = await fixture(); const admin = { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-dev-email': 'admin@hippy.vn', 'x-dev-step-up': 'true' }
  await call('POST', '/api/internal/lifecycle-sync', { users: [{ id: 'mail-1', email: 'real@hippy.vn', status: 'active', file_quota_bytes: 99 }] }, { 'x-lifecycle-sync-secret': 'sync-test-secret', 'x-dev-user-id': '' })
  await call('POST', '/api/admin/synthetic-load', { user_count: 2, bytes_per_user: 0 }, admin)
  await app.store.transaction(state => { state.users.push({ id: 'uat-1', app_user_id: 'uat-1', mailbox_id: 'uat-1', email: 'uat-1@hippy.vn', status: 'active', quota_bytes: 10, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), revoked_at: null }) })
  const result = await call('GET', '/api/admin/file-users', undefined, admin)
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.users.map(user => user.email), ['real@hippy.vn'])
  assert.equal(result.json.total, 1)
  assert.equal(result.json.excluded.total, 3)
  assert.equal(result.json.excluded.by_source.synthetic, 2)
  assert.equal(result.json.excluded.by_source.test, 1)
  assert.equal(result.json.users[0].source, 'cpanel')
})

test('binds a provisioned mailbox to its first OIDC subject without duplicating the user', async () => {
  const { call, app } = await fixture(); const secret = { 'x-lifecycle-sync-secret': 'sync-test-secret', 'x-dev-user-id': '' }
  await call('POST', '/api/internal/lifecycle-sync', { users: [{ id: 'mailflow-user-id', email: 'bind@hippy.vn', status: 'active', file_quota_bytes: 99 }] }, secret)
  const login = await call('GET', '/api/files/me', undefined, { 'x-dev-user-id': 'authentik-oidc-sub', 'x-dev-email': 'bind@hippy.vn' })
  assert.equal(login.status, 200); assert.equal(login.json.user.id, 'authentik-oidc-sub'); assert.equal(app.store.state.users.length, 1); assert.equal(app.store.state.users[0].app_user_id, 'mailflow-user-id')
  const sync = await call('POST', '/api/internal/lifecycle-sync', { users: [{ id: 'mailflow-user-id', email: 'bind@hippy.vn', status: 'active', file_quota_bytes: 123 }] }, secret)
  assert.equal(sync.json.created, 0); assert.equal(app.store.state.users[0].id, 'authentik-oidc-sub'); assert.equal(app.store.state.users[0].quota_bytes, 123)
})

test('retries transient provider operations and releases reservation on terminal outage', async () => {
  const { call, app } = await fixture(); const me = await call('GET', '/api/files/me'); const first = await call('POST', '/api/files/uploads', { name: 'retry', parent_id: me.json.home.id, size_bytes: 1 })
  app.provider.transientFailures = 2; assert.equal((await call('PATCH', `/api/files/uploads/${first.json.upload_id}`, { data: 'x', finalize: true })).status, 200)
  const second = await call('POST', '/api/files/uploads', { name: 'fail', parent_id: me.json.home.id, size_bytes: 1 }); app.store.state.provider.available = false
  assert.equal((await call('PATCH', `/api/files/uploads/${second.json.upload_id}`, { data: 'y', finalize: true })).status, 503)
  assert.equal(app.store.state.uploads.find(u => u.id === second.json.upload_id).state, 'failed'); assert.equal(app.store.state.reservations.find(r => r.upload_id === second.json.upload_id).state, 'released')
})

test('archive export contains ZIP metadata and file bytes', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me'); const intent = await call('POST', '/api/files/uploads', { name: 'inside.txt', parent_id: me.json.home.id, size_bytes: 6 }); await call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data: 'secret', finalize: true })
  const archive = await call('GET', '/api/admin/file-users/u1/export', undefined, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-dev-step-up': 'true' }); assert.equal(archive.status, 200); assert.equal(archive.headers['content-type'], 'application/zip'); assert.equal(archive.body.subarray(0, 2).toString(), 'PK'); assert.match(archive.body.toString(), /metadata\.json/); assert.match(archive.body.toString(), /secret/)
})

test('maintenance purges expired trash and reservations', async () => {
  const { call, app } = await fixture(); const me = await call('GET', '/api/files/me'); const folder = await call('POST', '/api/files/folders', { name: 'Old', parent_id: me.json.home.id }); await call('POST', `/api/files/nodes/${folder.json.node.id}/trash`, {})
  app.store.state.nodes.find(n => n.id === folder.json.node.id).trashed_at = '2000-01-01T00:00:00.000Z'
  const upload = await call('POST', '/api/files/uploads', { name: 'expired', parent_id: me.json.home.id, size_bytes: 1 }); app.store.state.reservations.find(r => r.upload_id === upload.json.upload_id).expires_at = '2000-01-01T00:00:00.000Z'
  const result = await call('POST', '/api/admin/file-maintenance', {}, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-dev-step-up': 'true' }); assert.equal(result.status, 200); assert.equal(result.json.purged, 1); assert.equal(result.json.expired_reservations, 1)
})

test('mock-only synthetic fixture creates capped sparse capacity data', async () => {
  const { call, app } = await fixture({ syntheticMaxBytes: 2 * 1024 ** 2 }); const admin = { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-dev-step-up': 'true' }
  const made = await call('POST', '/api/admin/synthetic-load', { user_count: 2, bytes_per_user: 1024 ** 2 }, admin); assert.equal(made.status, 201); assert.equal(made.json.logical_bytes, 2 * 1024 ** 2); assert.equal(made.json.sparse, true); assert.equal(app.store.state.users.filter(u => u.id.startsWith('synthetic-')).length, 2)
  assert.equal((await call('POST', '/api/admin/synthetic-load', { user_count: 3, bytes_per_user: 1024 ** 2 }, admin)).status, 422)
})

test('me exposes server-derived admin capability flags', async () => {
  const { call } = await fixture()
  assert.equal((await call('GET', '/api/files/me')).json.capabilities.can_admin_files, false)
  assert.equal((await call('GET', '/api/files/me', undefined, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true' })).json.capabilities.can_admin_files, true)
})

test('OIDC Authorization Code PKCE creates session, rejects replay and logs out', async () => {
  const originalFetch = globalThis.fetch; const calls = []
  const idToken = `x.${Buffer.from(JSON.stringify({ sub: 'oidc-user', iss: 'https://auth.test', aud: 'files-client', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.x`
  globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); if (String(url).endsWith('/token')) return new Response(JSON.stringify({ access_token: 'server-only-token', id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } }); if (String(url).endsWith('/userinfo')) return new Response(JSON.stringify({ sub: 'oidc-user', email: 'oidc@hippy.vn', iss: 'https://auth.test', permissions: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); return new Response('', { status: 404 }) }
  try {
    const { call, app } = await fixture({ authMode: 'oidc', oidcAuthorizationUrl: 'https://auth.test/authorize', oidcTokenUrl: 'https://auth.test/token', oidcUserinfoUrl: 'https://auth.test/userinfo', oidcIssuer: 'https://auth.test', oidcClientId: 'files-client', oidcClientSecret: '', oidcRedirectUri: 'https://api.test/auth/oidc/callback', sessionSecret: 'a-secure-test-secret-with-32-bytes', webRedirectUrl: 'https://files.test/', production: true })
    const login = await call('GET', '/auth/oidc/login', undefined, { 'x-dev-user-id': '' }); assert.equal(login.status, 302); const authorization = new URL(login.headers.location); assert.equal(authorization.origin, 'https://auth.test'); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorization.searchParams.get('redirect_uri'), 'https://api.test/auth/oidc/callback'); assert.ok(authorization.searchParams.get('code_challenge'))
    const state = authorization.searchParams.get('state'); const invalid = await call('GET', '/auth/oidc/callback?code=x&state=invalid', undefined, { 'x-dev-user-id': '' }); assert.equal(invalid.status, 401)
    const callback = await call('GET', `/auth/oidc/callback?code=valid-code&state=${state}`, undefined, { 'x-dev-user-id': '' }); assert.equal(callback.status, 302); assert.equal(callback.headers.location, 'https://files.test/'); assert.match(callback.headers['set-cookie'], /HttpOnly/); assert.match(callback.headers['set-cookie'], /SameSite=Lax/); assert.match(callback.headers['set-cookie'], /Secure/); assert.doesNotMatch(callback.headers.location, /valid-code/)
    const tokenRequest = calls.find(item => item.url.endsWith('/token')); assert.match(String(tokenRequest.options.body), /code_verifier=/); assert.doesNotMatch(callback.headers['set-cookie'], /server-only-token/)
    const cookie = callback.headers['set-cookie'].split(';')[0]; const deniedUnknown = await call('GET', '/api/files/me', undefined, { 'x-dev-user-id': '', cookie }); assert.equal(deniedUnknown.status, 403)
    await call('POST', '/api/internal/lifecycle-sync', { users: [{ id: 'oidc-user', email: 'oidc@hippy.vn', status: 'active', file_quota_bytes: 100 }] }, { 'x-lifecycle-sync-secret': 'sync-test-secret', 'x-dev-user-id': '' })
    const me = await call('GET', '/api/files/me', undefined, { 'x-dev-user-id': '', cookie }); assert.equal(me.status, 200); assert.equal(me.json.user.email, 'oidc@hippy.vn')
    const replay = await call('GET', `/auth/oidc/callback?code=valid-code&state=${state}`, undefined, { 'x-dev-user-id': '' }); assert.equal(replay.status, 401)
    const secondLogin = await call('GET', '/auth/oidc/login', undefined, { 'x-dev-user-id': '' }); const expiredState = new URL(secondLogin.headers.location).searchParams.get('state'); app.auth._pending.get(expiredState).expiresAt = 0; assert.equal((await call('GET', `/auth/oidc/callback?code=x&state=${expiredState}`, undefined, { 'x-dev-user-id': '' })).status, 401)
    const logout = await call('POST', '/auth/logout', undefined, { 'x-dev-user-id': '', cookie }); assert.equal(logout.status, 302); assert.match(logout.headers['set-cookie'], /Max-Age=0/); assert.equal((await call('GET', '/api/files/me', undefined, { 'x-dev-user-id': '', cookie })).status, 401)
  } finally { globalThis.fetch = originalFetch }
})

test('OIDC callback rejects missing or wrong client audience', async () => {
  const originalFetch = globalThis.fetch
  let audience
  globalThis.fetch = async url => {
    if (String(url).endsWith('/token')) {
      const claims = { sub: 'oidc-user', iss: 'https://auth.test', exp: Math.floor(Date.now() / 1000) + 300 }
      if (audience !== undefined) claims.aud = audience
      const idToken = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`
      return new Response(JSON.stringify({ access_token: 'access-token', id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ sub: 'oidc-user', email: 'oidc@hippy.vn' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const { call } = await fixture({ authMode: 'oidc', oidcAuthorizationUrl: 'https://auth.test/authorize', oidcTokenUrl: 'https://auth.test/token', oidcUserinfoUrl: 'https://auth.test/userinfo', oidcIssuer: 'https://auth.test', oidcClientId: 'files-client', oidcRedirectUri: 'https://api.test/auth/oidc/callback', sessionSecret: 'a-secure-test-secret-with-32-bytes', webRedirectUrl: 'https://files.test/' })
    for (const invalidAudience of [undefined, 'another-client']) {
      audience = invalidAudience
      const login = await call('GET', '/auth/oidc/login', undefined, { 'x-dev-user-id': '' })
      const state = new URL(login.headers.location).searchParams.get('state')
      assert.equal((await call('GET', `/auth/oidc/callback?code=x&state=${state}`, undefined, { 'x-dev-user-id': '' })).status, 401)
    }
  } finally { globalThis.fetch = originalFetch }
})

test('OIDC bearer authentication requires configured access-token audience', async () => {
  const originalFetch = globalThis.fetch
  let audience
  globalThis.fetch = async () => new Response(JSON.stringify({ sub: 'oidc-user', email: 'oidc@hippy.vn' }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const { call } = await fixture({ authMode: 'oidc', oidcUserinfoUrl: 'https://auth.test/userinfo', oidcAudience: 'hippy-files' })
    for (const invalidAudience of [undefined, 'another-api']) {
      audience = invalidAudience
      const claims = audience === undefined ? {} : { aud: audience }
      const token = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`
      assert.equal((await call('GET', '/api/files/me', undefined, { authorization: `Bearer ${token}`, 'x-dev-user-id': '' })).status, 401)
    }
    const validToken = `x.${Buffer.from(JSON.stringify({ aud: ['another-api', 'hippy-files'] })).toString('base64url')}.x`
    assert.equal((await call('GET', '/api/files/me', undefined, { authorization: `Bearer ${validToken}`, 'x-dev-user-id': '' })).status, 403)
  } finally { globalThis.fetch = originalFetch }
})

test('restore counts descendant bytes and held reservations against quota', async () => {
  const { call } = await fixture({ defaultQuotaBytes: 20 }); const me = await call('GET', '/api/files/me'); const folder = await call('POST', '/api/files/folders', { name: 'Tree', parent_id: me.json.home.id }); const upload = await call('POST', '/api/files/uploads', { name: 'child.bin', parent_id: folder.json.node.id, size_bytes: 8 }); await call('PATCH', `/api/files/uploads/${upload.json.upload_id}`, { data: '12345678', finalize: true }); await call('POST', `/api/files/nodes/${folder.json.node.id}/trash`, {})
  await call('POST', '/api/files/uploads', { name: 'held', parent_id: me.json.home.id, size_bytes: 4 }); await call('PATCH', '/api/admin/file-users/u1', { quota_bytes: 10 }, { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true' })
  const restored = await call('POST', `/api/files/nodes/${folder.json.node.id}/restore`, {}); assert.equal(restored.status, 409); assert.equal(restored.json.error.code, 'file_quota_exceeded')
})

test('audits privileged admin read and export operations', async () => {
  const { call, app } = await fixture(); await call('GET', '/api/files/me'); const admin = { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-dev-step-up': 'true' }
  await call('GET', '/api/admin/file-users', undefined, { ...admin, 'x-request-id': 'req-users-read' }); await call('GET', '/api/admin/file-health', undefined, { ...admin, 'x-request-id': 'req-health-read' }); await call('POST', '/api/admin/file-export', { user_id: 'u1' }, { ...admin, 'x-request-id': 'req-export-read' }); await call('POST', '/api/admin/file-reconcile', {}, { ...admin, 'x-request-id': 'req-reconcile-read' }); await call('GET', '/api/admin/file-audit', undefined, { ...admin, 'x-request-id': 'req-audit-read' })
  const storedByRequest = new Map(app.store.state.audits.map(event => [event.request_id, event]));
  for (const requestId of ['req-users-read', 'req-health-read', 'req-export-read', 'req-reconcile-read', 'req-audit-read']) {
    const event = storedByRequest.get(requestId); assert.ok(event, requestId); assert.equal(event.actor_app_user_id, 'admin'); assert.ok(event.action.startsWith('admin_'))
  }
  assert.equal(storedByRequest.get('req-export-read').subject_file_user_id, 'u1')
  const visible = await call('GET', '/api/admin/file-audit', undefined, admin)
  assert.ok(visible.json.events.some(event => event.request_id === 'req-export-read'))
  assert.equal(visible.json.events.some(event => event.request_id === 'req-users-read'), false)
  assert.equal(visible.json.events.some(event => event.request_id === 'req-health-read'), false)
})

test('reconcile reports missing, orphan and quota-size anomalies without deleting data', async () => {
  const { call, app } = await fixture({ defaultQuotaBytes: 100 }); const me = await call('GET', '/api/files/me')
  const make = async (name, data) => { const intent = await call('POST', '/api/files/uploads', { name, parent_id: me.json.home.id, size_bytes: data.length }); return call('PATCH', `/api/files/uploads/${intent.json.upload_id}`, { data, finalize: true }) }
  const missing = await make('missing.bin', 'abc'); const mismatch = await make('mismatch.bin', 'abcd')
  await fs.rm(path.join(app.store.blobs, missing.json.node.provider_file_id)); await fs.truncate(path.join(app.store.blobs, mismatch.json.node.provider_file_id), 2); await fs.writeFile(path.join(app.store.blobs, 'orphan-blob'), 'kept')
  const admin = { 'x-dev-user-id': 'admin', 'x-dev-admin': 'true', 'x-dev-step-up': 'true' }; const result = await call('POST', '/api/admin/file-reconcile', {}, admin)
  assert.equal(result.status, 200); assert.deepEqual(new Set(result.json.anomalies.map(item => item.type)), new Set(['missing_provider_file', 'quota_size_mismatch', 'orphan_provider_file'])); assert.equal(result.json.destructive_actions, 0)
  assert.equal(await fs.readFile(path.join(app.store.blobs, 'orphan-blob'), 'utf8'), 'kept')
})

test('star is idempotent, durable and owner scoped', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const folder = await call('POST', '/api/files/folders', {name:'Favorite', parent_id:me.json.home.id})
  const nested = await call('POST', '/api/files/folders', {name:'Nested favorite', parent_id:folder.json.node.id})
  const headers = {'idempotency-key':'star-once'}
  const first = await call('PATCH', `/api/files/nodes/${folder.json.node.id}/star`, {starred:true}, headers)
  const replay = await call('PATCH', `/api/files/nodes/${folder.json.node.id}/star`, {starred:true}, headers)
  assert.equal(first.status, 200); assert.equal(replay.headers['idempotency-replayed'], 'true'); assert.ok(first.json.node.starred_at)
  await call('PATCH', `/api/files/nodes/${nested.json.node.id}/star`, {starred:true})
  const starred = await call('GET', '/api/files/nodes?starred=true'); assert.deepEqual(new Set(starred.json.nodes.map(n=>n.id)), new Set([folder.json.node.id, nested.json.node.id]))
  const scoped = await call('GET', `/api/files/nodes?starred=true&parent_id=${folder.json.node.id}`); assert.deepEqual(scoped.json.nodes.map(n=>n.id), [nested.json.node.id])
  const other = await call('GET', '/api/files/nodes?starred=true', undefined, {'x-dev-user-id':'u2','x-dev-email':'two@hippy.vn'}); assert.equal(other.json.nodes.length, 0)
})

test('pagination binds cursor to actor and filters and activity is redacted', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  for (const name of ['A','B','C']) await call('POST', '/api/files/folders', {name,parent_id:me.json.home.id})
  const first = await call('GET', `/api/files/nodes?parent_id=${me.json.home.id}&limit=2`); assert.equal(first.json.nodes.length,2); assert.equal(first.json.page.has_more,true)
  const second = await call('GET', `/api/files/nodes?parent_id=${me.json.home.id}&limit=2&cursor=${encodeURIComponent(first.json.page.next_cursor)}`); assert.equal(new Set([...first.json.nodes,...second.json.nodes].map(n=>n.id)).size,3)
  assert.equal((await call('GET', `/api/files/nodes?state=trashed&cursor=${encodeURIComponent(first.json.page.next_cursor)}`)).status,422)
  const node=first.json.nodes[0]; await call('PATCH', `/api/files/nodes/${node.id}/star`, {starred:true})
  const activity=await call('GET', `/api/files/nodes/${node.id}/activity`); assert.ok(activity.json.events.some(e=>e.action==='node_star')); assert.deepEqual(Object.keys(activity.json.events[0]).sort(), ['action','created_at','id','result'])
})

test('search is global without parent and remains scoped with explicit parent', async () => {
  const { call } = await fixture(); const me = await call('GET', '/api/files/me')
  const child = await call('POST', '/api/files/folders', {name:'Child', parent_id:me.json.home.id})
  const nested = await call('POST', '/api/files/folders', {name:'Nested report', parent_id:child.json.node.id})
  const viaSearch = await call('GET', '/api/files/search?q=Nested%20report')
  const viaNodes = await call('GET', '/api/files/nodes?q=Nested%20report')
  assert.deepEqual(viaSearch.json.nodes.map(node => node.id), [nested.json.node.id])
  assert.deepEqual(viaNodes.json.nodes.map(node => node.id), [nested.json.node.id])
  const rootScoped = await call('GET', `/api/files/search?q=Nested%20report&parent_id=${me.json.home.id}`)
  const childScoped = await call('GET', `/api/files/nodes?q=Nested%20report&parent_id=${child.json.node.id}`)
  assert.deepEqual(rootScoped.json.nodes, [])
  assert.deepEqual(childScoped.json.nodes.map(node => node.id), [nested.json.node.id])
})
