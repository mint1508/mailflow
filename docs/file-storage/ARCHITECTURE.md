# Hippy File PWA - Architecture

## Components

```text
Browser/PWA
    |
    v
File API (Next.js server or separate Node service)
    |-- OIDC session validation (auth.hippy.vn)
    |-- cPanel lifecycle projection
    |-- Authorization + quota service
    |-- Upload/job queue (Redis Streams, consumer groups, AOF everysec)
    |-- Metadata/audit database (PostgreSQL)
    `-- Google Drive Storage Adapter
             |
             `-- dedicated Google account Drive
```

The browser never calls Google Drive directly. The File API is the policy
enforcement point and the only component holding the Google refresh token.

## Core data model

### `file_users`

`id`, `app_user_id`, `mailbox_id`, `status`, `quota_bytes`, `created_at`,
`updated_at`, `revoked_at`.

`app_user_id` and `mailbox_id` reference Mailflow identities; do not copy email
as the identity key. Status is a projection used to fail closed between cPanel
syncs.

### `storage_roots`

`id`, `provider`, `provider_root_id`, `storage_account_label`, `created_at`.

The provider credential is stored in the existing encrypted-secret mechanism,
not in this row or an API response.

### `file_nodes`

`id`, `storage_root_id`, `file_user_id`, `parent_id`, `provider_file_id`, `kind`, `name`,
`mime_type`, `size_bytes`, `checksum`, `state`, `created_at`, `updated_at`,
`trashed_at`, `purged_at`.

Unique constraints: `(storage_root_id, provider_file_id)` and active sibling names
under one parent. `parent_id` must remain inside the same File Home.

### `file_reservations`

`id`, `file_user_id`, `upload_id`, `bytes_reserved`, `state`, `expires_at`,
`created_at`, `committed_at`.

Reservation transitions are `held -> committed | released | expired`.

### `file_uploads`

`id`, `file_user_id`, `idempotency_key`, `provider_session_ref`, `state`,
`expected_bytes`, `received_bytes`, `provider_file_id`, `last_error`,
`created_at`, `updated_at`.

Unique `(file_user_id, idempotency_key)` prevents duplicate logical uploads.

### `file_audit_events`

`id`, `actor_app_user_id`, `subject_file_user_id`, `file_node_id`, `action`,
`result`, `request_id`, `source_ip`, `created_at`, `metadata_json`.

Metadata is bounded and must exclude credentials and file content.

## API contract (MVP)

All endpoints require an authenticated OIDC-backed session unless marked admin.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/files/me` | Current user, quota, usage and File Home |
| GET | `/api/files/nodes?parent_id=` | List children in the user's Home |
| POST | `/api/files/folders` | Create folder |
| POST | `/api/files/uploads` | Reserve quota and create upload intent |
| PATCH | `/api/files/uploads/:id` | Upload chunk/finalize through backend |
| GET | `/api/files/nodes/:id/download` | Authorized streamed download |
| PATCH | `/api/files/nodes/:id` | Rename or move within Home |
| POST | `/api/files/nodes/:id/trash` | Soft-delete |
| POST | `/api/files/nodes/:id/restore` | Restore from Trash |
| GET | `/api/files/search?q=` | Metadata search scoped to current user |
| GET | `/api/admin/file-users` | Admin user/quota/status view |
| PATCH | `/api/admin/file-users/:id` | Lock, quota and recovery controls |
| GET | `/api/admin/file-health` | Queue/provider/backup health |
| GET | `/api/admin/file-audit` | Filtered audit view |

Mutation requests accept an `Idempotency-Key`. Authorization is repeated at the
service boundary even if a route already checked it.

## Consistency rules

### Durable worker

Redis Stream `file-jobs:v1` is consumed by group `file-workers:v1`. Entries carry
schema version, operation ID, type, owner ID and bounded internal payload. A
worker claims stale pending entries with `XAUTOCLAIM` after the lease timeout,
acks only after the handler has durably completed, and writes terminal failures
to `file-jobs:dlq:v1` after the configured attempt limit. Maintenance and
reconciliation use Redis `SET NX PX` scheduler locks plus last-success keys, so
multiple replicas may schedule safely. Redis production deployments enable
`appendonly yes` and `appendfsync everysec`; readiness is degraded when this
durability setting is unavailable.

- PostgreSQL is the policy/read model; Google Drive is the byte/provider model.
- Upload commit writes provider identity and metadata in one application
  transaction after provider confirmation; reconciliation repairs interrupted
  transitions.
- Provider errors do not change committed usage. Reservations remain visible
  until released, expired or committed.
- A periodic reconciliation finds orphan provider files, missing provider files,
  checksum/size mismatches and quota drift; it does not silently delete data.

## Google personal-account adapter constraints

- Use a dedicated account with 2FA, recovery methods and organization billing.
- Store one encrypted refresh token on the server and rotate/re-authorize via an
  admin-only flow.
- Reserve approximately 10% of nominal capacity as headroom; initial usable
  quota target is 4.5TB, not the full advertised 5TB.
- Treat Drive API 429/5xx as retryable with exponential backoff and a circuit
  breaker. Never expose provider error details containing account identifiers.

### F6-02 visible actions

The File PWA has no sharing route or affordance in the MVP. Preview is a server-mediated, owner-scoped stream; provider IDs and URLs never reach the browser. Download, trash and restore use the corresponding authenticated lifecycle routes and reconcile UI state only after the response succeeds. Details render persisted node timestamps; activity remains limited to persisted creation/update metadata until the activity endpoint is delivered in F6-03.

## F6-03 list and metadata reads

The File PWA owns `starred_at` in each existing node record. Star mutations are idempotent and append an audit event. Node lists are owner scoped, typed and bounded to 200 rows, sorted by `updated_at DESC, id DESC`, and paged with the HMAC signed v1 cursor described in `phase-f6-ui-infra/LIST-CONTRACT.md`.

Activity reads expose only a bounded allowlist of audit fields. The browser passes search and filter state to the API; it does not treat localized display strings or a local star array as authoritative.
# Durable browser upload queue

The PWA stores versioned upload metadata and optional browser file handles in IndexedDB. It never stores file bytes. On reload it reconciles each upload with `GET /api/files/uploads/:id`; when file access cannot be restored the row enters `needs_file_reselect`. At most three rows upload concurrently, chunks follow the authoritative server offset, and success is shown only after provider commit. Cancel discards staging and releases quota.

Bulk trash and restore use one bounded service request with per-item outcomes so the UI can reconcile partial success without serial request ambiguity.

## F6-06 relational metadata migration

PostgreSQL retains each JSON `record` as the canonical snapshot while nullable typed columns are expanded and backfilled. `FILE_METADATA_WRITE_MODE=dual` writes the JSON record and typed projection in the same transaction, using row-level upserts for changed records instead of deleting and rebuilding every table. `FILE_METADATA_READ_MODE=snapshot` remains the default; `shadow` and `typed` are reserved for the operator-gated cutover.

Backfill advances a durable checkpoint per table and may be resumed safely. Parity output contains counts, difference totals and hashed row identifiers only. Database rollback changes metadata/read flags or restores a verified database backup; it never deletes provider bytes.
