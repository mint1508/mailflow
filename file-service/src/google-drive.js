import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { appendStreamToFile } from './storage.js'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

function providerError(message, code = 'file_provider_unavailable', status = 503, retryable = true) {
  return Object.assign(new Error(message), { code, status, retryable })
}

function quoteQuery(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

export class GoogleDriveAdapter {
  constructor(config, store, fetchImpl = globalThis.fetch) {
    this.config = config
    this.store = store
    this.fetch = fetchImpl
    this.token = null
    this.rootFolderId = config.googleRootFolderId || null
    this.userFolders = new Map()
  }

  tempPath(uploadId) { return path.join(this.store.tmp, uploadId) }
  sessionPath(uploadId) { return path.join(this.store.tmp, `${uploadId}.drive-session.json`) }

  async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    let response
    try {
      response = await this.fetch(this.config.googleTokenUrl || TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.googleClientId,
          client_secret: this.config.googleClientSecret,
          refresh_token: this.config.googleRefreshToken,
          grant_type: 'refresh_token',
        }),
      })
    } catch {
      throw providerError('Google authorization service is unavailable.')
    }
    if (!response.ok) throw providerError('Google storage authorization failed.', 'file_operation_failed', 502, false)
    const body = await response.json()
    if (!body.access_token) throw providerError('Google storage authorization failed.', 'file_operation_failed', 502, false)
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 }
    return this.token.value
  }

  async request(url, options = {}, allowNotFound = false) {
    const run = async () => {
      const token = await this.accessToken()
      try {
        return await this.fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }, duplex: options.body && typeof options.body.pipe === 'function' ? 'half' : undefined })
      } catch {
        throw providerError('Google storage is unavailable.')
      }
    }
    let response = await run()
    if (response.status === 401) {
      this.token = null
      if (options.body && typeof options.body.pipe === 'function') throw providerError('Google storage authorization expired during transfer.')
      response = await run()
    }
    if (allowNotFound && response.status === 404) return response
    if (response.status === 308) return response
    if (response.status === 429) throw providerError('Google storage rate limit reached.', 'file_provider_rate_limited')
    if (response.status >= 500) throw providerError('Google storage is unavailable.')
    if (!response.ok) throw providerError('Google storage rejected the operation.', 'file_operation_failed', 502, false)
    return response
  }

  async jsonRequest(url, options = {}, allowNotFound = false) {
    const response = await this.request(url, options, allowNotFound)
    if (allowNotFound && response.status === 404) return null
    return response.status === 204 ? null : response.json()
  }

  async findOne(query, fields = 'files(id,name,size,md5Checksum)') {
    const params = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '1', fields })
    const body = await this.jsonRequest(`${DRIVE_API}/files?${params}`)
    return body.files?.[0] || null
  }

  async createFolder(name, parentId, appProperties) {
    return this.jsonRequest(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties }),
    })
  }

  async ensureRootFolder() {
    if (this.rootFolderId) return this.rootFolderId
    const query = `trashed = false and mimeType = '${FOLDER_MIME}' and appProperties has { key='hippy_root' and value='files-v1' }`
    const existing = await this.findOne(query, 'files(id)')
    const folder = existing || await this.createFolder(this.config.googleRootFolderName || 'Hippy Files', null, { hippy_root: 'files-v1' })
    this.rootFolderId = folder.id
    return folder.id
  }

  async ensureUserFolder(context) {
    if (this.userFolders.has(context.fileUserId)) return this.userFolders.get(context.fileUserId)
    const root = await this.ensureRootFolder()
    const userId = quoteQuery(context.fileUserId)
    const query = `'${quoteQuery(root)}' in parents and trashed = false and mimeType = '${FOLDER_MIME}' and appProperties has { key='hippy_user_id' and value='${userId}' }`
    const existing = await this.findOne(query, 'files(id)')
    const safeEmail = String(context.email || context.fileUserId).replace(/[\\/\0]/g, '_').slice(0, 180)
    const folder = existing || await this.createFolder(safeEmail, root, { hippy_user_id: context.fileUserId, hippy_kind: 'user-folder' })
    this.userFolders.set(context.fileUserId, folder.id)
    return folder.id
  }

  async append(uploadId, buffer) { await fs.appendFile(this.tempPath(uploadId), buffer, { mode: 0o600 }) }
  async appendStream(uploadId, readable, maxBytes, exact = false) { return appendStreamToFile(this.tempPath(uploadId), readable, maxBytes, exact) }

  async existingUpload(uploadId) {
    const id = quoteQuery(uploadId)
    return this.findOne(`trashed = false and appProperties has { key='hippy_upload_id' and value='${id}' }`, 'files(id,name,size,md5Checksum,headRevisionId)')
  }

  async loadSession(uploadId) {
    try { return JSON.parse(await fs.readFile(this.sessionPath(uploadId), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; return null }
  }

  progressStream(source, start, total, onProgress) {
    const input = createReadStream(source, { start })
    if (typeof onProgress !== 'function') return input
    let sent = start
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        sent += chunk.length
        onProgress(sent, total)
        callback(null, chunk)
      },
    })
    return input.pipe(meter)
  }

  async initiateSession(uploadId, context, size) {
    const parentId = await this.ensureUserFolder(context)
    const response = await this.request(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,size,md5Checksum,headRevisionId`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': context.mimeType || 'application/octet-stream',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({
        name: context.name,
        parents: [parentId],
        appProperties: { hippy_upload_id: uploadId, hippy_user_id: context.fileUserId, hippy_kind: 'file' },
      }),
    })
    const sessionUrl = response.headers.get('location')
    if (!sessionUrl) throw providerError('Google storage did not create an upload session.')
    const session = { url: sessionUrl, size }
    await fs.writeFile(this.sessionPath(uploadId), JSON.stringify(session), { mode: 0o600 })
    return session
  }

  async commit(uploadId, context = {}) {
    const source = this.tempPath(uploadId)
    try { await fs.access(source) } catch (error) { if (error.code !== 'ENOENT') throw error; await fs.writeFile(source, Buffer.alloc(0), { mode: 0o600 }) }
    const stat = await fs.stat(source)
    if (context.expectedBytes !== undefined && stat.size !== context.expectedBytes) throw providerError('Staged upload size does not match the reservation.', 'file_validation_failed', 422, false)
    const already = await this.existingUpload(uploadId)
    if (context.targetProviderId) {
      const response = await this.request(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(context.targetProviderId)}?uploadType=media&fields=id,size,md5Checksum,headRevisionId`, {
        method: 'PATCH',
        headers: { 'content-type': context.mimeType || 'application/octet-stream', 'content-length': String(stat.size) },
        body: this.progressStream(source, 0, stat.size, context.onProgress),
      })
      const file = await response.json()
      await this.discard(uploadId)
      return { providerId: file.id || context.targetProviderId, size: Number(file.size ?? stat.size), checksum: file.md5Checksum ? `md5:${file.md5Checksum}` : null, ...(file.headRevisionId ? { revisionId: file.headRevisionId } : {}) }
    }
    if (already && Number(already.size) === stat.size) {
      await this.discard(uploadId)
      return { providerId: already.id, size: stat.size, checksum: already.md5Checksum ? `md5:${already.md5Checksum}` : null, ...(already.headRevisionId ? { revisionId: already.headRevisionId } : {}) }
    }
    let session = await this.loadSession(uploadId)
    let offset = 0
    if (session) {
      const probe = await this.request(session.url, { method: 'PUT', headers: { 'content-length': '0', 'content-range': `bytes */${stat.size}` } }, true)
      if (probe.status === 404) { await fs.rm(this.sessionPath(uploadId), { force: true }); session = null }
      else if (probe.status !== 308) { const file = await probe.json(); await this.discard(uploadId); return { providerId: file.id, size: Number(file.size ?? stat.size), checksum: file.md5Checksum ? `md5:${file.md5Checksum}` : null, ...(file.headRevisionId ? { revisionId: file.headRevisionId } : {}) } }
      else { const match = probe.headers.get('range')?.match(/bytes=0-(\d+)/); offset = match ? Number(match[1]) + 1 : 0 }
    }
    if (!session) session = await this.initiateSession(uploadId, context, stat.size)
    let response = await this.request(session.url, {
      method: 'PUT',
      headers: {
        'content-type': context.mimeType || 'application/octet-stream',
        'content-length': String(stat.size - offset),
        'content-range': stat.size ? `bytes ${offset}-${stat.size - 1}/${stat.size}` : 'bytes */0',
      },
      body: this.progressStream(source, offset, stat.size, context.onProgress),
    }, true)
    if (response.status === 404) {
      await fs.rm(this.sessionPath(uploadId), { force: true })
      session = await this.initiateSession(uploadId, context, stat.size)
      response = await this.request(session.url, {
        method: 'PUT',
        headers: { 'content-type': context.mimeType || 'application/octet-stream', 'content-length': String(stat.size), 'content-range': stat.size ? `bytes 0-${stat.size - 1}/${stat.size}` : 'bytes */0' },
        body: this.progressStream(source, 0, stat.size, context.onProgress),
      })
    }
    if (response.status === 308) throw providerError('Google upload is incomplete.')
    const file = await response.json()
    await this.discard(uploadId)
    return { providerId: file.id, size: Number(file.size ?? stat.size), checksum: file.md5Checksum ? `md5:${file.md5Checksum}` : null, ...(file.headRevisionId ? { revisionId: file.headRevisionId } : {}) }
  }

  async read(providerId) {
    const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(providerId)}?alt=media`)
    return Buffer.from(await response.arrayBuffer())
  }

  async openRead(providerId) {
    const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(providerId)}?alt=media`)
    const contentLength = response.headers.get('content-length')
    const length = contentLength === null ? undefined : Number(contentLength)
    return { stream: Readable.fromWeb(response.body), size: Number.isFinite(length) ? length : undefined }
  }

  async listRevisions(providerId) {
    const params = new URLSearchParams({ fields: 'revisions(id,modifiedTime,size,md5Checksum,keepForever,published,originalFilename,mimeType),nextPageToken', pageSize: '100' })
    const body = await this.jsonRequest(`${DRIVE_API}/files/${encodeURIComponent(providerId)}/revisions?${params}`)
    return (body.revisions || []).map(revision => ({ id: revision.id, size: Number(revision.size || 0), checksum: revision.md5Checksum ? `md5:${revision.md5Checksum}` : null, modifiedTime: revision.modifiedTime, name: revision.originalFilename, mimeType: revision.mimeType }))
  }

  async openRevision(providerId, revisionId) {
    const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(providerId)}/revisions/${encodeURIComponent(revisionId)}?alt=media`)
    const contentLength = response.headers.get('content-length')
    return { stream: Readable.fromWeb(response.body), size: contentLength === null ? undefined : Number(contentLength) }
  }

  async restoreRevision(providerId, revisionId, context = {}) {
    const source = await this.openRevision(providerId, revisionId)
    const response = await this.request(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(providerId)}?uploadType=media&fields=id,size,md5Checksum,headRevisionId`, {
      method: 'PATCH', headers: { 'content-type': context.mimeType || 'application/octet-stream', ...(Number.isFinite(source.size) ? { 'content-length': String(source.size) } : {}) }, body: source.stream,
    })
    const file = await response.json()
    return { providerId: file.id || providerId, revisionId: file.headRevisionId || null, size: Number(file.size || source.size || 0), checksum: file.md5Checksum ? `md5:${file.md5Checksum}` : null }
  }

  async openThumbnail(providerId, context = {}) {
    // Proxy media through the service so provider URLs and OAuth tokens never reach clients.
    return this.openRead(providerId)
  }

  async delete(providerId) { await this.request(`${DRIVE_API}/files/${encodeURIComponent(providerId)}`, { method: 'DELETE' }) }
  async discard(uploadId) { await Promise.all([fs.rm(this.tempPath(uploadId), { force: true }), fs.rm(this.sessionPath(uploadId), { force: true })]) }
  async exists(providerId) { return Boolean(await this.jsonRequest(`${DRIVE_API}/files/${encodeURIComponent(providerId)}?fields=id&supportsAllDrives=false`, {}, true)) }
  async inspect(providerId) { const file = await this.jsonRequest(`${DRIVE_API}/files/${encodeURIComponent(providerId)}?fields=id,size,md5Checksum`); return { size: Number(file.size), checksum: file.md5Checksum ? `md5:${file.md5Checksum}` : null } }
  async list() {
    const ids = []
    let pageToken = ''
    do {
      const params = new URLSearchParams({ q: "trashed = false and appProperties has { key='hippy_kind' and value='file' }", spaces: 'drive', pageSize: '1000', fields: 'nextPageToken,files(id)' })
      if (pageToken) params.set('pageToken', pageToken)
      const page = await this.jsonRequest(`${DRIVE_API}/files?${params}`)
      ids.push(...(page.files || []).map(file => file.id)); pageToken = page.nextPageToken || ''
    } while (pageToken)
    return ids
  }
  async createSparse() { throw providerError('Synthetic sparse files are unavailable with Google Drive.', 'file_validation_failed', 422, false) }
}
