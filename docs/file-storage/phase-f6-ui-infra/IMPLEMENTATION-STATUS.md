# F6 Implementation Status

## Implemented

- Clean-checkout source manifest, File PWA CI, build identity, cache policy, and release smoke gate.
- Authorized preview/download/trash/restore actions; unsupported sharing UI removed.
- Durable stars, activity, server filters/search, signed cursor pagination, and nested global search/starred views.
- Resumable upload status/ranges/cancel, durable multi-file browser queue, and bounded bulk outcomes.
- Redis Streams worker with atomic enqueue/retry, delayed jobs, lease heartbeat, DLQ, scheduled maintenance, and operation status.
- PostgreSQL expand/dual-write/backfill/parity plus functional snapshot, shadow, and typed read modes.
- Redacted fake-provider UAT, backup/restore/freshness checks, image-digest release attestation, and live promotion runbooks.

## Verification

- Service automated suite: 64 passed, 2 Redis integration tests skipped without a configured Redis endpoint.
- Backend suite: 1,928 tests passed across 115 files; File web suite: 30 passed; lint and production build passed.
- Canonical `bash scripts/file-pwa-validate.sh` passed in tracked-source mode; a clean `git archive` source-manifest verification also passed.
- Fake-provider full UAT: 38 checks passed in `artifacts/file-pwa/f6/fake-full-uat-final.json` after the final hardening changes.
- Fake-provider backup/restore drill passed with `RPO=0h` and `RTO<1s` in `artifacts/file-pwa/f6/fake-recovery-drill.json`; this is pilot evidence and does not replace the live Google/production recovery gate.
- Production configuration now fails closed unless `FILE_STORAGE_PROVIDER=google-drive`; fake storage requires an explicit pilot-only override.
- Release smoke: 37 checks passed before the final backend hardening patches.
- PostgreSQL backfill resumed as a no-op and produced zero-difference parity evidence at `artifacts/file-pwa/f6/db-parity.json`.
- Final static review found no remaining Critical or High issue in upload, maintenance, Redis lease/retry, or typed reads.

## Held Gates

- `FILE_METADATA_READ_MODE` remains `snapshot`; production typed-read cutover is **HOLD** until a verified backup/restore, zero-difference parity, at least 24 hours of shadow evidence, and rollback drill are attached.
- Live Google Drive promotion is **HOLD** until organizational credentials, two-user isolation, worker/recovery evidence, second-byte backup, and desktop/mobile browser UAT are available.
- Redis integration tests require a reachable Redis endpoint through `FILE_TEST_REDIS_URL`; the final restricted sandbox cannot access the Docker socket.

## Source Tracking

All File PWA source paths are listed in `.github/file-pwa-source-manifest.txt`. The implementation workflow stages the File PWA source tree so the strict tracked-source verifier can pass before commit.
