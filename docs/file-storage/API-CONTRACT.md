# Hippy File PWA - API Conventions

## Authentication

Requests carry the File API session established by OIDC Authorization Code +
PKCE. The server resolves the session to an `app_user_id`, then to a `file_user`
projection. The browser cannot choose the effective user, storage root or
provider file ID.

## Correlation and idempotency

### Durable uploads and bounded bulk actions

- `GET /api/files/uploads/:id` returns the owner-scoped upload and authoritative `received_bytes`/`expected_offset`.
- `PATCH /api/files/uploads/:id` accepts binary chunks with `Content-Range: bytes start-end/total`. `start` must equal the server offset; gaps and overlaps return `409 file_conflict` with the expected offset. Completion is provider-confirmed.
- `POST /api/files/uploads/:id/cancel` is idempotent, discards provider staging, marks the upload `canceled`, and releases its held reservation.
- Upload state is `pending | uploading | ready | finalizing | completed | failed | canceled`.
- `POST /api/files/nodes/bulk` accepts `{action:"trash"|"restore",ids:[...]}` with at most 100 deduplicated IDs. The response includes ordered per-item `outcomes`, `summary`, and request IDs; replaying the same actor-scoped idempotency key returns the same result.

- Every request gets an `X-Request-Id` (accept a valid caller value or create a
  cryptographically random one).
- Mutations require `Idempotency-Key`; keys are scoped to actor and operation.
- Retries with the same key return the original result while it is known, or a
  stable `operation_in_progress` response.
- Request IDs and idempotency keys are safe to log; tokens and file content are
  not.

## Error envelope

### Durable operations

Admin maintenance and reconciliation requests backed by Redis return `202` with
`{operation:{id,type,state}}`. Poll `GET /api/files/operations/:id`; the actor
that created the operation (or an authorized file admin) can read its bounded
state. Queue payloads, stream IDs, provider IDs, credentials and raw provider
errors are never returned. States are `queued | running | completed |
dead_letter`; a dead-letter result exposes only a stable safe error code.

```json
{
  "error": {
    "code": "file_quota_exceeded",
    "message": "File quota is not sufficient for this upload.",
    "request_id": "req_01J...",
    "retryable": false,
    "details": {}
  }
}
```

`message` is safe for UI display and must not contain provider account IDs,
tokens, raw upstream responses or filesystem paths. `details` is bounded and
schema-specific.

## Stable error codes

| Code | HTTP | Retryable | Meaning |
| --- | ---: | :---: | --- |
| `auth_required` | 401 | no | No valid File API session |
| `file_access_revoked` | 403 | no | Mailbox is suspended/deleted or user is locked |
| `file_forbidden` | 403 | no | Resource is outside the user's File Home |
| `file_not_found` | 404 | no | Resource is absent or intentionally hidden |
| `file_validation_failed` | 422 | no | Invalid name, parent, MIME or size |
| `file_quota_exceeded` | 409 | no | Reservation would cross File Quota |
| `file_operation_in_progress` | 409 | yes | Same idempotent operation is still running |
| `file_provider_unavailable` | 503 | yes | Google/provider timeout or circuit open |
| `file_provider_rate_limited` | 503 | yes | Provider returned a retryable rate limit |
| `file_conflict` | 409 | no | Name, parent or lifecycle conflict |
| `file_operation_failed` | 502 | bounded | Provider rejected an operation after retries |
| `admin_step_up_required` | 428 | no | Privileged recovery action needs fresh 2FA |

## Authorization rules

- User routes always scope by the authenticated `file_user_id`.
- Admin routes require explicit file-management permissions and use step-up 2FA
  for export, purge, provider reauthorization and recovery.
- A provider file ID is an opaque backend value; it is never accepted as proof
  of ownership without a database scope check.

## Endpoint authorization matrix

