import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { compareMetadataStates, hydrateTyped, MetadataRepository, projectTyped } from '../src/metadata/repository.js'
import { PostgresStore } from '../src/postgres-store.js'
import { loadConfig } from '../src/config.js'

test('metadata migration flags default to snapshot and reject unknown values', () => {
  const config = loadConfig({ FILE_AUTH_MODE: 'mock', FILE_METADATA_WRITE_MODE: 'bad', FILE_METADATA_READ_MODE: 'bad' })
  assert.equal(config.metadataWriteMode, 'snapshot')
  assert.equal(config.metadataReadMode, 'snapshot')
  const dual = loadConfig({ FILE_AUTH_MODE: 'mock', FILE_METADATA_WRITE_MODE: 'dual', FILE_METADATA_READ_MODE: 'shadow' })
  assert.equal(dual.metadataWriteMode, 'dual'); assert.equal(dual.metadataReadMode, 'shadow')
})

test('production rejects the fake provider unless explicitly opted in', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', FILE_AUTH_MODE: 'oidc', FILE_OIDC_USERINFO_URL: 'https://auth.test/userinfo', FILE_CURSOR_SECRET: 'cursor-secret' }),
    /FILE_STORAGE_PROVIDER=google-drive is required in production/,
  )
  const config = loadConfig({ NODE_ENV: 'production', FILE_AUTH_MODE: 'oidc', FILE_OIDC_USERINFO_URL: 'https://auth.test/userinfo', FILE_CURSOR_SECRET: 'cursor-secret', FILE_ALLOW_FAKE_PROVIDER: 'true' })
  assert.equal(config.providerType, 'fake-disk')
  assert.equal(config.allowFakeProvider, true)
})

test('typed node projection matches the owner-scoped API record', () => {
  const node = { id:'n1',file_user_id:'u1',parent_id:'root',kind:'file',name:'a.txt',mime_type:'text/plain',provider_file_id:'p1',size_bytes:3,checksum:'abc',state:'active',starred_at:null,created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-02T00:00:00.000Z',trashed_at:null,purged_at:null }
  assert.deepEqual(projectTyped('nodes', node), node)
})

test('dual write only upserts changed rows and propagates typed failures', async () => {
  const queries = []
  const client = { async query(sql, values) { queries.push({sql,values}); if (values?.[4] === 'explode') throw new Error('typed failure') } }
  const repository = new MetadataRepository(client)
  const before = { users:[],nodes:[{id:'same',file_user_id:'u1',name:'same'},{id:'changed',file_user_id:'u1',name:'old'}],uploads:[],reservations:[],audits:[],idempotency:[] }
  const after = structuredClone(before); after.nodes[1].name = 'new'
  await repository.applyChanges(before, after)
  assert.equal(queries.length, 1); assert.match(queries[0].sql, /ON CONFLICT\(id\) DO UPDATE/)
  await assert.rejects(repository.upsert('nodes', {...after.nodes[1],name:'explode'}), /typed failure/)
})

test('typed hydration uses typed columns while preserving compatible record fields', () => {
  const record = { id:'n1',file_user_id:'u1',kind:'file',name:'old.txt',size_bytes:3,custom:'kept',created_at:'2026-01-01T00:00:00.000Z' }
  const hydrated = hydrateTyped('nodes', { record, id:'n1',file_user_id:'u1',parent_id:null,kind:'file',name:'new.txt',mime_type:'text/plain',provider_file_id:null,size_bytes:'4',checksum:null,state:'active',starred_at:null,created_at:new Date(record.created_at),updated_at:new Date('2026-01-02T00:00:00.000Z'),trashed_at:null,purged_at:null })
  assert.equal(hydrated.name, 'new.txt'); assert.equal(hydrated.size_bytes, 4); assert.equal(hydrated.updated_at, '2026-01-02T00:00:00.000Z'); assert.equal(hydrated.custom, 'kept')
})

test('shadow reads return snapshot and report only bounded hashed divergence details', async () => {
  const reports = []
  const store = Object.create(PostgresStore.prototype)
  store.metadataReadMode = 'shadow'; store.metadataDivergenceReporter = report => reports.push(report)
  const record = { id:'n-secret',file_user_id:'u-secret',name:'private-name.txt' }
  const empty = []
  const results = [
    { rows:[{ value:{ version:1,provider:{available:true} } }] }, { rows:empty },
    { rows:[{ record,id:'n-secret',file_user_id:'u-secret',parent_id:null,kind:'file',name:'typed-name.txt',mime_type:null,provider_file_id:null,size_bytes:null,checksum:null,state:null,starred_at:null,created_at:null,updated_at:null,trashed_at:null,purged_at:null }] },
    { rows:empty }, { rows:empty }, { rows:empty }, { rows:empty },
  ]
  const state = await store.load({ query: async () => results.shift() })
  assert.equal(state.nodes[0].name, 'private-name.txt'); assert.equal(reports.length, 1); assert.equal(reports[0].differences, 1)
  const serialized = JSON.stringify(reports[0])
  assert.doesNotMatch(serialized, /n-secret|u-secret|private-name|typed-name/); assert.equal(reports[0].contains_sensitive_data, false)
})

test('shadow comparison detects nested metadata divergence without exposing values', () => {
  const snapshot = { users:[],nodes:[],uploads:[],reservations:[],idempotency:[],audits:[{id:'audit-secret',metadata:{path:'private/path'}}] }
  const typed = structuredClone(snapshot); typed.audits[0].metadata.path = 'other/private/path'
  const report = compareMetadataStates(snapshot, typed)
  assert.equal(report.differences, 1); assert.doesNotMatch(JSON.stringify(report), /audit-secret|private\/path/)
})

test('typed read mode hydrates the state from typed columns', async () => {
  const store = Object.create(PostgresStore.prototype); store.metadataReadMode = 'typed'
  const record = { id:'n1',file_user_id:'u1',name:'snapshot.txt',custom:'kept' }
  const empty = []
  const results = [{ rows:[{value:{version:1}}] },{rows:empty},{rows:[{record,id:'n1',file_user_id:'u1',parent_id:null,kind:'file',name:'typed.txt',mime_type:null,provider_file_id:null,size_bytes:'8',checksum:null,state:'active',starred_at:null,created_at:null,updated_at:null,trashed_at:null,purged_at:null}]},{rows:empty},{rows:empty},{rows:empty},{rows:empty}]
  const state = await store.load({ query: async () => results.shift() })
  assert.equal(state.nodes[0].name, 'typed.txt'); assert.equal(state.nodes[0].size_bytes, 8); assert.equal(state.nodes[0].custom, 'kept')
})

test('expand and backfill migrations retain JSON records and avoid destructive constraints', async () => {
  const expand = await fs.readFile(new URL('../migrations/0002_file_metadata_expand.sql', import.meta.url), 'utf8')
  const backfill = await fs.readFile(new URL('../migrations/0003_file_metadata_backfill.sql', import.meta.url), 'utf8')
  assert.match(expand, /ADD COLUMN IF NOT EXISTS starred_at/); assert.match(expand, /migration_checkpoint/)
  assert.doesNotMatch(`${expand}\n${backfill}`, /DROP COLUMN|SET NOT NULL|TRUNCATE/i)
})
