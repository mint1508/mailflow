import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryJobQueue } from '../src/job-queue.js'
import { JsonStore } from '../src/store.js'
import { createStorageProvider } from '../src/provider.js'
import { createJobHandlers } from '../src/jobs/handlers.js'
import { startFileAppFixture } from './helpers/app-fixture.js'

test('worker queue claims, completes, retries and exposes redacted operation status', async () => {
  const queue = new MemoryJobQueue(); await queue.init()
  const id = await queue.enqueue('maintenance', { ownerId: 'owner', payload: { provider_file_id: 'secret' } })
  const claimed = await queue.read('worker-1'); assert.equal(claimed.id, id); assert.equal(claimed.attempts, 1)
  await queue.retry(id, { code: 'temporary' }, 0, claimed); await queue.ack(claimed.streamId)
  const retried = await queue.read('worker-2'); assert.equal(retried.attempts, 2)
  await queue.complete(id, { purged: 1 }); await queue.ack(retried.streamId)
  const operation = await queue.getOperation(id)
  assert.deepEqual(operation.result, { purged: 1 }); assert.equal(operation.state, 'completed'); assert.equal('payload' in operation, false)
})

test('maintenance and reconcile handlers are idempotent and non-destructive', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-worker-test-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const config = { dataDir, providerType: 'fake-disk', trashRetentionDays: 30 }
  const store = new JsonStore(dataDir); await store.init(); const provider = createStorageProvider(config, store)
  store.state.nodes.push({ id: 'expired', file_user_id: 'u1', kind: 'file', state: 'trashed', trashed_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z', provider_file_id: null, size_bytes: 0 })
  store.state.uploads.push({ id: 'upload-1', file_user_id: 'u1', state: 'pending' }); store.state.reservations.push({ id: 'r1', upload_id: 'upload-1', file_user_id: 'u1', state: 'held', expires_at: '2000-01-01T00:00:00.000Z' })
  const handlers = createJobHandlers({ store, provider, config }); const job = { id: 'op-test', owner_id: 'admin' }
  assert.deepEqual(await handlers.maintenance(job), { purged: 1, expired_reservations: 1 })
  assert.deepEqual(await handlers.maintenance({ ...job, id: 'op-test-2' }), { purged: 0, expired_reservations: 0 })
  const result = await handlers.reconcile({ ...job, id: 'op-test-3' }); assert.equal(result.destructive_actions, 0)
})

test('maintenance stages provider deletion after metadata commit', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-worker-stage-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const store = new JsonStore(dataDir); await store.init()
  const deleted = []
  const provider = {
    async exists() { return true },
    async delete(id) { deleted.push(id) },
    async discard() {},
  }
  store.state.nodes.push({ id: 'expired-provider', file_user_id: 'u1', kind: 'file', state: 'trashed', trashed_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z', provider_file_id: 'provider-1', size_bytes: 3 })
  const originalSave = store.save.bind(store)
  store.save = async () => { throw new Error('metadata write failed') }
  const handlers = createJobHandlers({ store, provider, config: { trashRetentionDays: 30 } })
  await assert.rejects(() => handlers.maintenance({ id: 'op-save-failure', owner_id: 'admin' }), /metadata write failed/)
  assert.deepEqual(deleted, [], 'provider bytes must not be deleted before metadata commit')
  store.save = originalSave
  const result = await handlers.maintenance({ id: 'op-retry', owner_id: 'admin' })
  assert.deepEqual(result, { purged: 0, expired_reservations: 0 })
  assert.deepEqual(deleted, ['provider-1'])
  assert.equal(store.state.nodes[0].provider_file_id, null)
})

test('operation status is owner scoped and redacts queue payload', async t => {
  const { app, call } = await startFileAppFixture({}, t)
  const id = await app.jobQueue.enqueue('maintenance', { ownerId: 'fixture-user', payload: { provider_file_id: 'never-return' } })
  const own = await call('GET', `/api/files/operations/${id}`); assert.equal(own.status, 200); assert.equal(own.json.operation.id, id); assert.equal('payload' in own.json.operation, false)
  const other = await call('GET', `/api/files/operations/${id}`, undefined, { 'x-dev-user-id': 'other' }); assert.equal(other.status, 404)
})

test('scheduler lock admits one scheduler per lease and records success', async () => {
  const queue = new MemoryJobQueue()
  assert.equal(await queue.acquireLock('maintenance', 60_000), true)
  assert.equal(await queue.acquireLock('maintenance', 60_000), false)
  await queue.markScheduleSuccess('maintenance', '2026-01-01T00:00:00.000Z')
  assert.equal(await queue.scheduleStatus('maintenance'), '2026-01-01T00:00:00.000Z')
})

test('stale worker cannot complete after lease ownership changes', async () => {
  const queue = new MemoryJobQueue()
  const id = await queue.enqueue('maintenance')
  const first = await queue.read('worker-1', { leaseMs: 1 })
  await queue.retry(id, { code: 'expired' }, 0, first)
  const second = await queue.read('worker-2')
  assert.notEqual(first.lease_token, second.lease_token)
  assert.equal(await queue.complete(id, { stale: true }, first.lease_token), false)
  assert.equal((await queue.getOperation(id)).state, 'running')
  assert.equal(await queue.complete(id, { ok: true }, second.lease_token), true)
})
