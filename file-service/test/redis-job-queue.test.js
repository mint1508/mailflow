import test from 'node:test'
import assert from 'node:assert/strict'
import { RedisJobQueue } from '../src/job-queue.js'

const redisUrl = process.env.FILE_TEST_REDIS_URL || process.env.REDIS_URL

test('Redis queue atomically publishes metadata and delayed retries', { skip: !redisUrl }, async t => {
  const suffix = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const queue = new RedisJobQueue(redisUrl, { jobStream: `file-jobs:${suffix}`, jobGroup: `group:${suffix}`, jobDlq: `dlq:${suffix}` })
  await queue.init()
  t.after(async () => {
    await queue.client.del(queue.stream, queue.delayed, queue.dlq, queue.key(`op_${suffix}`))
    await queue.client.quit()
  })

  const id = await queue.enqueue('maintenance', { ownerId: 'test', payload: { n: 1 }, operationId: `op_${suffix}` })
  assert.equal((await queue.client.xLen(queue.stream)), 1)
  assert.equal((await queue.client.hGet(queue.key(id), 'state')), 'queued')
  assert.equal(await queue.enqueue('maintenance', { operationId: id }), id)
  assert.equal((await queue.client.xLen(queue.stream)), 1)

  const first = await queue.read('consumer', { blockMs: 1 })
  assert.equal(first.id, id)
  await queue.retry(id, { code: 'temporary' }, 120, first)
  assert.equal((await queue.client.xPending(queue.stream, queue.group)).pending, 0)
  assert.equal(await queue.client.xLen(queue.stream), 1)
  assert.equal(await queue.client.zCard(queue.delayed), 1)
  assert.equal(await queue.read('consumer', { blockMs: 1 }), null)
  await new Promise(resolve => setTimeout(resolve, 150))
  const second = await queue.read('consumer', { blockMs: 1 })
  assert.equal(second.id, id)
  assert.equal(await queue.client.zCard(queue.delayed), 0)
})

test('Redis lease heartbeat prevents concurrent reclaim and stale completion', { skip: !redisUrl }, async t => {
  const suffix = `lease-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const id = `op_${suffix}`
  const queue = new RedisJobQueue(redisUrl, { jobStream: `file-jobs:${suffix}`, jobGroup: `group:${suffix}`, jobDlq: `dlq:${suffix}` })
  await queue.init()
  t.after(async () => { await queue.client.del(queue.stream, queue.delayed, queue.dlq, queue.key(id)); await queue.client.quit() })

  await queue.enqueue('maintenance', { operationId: id })
  const first = await queue.read('worker-1', { blockMs: 1, leaseMs: 40 })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(await queue.renew(first, 80), true)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(await queue.read('worker-2', { blockMs: 1, leaseMs: 20 }), null)

  await new Promise(resolve => setTimeout(resolve, 90))
  const second = await queue.read('worker-2', { blockMs: 1, leaseMs: 40 })
  assert.equal(second.id, id)
  assert.equal(await queue.complete(id, { stale: true }, first.lease_token), false)
  assert.equal(await queue.complete(id, { ok: true }, second.lease_token), true)
})
