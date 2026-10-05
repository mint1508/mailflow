# File list contract (F6-03)

`GET /api/files/nodes` is owner scoped and accepts `q`, `parent_id`, `state`,
`kind`, `mime_family`, `updated_after`, `updated_before`, `starred`, `limit`
and a signed opaque `cursor`. Results sort by `updated_at DESC, id DESC` and
return `{nodes, page:{has_more,next_cursor}}`; limits are capped at 200.

Cursor payloads are version 1 HMAC values bound to the authenticated user and
the exact filter hash. Invalid, expired, cross-user, or mismatched cursors
return `file_validation_failed`.

`PATCH /api/files/nodes/:id/star` accepts `{starred:boolean}` and requires an
`Idempotency-Key`. The persisted `starred_at` field is the source of truth.
`GET /api/files/nodes/:id/activity?limit=50` returns bounded owner-scoped audit
events with sensitive metadata redacted.
