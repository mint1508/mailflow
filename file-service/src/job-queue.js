import crypto from 'node:crypto'
import { createClient } from 'redis'

const now = () => new Date().toISOString()
const safeError = error => error?.code || 'file_operation_failed'
const encode = value => JSON.stringify(value || {})
const decode = value => { try { return JSON.parse(value || '{}') } catch { return {} } }

export class MemoryJobQueue {
  constructor() { this.jobs = new Map(); this.ready = []; this.locks = new Map(); this.success = new Map() }
  async init() {}
  async close() {}
  async enqueue(type, { ownerId = '', payload = {}, operationId } = {}) { const id = operationId || `op_${crypto.randomUUID()}`; if (this.jobs.has(id)) return id; const stamp = now(); this.jobs.set(id, { id, type, owner_id: ownerId, state: 'queued', attempts: 0, payload, created_at: stamp, updated_at: stamp, next_retry_at: null }); this.ready.push(id); return id }
  async start(type) { const id = `op_${crypto.randomUUID()}`; const stamp = now(); this.jobs.set(id, { id, type, owner_id: '', state: 'running', attempts: 0, payload: {}, created_at: stamp, updated_at: stamp }); return id }
  async attempt(id) { const job = this.jobs.get(id); if (job) { job.attempts++; job.updated_at = now() } }
  async complete(id, result = {}, leaseToken) { const job = this.jobs.get(id); if (!job || (leaseToken && job.lease_token !== leaseToken)) return false; Object.assign(job, { state: 'completed', result, updated_at: now(), completed_at: now(), error: undefined, lease_token: '' }); return true }
  async fail(id, error, entry = {}) { const job = this.jobs.get(id); if (!job || (entry.lease_token && job.lease_token !== entry.lease_token)) return false; Object.assign(job, { state: 'dead_letter', error: safeError(error), updated_at: now(), failed_at: now(), lease_token: '' }); return true }
  async retry(id, error, delayMs = 0, entry = {}) { const job = this.jobs.get(id); if (!job || (entry.lease_token && job.lease_token !== entry.lease_token)) return false; job.state = 'queued'; job.error = safeError(error); job.next_retry_at = new Date(Date.now() + delayMs).toISOString(); job.updated_at = now(); job.lease_token = ''; this.ready.push(id); return true }
  async renew(entry, leaseMs = 60_000) { const job = this.jobs.get(entry.id); if (!job || job.lease_token !== entry.lease_token || job.state !== 'running') return false; job.lease_until = new Date(Date.now() + leaseMs).toISOString(); job.updated_at = now(); return true }
  async getOperation(id) { const job = this.jobs.get(id); return job ? publicOperation(job) : null }
  async read(consumer, { leaseMs = 60_000 } = {}) { while (this.ready.length) { const id = this.ready.shift(); const job = this.jobs.get(id); if (!job || job.state !== 'queued') continue; if (job.next_retry_at && Date.parse(job.next_retry_at) > Date.now()) { this.ready.push(id); return null }; job.state = 'running'; job.attempts++; job.updated_at = now(); job.lease_token = crypto.randomUUID(); job.lease_owner = consumer || ''; job.lease_until = new Date(Date.now() + leaseMs).toISOString(); return { streamId: id, ...job } }; return null }
  async ack() {}
  async stats() { const values = [...this.jobs.values()]; const active = values.filter(job => ['queued', 'running'].includes(job.state)); const oldest = active.reduce((value, job) => Math.min(value, Date.parse(job.created_at)), Date.now()); return { depth: active.length, pending: values.filter(job => job.state === 'running').length, oldest_pending_seconds: active.length ? Math.max(0, Math.floor((Date.now() - oldest) / 1000)) : 0, retries: values.reduce((sum, job) => sum + Math.max(0, job.attempts - 1), 0), dead_letter: values.filter(job => job.state === 'dead_letter').length, durability: 'memory' } }
  async acquireLock(name, ttlMs) { const expires = this.locks.get(name) || 0; if (expires > Date.now()) return false; this.locks.set(name, Date.now() + ttlMs); return true }
  async markScheduleSuccess(name, at = now()) { this.success.set(name, at) }
  async scheduleStatus(name) { return this.success.get(name) || null }
  async heartbeat() {}
  async health() { return { available: true, durable: false, mode: 'memory', worker_ready: true } }
}

