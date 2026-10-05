# File metadata migration runbook

## Scope and safety

This runbook covers the expand, dual-write, resumable backfill and parity stages only. Keep `FILE_METADATA_READ_MODE=snapshot`. Do not apply `0004`, enable typed reads, drop JSON records, or delete provider bytes before the explicit F6-06 cutover checkpoint.

## 1. Prepare and expand

1. Record a PostgreSQL backup and prove it restores into an isolated database.
2. Deploy `0002_file_metadata_expand.sql` and `0003_file_metadata_backfill.sql`. Both are additive and idempotent.
3. Start with `FILE_METADATA_WRITE_MODE=snapshot` and `FILE_METADATA_READ_MODE=snapshot`; confirm service tests and health.
4. Change only the write flag to `dual`. Rename and star one test node, then confirm its JSON record and typed columns match in the same row.

## 2. Backfill

Run from the service container with `FILE_DB_URL` set:

```sh
node scripts/backfill-file-metadata.mjs --batch-size 100 --resume
node scripts/backfill-file-metadata.mjs --batch-size 100 --resume --expect-noop
```

The first command checkpoints after each committed batch. A malformed record stops the run and stores a bounded error in `file_metadata_migration_checkpoint`; repair the source snapshot, then rerun with `--resume`. The second command must report `changed: 0`.

Use `--dry-run` before production if desired. Dry runs roll back projection changes and checkpoints.

## 3. Verify parity

```sh
node scripts/verify-file-metadata.mjs \
  --output artifacts/file-pwa/f6/db-parity.json \
  --require-zero-diff
```

The artifact contains table counts, difference totals and hashed sample IDs only. It must report `status: zero-difference`. Store its SHA-256 with the release evidence.

## 4. Hold before cutover

Keep snapshot reads throughout the observation window. Typed-read cutover requires a verified backup/restore artifact, zero-difference parity, shadow-read evidence, an exercised snapshot rollback and named operator approval. Those actions belong to F6-06 Task 3 and are intentionally absent here.

`FILE_METADATA_READ_MODE=shadow` hydrates the typed projection and compares it with the canonical snapshot on each state load, while still returning the snapshot to callers. Divergence logs contain only per-collection counts and bounded SHA-256 identifier hashes; they do not contain file names, owner IDs, paths, metadata values or content. Use the parity artifact for a complete batch result and aggregate the shadow divergence count during the observation window.

`FILE_METADATA_READ_MODE=typed` is implemented for disposable migration tests and the future gated cutover. It preserves fields outside the typed projection for API compatibility and takes projected fields from typed columns. Production remains `snapshot`; do not select `typed` or apply `0004` until every Task 3 checkpoint is satisfied and an operator explicitly approves cutover. The current decision is **HOLD**.

## Rollback

Set `FILE_METADATA_READ_MODE=snapshot`. Keep dual writes if healthy; otherwise set `FILE_METADATA_WRITE_MODE=snapshot` and restart the API. If metadata must be restored, use the verified PostgreSQL backup. Reconcile provider state read-only after restore. Never remove Google Drive/provider bytes as part of database rollback.
