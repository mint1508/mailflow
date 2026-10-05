import crypto from 'node:crypto'

const definitions = {
  users: { table: 'file_users', key: row => [row.id], columns: ['id','app_user_id','mailbox_id','source','status','quota_bytes','created_at','updated_at','revoked_at'] },
  nodes: { table: 'file_nodes', key: row => [row.id], columns: ['id','file_user_id','parent_id','kind','name','mime_type','provider_file_id','size_bytes','checksum','state','starred_at','created_at','updated_at','trashed_at','purged_at'] },
  uploads: { table: 'file_uploads', key: row => [row.id], columns: ['id','file_user_id','idempotency_key','state','expected_bytes','received_bytes','provider_file_id','provider_session_ref','last_error','created_at','updated_at'] },
  reservations: { table: 'file_reservations', key: row => [row.id], columns: ['id','file_user_id','upload_id','bytes_reserved','state','expires_at','created_at','committed_at'] },
  audits: { table: 'file_audits', key: row => [row.id], columns: ['id','created_at','actor_app_user_id','subject_file_user_id','file_node_id','action','result','request_id','source_ip','metadata_json'] },
  idempotency: { table: 'file_idempotency', key: row => [row.actor,row.key,row.operation], columns: ['actor','key','operation','created_at','status','response_json'] },
  revisions: { table: 'file_revisions', key: row => [row.id], columns: ['id','file_user_id','node_id','provider_revision_id','revision_number','name','mime_type','size_bytes','checksum','created_at','created_by'] },
}

const value = (row, column) => {
  if (column === 'file_node_id') return row.file_node_id || row.metadata?.node_id || null
  if (column === 'metadata_json') return row.metadata || {}
  if (column === 'response_json') return row.response || row.result || null
  return row[column] ?? null
}
const encoded = row => JSON.stringify(row)

const numericColumns = new Set(['quota_bytes', 'size_bytes', 'expected_bytes', 'received_bytes', 'bytes_reserved', 'status', 'revision_number'])
const normalizeTypedValue = (typed, snapshot, column) => {
  if (typed instanceof Date) return typed.toISOString()
  if (typeof typed === 'bigint') return typeof snapshot === 'number' ? Number(typed) : String(typed)
  if (typeof typed === 'string' && (typeof snapshot === 'number' || numericColumns.has(column)) && /^-?\d+$/.test(typed)) return Number(typed)
  return typed
}

export function hydrateTyped(collection, row) {
  const definition = definitions[collection]
  if (!definition) throw new Error(`Unknown metadata collection: ${collection}`)
  const hydrated = { ...(row.record || {}) }
  for (const column of definition.columns) {
    const typed = normalizeTypedValue(row[column], value(row.record || {}, column), column)
    if (column === 'metadata_json') hydrated.metadata = typed
    else if (column === 'response_json') {
      if ('result' in hydrated && !('response' in hydrated)) hydrated.result = typed
      else hydrated.response = typed
    } else hydrated[column] = typed
  }
  return hydrated
}

const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  return value
}
const stable = value => JSON.stringify(canonicalize(value))
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)

export function compareMetadataStates(snapshot, typed, sampleLimit = 20) {
  const collections = {}
  let differences = 0
  for (const [collection, definition] of Object.entries(definitions)) {
    const snapshotRows = new Map((snapshot[collection] || []).map(row => [definition.key(row).join('\u0000'), row]))
    const typedRows = new Map((typed[collection] || []).map(row => [definition.key(row).join('\u0000'), row]))
    const keys = new Set([...snapshotRows.keys(), ...typedRows.keys()])
    const sampleIdHashes = []
    let collectionDifferences = 0
    for (const key of keys) {
      if (stable(snapshotRows.get(key)) === stable(typedRows.get(key))) continue
      collectionDifferences++
      if (sampleIdHashes.length < sampleLimit) sampleIdHashes.push(digest(key))
    }
    collections[collection] = {
      snapshot_rows: snapshotRows.size,
      typed_rows: typedRows.size,
      differences: collectionDifferences,
      sample_id_hashes: sampleIdHashes,
    }
    differences += collectionDifferences
  }
  return { schema_version: 1, contains_sensitive_data: false, differences, collections }
}

export function projectTyped(collection, row) {
  const definition = definitions[collection]
  if (!definition) throw new Error(`Unknown metadata collection: ${collection}`)
  return Object.fromEntries(definition.columns.map(column => [column, value(row, column)]))
}

export class MetadataRepository {
  constructor(client) { this.client = client }

  async applyChanges(before, after) {
    for (const [collection, definition] of Object.entries(definitions)) {
      const previous = new Map((before[collection] || []).map(row => [definition.key(row).join('\u0000'), encoded(row)]))
      const current = new Map((after[collection] || []).map(row => [definition.key(row).join('\u0000'), row]))
      for (const row of current.values()) {
        const key = definition.key(row).join('\u0000')
        if (previous.get(key) !== encoded(row)) await this.upsert(collection, row)
      }
      for (const row of before[collection] || []) {
        if (!current.has(definition.key(row).join('\u0000'))) await this.remove(collection, row)
      }
    }
  }

  async upsert(collection, row) {
    const definition = definitions[collection]
    const columns = [...definition.columns, 'record']
    const values = [...definition.columns.map(column => value(row, column)), row]
    const conflict = definition.key(row).length === 1 ? 'id' : 'actor,key,operation'
    const updates = columns.filter(column => !conflict.split(',').includes(column)).map(column => `${column}=excluded.${column}`).join(',')
    await this.client.query(`INSERT INTO ${definition.table}(${columns.join(',')}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT(${conflict}) DO UPDATE SET ${updates}`, values)
  }

  async remove(collection, row) {
    const definition = definitions[collection]
    const keys = definition.key(row)
    const names = keys.length === 1 ? ['id'] : ['actor','key','operation']
    await this.client.query(`DELETE FROM ${definition.table} WHERE ${names.map((name, index) => `${name}=$${index + 1}`).join(' AND ')}`, keys)
  }
}

export const metadataDefinitions = definitions