export class RedisJobQueue {
  constructor(url, config = {}) { this.stream = config.jobStream || 'file-jobs:v1'; this.group = config.jobGroup || 'file-workers:v1'; this.dlq = config.jobDlq || 'file-jobs:dlq:v1'; this.delayed = config.jobDelayed || `${this.stream}:delayed`; this.workerHeartbeatKey = config.workerHeartbeatKey || 'file-worker:heartbeat'; this.client = createClient({ url }); this.client.on('error', error => console.warn('file queue Redis error:', error.message)) }
  async init() { if (!this.client.isOpen) await this.client.connect(); try { await this.client.xGroupCreate(this.stream, this.group, '0', { MKSTREAM: true }) } catch (error) { if (!String(error.message).includes('BUSYGROUP')) throw error } }
  async close() { if (this.client.isOpen) await this.client.quit() }
  key(id) { return `file-operation:${id}` }
  async enqueue(type, { ownerId = '', payload = {}, operationId } = {}) { const id = operationId || `op_${crypto.randomUUID()}`; const stamp = now(); await this.client.eval(ENQUEUE_SCRIPT, { keys: [this.key(id), this.stream], arguments: [id, type, ownerId, encode(payload), stamp] }); return id }
  async start(type) { const id = `op_${crypto.randomUUID()}`; const stamp = now(); await this.client.hSet(this.key(id), { id, type, owner_id: '', state: 'running', attempts: '0', payload: '{}', created_at: stamp, updated_at: stamp, next_retry_at: '' }); return id }
  async attempt(id) { await this.client.hIncrBy(this.key(id), 'attempts', 1); await this.client.hSet(this.key(id), { updated_at: now() }) }
  async complete(id, result = {}, leaseToken) { return Number(await this.client.eval(COMPLETE_SCRIPT, { keys: [this.key(id)], arguments: [leaseToken || '', encode(result), now()] })) === 1 }
  async fail(id, error, entry = {}) { const stamp = now(); const code = safeError(error); const owned = Number(await this.client.eval(FAIL_SCRIPT, { keys: [this.key(id)], arguments: [entry.lease_token || '', code, stamp] })) === 1; if (owned) await this.client.xAdd(this.dlq, '*', { version: '1', operation_id: id, type: entry.type || '', error: code, failed_at: stamp }); return owned }
  async retry(id, error, delayMs = 0, entry = {}) { const currentTime = Date.now(); const dueAt = currentTime + Math.max(0, delayMs); const retryAt = new Date(dueAt).toISOString(); return Number(await this.client.eval(RETRY_SCRIPT, { keys: [this.key(id), this.stream, this.delayed], arguments: [id, safeError(error), retryAt, now(), String(dueAt), entry.type || '', entry.owner_id || '', encode(entry.payload), String(currentTime), this.group, entry.streamId || '', entry.lease_token || ''] })) === 1 }
  async renew(entry, leaseMs = 60_000) { return Number(await this.client.eval(RENEW_SCRIPT, { keys: [this.key(entry.id), this.stream], arguments: [entry.lease_token || '', new Date(Date.now() + leaseMs).toISOString(), now(), this.group, entry.lease_owner || '', entry.streamId || ''] })) === 1 }
  async getOperation(id) { const value = await this.client.hGetAll(this.key(id)); if (!value.id) return null; return publicOperation({ ...value, attempts: Number(value.attempts || 0), result: decode(value.result) }) }
  async parseEntry(message, consumer, leaseMs = 60_000) { const data = message.message; const operation = await this.client.hGetAll(this.key(data.operation_id)); if (!operation.id || ['completed', 'dead_letter'].includes(operation.state)) { await this.ack(message.id); return null }; if (operation.state === 'running' && operation.lease_token && Date.parse(operation.lease_until) > Date.now()) { if (operation.lease_owner) await this.client.xClaim(this.stream, this.group, operation.lease_owner, 0, [message.id], { JUSTID: true }); return null }; const retryAt = data.next_retry_at || operation.next_retry_at; if (retryAt && Date.parse(retryAt) > Date.now()) { await this.client.multi().zAdd(this.delayed, { score: Date.parse(retryAt), value: operation.id }).xAck(this.stream, this.group, message.id).exec(); return null }; const token = crypto.randomUUID(); const attempts = await this.client.hIncrBy(this.key(operation.id), 'attempts', 1); await this.client.hSet(this.key(operation.id), { state: 'running', updated_at: now(), lease_token: token, lease_owner: consumer || '', lease_until: new Date(Date.now() + leaseMs).toISOString() }); return { streamId: message.id, id: operation.id, type: data.type || operation.type, owner_id: operation.owner_id, payload: decode(data.payload || operation.payload), attempts, lease_token: token, lease_owner: consumer || '' } }
  async promoteDelayed(limit = 100) { return Number(await this.client.eval(PROMOTE_DELAYED_SCRIPT, { keys: [this.delayed, this.stream], arguments: [String(Date.now()), String(limit)] })) }
  async read(consumer, { blockMs = 1000, leaseMs = 60_000 } = {}) { await this.promoteDelayed(); const claimed = await this.client.xAutoClaim(this.stream, this.group, consumer, leaseMs, '0-0', { COUNT: 1 }); if (claimed.messages?.length) return this.parseEntry(claimed.messages[0], consumer, leaseMs); const rows = await this.client.xReadGroup(this.group, consumer, [{ key: this.stream, id: '>' }], { COUNT: 1, BLOCK: blockMs }); return rows?.[0]?.messages?.[0] ? this.parseEntry(rows[0].messages[0], consumer, leaseMs) : null }
  async ack(streamId) { if (streamId) await this.client.xAck(this.stream, this.group, streamId) }
  async stats() { const deadLetter = await this.client.xLen(this.dlq); let pending = 0; let oldest = 0; let depth = 0; try { const info = await this.client.xPending(this.stream, this.group); pending = Number(info.pending || 0); oldest = info.firstId ? Math.max(0, Math.floor((Date.now() - Number(info.firstId.split('-')[0])) / 1000)) : 0; const groups = await this.client.xInfoGroups(this.stream); depth = Number(groups.find(item => item.name === this.group)?.lag || 0) } catch {}; return { depth, pending, oldest_pending_seconds: oldest, retries: 0, dead_letter: deadLetter, durability: 'aof' } }
  async acquireLock(name, ttlMs) { return (await this.client.set(`file-scheduler:lock:${name}`, crypto.randomUUID(), { NX: true, PX: ttlMs })) === 'OK' }
  async markScheduleSuccess(name, at = now()) { await this.client.set(`file-scheduler:last-success:${name}`, at) }
  async scheduleStatus(name) { return this.client.get(`file-scheduler:last-success:${name}`) }
  async heartbeat(consumer, ttlMs = 30_000) { if (!this.client.isOpen) return false; await this.client.set(this.workerHeartbeatKey, consumer || 'unknown', { EX: Math.max(5, Math.ceil(ttlMs / 1000)) }); return true }
  async health() {
    try {
      const config = await this.client.configGet('append*')
      const durable = config.appendonly === 'yes' && config.appendfsync === 'everysec'
      const workerReady = Boolean(await this.client.get(this.workerHeartbeatKey))
      return { available: true, durable, mode: durable ? 'aof-everysec' : 'unsafe', worker_ready: workerReady }
    } catch { return { available: false, durable: false, mode: 'unavailable', worker_ready: false } }
  }
}

