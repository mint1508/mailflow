import fs from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { compareMetadataStates, hydrateTyped, MetadataRepository } from './metadata/repository.js'

const blank = () => ({ version: 1, users: [], nodes: [], uploads: [], reservations: [], audits: [], idempotency: [], revisions: [], provider: { available: true }, created_at: new Date().toISOString() })

export class PostgresStore {
  constructor(dataDir, connectionString, options = {}) {
    this.dataDir = dataDir; this.blobs = path.join(dataDir, 'blobs'); this.tmp = path.join(dataDir, 'tmp')
    this.pool = new Pool({ connectionString }); this.state = blank(); this.metadataWriteMode = options.metadataWriteMode || 'snapshot'; this.metadataReadMode = options.metadataReadMode || 'snapshot'; this.metadataDivergenceReporter = options.metadataDivergenceReporter || (report => console.warn('file_metadata_shadow_divergence', report))
  }
  async init() {
    await fs.mkdir(this.blobs, { recursive: true }); await fs.mkdir(this.tmp, { recursive: true })
    for (const migration of ['0001_file_storage.sql', '0002_file_metadata_expand.sql', '0003_file_metadata_backfill.sql', '0004_file_revisions.sql', '0005_file_user_source.sql']) {
      await this.pool.query(await fs.readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
    }
    this.state = await this.load(this.pool)
    if (!(await this.pool.query("SELECT 1 FROM file_store_meta WHERE key='state'")).rowCount) await this.save(this.pool, this.state)
  }
  async load(client) {
    // A transaction client is single-flight; keep reads sequential so pg does
    // not interleave queries and weaken the advisory serialization lock.
    const meta = await client.query("SELECT value FROM file_store_meta WHERE key='state'")
    const users = await client.query('SELECT * FROM file_users')
    const nodes = await client.query('SELECT * FROM file_nodes')
    const uploads = await client.query('SELECT * FROM file_uploads')
    const reservations = await client.query('SELECT * FROM file_reservations')
    const audits = await client.query('SELECT * FROM file_audits ORDER BY created_at')
    const idempotency = await client.query('SELECT * FROM file_idempotency')
    const revisions = (await client.query('SELECT * FROM file_revisions ORDER BY created_at, id')) || { rows: [] }
    const base = meta.rows[0]?.value || blank()
    const rows = { users: users.rows, nodes: nodes.rows, uploads: uploads.rows, reservations: reservations.rows, audits: audits.rows, idempotency: idempotency.rows, revisions: revisions.rows }
    const snapshot = { ...base, ...Object.fromEntries(Object.entries(rows).map(([collection, entries]) => [collection, entries.map(row => row.record)])) }
    if (this.metadataReadMode === 'snapshot') return snapshot
    const typed = { ...base, ...Object.fromEntries(Object.entries(rows).map(([collection, entries]) => [collection, entries.map(row => hydrateTyped(collection, row))])) }
    if (this.metadataReadMode === 'typed') return typed
    const report = compareMetadataStates(snapshot, typed)
    if (report.differences) {
      try { this.metadataDivergenceReporter(report) } catch (error) { console.warn('file_metadata_shadow_report_failed', { message: error?.message || 'unknown' }) }
    }
    return snapshot
  }
  async save(client, state) {
    await client.query("INSERT INTO file_store_meta(key,value) VALUES('state',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [{ version: state.version, provider: state.provider, created_at: state.created_at }])
    for (const table of ['file_users', 'file_nodes', 'file_uploads', 'file_reservations', 'file_audits', 'file_idempotency', 'file_revisions']) await client.query(`DELETE FROM ${table}`)
    for (const row of state.users) await client.query('INSERT INTO file_users(id,record) VALUES($1,$2)', [row.id, row])
    for (const row of state.nodes) await client.query('INSERT INTO file_nodes(id,file_user_id,parent_id,record) VALUES($1,$2,$3,$4)', [row.id, row.file_user_id, row.parent_id, row])
    for (const row of state.uploads) await client.query('INSERT INTO file_uploads(id,file_user_id,record) VALUES($1,$2,$3)', [row.id, row.file_user_id, row])
    for (const row of state.reservations) await client.query('INSERT INTO file_reservations(id,file_user_id,record) VALUES($1,$2,$3)', [row.id, row.file_user_id, row])
    for (const row of state.audits) await client.query('INSERT INTO file_audits(id,created_at,record) VALUES($1,$2,$3)', [row.id, row.created_at, row])
    for (const row of state.idempotency) await client.query('INSERT INTO file_idempotency(actor,key,operation,record) VALUES($1,$2,$3,$4)', [row.actor, row.key, row.operation, row])
    for (const row of state.revisions) await client.query('INSERT INTO file_revisions(id,file_user_id,node_id,provider_revision_id,record) VALUES($1,$2,$3,$4,$5)', [row.id, row.file_user_id, row.node_id, row.provider_revision_id, row])
  }
  async transaction(fn) {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(6847331)'); const state = await this.load(client); const before = structuredClone(state); const result = await fn(state); if (this.metadataWriteMode === 'dual') { await client.query("INSERT INTO file_store_meta(key,value) VALUES('state',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [{ version: state.version, provider: state.provider, created_at: state.created_at }]); await new MetadataRepository(client).applyChanges(before, state) } else await this.save(client, state); await client.query('COMMIT'); this.state = state; return result }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
  }
}
