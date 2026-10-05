import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const overflow = () => Object.assign(new Error('Upload exceeds declared size.'), { code: 'file_validation_failed', status: 422 })

export async function appendStreamToFile(file, readable, maxBytes, exact = false) {
  let originalSize = 0
  try { originalSize = (await fs.stat(file)).size } catch (error) { if (error.code !== 'ENOENT') throw error }
  let written = 0
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      written += chunk.length
      callback(written > maxBytes ? overflow() : null, chunk)
    },
  })
  try {
    await pipeline(readable, meter, createWriteStream(file, { flags: 'a', mode: 0o600 }))
    if (exact && written !== maxBytes) throw Object.assign(new Error('Content-Range length does not match body.'), { code: 'file_validation_failed', status: 422 })
    return written
  } catch (error) {
    if (originalSize === 0) await fs.rm(file, { force: true })
    else await fs.truncate(file, originalSize)
    throw error
  }
}

export class FakeDriveAdapter {
  constructor(store) { this.store = store; this.transientFailures = 0 }
  assertAvailable() {
    if (this.transientFailures > 0) { this.transientFailures--; throw Object.assign(new Error('Transient provider failure.'), { code: 'file_provider_unavailable', status: 503, retryable: true }) }
    if (!this.store.state.provider.available) throw Object.assign(new Error('Storage provider unavailable.'), { code: 'file_provider_unavailable', status: 503, retryable: true })
  }
  tempPath(uploadId) { return path.join(this.store.tmp, uploadId) }
  blobPath(providerId) { return path.join(this.store.blobs, providerId) }
  revisionDir(providerId) { return path.join(this.store.blobs, '.revisions', providerId) }
  revisionPath(providerId, revisionId) { return path.join(this.revisionDir(providerId), revisionId) }
  async append(uploadId, buffer) { this.assertAvailable(); await fs.appendFile(this.tempPath(uploadId), buffer, { mode: 0o600 }) }
  async appendStream(uploadId, readable, maxBytes, exact = false) { this.assertAvailable(); return appendStreamToFile(this.tempPath(uploadId), readable, maxBytes, exact) }
  async commit(uploadId, context = {}) {
    this.assertAvailable()
    const providerId = context.targetProviderId || crypto.randomUUID()
    const source = this.tempPath(uploadId)
    let data
    try { data = await fs.readFile(source) } catch (error) { if (error.code !== 'ENOENT') throw error; data = Buffer.alloc(0); await fs.writeFile(source, data, { mode: 0o600 }) }
    const checksum = crypto.createHash('sha256').update(data).digest('hex')
    if (context.targetProviderId) {
      try {
        const previous = await fs.readFile(this.blobPath(providerId))
        const previousRevisionId = `rev_${crypto.randomUUID()}`
        await fs.mkdir(this.revisionDir(providerId), { recursive: true })
        await fs.writeFile(this.revisionPath(providerId, previousRevisionId), previous, { mode: 0o600 })
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await fs.rm(this.blobPath(providerId), { force: true })
    }
    await fs.rename(source, this.blobPath(providerId))
    await fs.mkdir(this.revisionDir(providerId), { recursive: true })
    const revisionId = `rev_${crypto.randomUUID()}`
    await fs.copyFile(this.blobPath(providerId), this.revisionPath(providerId, revisionId))
    return { providerId, size: data.length, checksum, revisionId }
  }
  async read(providerId) { this.assertAvailable(); return fs.readFile(this.blobPath(providerId)) }
  async openRead(providerId) {
    this.assertAvailable()
    const { createReadStream } = await import('node:fs')
    const info = await this.inspect(providerId)
    return { stream: createReadStream(this.blobPath(providerId)), size: info.size }
  }
  async delete(providerId) { await fs.rm(this.blobPath(providerId), { force: true }) }
  async discard(uploadId) { await fs.rm(this.tempPath(uploadId), { force: true }) }
  async exists(providerId) { try { await fs.access(this.blobPath(providerId)); return true } catch { return false } }
  async inspect(providerId) { const stat = await fs.stat(this.blobPath(providerId)); return { size: stat.size } }
  async listRevisions(providerId) {
    let names
    try { names = await fs.readdir(this.revisionDir(providerId)) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const output = []
    for (const id of names.filter(name => !name.startsWith('.'))) {
      const stat = await fs.stat(this.revisionPath(providerId, id)); output.push({ id, size: stat.size, modifiedTime: stat.mtime.toISOString() })
    }
    return output.sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime) || a.id.localeCompare(b.id))
  }
  async openRevision(providerId, revisionId) {
    this.assertAvailable()
    const info = await fs.stat(this.revisionPath(providerId, revisionId))
    const { createReadStream } = await import('node:fs')
    return { stream: createReadStream(this.revisionPath(providerId, revisionId)), size: info.size }
  }
  async restoreRevision(providerId, revisionId, context = {}) {
    this.assertAvailable()
    const source = this.revisionPath(providerId, revisionId)
    const data = await fs.readFile(source)
    const current = await fs.readFile(this.blobPath(providerId))
    const currentRevisionId = `rev_${crypto.randomUUID()}`
    const restoredRevisionId = `rev_${crypto.randomUUID()}`
    await fs.mkdir(this.revisionDir(providerId), { recursive: true })
    await fs.writeFile(this.revisionPath(providerId, currentRevisionId), current, { mode: 0o600 })
    await fs.writeFile(this.blobPath(providerId), data, { mode: 0o600 })
    await fs.copyFile(this.blobPath(providerId), this.revisionPath(providerId, restoredRevisionId))
    return { providerId, revisionId: restoredRevisionId, size: data.length, checksum: crypto.createHash('sha256').update(data).digest('hex') }
  }
  async openThumbnail(providerId, context = {}) {
    return this.openRead(providerId)
  }
  async list() { return (await fs.readdir(this.store.blobs)).filter(name => !name.startsWith('.')) }
  async createSparse(size) { this.assertAvailable(); const providerId = crypto.randomUUID(); const handle = await fs.open(this.blobPath(providerId), 'w', 0o600); await handle.truncate(size); await handle.close(); return { providerId, size, checksum: `sparse:${size}` } }
}
