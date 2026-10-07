import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { loadConfig } from './config.js'
import { createStore } from './store-factory.js'
import { createStorageProvider } from './provider.js'
import { createAuthenticator } from './auth.js'
import { ApiError, fail, errorBody } from './errors.js'
import { createZip } from './zip.js'
import { createJobQueue } from './job-queue.js'
import { runMaintenance, runReconcile } from './jobs/handlers.js'
import { createCursor, parseCursor, filterHash } from './cursor.js'

const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`
const bytes = (value) => Buffer.byteLength(value || '')
const validName = name => typeof name === 'string' && name.trim() && name.length <= 255 && !/[\\/\0]/.test(name)
const importantAuditActions = new Set(['upload_commit', 'folder_create', 'node_update', 'node_trash', 'node_restore', 'node_star', 'node_unstar', 'revision_restore', 'admin_user_update', 'admin_export', 'admin_export_archive', 'admin_purge', 'admin_reconcile', 'admin_maintenance'])
const isImportantAudit = event => importantAuditActions.has(event.action) && !(event.source_ip === 'worker' && event.action === 'admin_maintenance')

// Older pilot/UAT rows predate the explicit source marker. Keep them out of
// the mailbox inventory until the next lifecycle sync marks real cPanel rows.
const inferredUserSource = user => {
  const idValue = String(user?.id || '').toLowerCase()
  const email = String(user?.email || '').toLowerCase()
  if (user?.source) return user.source
  if (idValue.startsWith('synthetic-') || email.endsWith('@example.invalid')) return 'synthetic'
  if (idValue.startsWith('uat-') || idValue.startsWith('f6-') || idValue.startsWith('f7-') || email.endsWith('@example.test')) return 'test'
  if (idValue === 'pilot-admin' || idValue.startsWith('fixture-') || email.startsWith('pilot-admin@')) return 'dev'
  return 'cpanel'
}
const adminMailboxUser = user => inferredUserSource(user) === 'cpanel'

export async function createApp(config = loadConfig()) {
  if (typeof config.webOrigin === 'string' && config.webOrigin.length > 1) config.webOrigin = config.webOrigin.replace(/\/$/, '')
  config.cursorSecret ||= 'file-pwa-test-cursor-secret'
  config.cursorTtlSeconds ||= 900
  const store = createStore(config); await store.init()
  const provider = createStorageProvider(config, store)
  const jobQueue = createJobQueue(config); await jobQueue.init()
  const auth = createAuthenticator(config)
  const limiter = new Map()
  const uploadProgress = new Map()
  const readJson = async req => {
    const maxBytes = config.maxJsonBytes || 2 * 1024 * 1024
    const declared = Number(req.headers['content-length'])
    if (Number.isSafeInteger(declared) && declared > maxBytes) fail('file_validation_failed', 422, 'Request body is too large.')
    const chunks = []; let total = 0
    for await (const chunk of req) { total += chunk.length; if (total <= maxBytes) chunks.push(chunk) }
    if (total > maxBytes) fail('file_validation_failed', 422, 'Request body is too large.')
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { fail('file_validation_failed', 422, 'Request body must be valid JSON.') }
  }
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)) }
  const sendBinary = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'cache-control': 'private, no-store', ...headers }); res.end(body) }
  const sendStream = async (res, status, result, headers = {}) => {
    const responseHeaders = { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store', ...headers }
    if (Number.isFinite(result.size)) responseHeaders['content-length'] = result.size
    if (typeof res.write !== 'function') { const chunks = []; for await (const chunk of result.stream) chunks.push(chunk); return sendBinary(res, status, Buffer.concat(chunks), headers) }
    res.writeHead(status, responseHeaders)
    await new Promise((resolve, reject) => { result.stream.once('error', reject); res.once('finish', resolve); result.stream.pipe(res) })
  }
  const retryProvider = async operation => { const jobId = await jobQueue.start('provider_operation'); let last; const attempts = config.providerRetryAttempts || 3; for (let attempt = 0; attempt < attempts; attempt++) { await jobQueue.attempt(jobId); try { const result = await operation(); await jobQueue.complete(jobId); return result } catch (error) { last = error; if (!error.retryable || attempt === attempts - 1) { await jobQueue.fail(jobId, error); throw error } await new Promise(resolve => setTimeout(resolve, (config.providerRetryBaseMs || 10) * 2 ** attempt)) } } await jobQueue.fail(jobId, last); throw last }
  const audit = (state, actor, subject, action, result, requestId, req, metadata = {}) => state.audits.push({ id: id('audit'), actor_app_user_id: actor?.id, subject_file_user_id: subject, action, result, request_id: requestId, source_ip: req.socket.remoteAddress, metadata, created_at: now() })
  const userFor = (state, actor) => {
    let user = state.users.find(u => u.id === actor.id)
    if (!user) { user = { id: actor.id, app_user_id: actor.id, mailbox_id: actor.id, email: actor.email, source: 'dev', status: 'active', quota_bytes: config.defaultQuotaBytes, created_at: now(), updated_at: now(), revoked_at: null }; state.users.push(user) }
    user.source ||= inferredUserSource(user)
    if (!state.nodes.some(n => n.file_user_id === user.id && !n.parent_id && n.kind === 'folder')) state.nodes.push({ id: id('node'), file_user_id: user.id, parent_id: null, kind: 'folder', name: 'My Files', mime_type: 'inode/directory', size_bytes: 0, state: 'active', created_at: now(), updated_at: now(), trashed_at: null, purged_at: null, provider_file_id: null, starred_at: null })
    return user
  }
  const provisionedUserFor = (state, actor) => {
    let existing = state.users.find(user => user.id === actor.id)
    if (!existing && actor.email) {
      existing = state.users.find(user => String(user.email || '').toLowerCase() === String(actor.email).toLowerCase())
      if (existing) {
        const previousId = existing.id
        existing.id = actor.id
        existing.app_user_id ||= previousId
        existing.updated_at = now()
        for (const collection of [state.nodes, state.uploads, state.reservations]) for (const row of collection) if (row.file_user_id === previousId) row.file_user_id = actor.id
        for (const event of state.audits) if (event.subject_file_user_id === previousId) event.subject_file_user_id = actor.id
      }
    }
    if (!existing && config.authMode !== 'mock') fail('file_access_revoked', 403, 'File account is not provisioned.')
    return userFor(state, actor)
  }
  const active = user => { if (!user || user.status !== 'active' || user.revoked_at) fail('file_access_revoked', 403, 'File access is revoked.') }
  const rootFor = (state, user) => state.nodes.find(n => n.file_user_id === user.id && !n.parent_id && n.kind === 'folder')
  const nodeFor = (state, user, nodeId, includeTrash = false) => { const node = state.nodes.find(n => n.id === nodeId && n.file_user_id === user.id && (includeTrash || n.state === 'active')); if (!node) fail('file_not_found', 404, 'File not found.'); return node }
  const folderFor = (state, user, nodeId) => { const node = nodeFor(state, user, nodeId); if (node.kind !== 'folder') fail('file_validation_failed', 422, 'Destination must be an active folder.'); return node }
  const usage = (state, user) => state.nodes.filter(n => n.file_user_id === user.id && n.state !== 'purged' && n.kind === 'file').reduce((a, n) => a + n.size_bytes, 0) + state.reservations.filter(r => r.file_user_id === user.id && r.state === 'held').reduce((a, r) => a + r.bytes_reserved, 0)
  const descendants = (state, node) => { const found = []; const visit = parent => state.nodes.filter(n => n.file_user_id === node.file_user_id && n.parent_id === parent.id).forEach(child => { found.push(child); visit(child) }); visit(node); return found }
  const idem = async (state, actor, key, operation, fn) => {
    if (!key) fail('file_validation_failed', 422, 'Idempotency-Key is required for this mutation.')
    const existing = state.idempotency.find(x => x.actor === actor.id && x.key === key && x.operation === operation)
    if (existing) fail('file_operation_in_progress', 409, 'This idempotent operation is already known.', true)
    const result = await fn()
    state.idempotency.push({ actor: actor.id, key, operation, result, created_at: now() }); return result
  }
  async function handler(req, res) {
    const requestId = req.headers['x-request-id'] || id('req'); res.setHeader('x-request-id', requestId)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'same-origin')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    if (config.production) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains')
    if (config.webOrigin) {
      const requestOrigin = String(req.headers.origin || '')
      const originAllowed = !requestOrigin || requestOrigin === config.webOrigin
      if (originAllowed) res.setHeader('access-control-allow-origin', config.webOrigin)
      res.setHeader('vary', 'Origin')
      if (originAllowed) {
        res.setHeader('access-control-allow-credentials', 'true')
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS')
        const devHeaders = config.authMode === 'mock' ? ',X-Dev-User-Id,X-Dev-Email,X-Dev-Admin,X-Dev-Permissions,X-Dev-Step-Up' : ''
        res.setHeader('access-control-allow-headers', `Authorization,Content-Type,Content-Range,Idempotency-Key,X-Request-Id${devHeaders}`)
        res.setHeader('access-control-expose-headers', 'Content-Disposition,Content-Length,X-Request-Id')
      }
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    const routePath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname
    if (routePath !== '/health' && routePath !== '/healthz') {
      const stamp = Date.now(); const ip = req.socket.remoteAddress || 'unknown'; const bucket = limiter.get(ip) || { at: stamp, count: 0 }; if (stamp - bucket.at > 60_000) { bucket.at = stamp; bucket.count = 0 }; bucket.count++; limiter.set(ip, bucket); if (bucket.count > config.rateLimitPerMinute) return send(res, 429, { error: { code: 'file_provider_rate_limited', message: 'Too many requests.', request_id: requestId, retryable: true, details: {} } })
    }
    try {
      const actor = await auth(req); const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); let route = url.pathname
      if (route === '/api/files/search' && req.method === 'GET') { if (!url.searchParams.get('q')) fail('file_validation_failed', 422, 'Search query is required.'); route = '/api/files/nodes' }
      if (route === '/health' || route === '/healthz') { const queueHealth = await jobQueue.health(); const providerReady = Boolean(store.state.provider.available); const durable = queueHealth.available && queueHealth.durable; const workerReady = queueHealth.worker_ready !== false; const ready = providerReady && (!config.production || (durable && workerReady)); const statusCode = config.production && (!durable || !workerReady) ? 503 : 200; return send(res, statusCode, { ok: ready, status: ready ? 'healthy' : 'degraded', provider: providerReady ? 'available' : 'unavailable', provider_type: config.providerType || 'fake-disk', queue: { available: queueHealth.available, durable: queueHealth.durable, mode: queueHealth.mode, worker_ready: workerReady } }) }
      if (route === '/metrics') { const completed = store.state.uploads.filter(u => u.state === 'completed').length; const failed = store.state.uploads.filter(u => u.state === 'failed').length; const queue = await jobQueue.stats(); const maintenance = await jobQueue.scheduleStatus('maintenance'); const reconcile = await jobQueue.scheduleStatus('reconcile'); const age = value => value ? Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000)) : -1; res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' }); return res.end(`hippy_file_users ${store.state.users.length}\nhippy_file_uploads_completed ${completed}\nhippy_file_uploads_failed ${failed}\nhippy_file_provider_available ${store.state.provider.available ? 1 : 0}\nhippy_file_queue_depth ${queue.depth}\nhippy_file_queue_pending ${queue.pending || 0}\nhippy_file_queue_oldest_pending_seconds ${queue.oldest_pending_seconds || 0}\nhippy_file_queue_retries ${queue.retries || 0}\nhippy_file_queue_dead_letter ${queue.dead_letter}\nhippy_file_maintenance_age_seconds ${age(maintenance)}\nhippy_file_reconcile_age_seconds ${age(reconcile)}\n`) }
      if (route === '/auth/oidc/login' && req.method === 'GET') { const location = auth.loginUrl(); res.writeHead(302, { location, 'cache-control': 'no-store' }); return res.end() }
      if (route === '/auth/oidc/callback' && req.method === 'GET') { const cookie = await auth.callback(url.searchParams.get('code'), url.searchParams.get('state')); if (!cookie) fail('auth_required', 401, 'OIDC callback is invalid or expired.'); res.writeHead(302, { location: config.webRedirectUrl, 'set-cookie': cookie, 'cache-control': 'no-store' }); return res.end() }
      if (route === '/auth/logout' && (req.method === 'POST' || req.method === 'GET')) { res.writeHead(302, { location: config.webRedirectUrl, 'set-cookie': auth.logout(req), 'cache-control': 'no-store' }); return res.end() }
      if (route === '/api/internal/lifecycle-sync' && req.method === 'POST') {
        const supplied = String(req.headers['x-lifecycle-sync-secret'] || ''); const expected = String(config.lifecycleSyncSecret || '')
        if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail('auth_required', 401, 'Invalid lifecycle sync credential.')
        const body = await readJson(req); if (!Array.isArray(body.users)) fail('file_validation_failed', 422, 'users must be an array.')
        return await store.transaction(state => { let created = 0; let updated = 0; for (const record of body.users) { if (!record.id || !record.email || !['active', 'suspended', 'deleted', 'locked'].includes(record.status) || !Number.isSafeInteger(record.file_quota_bytes) || record.file_quota_bytes < 0) fail('file_validation_failed', 422, 'Invalid lifecycle user record.'); let user = state.users.find(u => u.app_user_id === record.id || u.id === record.id || String(u.email || '').toLowerCase() === String(record.email).toLowerCase()); if (!user) { user = { id: record.id, app_user_id: record.id, mailbox_id: record.id, email: record.email, source: 'cpanel', status: record.status, quota_bytes: record.file_quota_bytes, created_at: now(), updated_at: now(), revoked_at: record.status === 'active' ? null : now() }; state.users.push(user); created++ } else { user.app_user_id ||= record.id; user.mailbox_id ||= record.id; user.email = record.email; user.source = 'cpanel'; user.status = record.status; user.revoked_at = record.status === 'active' ? null : (user.revoked_at || now()); user.updated_at = now(); updated++ } } return send(res, 200, { created, updated, total: body.users.length }) })
      }
      if (route === '/api/files/me' && req.method === 'GET') {
        if (!actor) fail('auth_required', 401, 'Authentication required.')
        return await store.transaction(state => { const user = provisionedUserFor(state, actor); active(user); const root = rootFor(state, user); return send(res, 200, { user: { id: user.id, email: user.email, status: user.status }, capabilities: { can_admin_files: Boolean(actor.admin || actor.permissions.includes('files:admin')) }, home: { id: root.id, name: root.name }, quota: { used_bytes: usage(state, user), quota_bytes: user.quota_bytes, available_bytes: Math.max(0, user.quota_bytes - usage(state, user)) } }) })
      }
      const admin = actor && (actor.admin || actor.permissions.includes('files:admin'))
      if (!actor) fail('auth_required', 401, 'Authentication required.')
      const fastUploadStatus = route.match(/^\/api\/files\/uploads\/([^/]+)$/)
      if (fastUploadStatus && req.method === 'GET') {
        const owner = store.state.users.find(candidate => candidate.id === actor.id || candidate.app_user_id === actor.id || String(candidate.email || '').toLowerCase() === String(actor.email || '').toLowerCase())
        const upload = store.state.uploads.find(candidate => candidate.id === fastUploadStatus[1] && candidate.file_user_id === owner?.id)
        if (!upload) fail('file_not_found', 404, 'Upload not found.')
        if (owner?.status !== 'active' || owner.revoked_at) {
          const withinGrace = owner.revoked_at && new Date(upload.created_at) <= new Date(owner.revoked_at) && Date.now() <= new Date(owner.revoked_at).getTime() + config.uploadGraceMs
          if (!withinGrace) active(owner)
        }
        const live = uploadProgress.get(upload.id)
        return send(res, 200, { upload: { ...upload, expected_offset: upload.received_bytes, provider_progress: live?.progress ?? null, provider_phase: live?.phase ?? null } })
      }
      if (route.startsWith('/api/admin/') && !admin) fail('file_forbidden', 403, 'Admin permission required.')
      if (route === '/api/admin/file-users' && req.method === 'GET') return await store.transaction(state => {
        const allUsers = state.users.map(user => ({ ...user, source: inferredUserSource(user), usage_bytes: usage(state, user) }))
        const users = allUsers.filter(adminMailboxUser)
        const excluded = allUsers.filter(user => !adminMailboxUser(user))
        const excludedBySource = excluded.reduce((counts, user) => { counts[user.source] = (counts[user.source] || 0) + 1; return counts }, {})
        audit(state, actor, null, 'admin_list_users', 'success', requestId, req, { returned: users.length, excluded: excluded.length })
        return send(res, 200, { users, total: users.length, source: 'cpanel', excluded: { total: excluded.length, by_source: excludedBySource } })
      })
      if (route.startsWith('/api/admin/file-users/') && req.method === 'PATCH') {
        const targetId = route.split('/').pop(); if (targetId === actor.id) fail('file_forbidden', 403, 'Self-administration is not allowed.')
        const body = await readJson(req); return await store.transaction(state => { const user = state.users.find(u => u.id === targetId); if (!user) fail('file_not_found', 404, 'User not found.'); if (body.locked !== undefined) { user.status = body.locked ? 'locked' : 'active'; user.revoked_at = body.locked ? now() : null }; if (body.status === 'suspended' || body.status === 'deleted') { user.status = body.status; user.revoked_at = now() }; if (body.quota_bytes !== undefined) { if (!Number.isSafeInteger(body.quota_bytes) || body.quota_bytes < 0) fail('file_validation_failed', 422, 'Invalid quota.'); user.quota_bytes = body.quota_bytes }; user.updated_at = now(); audit(state, actor, user.id, 'admin_user_update', 'success', requestId, req, { fields: Object.keys(body) }); return send(res, 200, { user, usage_bytes: usage(state, user) }) })
      }
      if (route === '/api/admin/file-health' && req.method === 'GET') return await store.transaction(async state => { audit(state, actor, null, 'admin_read_health', 'success', requestId, req); let freshness = null; try { freshness = JSON.parse(await fs.readFile(config.backupMarker, 'utf8')).created_at || null } catch {} const providerType = config.providerType || 'fake-disk'; const queue = await jobQueue.stats(); const mailboxUsers = state.users.filter(adminMailboxUser).length; return send(res, 200, { provider: { available: state.provider.available, type: providerType, simulated: providerType === 'fake-disk' }, queue, backup: { freshness }, users: mailboxUsers, excluded_users: state.users.length - mailboxUsers }) })
      const operationMatch = route.match(/^\/api\/files\/operations\/([^/]+)$/)
      if (operationMatch && req.method === 'GET') {
        const operation = await jobQueue.getOperation(operationMatch[1])
        if (!operation || (operation.owner_id && operation.owner_id !== actor.id && !admin)) fail('file_not_found', 404, 'Operation not found.')
        return send(res, 200, { operation: operation ? { id: operation.id, type: operation.type, state: operation.state, attempts: operation.attempts, created_at: operation.created_at, updated_at: operation.updated_at, completed_at: operation.completed_at, next_retry_at: operation.next_retry_at, error: operation.error, result: operation.result } : null })
      }
      if (route === '/api/admin/file-audit' && req.method === 'GET') return await store.transaction(state => {
        audit(state, actor, null, 'admin_read_audit', 'success', requestId, req)
        const hash = filterHash({resource: 'admin-audit', important: true})
        let events = state.audits.filter(isImportantAudit).sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id.localeCompare(a.id))
        const token = url.searchParams.get('cursor')
        if (token) {
          const cursor = parseCursor(token, config.cursorSecret, {sub: actor.id, filter_hash: hash})
          events = events.filter(event => event.created_at < cursor.created_at || (event.created_at === cursor.created_at && event.id < cursor.id))
        }
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 25))
        const page = events.slice(0, limit)
        const hasMore = events.length > limit
        const last = page.at(-1)
        return send(res, 200, { events: page, page: { has_more: hasMore, next_cursor: hasMore && last ? createCursor({sub: actor.id, filter_hash: hash, created_at: last.created_at, id: last.id}, config.cursorSecret, config.cursorTtlSeconds) : null } })
      })
      if (route === '/api/admin/file-export' && req.method === 'POST') {
        if (!actor.stepUp) fail('admin_step_up_required', 428, 'Fresh step-up authentication is required.')
        const body = await readJson(req)
        return await store.transaction(state => { const target = state.users.find(u => u.id === body.user_id); if (!target) fail('file_not_found', 404, 'User not found.'); audit(state, actor, target.id, 'admin_export', 'success', requestId, req); return send(res, 200, { user: { id: target.id, email: target.email }, nodes: state.nodes.filter(n => n.file_user_id === target.id) }) })
      }
      const archiveMatch = route.match(/^\/api\/admin\/file-users\/([^/]+)\/export$/)
      if (archiveMatch && req.method === 'GET') {
        if (!actor.stepUp) fail('admin_step_up_required', 428, 'Fresh step-up authentication is required.')
        const target = store.state.users.find(u => u.id === archiveMatch[1]); if (!target) fail('file_not_found', 404, 'User not found.')
        const nodes = store.state.nodes.filter(n => n.file_user_id === target.id && n.state !== 'purged'); const byId = new Map(nodes.map(n => [n.id, n])); const nodePath = node => { const parts = [node.name]; let parent = byId.get(node.parent_id); while (parent?.parent_id) { parts.unshift(parent.name); parent = byId.get(parent.parent_id) } return parts.join('/') }
        const entries = [{ name: 'metadata.json', data: JSON.stringify({ user: target, nodes }, null, 2) }]; for (const node of nodes.filter(n => n.kind === 'file' && n.provider_file_id)) entries.push({ name: `files/${nodePath(node)}`, data: await retryProvider(() => provider.read(node.provider_file_id)) })
        await store.transaction(state => { audit(state, actor, target.id, 'admin_export_archive', 'success', requestId, req, { files: entries.length - 1 }) })
        return sendBinary(res, 200, createZip(entries), { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${target.id}-export.zip"` })
      }
      if (route === '/api/admin/file-reconcile' && req.method === 'POST') {
        if (!actor.stepUp) fail('admin_step_up_required', 428, 'Fresh step-up authentication is required.')
        if (config.redisUrl) { const operationId = await jobQueue.enqueue('reconcile', { ownerId: actor.id, payload: { request_id: requestId } }); return send(res, 202, { operation: { id: operationId, type: 'reconcile', state: 'queued' } }) }
        const result = await runReconcile({ store, provider, job: { id: requestId, owner_id: actor.id } })
        return send(res, 200, result)
      }
      const purgeMatch = route.match(/^\/api\/admin\/nodes\/([^/]+)\/purge$/)
      if (purgeMatch && req.method === 'POST') {
        if (!actor.stepUp) fail('admin_step_up_required', 428, 'Fresh step-up authentication is required.')
        return await store.transaction(async state => { const node = state.nodes.find(n => n.id === purgeMatch[1]); if (!node || node.state !== 'trashed') fail('file_not_found', 404, 'Trashed node not found.'); const targets = [node, ...descendants(state, node)]; for (const target of targets) { if (target.provider_file_id) await provider.delete(target.provider_file_id); target.state = 'purged'; target.purged_at = now(); target.updated_at = now() }; audit(state, actor, node.file_user_id, 'admin_purge', 'success', requestId, req, { node_id: node.id, count: targets.length }); return send(res, 200, { purged: targets.length }) })
      }
      if (route === '/api/admin/file-maintenance' && req.method === 'POST') {
        if (!actor.stepUp) fail('admin_step_up_required', 428, 'Fresh step-up authentication is required.')
        if (config.redisUrl) { const operationId = await jobQueue.enqueue('maintenance', { ownerId: actor.id, payload: { request_id: requestId } }); return send(res, 202, { operation: { id: operationId, type: 'maintenance', state: 'queued' } }) }
        const result = await runMaintenance({ store, provider, config, job: { id: requestId, owner_id: actor.id } })
        return send(res, 200, result)
      }
      if (route === '/api/admin/synthetic-load' && req.method === 'POST') {
        if (config.authMode !== 'mock') fail('file_not_found', 404, 'Route not found.'); if (!actor.stepUp) fail('admin_step_up_required', 428, 'Fresh step-up authentication is required.')
        const body = await readJson(req); if (!Number.isSafeInteger(body.user_count) || body.user_count < 1 || body.user_count > 1000 || !Number.isSafeInteger(body.bytes_per_user) || body.bytes_per_user < 0 || body.user_count * body.bytes_per_user > config.syntheticMaxBytes) fail('file_validation_failed', 422, 'Synthetic load exceeds configured limits.')
        return await store.transaction(async state => { for (let index = 0; index < body.user_count; index++) { const userId = `synthetic-${index + 1}`; let user = state.users.find(u => u.id === userId); if (!user) { user = { id: userId, app_user_id: userId, mailbox_id: userId, email: `${userId}@example.invalid`, source: 'synthetic', status: 'active', quota_bytes: body.bytes_per_user, created_at: now(), updated_at: now(), revoked_at: null }; state.users.push(user) } else user.source = 'synthetic'; let root = rootFor(state, user); if (!root) { root = { id: id('node'), file_user_id: user.id, parent_id: null, kind: 'folder', name: 'My Files', mime_type: 'inode/directory', size_bytes: 0, state: 'active', created_at: now(), updated_at: now(), trashed_at: null, purged_at: null, provider_file_id: null }; state.nodes.push(root) } if (body.bytes_per_user && !state.nodes.some(n => n.file_user_id === user.id && n.name === 'synthetic.bin')) { const sparse = await provider.createSparse(body.bytes_per_user); state.nodes.push({ id: id('node'), file_user_id: user.id, parent_id: root.id, kind: 'file', name: 'synthetic.bin', mime_type: 'application/octet-stream', size_bytes: sparse.size, checksum: sparse.checksum, provider_file_id: sparse.providerId, state: 'active', created_at: now(), updated_at: now(), trashed_at: null, purged_at: null }) } } audit(state, actor, null, 'admin_synthetic_load', 'success', requestId, req, { user_count: body.user_count, bytes_per_user: body.bytes_per_user }); return send(res, 201, { users: body.user_count, logical_bytes: body.user_count * body.bytes_per_user, sparse: true }) })
      }
      const user = await store.transaction(state => provisionedUserFor(state, actor))
      const uploadRoute = route.match(/^\/api\/files\/uploads\/([^/]+)$/)
      const uploadCancelRoute = route.match(/^\/api\/files\/uploads\/([^/]+)\/cancel$/)
      if (user.status !== 'active' || user.revoked_at) {
        if (uploadCancelRoute) {
          const owned = store.state.uploads.some(u => u.id === uploadCancelRoute[1] && u.file_user_id === user.id)
          if (owned) { /* Cancellation remains available to release held quota. */ }
          else active(user)
        } else {
        const accepted = uploadRoute && store.state.uploads.find(u => u.id === uploadRoute[1] && u.file_user_id === user.id && new Date(u.created_at) <= new Date(user.revoked_at || 0))
        const withinGrace = accepted && Date.now() <= new Date(user.revoked_at).getTime() + config.uploadGraceMs
        if (!withinGrace) active(user)
        }
      }
      if (route === '/api/files/nodes' && req.method === 'GET') return await store.transaction(state => {
        const parent = url.searchParams.get('parent_id'); const requestedState = url.searchParams.get('state') || 'active'; if (!['active', 'trashed'].includes(requestedState)) fail('file_validation_failed', 422, 'Invalid node state.')
        if (parent) { const parentNode = nodeFor(state, user, parent, requestedState === 'trashed'); if (parentNode.kind !== 'folder') fail('file_validation_failed', 422, 'Parent must be a folder.') }
        const filters = { parent_id: parent || null, state: requestedState, q: url.searchParams.get('q') || '', kind: url.searchParams.get('kind') || '', mime_family: url.searchParams.get('mime_family') || '', updated_after: url.searchParams.get('updated_after') || '', updated_before: url.searchParams.get('updated_before') || '', starred: url.searchParams.get('starred') === 'true', recent: url.searchParams.get('recent') === 'true' }
        const hash = filterHash(filters); let nodes = state.nodes.filter(n => n.file_user_id === user.id && n.state === requestedState)
        if (requestedState === 'active' && !filters.recent && url.searchParams.get('sort') !== 'recent' && !filters.starred && !filters.q) nodes = nodes.filter(n => n.parent_id === (parent || rootFor(state, user).id))
        else if (parent) nodes = nodes.filter(n => n.parent_id === parent)
        else if (requestedState === 'trashed') { const trashedIds = new Set(nodes.map(n => n.id)); nodes = nodes.filter(n => !trashedIds.has(n.parent_id)) }
        if (filters.q) nodes = nodes.filter(n => n.name.toLowerCase().includes(filters.q.toLowerCase()))
        if (filters.kind) nodes = nodes.filter(n => n.kind === filters.kind)
        if (filters.mime_family) nodes = nodes.filter(n => String(n.mime_type || '').startsWith(`${filters.mime_family}/`))
        if (filters.updated_after) nodes = nodes.filter(n => n.updated_at >= filters.updated_after)
        if (filters.updated_before) nodes = nodes.filter(n => n.updated_at <= filters.updated_before)
        if (filters.starred) nodes = nodes.filter(n => Boolean(n.starred_at))
        nodes.sort((a, b) => { const diff = new Date(b.updated_at) - new Date(a.updated_at); return diff || b.id.localeCompare(a.id) })
        const token = url.searchParams.get('cursor'); if (token) { const cursor = parseCursor(token, config.cursorSecret, { sub: user.id, filter_hash: hash }); nodes = nodes.filter(n => n.updated_at < cursor.updated_at || (n.updated_at === cursor.updated_at && n.id < cursor.id)) }
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100)); const page = nodes.slice(0, limit); const hasMore = nodes.length > limit; const last = page.at(-1)
        return send(res, 200, { nodes: page, page: { has_more: hasMore, next_cursor: hasMore && last ? createCursor({ sub: user.id, filter_hash: hash, updated_at: last.updated_at, id: last.id }, config.cursorSecret, config.cursorTtlSeconds) : null } })
      })
      if (route === '/api/files/folders' && req.method === 'POST') { const body = await readJson(req); return await store.transaction(state => idem(state, actor, req.headers['idempotency-key'], 'folder.create', () => { if (!validName(body.name)) fail('file_validation_failed', 422, 'Invalid folder name.'); const parentId = body.parent_id || rootFor(state, user).id; folderFor(state, user, parentId); if (state.nodes.some(n => n.file_user_id === user.id && n.parent_id === parentId && n.state === 'active' && n.name === body.name)) fail('file_conflict', 409, 'A node with that name already exists.'); const node = { id: id('node'), file_user_id: user.id, parent_id: parentId, kind: 'folder', name: body.name.trim(), mime_type: 'inode/directory', size_bytes: 0, state: 'active', created_at: now(), updated_at: now(), trashed_at: null, purged_at: null, provider_file_id: null }; state.nodes.push(node); audit(state, actor, user.id, 'folder_create', 'success', requestId, req); return send(res, 201, { node }) })) }
      if (route === '/api/files/uploads' && req.method === 'POST') {
        const body = await readJson(req); const key = req.headers['idempotency-key']
        if (!key) fail('file_validation_failed', 422, 'Idempotency-Key is required for this mutation.')
        return await store.transaction(state => {
          const prior = state.idempotency.find(item => item.actor === actor.id && item.key === key && item.operation === 'upload.create')
          if (prior?.response) return send(res, prior.status || 201, prior.response, { 'idempotency-replayed': 'true' })
          if (!Number.isSafeInteger(body.size_bytes) || body.size_bytes < 0 || body.size_bytes > config.maxUploadBytes) fail('file_validation_failed', 422, 'Invalid upload.')
          let targetNode = null
          if (body.target_node_id !== undefined) {
            targetNode = nodeFor(state, user, String(body.target_node_id))
            if (targetNode.kind !== 'file') fail('file_validation_failed', 422, 'Revision target must be a file.')
            if (targetNode.state !== 'active') fail('file_conflict', 409, 'Revision target is not active.')
            if (body.parent_id !== undefined && String(body.parent_id) !== String(targetNode.parent_id || '')) fail('file_validation_failed', 422, 'Revision upload cannot change parent.')
          }
          const uploadMode = targetNode ? (body.upload_mode || 'revision') : 'new'
          if (!['new', 'revision', 'overwrite'].includes(uploadMode) || (!targetNode && !['new', 'overwrite'].includes(uploadMode))) fail('file_validation_failed', 422, 'Invalid upload mode.')
          const uploadName = (body.name || targetNode?.name || '').trim()
          if (!validName(uploadName)) fail('file_validation_failed', 422, 'Invalid upload.')
          const parentId = targetNode?.parent_id ?? body.parent_id ?? rootFor(state, user).id; folderFor(state, user, parentId)
          const additionalBytes = Math.max(0, body.size_bytes - (targetNode?.size_bytes || 0))
          if (usage(state, user) + additionalBytes > user.quota_bytes) fail('file_quota_exceeded', 409, 'File quota is not sufficient for this upload.')
          const upload = { id: id('upload'), file_user_id: user.id, idempotency_key: key, expected_bytes: body.size_bytes, received_bytes: 0, state: 'pending', provider_file_id: targetNode?.provider_file_id || null, target_node_id: targetNode?.id || null, upload_mode: uploadMode, name: uploadName, parent_id: parentId, mime_type: body.mime_type || targetNode?.mime_type || 'application/octet-stream', created_at: now(), updated_at: now() }
          state.uploads.push(upload); state.reservations.push({ id: id('reservation'), file_user_id: user.id, upload_id: upload.id, bytes_reserved: additionalBytes, state: 'held', expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: now() })
          const response = { upload_id: upload.id, expected_bytes: upload.expected_bytes, received_bytes: 0, state: upload.state }
          state.idempotency.push({ actor: actor.id, key, operation: 'upload.create', status: 201, response, created_at: now() })
          audit(state, actor, user.id, 'upload_create', 'success', requestId, req, { upload_id: upload.id })
          return send(res, 201, response)
        })
      }
      const uploadMatch = uploadRoute
      if (uploadMatch && req.method === 'GET') {
        return await store.transaction(state => {
          const upload = state.uploads.find(u => u.id === uploadMatch[1] && u.file_user_id === user.id)
          if (!upload) fail('file_not_found', 404, 'Upload not found.')
          const live = uploadProgress.get(upload.id)
          return send(res, 200, { upload: { ...upload, expected_offset: upload.received_bytes, provider_progress: live?.progress ?? null, provider_phase: live?.phase ?? null } })
        })
      }
      if (uploadCancelRoute && req.method === 'POST') {
        const uploadId = uploadCancelRoute[1]
        return await store.transaction(async state => {
          const upload = state.uploads.find(u => u.id === uploadId && u.file_user_id === user.id)
          if (!upload) fail('file_not_found', 404, 'Upload not found.')
          const key = req.headers['idempotency-key']; if (!key) fail('file_validation_failed', 422, 'Idempotency-Key is required for this mutation.')
          const prior = state.idempotency.find(x => x.actor === actor.id && x.key === key && x.operation === 'upload.cancel')
          if (prior?.response) return send(res, 200, prior.response, { 'idempotency-replayed': 'true' })
          if (!['completed', 'canceled'].includes(upload.state)) {
            await retryProvider(() => provider.discard(upload.id))
            upload.state = 'canceled'; upload.updated_at = now(); upload.last_error = null
            const reservation = state.reservations.find(r => r.upload_id === upload.id && r.state === 'held')
            if (reservation) { reservation.state = 'released'; reservation.released_at = now() }
          }
          const response = { upload, released: true }
          state.idempotency.push({ actor: actor.id, key, operation: 'upload.cancel', response, created_at: now() })
          audit(state, actor, user.id, 'upload_cancel', 'success', requestId, req, { upload_id: upload.id })
          return send(res, 200, response)
        })
      }
      if (uploadMatch && req.method === 'PATCH') {
        const uploadId = uploadMatch[1]
        const raw = !String(req.headers['content-type'] || '').toLowerCase().includes('application/json')
        return await store.transaction(async state => {
          const upload = state.uploads.find(u => u.id === uploadId && u.file_user_id === user.id)
          if (!upload) fail('file_not_found', 404, 'Upload not found.')
          if (upload.state === 'completed') return send(res, 200, { upload })
          if (['canceled', 'failed', 'expired'].includes(upload.state)) fail('file_conflict', 409, 'Upload is no longer writable.', false, { upload_state: upload.state })
          const body = raw ? {} : await readJson(req)
          const finalize = raw ? url.searchParams.get('finalize') === 'true' : body.finalize === true
          if (!raw && body.data === undefined && !finalize) fail('file_validation_failed', 422, 'Upload data is required.')
          const range = req.headers['content-range']
          if (range) {
            const match = String(range).match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/)
            if (!match) fail('file_validation_failed', 422, 'Invalid Content-Range.')
            const start = Number(match[1]); const end = Number(match[2]); const total = Number(match[3])
            if (![start, end, total].every(Number.isSafeInteger)) fail('file_validation_failed', 422, 'Invalid Content-Range.')
            if (start !== upload.received_bytes) fail('file_conflict', 409, 'Upload offset does not match server state.', false, { expected_offset: upload.received_bytes })
            const chunkBytes = end - start + 1
            const nextOffset = upload.received_bytes + chunkBytes
            if (upload.expected_bytes === 0 || total !== upload.expected_bytes || end < start || end >= total || chunkBytes <= 0 || !Number.isSafeInteger(nextOffset) || nextOffset > upload.expected_bytes) fail('file_validation_failed', 422, 'Content-Range does not match upload intent.')
            const contentLength = req.headers['content-length']
            if (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) !== chunkBytes)) fail('file_validation_failed', 422, 'Content-Range length does not match body.')
            const expected = chunkBytes
            const received = await retryProvider(() => provider.appendStream(upload.id, req, expected, true))
            const receivedOffset = upload.received_bytes + received
            if (!Number.isSafeInteger(receivedOffset) || receivedOffset > upload.expected_bytes) fail('file_validation_failed', 422, 'Upload exceeds declared size.')
            upload.received_bytes = receivedOffset
          } else if (raw) {
            const remaining = upload.expected_bytes - upload.received_bytes
            const received = await retryProvider(() => provider.appendStream(upload.id, req, remaining))
            upload.received_bytes += received
          } else if (body.data !== undefined) {
            const buffer = Buffer.from(body.data, body.encoding === 'base64' ? 'base64' : 'utf8')
            if (upload.received_bytes + buffer.length > upload.expected_bytes) fail('file_validation_failed', 422, 'Upload exceeds declared size.')
            await retryProvider(() => provider.append(upload.id, buffer)); upload.received_bytes += buffer.length
          }
          upload.state = upload.received_bytes === upload.expected_bytes ? 'ready' : 'uploading'; upload.updated_at = now()
          if (finalize) {
            if (upload.received_bytes !== upload.expected_bytes) fail('file_validation_failed', 422, 'Upload is incomplete.')
            folderFor(state, user, upload.parent_id)
            upload.state = 'finalizing'; upload.updated_at = now()
            uploadProgress.set(upload.id, { progress: 0, phase: 'google_drive_commit' })
            let committed
            try {
              committed = await retryProvider(() => provider.commit(upload.id, { expectedBytes: upload.expected_bytes, targetProviderId: upload.provider_file_id || undefined, fileUserId: user.id, email: user.email, name: upload.name, mimeType: upload.mime_type, onProgress: (sent, total) => uploadProgress.set(upload.id, { progress: total ? Math.min(99, Math.round(sent / total * 100)) : 0, phase: 'google_drive_commit' }) }))
            } finally {
              setTimeout(() => uploadProgress.delete(upload.id), 10_000)
            }
            const existingNode = upload.target_node_id && state.nodes.find(candidate => candidate.id === upload.target_node_id && candidate.file_user_id === user.id)
            const node = existingNode || { id: id('node'), file_user_id: user.id, parent_id: upload.parent_id, kind: 'file', name: upload.name, mime_type: upload.mime_type, size_bytes: committed.size, checksum: committed.checksum, provider_file_id: committed.providerId, state: 'active', created_at: now(), updated_at: now(), trashed_at: null, purged_at: null, starred_at: null }
            if (existingNode) Object.assign(existingNode, { name: upload.name, mime_type: upload.mime_type, size_bytes: committed.size, checksum: committed.checksum, provider_file_id: committed.providerId, state: 'active', updated_at: now() })
            else state.nodes.push(node)
            upload.provider_file_id = committed.providerId; upload.node_id = node.id; upload.state = 'completed'
            if (upload.upload_mode === 'overwrite') state.revisions = state.revisions.filter(revision => revision.node_id !== node.id || revision.file_user_id !== user.id)
            const priorRevisionCount = state.revisions.filter(revision => revision.node_id === node.id && revision.file_user_id === user.id).length
            state.revisions.push({ id: id('revision'), file_user_id: user.id, node_id: node.id, provider_revision_id: committed.revisionId || `head_${crypto.randomUUID()}`, revision_number: priorRevisionCount + 1, name: node.name, mime_type: node.mime_type, size_bytes: committed.size, checksum: committed.checksum, created_at: now(), created_by: actor.id })
            const reservation = state.reservations.find(r => r.upload_id === upload.id); if (reservation) { reservation.state = 'committed'; reservation.committed_at = now() }
            audit(state, actor, user.id, 'upload_commit', 'success', requestId, req, { node_id: node.id }); return send(res, 200, { upload, node })
          }
          return send(res, 200, { upload })
        })
      }
      if (route === '/api/files/nodes/bulk' && req.method === 'POST') {
        const body = await readJson(req); const key = req.headers['idempotency-key']
        if (!key) fail('file_validation_failed', 422, 'Idempotency-Key is required for this mutation.')
        if (!['trash', 'restore'].includes(body.action) || !Array.isArray(body.ids) || body.ids.length > 100) fail('file_validation_failed', 422, 'Invalid bulk operation.')
        return await store.transaction(state => {
          const prior = state.idempotency.find(x => x.actor === actor.id && x.key === key && x.operation === `node.bulk.${body.action}`)
          if (prior?.response) return send(res, 200, prior.response, { 'idempotency-replayed': 'true' })
          const ids = [...new Set(body.ids.map(String))]; const outcomes = ids.map(nodeId => {
            try {
              const node = nodeFor(state, user, nodeId, body.action === 'restore')
              if (body.action === 'trash') { for (const target of [node, ...descendants(state, node)]) { target.state = 'trashed'; target.trashed_at = now(); target.updated_at = now() } }
              else { if (node.state !== 'trashed') fail('file_conflict', 409, 'Node is not in trash.'); const parent=node.parent_id&&state.nodes.find(target=>target.id===node.parent_id&&target.file_user_id===user.id); if(node.parent_id&&parent?.state!=='active')fail('file_conflict',409,'Restore the parent folder first.'); const targets=[node,...descendants(state,node)]; const restoreBytes=targets.filter(target=>target.kind==='file'&&target.state==='trashed').reduce((sum,target)=>sum+target.size_bytes,0); if(usage(state,user)+restoreBytes>user.quota_bytes)fail('file_quota_exceeded',409,'File quota is not sufficient for restore.'); for (const target of targets) { target.state = 'active'; target.trashed_at = null; target.updated_at = now() } }
              return { id: nodeId, status: 'succeeded', request_id: requestId }
            } catch (error) { return { id: nodeId, status: 'failed', code: error.code || 'file_operation_failed', message: error.message, request_id: requestId } }
          })
          const response = { action: body.action, outcomes, summary: { total: outcomes.length, succeeded: outcomes.filter(x => x.status === 'succeeded').length, failed: outcomes.filter(x => x.status !== 'succeeded').length } }
          state.idempotency.push({ actor: actor.id, key, operation: `node.bulk.${body.action}`, response, created_at: now() }); audit(state, actor, user.id, `node_bulk_${body.action}`, 'success', requestId, req, response.summary)
          return send(res, 200, response)
        })
      }
      const revisionMatch = route.match(/^\/api\/files\/nodes\/([^/]+)\/revisions(?:\/([^/]+)(?:\/(download|restore))?)?$/)
      if (revisionMatch) {
        const nodeId = revisionMatch[1]; const revisionId = revisionMatch[2]; const revisionAction = revisionMatch[3]
        if (req.method === 'GET' && !revisionAction) {
          const node = nodeFor(store.state, user, nodeId)
          const revisions = store.state.revisions.filter(revision => revision.node_id === node.id && revision.file_user_id === user.id).sort((a, b) => b.revision_number - a.revision_number || b.created_at.localeCompare(a.created_at))
          return send(res, 200, { revisions: revisions.map(revision => ({ ...revision, provider_revision_id: undefined })) })
        }
        if (!revisionId) fail('file_not_found', 404, 'Revision not found.')
        const node = nodeFor(store.state, user, nodeId)
        const revision = store.state.revisions.find(candidate => candidate.id === revisionId && candidate.node_id === node.id && candidate.file_user_id === user.id)
        if (!revision) fail('file_not_found', 404, 'Revision not found.')
        if (revisionAction === 'download' && req.method === 'GET') {
          const result = await retryProvider(() => provider.openRevision(node.provider_file_id, revision.provider_revision_id))
          return sendStream(res, 200, result, { 'content-type': revision.mime_type || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(revision.name || node.name)}`, 'cache-control': 'private, no-store' })
        }
        if (revisionAction === 'restore' && req.method === 'POST') {
          const key = req.headers['idempotency-key']
          if (!key) fail('file_validation_failed', 422, 'Idempotency-Key is required for this mutation.')
          return await store.transaction(async state => {
            const currentNode = nodeFor(state, user, nodeId); const currentRevision = state.revisions.find(candidate => candidate.id === revisionId && candidate.node_id === currentNode.id && candidate.file_user_id === user.id)
            if (!currentRevision) fail('file_not_found', 404, 'Revision not found.')
            const prior = state.idempotency.find(item => item.actor === actor.id && item.key === key && item.operation === 'revision.restore')
            if (prior?.response) return send(res, 200, prior.response, { 'idempotency-replayed': 'true' })
            const delta = Math.max(0, currentRevision.size_bytes - currentNode.size_bytes)
            if (usage(state, user) + delta > user.quota_bytes) fail('file_quota_exceeded', 409, 'File quota is not sufficient for this revision restore.')
            const restored = await retryProvider(() => provider.restoreRevision(currentNode.provider_file_id, currentRevision.provider_revision_id, { mimeType: currentRevision.mime_type }))
            Object.assign(currentNode, { size_bytes: restored.size, checksum: restored.checksum || currentRevision.checksum, mime_type: currentRevision.mime_type || currentNode.mime_type, name: currentRevision.name || currentNode.name, updated_at: now() })
            const next = { id: id('revision'), file_user_id: user.id, node_id: currentNode.id, provider_revision_id: restored.revisionId || currentRevision.provider_revision_id, revision_number: state.revisions.filter(item => item.node_id === currentNode.id).length + 1, name: currentNode.name, mime_type: currentNode.mime_type, size_bytes: currentNode.size_bytes, checksum: currentNode.checksum, created_at: now(), created_by: actor.id }
            state.revisions.push(next)
            const response = { node: currentNode, revision: { ...next, provider_revision_id: undefined } }
            state.idempotency.push({ actor: actor.id, key, operation: 'revision.restore', response, created_at: now() }); audit(state, actor, user.id, 'revision_restore', 'success', requestId, req, { node_id: nodeId, revision_id: revisionId }); return send(res, 200, response)
          })
        }
      }
      const nodeMatch = route.match(/^\/api\/files\/nodes\/([^/]+)(?:\/(download|preview|thumbnail|trash|restore|star|activity))?$/); if (nodeMatch) { const nodeId = nodeMatch[1]; const action = nodeMatch[2]
        if (action === 'star' && req.method === 'PATCH') { const body = await readJson(req); return await store.transaction(state => { const key = req.headers['idempotency-key']; if (!key) fail('file_validation_failed', 422, 'Idempotency-Key is required for this mutation.'); const prior = state.idempotency.find(x => x.actor === actor.id && x.key === key && x.operation === 'node.star'); if (prior?.response) return send(res, 200, prior.response, {'idempotency-replayed':'true'}); const node = nodeFor(state, user, nodeId); node.starred_at = body.starred === false ? null : now(); node.updated_at = now(); const response = { node }; state.idempotency.push({actor: actor.id,key,operation:'node.star',response,created_at:now()}); audit(state, actor, user.id, node.starred_at ? 'node_star' : 'node_unstar', 'success', requestId, req, {node_id:nodeId}); return send(res, 200, response) }) }
        if (action === 'activity' && req.method === 'GET') return await store.transaction(state => { nodeFor(state, user, nodeId, true); const hash = filterHash({node_id:nodeId,resource:'activity'}); let events = state.audits.filter(e => e.subject_file_user_id === user.id && e.metadata?.node_id === nodeId).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)||b.id.localeCompare(a.id)); const token=url.searchParams.get('cursor'); if(token){const cursor=parseCursor(token,config.cursorSecret,{sub:user.id,filter_hash:hash});events=events.filter(e=>e.created_at<cursor.updated_at||(e.created_at===cursor.updated_at&&e.id<cursor.id))} const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20)); const page=events.slice(0,limit);const hasMore=events.length>limit;const last=page.at(-1); return send(res,200,{events:page.map(e => ({id:e.id, action:e.action, result:e.result, created_at:e.created_at})),page:{has_more:hasMore,next_cursor:hasMore?createCursor({sub:user.id,filter_hash:hash,updated_at:last.created_at,id:last.id},config.cursorSecret,config.cursorTtlSeconds):null}}) })
        if (action === 'download' && req.method === 'GET') { const node = nodeFor(store.state, user, nodeId); const result = await retryProvider(() => provider.openRead(node.provider_file_id)); return sendStream(res, 200, result, { 'content-type': node.mime_type || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}` }) }
        if (action === 'preview' && req.method === 'GET') {
          const node = nodeFor(store.state, user, nodeId)
          const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])
          if (config.previewEnabled === false || node.kind !== 'file' || !allowed.has(String(node.mime_type || '').toLowerCase()) || node.size_bytes > (config.previewMaxBytes || 25 * 1024 ** 2)) fail('file_preview_unsupported', 415, 'This file cannot be previewed safely.')
          const result = await retryProvider(() => provider.openRead(node.provider_file_id))
          audit(store.state, actor, user.id, 'node_preview', 'success', requestId, req, { node_id: nodeId })
          return sendStream(res, 200, result, { 'content-type': node.mime_type, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(node.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' })
        }
        if (action === 'thumbnail' && req.method === 'GET') {
          const node = nodeFor(store.state, user, nodeId)
          if (node.kind !== 'file' || !String(node.mime_type || '').toLowerCase().startsWith('image/')) fail('file_preview_unsupported', 415, 'This file has no thumbnail.')
          const result = await retryProvider(() => provider.openThumbnail(node.provider_file_id, { mimeType: node.mime_type }))
          return sendStream(res, 200, result, { 'content-type': node.mime_type, 'content-disposition': 'inline', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=60' })
        }
        if (action === 'trash' && req.method === 'POST') return await store.transaction(state => idem(state, actor, req.headers['idempotency-key'], 'node.trash', async () => { const node = nodeFor(state, user, nodeId); for (const target of [node, ...descendants(state, node)]) { target.state = 'trashed'; target.trashed_at = now(); target.updated_at = now() }; audit(state, actor, user.id, 'node_trash', 'success', requestId, req, { node_id: nodeId }); return send(res, 200, { node }) }))
        if (action === 'restore' && req.method === 'POST') return await store.transaction(state => idem(state, actor, req.headers['idempotency-key'], 'node.restore', async () => { const node = nodeFor(state, user, nodeId, true); if (node.state !== 'trashed') fail('file_conflict', 409, 'Node is not in trash.'); const parent = node.parent_id && state.nodes.find(target => target.id === node.parent_id && target.file_user_id === user.id); if (node.parent_id && parent?.state !== 'active') fail('file_conflict', 409, 'Restore the parent folder first.'); const targets = [node, ...descendants(state, node)]; const restoreBytes = targets.filter(target => target.kind === 'file' && target.state === 'trashed').reduce((sum, target) => sum + target.size_bytes, 0); const activeBytes = state.nodes.filter(target => target.file_user_id === user.id && target.kind === 'file' && target.state === 'active').reduce((sum, target) => sum + target.size_bytes, 0); const heldBytes = state.reservations.filter(reservation => reservation.file_user_id === user.id && reservation.state === 'held').reduce((sum, reservation) => sum + reservation.bytes_reserved, 0); if (activeBytes + heldBytes + restoreBytes > user.quota_bytes) fail('file_quota_exceeded', 409, 'File quota is not sufficient for restore.'); for (const target of targets) { target.state = 'active'; target.trashed_at = null; target.updated_at = now() }; audit(state, actor, user.id, 'node_restore', 'success', requestId, req, { node_id: nodeId }); return send(res, 200, { node }) }))
        if (!action && req.method === 'PATCH') { const body = await readJson(req); return await store.transaction(state => idem(state, actor, req.headers['idempotency-key'], 'node.update', async () => { const node = nodeFor(state, user, nodeId); if (body.name !== undefined) { if (!validName(body.name)) fail('file_validation_failed', 422, 'Invalid name.'); if (state.nodes.some(n => n.file_user_id === user.id && n.parent_id === node.parent_id && n.id !== node.id && n.state === 'active' && n.name === body.name)) fail('file_conflict', 409, 'A node with that name already exists.'); node.name = body.name.trim() }; if (body.parent_id !== undefined) { const parent = folderFor(state, user, body.parent_id); const invalidCycle = node.kind === 'folder' && descendants(state, node).some(child => child.id === parent.id); if (parent.id === node.id || invalidCycle) fail('file_validation_failed', 422, 'Invalid destination folder.'); node.parent_id = parent.id }; node.updated_at = now(); audit(state, actor, user.id, 'node_update', 'success', requestId, req, { node_id: nodeId }); return send(res, 200, { node }) })) }
      }
      fail('file_not_found', 404, 'Route not found.')
    } catch (error) { if (res.headersSent) { res.destroy(error); return } if (error.retryable) { const match = req.url.match(/^\/api\/files\/uploads\/([^/?]+)/); if (match) await store.transaction(state => { const upload = state.uploads.find(u => u.id === match[1]); if (upload) { upload.state = 'failed'; upload.last_error = error.code; const reservation = state.reservations.find(r => r.upload_id === upload.id && r.state === 'held'); if (reservation) reservation.state = 'released' } }) } const result = errorBody(error, requestId); return send(res, result.status, result.body) }
  }
  return { store, provider, auth, jobQueue, handler }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig(); const app = await createApp(config); http.createServer(app.handler).listen(config.port, () => console.log(`file-service listening on ${config.port}`))
}
