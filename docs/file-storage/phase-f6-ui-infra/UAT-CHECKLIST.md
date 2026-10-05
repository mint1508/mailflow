# F6 Live UAT Checklist

This checklist is a production-readiness gate. Local fake-provider runs validate the harness only. They do not count as Google Drive, recovery, or promotion evidence.

## Evidence policy

- Use a dedicated organizationally controlled Drive root and two active File PWA users.
- Pass credentials only through environment variables or the deployment secret manager.
- Store artifacts under `artifacts/file-pwa/f6/`; artifacts must not contain tokens, email addresses, provider IDs, file names, or uploaded content.
- Keep the live UAT, recovery drill, staging smoke, production smoke, and rollback smoke artifacts together with their SHA-256 hashes.

## Live tracer

```sh
FILE_UAT_PROVIDER=google-drive \
FILE_UAT_URL="$FILE_SERVICE_URL" \
FILE_UAT_OUTPUT=artifacts/file-pwa/f6/live-uat.json \
node scripts/run-production-file-uat.mjs --suite tracer
```

The tracer must pass health/provider identity, resumable offset recovery, provider-confirmed finalize, download and preview checksums, durable Starred state, redacted activity, cursor response shape, bulk partial outcomes, cross-user 404s, quota enforcement, Trash/restore, and cleanup.

## Full matrix

```sh
FILE_UAT_PROVIDER=google-drive \
FILE_UAT_OUTPUT=artifacts/file-pwa/f6/live-full.json \
node scripts/run-production-file-uat.mjs --suite full
```

| Area | Required evidence |
| --- | --- |
| OAuth | Refresh succeeds server-side; no token or provider URL appears in responses/artifacts |
| Resume | Upload status returns authoritative offset after interruption; completion creates one node |
| Star/activity | Star survives refetch; activity is owner-scoped and contains only safe fields |
| Search/cursor | Filters are server-side; cursors reject another user or changed filters |
| Bulk | Per-item success/failure is deterministic and idempotent |
| Quota/revoke | Held reservations and Trash count; accepted upload grace is at most five minutes; post-grace access fails closed |
| Worker | Maintenance/reconcile is accepted, owner/admin status is redacted, retry/reclaim and DLQ alerts are observed |
| Provider limits | Retryable throttling is bounded and does not duplicate finalized nodes |
| Export/reconcile | Export is step-up protected; reconciliation reports anomalies without deleting provider bytes |

Rows not automated by `production-file-uat.mjs` require a redacted operator note and request IDs. A missing row is a failed gate, not a waiver.

## Recovery drill

Create the byte backup on storage independent from Drive, restore into a clean target, then verify freshness:

```sh
export FILE_BACKUP_OUTPUT=artifacts/file-pwa/f6/recovery-drill.json
archive="$(bash scripts/file-pwa-backup.sh)"
CONFIRM_FILE_RESTORE=yes FILE_DATA_DIR="$(mktemp -d)" bash scripts/file-pwa-restore.sh "$archive"
bash scripts/file-pwa-backup-freshness.sh
node -e "const r=require('./artifacts/file-pwa/f6/recovery-drill.json');if(!r.ok||r.rpo_hours>24||r.rto_hours>4)process.exit(1)"
```

For Compose/PostgreSQL production backups, follow the promotion runbook with writers stopped and record a separate clean-database restore/reconcile result. The restore script deliberately refuses to overwrite Compose volumes automatically.

## Sign-off

Record UTC time, release build SHA, service/web/worker image digests, artifact hashes, RPO/RTO, unresolved findings, operator, and reviewer. Approval requires zero unresolved high-severity findings and must explicitly state that the evidence came from Google Drive rather than fake-disk.
