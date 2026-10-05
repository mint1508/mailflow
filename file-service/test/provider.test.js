import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JsonStore } from '../src/store.js'
import { createStorageProvider, storageProviderContract } from '../src/provider.js'
import { GoogleDriveAdapter } from '../src/google-drive.js'

test('fake disk satisfies the provider-neutral adapter contract', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-contract-')); const store = new JsonStore(dir); await store.init(); const provider = createStorageProvider({ providerType: 'fake-disk' }, store)
  for (const method of storageProviderContract) assert.equal(typeof provider[method], 'function', method)
  await provider.append('contract-upload', Buffer.from('ok')); const committed = await provider.commit('contract-upload'); assert.equal((await provider.read(committed.providerId)).toString(), 'ok'); assert.equal((await provider.inspect(committed.providerId)).size, 2); assert.ok((await provider.list()).includes(committed.providerId))
})

test('google drive adapter refreshes server token and completes a resumable upload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-provider-')); const store = new JsonStore(dir); await store.init()
  const calls = []; let uploaded = Buffer.alloc(0); const progress = []
  const json = (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200, headers: { 'content-type': 'application/json', ...init.headers } })
  const fetchImpl = async (input, options = {}) => {
    const url = String(input); calls.push({ url, options })
    if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'server-token', expires_in: 3600 })
    if (url.includes('upload/drive/v3/files?uploadType=resumable')) return json({}, { headers: { location: 'https://upload.example/session-1' } })
    if (url === 'https://upload.example/session-1') { const chunks = []; for await (const chunk of options.body) chunks.push(chunk); uploaded = Buffer.concat(chunks); return json({ id: 'drive-file-1', size: String(uploaded.length), md5Checksum: 'abc123' }) }
    if (url.includes('alt=media')) return new Response(uploaded, { headers: { 'content-length': String(uploaded.length) } })
    if (url.includes('/files/drive-file-1?fields=id,size')) return json({ id: 'drive-file-1', size: String(uploaded.length), md5Checksum: 'abc123' })
    if (options.method === 'POST' && !url.includes('upload/')) {
      const body = JSON.parse(options.body); return json({ id: body.appProperties.hippy_root ? 'root-folder' : 'user-folder' })
    }
    if (url.includes('/files?')) return json({ files: [] })
    throw new Error(`Unexpected URL: ${url}`)
  }
  const provider = new GoogleDriveAdapter({ googleClientId: 'client', googleClientSecret: 'secret', googleRefreshToken: 'refresh', googleRootFolderName: 'Hippy Files' }, store, fetchImpl)
  for (const method of storageProviderContract) assert.equal(typeof provider[method], 'function', method)
  await provider.append('upload-1', Buffer.from('hello drive'))
  const committed = await provider.commit('upload-1', { expectedBytes: 11, fileUserId: 'user-1', email: 'user@hippy.vn', name: 'hello.txt', mimeType: 'text/plain', onProgress: (sent, total) => progress.push([sent, total]) })
  assert.deepEqual(committed, { providerId: 'drive-file-1', size: 11, checksum: 'md5:abc123' })
  assert.equal((await provider.read('drive-file-1')).toString(), 'hello drive')
  const tokenCall = calls.find(call => call.url.includes('/token')); assert.match(String(tokenCall.options.body), /refresh_token=refresh/)
  const initiate = calls.find(call => call.url.includes('uploadType=resumable')); assert.equal(initiate.options.headers['x-upload-content-length'], '11')
  const upload = calls.find(call => call.url === 'https://upload.example/session-1'); assert.equal(upload.options.headers['content-range'], 'bytes 0-10/11')
  assert.deepEqual(progress.at(-1), [11, 11])
})

test('google drive adapter normalizes provider rate limits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-rate-limit-')); const store = new JsonStore(dir); await store.init()
  const fetchImpl = async input => String(input).includes('/token') ? new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }) : new Response('', { status: 429 })
  const provider = new GoogleDriveAdapter({ googleClientId: 'client', googleClientSecret: 'secret', googleRefreshToken: 'refresh' }, store, fetchImpl)
  await assert.rejects(() => provider.inspect('file-1'), error => error.code === 'file_provider_rate_limited' && error.retryable === true)
})

test('google drive adapter resumes a persisted partial upload session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-resume-')); const store = new JsonStore(dir); await store.init(); let transfer = 0; let resumed = Buffer.alloc(0)
  const json = (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200, headers: { 'content-type': 'application/json', ...init.headers } })
  const fetchImpl = async (input, options = {}) => {
    const url = String(input)
    if (url.includes('/token')) return json({ access_token: 'token' })
    if (url.includes('uploadType=resumable')) return json({}, { headers: { location: 'https://upload.example/resume' } })
    if (url === 'https://upload.example/resume' && !options.body) return new Response('', { status: 308, headers: { range: 'bytes=0-3' } })
    if (url === 'https://upload.example/resume') {
      const chunks = []; for await (const chunk of options.body) chunks.push(chunk); transfer++
      if (transfer === 1) return new Response('', { status: 308, headers: { range: 'bytes=0-3' } })
      resumed = Buffer.concat(chunks); return json({ id: 'resumed-file', size: '8' })
    }
    if (options.method === 'POST') return json({ id: 'user-folder' })
    if (url.includes('/files?')) return json({ files: [] })
    throw new Error(`Unexpected URL: ${url}`)
  }
  const provider = new GoogleDriveAdapter({ googleClientId: 'client', googleClientSecret: 'secret', googleRefreshToken: 'refresh', googleRootFolderId: 'root' }, store, fetchImpl)
  await provider.append('resume-upload', Buffer.from('abcdefgh'))
  const context = { expectedBytes: 8, fileUserId: 'user-1', email: 'user@hippy.vn', name: 'resume.bin', mimeType: 'application/octet-stream' }
  await assert.rejects(() => provider.commit('resume-upload', context), error => error.retryable === true)
  const committed = await provider.commit('resume-upload', context)
  assert.equal(committed.providerId, 'resumed-file'); assert.equal(resumed.toString(), 'efgh')
})
