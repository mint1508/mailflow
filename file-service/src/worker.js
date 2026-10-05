import os from 'node:os'
import { loadConfig } from './config.js'
import { createStore } from './store-factory.js'
import { createStorageProvider } from './provider.js'
import { createJobQueue } from './job-queue.js'
import { createJobHandlers } from './jobs/handlers.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function createWorker(config = loadConfig()) {
  const store = createStore(config); await store.init()
  const provider = createStorageProvider(config, store)
  const queue = createJobQueue(config); await queue.init()
  const handlers = createJobHandlers({ store, provider, config })
  const consumer = `${os.hostname()}:${process.pid}`
  let stopping = false
  const heartbeatMs = Math.max(1_000, config.workerHeartbeatMs || 10_000)
  const heartbeat = async () => {
    if (typeof queue.heartbeat === 'function') await queue.heartbeat(consumer, heartbeatMs * 3)
  }
  await heartbeat()
  const heartbeatTimer = setInterval(() => heartbeat().catch(error => console.warn('file worker heartbeat failed:', error?.message)), heartbeatMs)
  heartbeatTimer.unref?.()

  async function schedule(type, intervalMs) {
    const last = await queue.scheduleStatus(type)
    if (last && Date.now() - Date.parse(last) < intervalMs) return false
    if (!await queue.acquireLock(type, Math.min(intervalMs, config.schedulerLockMs))) return false
    await queue.enqueue(type, { ownerId: 'file-scheduler', operationId: `op_schedule_${type}_${Math.floor(Date.now() / intervalMs)}` })
    return true
  }

  async function tick() {
    await schedule('maintenance', config.maintenanceIntervalMs)
    await schedule('reconcile', config.reconcileIntervalMs)
    const job = await queue.read(consumer, { blockMs: config.workerBlockMs, leaseMs: config.workerLeaseMs })
    if (!job) return false
    const handler = handlers[job.type]
    if (!handler) { if (await queue.fail(job.id, { code: 'file_job_type_unknown' }, job)) await queue.ack(job.streamId); return true }
    const heartbeatMs = Math.max(250, Math.floor(config.workerLeaseMs / 3))
    const heartbeat = setInterval(() => queue.renew(job, config.workerLeaseMs).catch(error => console.warn('file worker lease renewal failed:', error?.message)), heartbeatMs)
    try {
      const result = await handler(job)
      clearInterval(heartbeat)
      if (await queue.complete(job.id, result, job.lease_token)) { await queue.markScheduleSuccess(job.type); await queue.ack(job.streamId) }
    } catch (error) {
      clearInterval(heartbeat)
      const changed = job.attempts >= config.workerMaxAttempts || error.retryable === false
        ? await queue.fail(job.id, error, job)
        : await queue.retry(job.id, error, config.workerRetryBaseMs * 2 ** Math.max(0, job.attempts - 1), job)
      if (changed) await queue.ack(job.streamId)
    }
    return true
  }

  async function run() { while (!stopping) { try { await tick() } catch (error) { console.error('file worker tick failed:', error?.code || error?.message); await sleep(1000) } } }
  async function stop() { stopping = true; clearInterval(heartbeatTimer); await queue.close() }
  return { queue, store, provider, handlers, tick, run, stop }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = await createWorker()
  const shutdown = async signal => { console.log(`file-worker received ${signal}`); await worker.stop(); process.exit(0) }
  process.once('SIGTERM', () => shutdown('SIGTERM')); process.once('SIGINT', () => shutdown('SIGINT'))
  await worker.run()
}