| Endpoint | Actor/scope | Lifecycle check | Idempotency | Main errors |
| --- | --- | --- | --- | --- |
| `GET /api/files/me` | authenticated File User, self | active | no | `auth_required`, `file_access_revoked` |
| `GET /api/files/nodes` | authenticated File User, own Home | active | no | `file_forbidden`, `file_not_found` |
| `POST /api/files/folders` | authenticated File User, own parent | active | yes | `file_validation_failed`, `file_conflict`, `file_forbidden` |
| `POST /api/files/uploads` | authenticated File User, own parent | active | yes | `file_quota_exceeded`, `file_validation_failed`, `file_forbidden` |
| `PATCH /api/files/uploads/:id` | upload owner only | active, or in-flight upload observed before suspension and within five-minute grace | yes | `file_access_revoked`, `file_operation_in_progress`, `file_provider_unavailable`, `file_not_found` |
| `GET /api/files/uploads/:id` | upload owner only | active, or in-flight upload observed before suspension and within five-minute grace | no | `file_not_found` |
| `GET /api/files/nodes/:id/download` | authenticated File User, own node | active | no | `file_forbidden`, `file_not_found`, `file_provider_unavailable` |
| `GET /api/files/nodes/:id/thumbnail` | authenticated File User, own image node | active | no | `file_preview_unsupported`, `file_not_found`, `file_provider_unavailable` |
| `GET /api/files/nodes/:id/revisions` | authenticated File User, own file node | active | no | `file_not_found`, `file_provider_unavailable` |
| `GET /api/files/nodes/:id/revisions/:revision_id/download` | authenticated File User, own revision | active | no | `file_not_found`, `file_provider_unavailable` |
| `POST /api/files/nodes/:id/revisions/:revision_id/restore` | authenticated File User, own revision | active | yes | `file_quota_exceeded`, `file_not_found`, `file_provider_unavailable` |
| `PATCH /api/files/nodes/:id` | authenticated File User, own node/parents | active | yes | `file_conflict`, `file_forbidden`, `file_not_found` |
| `POST /api/files/nodes/:id/trash` | authenticated File User, own node | active | yes | `file_forbidden`, `file_not_found`, `file_conflict` |
| `POST /api/files/nodes/:id/restore` | authenticated File User, own node | active | yes | `file_quota_exceeded`, `file_forbidden`, `file_not_found` |
| `GET /api/files/search` | authenticated File User, own Home | active | no | `file_validation_failed`, `file_access_revoked` |
| `PATCH /api/files/nodes/:id/star` | authenticated File User, own node | active | yes | `file_validation_failed`, `file_not_found` |
| `GET /api/files/nodes/:id/activity` | authenticated File User, own node | active | no | `file_not_found`, `file_validation_failed` |

Revision uploads reuse `POST /api/files/uploads` with `target_node_id` and
`upload_mode:"revision"`. The existing node and provider file ID are retained;
finalization creates a new immutable revision and charges only positive size
growth against quota. A duplicate-name overwrite uses `target_node_id` with
`upload_mode:"overwrite"`; it replaces the current content and resets the
visible revision history to the new current version. A new file omits both
fields.

While the final chunk is being committed, `GET /api/files/uploads/:id` may
include `provider_progress` and `provider_phase:"google_drive_commit"` so the
client can distinguish browser transfer progress from provider commit progress.
Revision restore never moves a provider pointer backward: it writes the
selected content as a new current revision. Provider revision IDs are never
returned to clients.
| `GET /api/admin/file-users` | admin file-management permission | admin active | no | `auth_required`, `file_forbidden` |
| `PATCH /api/admin/file-users/:id` | admin permission; self-escalation denied | admin active | yes | `file_forbidden`, `file_conflict`, `admin_step_up_required` |
| `GET /api/admin/file-health` | admin operations permission | admin active | no | `file_forbidden` |
| `GET /api/admin/file-audit` | admin audit permission | admin active | no | `file_forbidden`, `file_validation_failed` |

`GET /api/admin/file-users` returns only lifecycle-provisioned cPanel mailbox
users by default: `{users, total, source:"cpanel", excluded:{total,by_source}}`.
Synthetic, UAT and dev identities remain in storage for diagnostics but are
excluded from the mailbox inventory count. Each returned user includes
`source:"cpanel"`.

## Revocation rule

When the File API observes a cPanel suspension/deletion, it records
`revoked_at`. New sessions and new mutations fail immediately. An upload that
was already accepted before `revoked_at` may finish only until
`revoked_at + 5 minutes`; after that every chunk/finalize request returns
`file_access_revoked` and the reservation is released or marked for recovery.
The five-minute interval is a maximum safety grace, not a promise that every
upload will be allowed to finish.

## Metadata persistence modes (F6-06)

Persistence flags are deployment controls and do not change the public HTTP contract. Snapshot JSON remains canonical by default. Dual-write mode updates the snapshot and nullable typed projection atomically; a typed write failure rolls back the whole request. Shadow/typed reads cannot be promoted until parity, backup restore and rollback evidence satisfy the F6-06 operator checkpoint.

### Authorized preview (F6-02)

`GET /api/files/nodes/:id/preview` resolves the node under the authenticated `file_user_id` before opening provider bytes. Only PNG, JPEG, WebP, GIF and PDF files up to `FILE_PREVIEW_MAX_BYTES` (default 25 MiB) are streamed with `Content-Disposition: inline`, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`. Unsupported files return `415 file_preview_unsupported`; cross-user IDs return the same `404 file_not_found` as other node routes. Attachment download remains available.
