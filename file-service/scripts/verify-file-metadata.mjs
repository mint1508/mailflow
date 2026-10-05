import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { metadataDefinitions, projectTyped } from '../src/metadata/repository.js'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const output = option('--output', 'artifacts/file-pwa/f6/db-parity.json')
const requireZero = args.includes('--require-zero-diff')
const dbUrl = process.env.FILE_DB_URL
if (!dbUrl) throw new Error('FILE_DB_URL is required')
const pool = new Pool({ connectionString: dbUrl })
const normalize = value => value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? String(value) : value
const comparable = value => value instanceof Date ? value.toISOString() : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(normalize(value) ?? '')
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16)
const report = { schema_version: 1, generated_at: new Date().toISOString(), canonical: 'snapshot', contains_sensitive_data: false, tables: {}, differences: 0 }

try {
  for (const [collection, definition] of Object.entries(metadataDefinitions)) {
    const rows = (await pool.query(`SELECT * FROM ${definition.table}`)).rows
    let differences = 0; const sample_hashes = []
    for (const row of rows) {
      const projected = projectTyped(collection, row.record)
      const mismatch = definition.columns.some(column => comparable(projected[column]) !== comparable(row[column]))
      if (mismatch) { differences++; if (sample_hashes.length < 20) sample_hashes.push(digest(definition.key(row.record).join(':'))) }
    }
    report.tables[definition.table] = { snapshot_rows: rows.length, typed_rows: rows.length, differences, sample_id_hashes: sample_hashes }
    report.differences += differences
  }
  const nodeOrder = (await pool.query("SELECT id FROM file_nodes ORDER BY updated_at DESC NULLS LAST,id DESC")).rows.map(row => row.id)
  const snapshotNodeOrder = (await pool.query("SELECT id FROM file_nodes ORDER BY (record->>'updated_at')::timestamptz DESC NULLS LAST,id DESC")).rows.map(row => row.id)
  report.cursor_order_difference = nodeOrder.join('\u001f') === snapshotNodeOrder.join('\u001f') ? 0 : 1
  report.differences += report.cursor_order_difference
  report.status = report.differences ? 'difference' : 'zero-difference'
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (requireZero && report.differences) process.exitCode = 2
} finally { await pool.end() }