const ENQUEUE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'type', ARGV[2], 'owner_id', ARGV[3], 'state', 'queued', 'attempts', '0', 'payload', ARGV[4], 'created_at', ARGV[5], 'updated_at', ARGV[5], 'next_retry_at', '')
redis.call('XADD', KEYS[2], '*', 'version', '1', 'operation_id', ARGV[1], 'type', ARGV[2], 'owner_id', ARGV[3], 'payload', ARGV[4])
return 1`

const RETRY_SCRIPT = `
if (redis.call('HGET', KEYS[1], 'lease_token') or '') ~= ARGV[12] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'queued', 'error', ARGV[2], 'next_retry_at', ARGV[3], 'updated_at', ARGV[4], 'type', ARGV[6], 'owner_id', ARGV[7], 'payload', ARGV[8])
redis.call('HDEL', KEYS[1], 'lease_token', 'lease_owner', 'lease_until')
if tonumber(ARGV[5]) > tonumber(ARGV[9]) then
  redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
else
  redis.call('XADD', KEYS[2], '*', 'version', '1', 'operation_id', ARGV[1], 'type', ARGV[6], 'owner_id', ARGV[7], 'payload', ARGV[8])
end
if ARGV[11] ~= '' then redis.call('XACK', KEYS[2], ARGV[10], ARGV[11]) end
return 1`

const COMPLETE_SCRIPT = `
if (redis.call('HGET', KEYS[1], 'lease_token') or '') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'completed', 'result', ARGV[2], 'updated_at', ARGV[3], 'completed_at', ARGV[3], 'error', '', 'next_retry_at', '')
redis.call('HDEL', KEYS[1], 'lease_token', 'lease_owner', 'lease_until')
return 1`

const FAIL_SCRIPT = `
if (redis.call('HGET', KEYS[1], 'lease_token') or '') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'state', 'dead_letter', 'error', ARGV[2], 'updated_at', ARGV[3], 'failed_at', ARGV[3])
redis.call('HDEL', KEYS[1], 'lease_token', 'lease_owner', 'lease_until')
return 1`

const RENEW_SCRIPT = `
if (redis.call('HGET', KEYS[1], 'lease_token') or '') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'state') ~= 'running' then return 0 end
redis.call('HSET', KEYS[1], 'lease_until', ARGV[2], 'updated_at', ARGV[3])
if ARGV[6] ~= '' then redis.call('XCLAIM', KEYS[2], ARGV[4], ARGV[5], 0, ARGV[6], 'JUSTID') end
return 1`

const PROMOTE_DELAYED_SCRIPT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local promoted = 0
for _, id in ipairs(ids) do
  local key = 'file-operation:' .. id
  if redis.call('HGET', key, 'state') == 'queued' then
    redis.call('XADD', KEYS[2], '*', 'version', '1', 'operation_id', id, 'type', redis.call('HGET', key, 'type') or '', 'owner_id', redis.call('HGET', key, 'owner_id') or '', 'payload', redis.call('HGET', key, 'payload') or '{}')
    promoted = promoted + 1
  end
  redis.call('ZREM', KEYS[1], id)
end
return promoted`

function publicOperation(job) { return { id: job.id, type: job.type, state: job.state, attempts: Number(job.attempts || 0), created_at: job.created_at, updated_at: job.updated_at, completed_at: job.completed_at || null, next_retry_at: job.next_retry_at || null, error: job.error || null, result: job.result && Object.keys(job.result).length ? job.result : undefined, owner_id: job.owner_id || '' } }
export function createJobQueue(config) { return config.redisUrl ? new RedisJobQueue(config.redisUrl, config) : new MemoryJobQueue(config) }
