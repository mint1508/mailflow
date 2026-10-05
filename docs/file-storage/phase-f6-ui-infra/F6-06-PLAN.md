---
phase: f6-ui-infra
plan: F6-06
type: execute
wave: 5
depends_on: [F6-05]
requirements: [F6-DB]
autonomous: false
files_modified: [docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, docs/file-storage/file-pwa.env.example, file-service/migrations/0002_file_metadata_expand.sql, file-service/migrations/0003_file_metadata_backfill.sql, file-service/migrations/0004_file_metadata_constraints.sql, file-service/src/config.js, file-service/src/metadata/repository.js, file-service/src/postgres-store.js, file-service/src/store-factory.js, file-service/scripts/backfill-file-metadata.mjs, file-service/scripts/verify-file-metadata.mjs, file-service/test/postgres-migration.test.js, docs/file-storage/phase-f6-ui-infra/DB-MIGRATION-RUNBOOK.md]
estimate: {raw_tokens: 32000, tokens: 32000, tasks: 3, confidence: low}
must_haves:
  truths: ["Normal writes are incremental and scoped", "Backfill parity is resumable and zero-difference", "Typed-read cutover has an exercised snapshot rollback"]
  artifacts: ["file-service/migrations/0002_file_metadata_expand.sql", "file-service/src/metadata/repository.js", "file-service/scripts/verify-file-metadata.mjs", "docs/file-storage/phase-f6-ui-infra/DB-MIGRATION-RUNBOOK.md"]
  key_links: ["dual write -> checkpointed backfill -> parity/shadow -> operator checkpoint -> typed read -> snapshot rollback"]
---

# F6-06 - Relational Metadata Migration with Rollback

## Preconditions

- F6-03 list/star/activity contracts and F6-05 worker/reconciliation tests pass.
- A PostgreSQL backup and clean restore drill are recorded before Task 3.

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Dual-write one node mutation to JSON and typed columns</name>
  <files>docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, docs/file-storage/file-pwa.env.example, file-service/migrations/0002_file_metadata_expand.sql, file-service/src/config.js, file-service/src/metadata/repository.js, file-service/src/postgres-store.js, file-service/src/store-factory.js, file-service/test/postgres-migration.test.js</files>
  <behavior>Rename/star mutation updates record JSON and typed columns in one transaction; typed failure rolls back both; snapshot remains canonical; owner-scoped typed row matches API projection.</behavior>
  <action>Per D-08/D-09, F6-06 exclusively owns migrations. 0002 adds nullable typed columns and concurrent-safe indexes for users/nodes/uploads/reservations/audits/idempotency plus migration checkpoint table, retaining record JSON. Introduce explicit repository methods and FILE_METADATA_WRITE_MODE=snapshot|dual, FILE_METADATA_READ_MODE=snapshot|shadow|typed with snapshot defaults. Remove full-table delete/reinsert from dual-mode mutation paths one repository operation at a time.</action>
  <verify><automated>docker compose -f docs/file-storage/docker-compose.file-pwa.yml up -d postgres &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml run --rm -e FILE_DB_URL=postgres://file_storage:file_storage_dev_only@postgres:5432/file_storage file-service node --test --test-name-pattern="dual write|rollback" test/postgres-migration.test.js</automated></verify>
  <done>One real API mutation commits both representations atomically without rewriting unrelated tables.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Backfill in batches and prove snapshot/typed parity</name>
  <files>file-service/migrations/0003_file_metadata_backfill.sql, file-service/scripts/backfill-file-metadata.mjs, file-service/scripts/verify-file-metadata.mjs, file-service/src/metadata/repository.js, file-service/test/postgres-migration.test.js, docs/file-storage/phase-f6-ui-infra/DB-MIGRATION-RUNBOOK.md</files>
  <behavior>Backfill batches resume by table/last ID; second run changes zero rows; malformed record halts and records error; parity covers counts, ownership, lifecycle, quota, provider refs, audits, idempotency, and cursor order.</behavior>
  <action>0003 creates backfill/projection helpers only; the Node backfill owns batched conversion with --batch-size, --resume, --dry-run, and JSON report. The verifier writes artifacts/file-pwa/f6/db-parity.json and exits nonzero on unexplained difference. Shadow reads compare projections by IDs/counts/hashes only, with rate-limited redacted metrics.</action>
  <verify><automated>mkdir -p artifacts/file-pwa/f6 &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml run --rm file-service node scripts/backfill-file-metadata.mjs --batch-size 100 --resume &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml run --rm file-service node scripts/backfill-file-metadata.mjs --batch-size 100 --resume --expect-noop &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml run --rm -v "$PWD/artifacts/file-pwa/f6:/artifacts" file-service node scripts/verify-file-metadata.mjs --output /artifacts/db-parity.json --require-zero-diff</automated></verify>
  <done>Backfill is resumable/idempotent and a redacted zero-difference parity artifact exists.</done>
</task>

<task type="checkpoint:decision" gate="blocking">
  <name>Task 3: Approve typed-read cutover after recovery evidence</name>
  <files>file-service/migrations/0004_file_metadata_constraints.sql, file-service/src/config.js, file-service/src/metadata/repository.js, file-service/src/postgres-store.js, file-service/src/store-factory.js, file-service/test/postgres-migration.test.js, docs/file-storage/phase-f6-ui-infra/DB-MIGRATION-RUNBOOK.md</files>
  <decision>Switch FILE_METADATA_READ_MODE from shadow to typed and apply 0004 constraints.</decision>
  <context>Approval requires passing backup restore, db-parity zero diff, 24-hour shadow observation or equivalent staging workload, and a successful snapshot-read rollback drill. 0004 adds NOT NULL/unique/FK/check constraints but does not drop record JSON or snapshot writes.</context>
  <options><option id="cutover"><name>Cut over</name><pros>Enables indexed incremental reads/writes</pros><cons>Requires monitored observation and rollback readiness</cons></option><option id="hold"><name>Hold in shadow</name><pros>No user-facing read risk</pros><cons>Whole-state reads remain canonical</cons></option></options>
  <verify><automated>docker compose -f docs/file-storage/docker-compose.file-pwa.yml run --rm -e FILE_METADATA_READ_MODE=typed file-service node --test test/postgres-migration.test.js test/service.test.js &amp;&amp; FILE_METADATA_READ_MODE=snapshot bash scripts/file-pwa-restore.sh</automated></verify>
  <resume-signal>Respond with `cutover` or `hold` and attach/reference: the verified backup and clean-restore artifact, zero-difference `artifacts/file-pwa/f6/db-parity.json`, at least 24 hours of shadow-read evidence with no unexplained divergence, the snapshot-read rollback drill result, and the operator name/timestamp. Choose `hold` if any evidence is absent or failing.</resume-signal>
  <done>Operator records cutover/hold, artifact hashes, timestamps, and rollback result; provider bytes are unchanged.</done>
</task>

</tasks>

## Threat model and rollback

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Partial dual-write/schema corruption | critical | mitigate | one DB transaction, fail closed, parity/checkpoint |
| Rollback deleting provider bytes | critical | mitigate | D-09 metadata-only rollback and read-only reconciliation |

Set `FILE_METADATA_READ_MODE=snapshot`, keep dual-write if healthy, restore the verified database backup if necessary, and replay only idempotent provider-safe jobs. Do not drop JSON columns in F6.
