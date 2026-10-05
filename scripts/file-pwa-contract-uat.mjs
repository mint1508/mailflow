import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const base = (process.env.FILE_PWA_UAT_URL || process.env.FILE_UAT_URL || '').replace(/\/$/, '')
const artifact = path.resolve(process.env.FILE_UAT_OUTPUT || process.env.FILE_PWA_UAT_ARTIFACT || 'artifacts/file-pwa/f6/contract-uat.json')
const suite = process.argv.includes('--suite') ? process.argv[process.argv.indexOf('--suite') + 1] : 'contract'
const directUserId = process.env.FILE_PWA_UAT_USER_ID || process.env.FILE_UAT_DIRECT_USER_ID
const directEmail = process.env.FILE_PWA_UAT_EMAIL || process.env.FILE_UAT_EMAIL || 'f6-uat@example.test'
const accessToken = process.env.FILE_PWA_UAT_ACCESS_TOKEN || process.env.FILE_UAT_ACCESS_TOKEN

if (!base) {
  console.error('FILE_PWA_UAT_URL is required to run the authenticated File PWA contract UAT.')
  process.exit(2)
}
if (!directUserId && !accessToken) {
  console.error('Provide FILE_PWA_UAT_USER_ID (dev fixture) or FILE_PWA_UAT_ACCESS_TOKEN.')
  process.exit(2)
}

const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
const name = `f6-contract-${stamp}`
const checks = []
const request = async (method, route, body, options = {}) => {
  const headers = directUserId
    ? { 'x-dev-user-id': options.userId || directUserId, 'x-dev-email': options.email || directEmail }
    : { authorization: `Bearer ${accessToken}` }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    headers['idempotency-key'] = `f6-uat-${crypto.randomUUID()}`
  }
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  const safeRoute = route.split('?')[0].replace(/(\/api\/files\/(?:nodes|uploads)\/)[^/]+/g, '$1:id')
  checks.push({ method, route: safeRoute, status: response.status, request_id: response.headers.get('x-request-id') || null, ok: response.ok })
  if (options.expectStatus) {
    if (response.status !== options.expectStatus) throw new Error(`${method} ${safeRoute} returned HTTP ${response.status}; expected ${options.expectStatus}`)
  } else if (!response.ok) throw new Error(`${method} ${safeRoute} returned HTTP ${response.status}`)
  return payload
}

const result = { ok: false, started_at: new Date().toISOString(), checks, cleanup: 'pending' }
let trashId
let folderId
try {
  const me = await request('GET', '/api/files/me')
  const folder = await request('POST', '/api/files/folders', { parent_id: me.home.id, name })
  folderId = folder.node.id
  const content = 'f6 contract uat content\n'
  const intent = await request('POST', '/api/files/uploads', { parent_id: folder.node.id, name: `${name}.png`, size_bytes: Buffer.byteLength(content), mime_type: 'image/png' })
  const committed = await request('PATCH', `/api/files/uploads/${intent.upload_id}`, { data: content, finalize: true })
  if (suite === 'actions') {
    const previewed = await request('GET', `/api/files/nodes/${committed.node.id}/preview`)
    if (previewed.toString() !== content) throw new Error('authorized preview did not match uploaded bytes')
    if (directUserId) await request('GET', `/api/files/nodes/${committed.node.id}/preview`, undefined, { userId: `${directUserId}-other`, email: `other-${directEmail}`, expectStatus: 404 })
  }
  const downloaded = await request('GET', `/api/files/nodes/${committed.node.id}/download`)
  if (downloaded.toString() !== content) throw new Error('provider-confirmed download did not match expected length')
  const search = await request('GET', `/api/files/search?q=${encodeURIComponent(name)}`)
  if (!search.nodes.some(node => node.id === committed.node.id)) throw new Error('created file was not searchable')
  await request('POST', `/api/files/nodes/${committed.node.id}/trash`, {})
  trashId = committed.node.id
  await request('GET', '/api/files/nodes?state=trashed')
  await request('POST', `/api/files/nodes/${committed.node.id}/restore`, {})
  result.ok = true
  result.contracts = { auth: true, folder_create: true, upload_commit: true, preview: suite === 'actions', cross_user_denial: suite === 'actions' && Boolean(directUserId), download: true, search: true, trash_restore: true }
} catch (error) {
  result.error = error instanceof Error ? error.message : 'contract UAT failed'
  process.exitCode = 1
} finally {
  // Keep the artifact useful without recording user identity, access tokens, or
  // uploaded bytes. Cleanup is best effort because failed UAT must remain inspectable.
  if (folderId) {
    try { await request('POST', `/api/files/nodes/${folderId}/trash`, {}) } catch { /* cleanup is best effort */ }
  } else if (trashId) {
    try { await request('POST', `/api/files/nodes/${trashId}/trash`, {}) } catch { /* cleanup is best effort */ }
  }
  result.cleanup = 'attempted'
  result.finished_at = new Date().toISOString()
  await fs.mkdir(path.dirname(artifact), { recursive: true })
  await fs.writeFile(artifact, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
}

console.log(`File PWA contract UAT ${result.ok ? 'passed' : 'failed'}; artifact: ${artifact}`)
