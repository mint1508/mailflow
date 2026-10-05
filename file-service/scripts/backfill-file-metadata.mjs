import crypto from 'node:crypto'
import { Pool } from 'pg'
import { MetadataRepository } from '../src/metadata/repository.js'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const batchSize = Math.max(1, Math.min(5000, Number(option('--batch-size', 250))))
const dryRun = args.includes('--dry-run')
const resume = args.includes('--resume')
const expectNoop = args.includes('--expect-noop')
const dbUrl = process.env.FILE_DB_URL
if (!dbUrl) throw new Error('FILE_DB_URL is required')

const specs = [
  ['users','file_users',"id"], ['nodes','file_nodes',"id"], ['uploads','file_uploads',"id"],
  ['reservations','file_reservations',"id"], ['audits','file_audits',"id"],
  ['idempotency','file_idempotency',"actor || chr(31) || key || chr(31) || operation"],
]
const pool = new Pool({ connectionString: dbUrl })
const runId = crypto.randomUUID()
const report = { schema_version: 1, run_id: runId, dry_run: dryRun, batch_size: batchSize, tables: {}, changed: 0 }

try {
  await pool.query(`INSERT INTO file_metadata_backfill_runs(id,dry_run,batch_size) VALUES($1,$2,$3)`, [runId, dryRun, batchSize])
  for (const [collection, table, cursorExpression] of specs) {
    let lastId = ''
    if (resume) lastId = (await pool.query('SELECT last_id FROM file_metadata_migration_checkpoint WHERE table_name=$1', [table])).rows[0]?.last_id || ''
    let processed = 0
    while (true) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const rows = (await client.query(`SELECT record, ${cursorExpression} AS cursor_id FROM ${table} WHERE ${cursorExpression} > $1 ORDER BY ${cursorExpression} LIMIT $2 FOR UPDATE`, [lastId, batchSize])).rows
        if (!rows.length) { await client.query('ROLLBACK'); break }
        const repository = new MetadataRepository(client)
        for (const item of rows) {
          if (!item.record || typeof item.record !== 'object') throw new Error(`Invalid JSON record in ${table}`)
          if (!dryRun) await repository.upsert(collection, item.record)
          lastId = item.cursor_id; processed++; report.changed++
        }
        if (!dryRun) await client.query(`INSERT INTO file_metadata_migration_checkpoint(table_name,last_id,processed,updated_at,last_error) VALUES($1,$2,$3,now(),NULL) ON CONFLICT(table_name) DO UPDATE SET last_id=excluded.last_id,processed=file_metadata_migration_checkpoint.processed + excluded.processed,updated_at=now(),last_error=NULL`, [table,lastId,rows.length])
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        await pool.query(`INSERT INTO file_metadata_migration_checkpoint(table_name,last_id,last_error) VALUES($1,$2,$3) ON CONFLICT(table_name) DO UPDATE SET updated_at=now(),last_error=excluded.last_error`, [table,lastId,String(error.message).slice(0,500)]).catch(() => {})
        throw error
      } finally { client.release() }
    }
    report.tables[table] = { processed, complete: true }
  }
  report.status = 'complete'
  await pool.query('UPDATE file_metadata_backfill_runs SET completed_at=now(),status=$2,report=$3 WHERE id=$1', [runId,'complete',report])
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (expectNoop && report.changed !== 0) process.exitCode = 2
} catch (error) {
  report.status = 'failed'; report.error = String(error.message).slice(0,500)
  await pool.query('UPDATE file_metadata_backfill_runs SET completed_at=now(),status=$2,report=$3 WHERE id=$1', [runId,'failed',report]).catch(() => {})
  console.error(report.error); process.exitCode = 1
} finally { await pool.end() }
