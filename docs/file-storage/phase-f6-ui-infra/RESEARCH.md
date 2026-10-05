# Phase F6: File PWA UI Infrastructure Gap Closure - Research

**Researched:** 2026-10-01
**Domain:** Next.js PWA, Node file API, PostgreSQL metadata, Redis jobs, Google Drive provider, and production release integrity
**Confidence:** HIGH for repository architecture and existing contracts; MEDIUM for operational recommendations that require staging/live-provider confirmation

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

No phase-specific `CONTEXT.md` was supplied. The following product decisions are locked by the File PWA contract and must remain true during this phase:

- File PWA uses a separate backend storage service and the browser never calls Google Drive directly. [VERIFIED: docs/file-storage/PRODUCT-BRIEF.md:4-8, docs/file-storage/ARCHITECTURE.md:15-21; quote: "Google Drive on a dedicated personal Google account is the pilot byte store" and "The browser never calls Google Drive directly."]
- Sharing, public links, direct Google Drive access, desktop sync, offline upload, version history and multi-tenant self-service are MVP non-goals. [VERIFIED: docs/file-storage/PRODUCT-BRIEF.md:34-36; quote: "Sharing, public links, direct Google Drive access, desktop sync, collaborative editing, offline upload, version history and multi-tenant self-service are not MVP features."]
- Authorization is server-side and every user route is scoped to the authenticated File User. [VERIFIED: docs/file-storage/API-CONTRACT.md:55-61; quote: "User routes always scope by the authenticated `file_user_id`." and "A provider file ID is an opaque backend value."]
- Mutations require actor-scoped idempotency keys and request IDs must not expose tokens or file content. [VERIFIED: docs/file-storage/API-CONTRACT.md:10-18; quote: "Mutations require `Idempotency-Key`" and "tokens and file content are not" safe to log.]
- A successful upload is reported only after provider confirmation; hard quota includes concurrent reservations and Trash. [VERIFIED: docs/file-storage/PRODUCT-BRIEF.md:38-42; quote: "A successful upload is not reported until the storage provider confirms it." and "A File User cannot exceed hard quota, including concurrent uploads and Trash."]
- Revoked users fail closed; an already accepted upload has at most a five-minute grace window. [VERIFIED: docs/file-storage/API-CONTRACT.md:82-90; quote: "after `revoked_at + 5 minutes` every chunk/finalize request returns `file_access_revoked`".]

### the agent's Discretion

- Choose the migration sequence, endpoint shapes for new UI contracts, queue/worker decomposition, and release verification details, provided the locked security and MVP constraints remain intact.
- Prefer native browser capabilities and existing `pg`/`redis` dependencies over adding packages. This is a planning recommendation based on the current repository, not a product lock.

### Deferred Ideas (OUT OF SCOPE)

- Full sharing/ACL implementation, public links, desktop sync, offline upload, version history, and direct end-user Google Drive access remain out of scope for this phase. [VERIFIED: docs/file-storage/PRODUCT-BRIEF.md:34-36]
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research support |
|---|---|---|
| F6-REL | Release the File PWA from a clean checkout with cache-safe, runtime-verified web assets | Immutable image/version contract, HTML/service-worker cache rules, deploy smoke checks |
| F6-ACTIONS | Make visible download, trash/restore, preview and details actions perform the advertised authorized operation | Existing API wiring, new inline/activity contracts, idempotent mutation rules |
| F6-FAVORITES | Persist stars across reloads while keeping sharing out of MVP | `starred_at` field and scoped PATCH endpoint; remove or disable Shared navigation |
| F6-LIST | Add server-side filters, stable ISO metadata and cursor pagination | Typed query contract and indexed keyset reads |
| F6-UPLOAD | Make upload sessions durable, resumable, cancellable and multi-file in the UI | Upload status/cancel contract, IndexedDB queue, provider session reconciliation |
| F6-BULK | Make bulk trash/restore atomic enough to report per-item outcomes and reconcile partial failures | Bulk endpoint with bounded IDs, result list and idempotency |
| F6-WORKER | Add scheduled maintenance and a real durable worker/status model | Separate worker process, Redis job payload/status, retry/dead-letter and health metrics |
| F6-DB | Migrate PostgreSQL from whole-state snapshots to incremental typed writes with rollback | Expand/dual-read/backfill/dual-write/cutover/rollback sequence |
| F6-LIVE | Complete live Google Drive authorization/UAT and define promotion gates | Real-account test matrix and evidence checklist tied to F6-REL/F6-UPLOAD/F6-WORKER |
</phase_requirements>

## Summary

The repository already has the policy boundary and most fake-provider behavior, but the current UI contract is ahead of the durable backend. `file-web` keeps stars and upload progress in React state, several controls only show toasts, search is an unbounded in-memory filter, and bulk operations issue sequential requests. [VERIFIED: docs/file-storage/phase-f5/UI-REVIEW.md:21-45; quote: "Starred files are held only in React state", "Preview and several download actions are placeholders", and "Advanced filters are implemented against the current client array".] The first vertical slice should close the user-visible correctness gaps and release integrity before changing the storage engine.

The service has strong invariants to preserve: authenticated `file_user_id` scoping, actor/operation idempotency, reservation-based quota, provider confirmation before commit, opaque provider IDs, and the five-minute revocation grace. [VERIFIED: docs/file-storage/API-CONTRACT.md:10-18,55-90; docs/file-storage/PRODUCT-BRIEF.md:38-42.] New endpoints should be additive and use the existing error envelope; they should not make the browser aware of Google IDs or bypass `file-service`.

The PostgreSQL adapter is the largest structural risk. It loads every JSON record, takes one advisory lock, deletes every metadata table, and reinserts the complete state on each transaction. [VERIFIED: file-service/src/postgres-store.js:18-44; quote: "SELECT pg_advisory_xact_lock(6847331)" and `DELETE FROM ${table}`.] Migrate in expand/dual-write/backfill/cutover stages, with a feature flag and a rollback path that keeps the snapshot projection readable until typed data is verified. Do not combine the database cutover with the first UI behavior release.

**Primary recommendation:** ship five deployable slices: (1) release/cache and action correctness, (2) typed list/favorites/activity plus server pagination, (3) durable upload queue and bulk outcomes, (4) worker/maintenance and incremental PostgreSQL migration, and (5) live Drive UAT/promotion. Keep each slice backward-compatible with the previous API and require evidence before promotion.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Release version, HTML/chunk/service-worker cache integrity | CDN / Static | Frontend Server | Cache headers and immutable assets determine whether the browser receives a coherent Next build; deploy checks must verify the served version. |
| Visible download/trash/restore/rename actions | API / Backend | Browser / Client | The API owns authorization, provider access and idempotency; the browser only invokes the contract and reconciles state. |
| Starred state | Database / Storage | API / Backend, Browser / Client | `starred_at` is durable metadata; API scopes it to the user and the browser renders it. |
| Preview and node activity | API / Backend | Database / Storage, Browser / Client | The API must authorize streaming and activity records; the UI renders returned metadata. |
| Search/filter/cursor pagination | Database / Storage | API / Backend, Browser / Client | Typed columns and indexes provide bounded reads; API signs/validates cursors and UI requests pages. |
| Resumable upload queue | Browser / Client | API / Backend, Database / Storage | IndexedDB retains local intent, while the API/provider retain authoritative received bytes and reservation state. |
| Bulk mutations | API / Backend | Browser / Client, Database / Storage | Server validates all IDs under one actor and returns per-item outcomes; UI displays partial failures. |
| Maintenance scheduling and job status | API / Backend | Database / Storage, Redis worker | A worker owns retries and cleanup; API exposes safe status and health, never direct queue internals. |
| Snapshot-to-relational migration | Database / Storage | API / Backend | Data shape and transaction semantics change; API compatibility and feature flags control the cutover. |
| Google Drive live UAT and promotion | Storage / Provider | API / Backend, Operations/CDN | Real OAuth, quota, retry and recovery evidence must be collected before a release is promoted. |

## Standard Stack

### Core

| Component | Version | Purpose | Why standard for this repository |
|---|---:|---|---|
| Node.js | 22 container baseline | File API, worker and scripts | `file-service/Dockerfile` uses `node:22-alpine`; `file-service/package.json` declares `"node": ">=22"`. [VERIFIED: file-service/Dockerfile:1, file-service/package.json:5-7; quote: `FROM node:22-alpine` and `"node": ">=22"`] |
| Next.js | `^15.5.4` | PWA shell and client UI | Already installed in `file-web`; preserve the existing build output and avoid a framework migration in this phase. [VERIFIED: file-web/package.json:8-12; quote: `"next": "^15.5.4"`] |
| PostgreSQL | `16-alpine` | Durable metadata/read model | Existing compose service and current `pg` adapter. [VERIFIED: docs/file-storage/docker-compose.file-pwa.yml:2-15; quote: `image: postgres:16-alpine`] |
| `pg` | `^8.23.0` | Incremental relational queries/transactions | Existing service dependency; no new ORM is needed for explicit migrations and scoped SQL. [VERIFIED: file-service/package.json:15-18; quote: `"pg": "^8.23.0"`] |
| Redis | `7-alpine` / `redis` `^4.7.1` | Durable queue state and worker coordination | Existing compose and service dependency. [VERIFIED: docs/file-storage/docker-compose.file-pwa.yml:17-26, file-service/package.json:15-18; quote: `image: redis:7-alpine` and `"redis": "^4.7.1"`] |

### Supporting

| Capability | Use | Guidance |
|---|---|---|
| IndexedDB | Browser upload intent/chunk progress queue | Use a small versioned object store keyed by upload ID; store metadata and offsets, never file content unless the browser can safely retain it. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API] |
| Native `fetch`, `ReadableStream`, `AbortController` | Upload retry/cancel and authorized preview/download | Keep provider bytes behind the API; abort only marks a client attempt canceled and requires an idempotent server cancel/release operation. [ASSUMED] |
| Google Drive resumable upload protocol | Provider-side resume/reconciliation | The adapter already persists a session reference and probes the provider range before continuing. [VERIFIED: file-service/src/google-drive.js:129-195; quote: `sessionPath(uploadId)`, `content-range`, and `loadSession(uploadId)`] |
| Docker Compose | API/web/db/redis/worker process topology | Add a worker service only after its health and shutdown semantics are defined; keep the API and worker images versioned together. [VERIFIED: docs/file-storage/docker-compose.file-pwa.yml:28-80] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Explicit SQL migrations with `pg` | ORM/query builder | Adds package and migration abstraction during a risky storage cutover; current code already uses SQL and needs JSON backfill control. |
| Native IndexedDB wrapper | New browser queue package | Avoids dependency and bundle risk; wrapper is acceptable only if the implementation remains small, versioned and tested. |
| Redis-backed worker | In-process `setInterval` only | An in-process timer does not provide durable ownership or independent restart; retain a local timer only as a development fallback. |
| Keyset cursor | Offset pagination | Keyset avoids duplicates/skips under concurrent updates and scales with indexed `(owner, state, updated_at, id)` ordering. [ASSUMED] |

**Installation:** No new external package is recommended for this phase. Existing `next`, `react`, `pg`, and `redis` versions remain in place.

## Package Legitimacy Audit

No package installation is part of the recommended plan, so the legitimacy gate has no new package candidates. Reuse of existing dependencies is verified from `file-web/package.json` and `file-service/package.json`; do not add an ORM, queue framework, IndexedDB wrapper or preview library without a separate package review.

## Architecture Patterns

### System Architecture Diagram

```text
Browser UI / PWA
  |  authenticated API calls + Idempotency-Key
  |  IndexedDB upload queue and resumable client state
  v
File API (Node)
  |-- auth/lifecycle check -> fail closed for revoked user
  |-- typed query/mutation service -> owner scope + bounded validation
  |-- provider stream/preview -> Google Drive adapter only
  |-- enqueue operation -> Redis job state
  v
PostgreSQL relational read/write model <---- migration projection/verification
  |                         ^
  |                         |
Redis queue <---- File Worker ---- scheduled maintenance/reconcile/retry
  |
Google Drive provider (server-side OAuth, resumable session, no browser URL)

Release pipeline -> immutable web/API images -> deploy smoke/version check
CDN/Nginx: no-store HTML/SW, immutable hashed assets, API no-cache
```

### Recommended Project Structure

```text
file-service/
├── migrations/0002_file_typed_columns.sql       # expand schema, indexes, constraints
├── migrations/0003_file_backfill.sql             # resumable batched backfill/checkpoints
├── src/metadata/                                  # typed repositories and cursor codecs
├── src/jobs/                                      # job payloads, worker handlers, scheduler
├── src/http/                                      # route contracts and response envelopes
├── src/migrations/                                # dual-read/write and cutover flags
└── test/                                          # contract, migration, worker and security tests
file-web/
├── src/upload-queue.js                            # IndexedDB schema and queue state
├── src/api.js                                     # typed query/mutation clients
└── test/                                          # action, queue and cache regression tests
docs/file-storage/phase-f6-ui-infra/
├── RESEARCH.md
├── PLAN.md
└── UAT-CHECKLIST.md
```

### Pattern 1: Backward-compatible UI action wiring

**What:** Every visible action calls an API method that returns the authoritative node/operation result, then updates the UI from a fresh list or returned row. Download/preview use the existing `fileApi.download` path or a new authorized stream endpoint; no success toast is emitted before the request resolves.

**When to use:** Any button currently mutating local React state or showing a toast without a server response.

```js
// Source: existing repository contract, adapted from file-web/src/api.js:54-75
await fileApi.trash(item.id)
await load(active, currentFolder)
notify('Đã chuyển vào thùng rác')
```

The exact `trash`, `restore`, `download`, `updateNode` names are existing values and are verified in `file-web/src/api.js:54-75`; new methods must preserve the same error-envelope handling.

### Pattern 2: Typed cursor contract

**What:** Return `{ nodes, page: { next_cursor, has_more } }` with a stable order such as `(updated_at DESC, id DESC)`. Encode the last tuple in an opaque, integrity-protected cursor; validate all query filters server-side. The UI holds the cursor per view and requests the next page rather than slicing an unbounded array.

**When to use:** `/api/files/nodes` and `/api/files/search`, including Trash and Starred views.

**Required filters:** `q`, `parent_id`, `state`, `kind`, `mime_family`, `updated_after`, `updated_before`, `starred`, `limit`, `cursor`. Keep owner implicit from the authenticated user. Do not accept a caller-selected `file_user_id`.

### Pattern 3: Durable upload state machine

**What:** Model upload states explicitly: existing states are `pending`, `uploading`, `ready`, `completed`, and `failed` in the current handler. [VERIFIED: file-service/src/server.js:186-224; quote: `state: 'pending'`, `upload.state = ... ? 'ready' : 'uploading'`, and `upload.state = 'completed'`.] Add a status response exposing `expected_bytes`, `received_bytes`, `state`, `last_error`, `updated_at`, and a cancel endpoint that releases a held reservation idempotently. The client stores `{upload_id, file identity, parent_id, next offset, state}` in IndexedDB and reconciles with the server after reload.

**When to use:** Every upload, including page refresh, browser reconnect, provider retry, cancel and revoked-session recovery.

### Pattern 4: Expand/dual-read/backfill/cutover/rollback database migration

**What:** Add nullable typed columns and indexes while retaining JSON `record`; write both representations, backfill existing rows in bounded batches, compare canonical projections, switch reads behind a feature flag, then enforce constraints and retire snapshot writes only after an observation window. Keep a one-command rollback to snapshot reads and preserve the old JSON record until backup/recovery evidence exists.

**When to use:** `file_users`, `file_nodes`, `file_uploads`, `file_reservations`, `file_audits` and idempotency rows. The current migration only has `record jsonb` plus owner/parent indexes. [VERIFIED: file-service/migrations/0001_file_storage.sql:1-8; quote: `record jsonb NOT NULL` and `file_nodes_owner_parent_idx`.]

### Pattern 5: Separate worker ownership from API request lifecycle

**What:** API validates and enqueues a bounded job payload; worker claims it with a lease, records attempts/next retry/dead-letter reason, executes provider/maintenance work, and updates the operation row. A job status route returns safe state to the UI. Scheduled maintenance uses the same handler as the existing admin maintenance operation, preserving idempotency.

**When to use:** trash purge, expired reservations, reconciliation, provider retries, queued bulk mutations and future streamed exports.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Browser upload persistence | React state or localStorage-only progress | Versioned IndexedDB object store plus server upload status | Refresh and multi-file state need structured durable records; localStorage cannot safely model binary/queue semantics. [CITED: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API] |
| Provider resumability | Client-side Google SDK or permanent Drive URLs | Existing server-side adapter session probe/commit | Keeps credentials and provider IDs server-side and preserves authorization boundary. [VERIFIED: docs/file-storage/ARCHITECTURE.md:20-21; file-service/src/google-drive.js:133-195] |
| Queue scheduling | API request timers and ad hoc `setInterval` mutations | Redis-backed worker with leased jobs and a scheduler trigger | Restarts and multiple API instances otherwise duplicate or lose work. [ASSUMED] |
| Cursor integrity | Plain user-controlled offset/owner fields | Opaque cursor bound to actor, filter hash and sort tuple | Prevents cross-user traversal and unstable pagination. [ASSUMED] |
| Preview authorization | Direct Drive URL or browser Google API call | API stream endpoint with node scope and inline content disposition | Permanent provider URLs violate product invariants. [VERIFIED: docs/file-storage/PRODUCT-BRIEF.md:42-45; quote: "File bytes are never exposed through a permanent Google URL."] |
| Migration consistency | Big-bang table rewrite | Expand/dual-write/backfill/verify/cutover | Allows rollback while old snapshots remain valid. [ASSUMED] |

**Key insight:** the File API is the policy boundary; all UI affordances must converge on API-confirmed state, and all provider/queue work must be replay-safe under the existing idempotency rules.

## Release, Deployment and Cache Integrity

1. Track `file-web` and `file-service` source in the release checkout and build both from the same commit. The UI review found both directories untracked in the current worktree. [VERIFIED: docs/file-storage/phase-f5/UI-REVIEW.md:21-24; quote: "`file-web` and `file-service` are untracked in Git".]
2. Build immutable images tagged by commit SHA plus a human release tag; expose a non-secret build identifier from the web and API health/version endpoints. The existing `file-web/Dockerfile` is a multi-stage Next standalone build and accepts public build arguments. [VERIFIED: file-web/Dockerfile:1-31; quote: `RUN npm run build` and `COPY --from=builder .../.next/standalone`].
3. Keep HTML and `/sw.js` no-store/revalidated; serve hashed JS/CSS/fonts as immutable. The deployed evidence reported `s-maxage=31536000` on HTML, which allowed stale bundles to persist. [VERIFIED: docs/file-storage/phase-f5/UI-REVIEW.md:24; quote: "The web response is cached with `s-maxage=31536000`".] The existing PWA service worker uses cache `hippy-files-v3`, caches the manifest/icon and bypasses `/api/`; bump cache names only when the asset contract changes and ensure navigation falls back safely. [VERIFIED: file-web/public/sw.js:1-13; quote: `const CACHE = 'hippy-files-v3'` and `url.pathname.startsWith('/api/')`].
4. After deployment, run a smoke check that fetches HTML, extracts referenced chunk URLs, verifies each chunk returns 200, checks the build identifier, loads `/sw.js`, calls `/health`, and runs an authenticated browser action. Fail promotion on console errors, mixed build identifiers, stale `List`-style runtime errors, failed API calls or missing source maps only if source maps are part of the release policy.
5. Keep API and auth routes uncached at Nginx; preserve upload/download timeouts and request buffering settings in `files-api.hippy.vn.conf`. [VERIFIED: docs/file-storage/nginx/files-api.hippy.vn.conf:6-23; quote: `proxy_request_buffering off`, `proxy_buffering off`, and `proxy_read_timeout 3600s`].

## Visible Action and API Gaps

| UI behavior | Current evidence | Plan contract |
|---|---|---|
| Download from context/details/preview | Current handlers show a toast; only `fileApi.download` performs a binary fetch. [VERIFIED: file-web/src/main.jsx:718-723, file-web/src/main.jsx:863-864; file-web/src/api.js:74] | Route all download buttons to `fileApi.download`; disable folders; show retryable error from the API. |
| Trash/delete | Context/details handlers call `toggleStar` and claim trash. [VERIFIED: file-web/src/main.jsx:721, file-web/src/main.jsx:866; quote: `toggleStar(contextMenu.item.id)`] | Call `fileApi.trash`, confirm destructive action, refresh list, and offer restore/undo only after success. |
| Preview | Image preview uses `/icon.svg`; no inline API. [VERIFIED: file-web/src/main.jsx:878-881; quote: `<img src="/icon.svg" ...>`] | Add `GET /api/files/nodes/:id/preview` (or `?disposition=inline`) with the same owner scope as download, safe MIME allowlist, bounded size/range behavior and no provider URL leakage. |
| Details created date/activity | Created date and activity event are hardcoded. [VERIFIED: file-web/src/main.jsx:826,834-847] | Return `created_at` from node and `GET /api/files/nodes/:id/activity?cursor=` from audit rows scoped to `file_node_id`; omit events without a node subject. |
| Shared navigation | Product explicitly excludes sharing and current list is owner-scoped. [VERIFIED: docs/file-storage/PRODUCT-BRIEF.md:34-36; docs/file-storage/phase-f5/UI-REVIEW.md:28-29] | Remove from MVP nav or render a disabled “Sắp có” item without implying data exists. Do not add ACLs in F6. |
| Starred navigation | `starredIds` is seeded/local React state. [VERIFIED: file-web/src/main.jsx:49,67-76] | Add nullable `starred_at`, user-scoped `PATCH /api/files/nodes/:id/star` or node PATCH field, and `starred=true` list filter. Make toggle idempotent and return the updated node. |

## Search, Filters and Pagination

The current list endpoint limits an in-memory array to 200 and the search endpoint requires only `q`, returning every matching active node. [VERIFIED: file-service/src/server.js:166-174,233; quote: `nodes.slice(0, limit)` and `state.nodes.filter(...name.toLowerCase().includes(q))`.] The browser additionally filters localized display strings such as `Hôm nay` and `09/2026`. [VERIFIED: file-web/src/main.jsx:72-110; quote: `i.updated || ''` and `'09/2026'`.] This must move to typed server parameters and ISO timestamps.

Recommended contract:

```text
GET /api/files/nodes
  ?parent_id=<owned-folder>
  &state=active|trashed
  &kind=file|folder
  &mime_family=image|pdf|sheet|other
  &starred=true|false
  &updated_after=<ISO-8601>
  &updated_before=<ISO-8601>
  &limit=1..100
  &cursor=<opaque>

GET /api/files/search
  ?q=<bounded UTF-8 text>
  &state=active|trashed
  &kind=...
  &mime_family=...
  &starred=...
  &updated_after=...
  &updated_before=...
  &limit=1..100
  &cursor=<opaque>
```

Use owner-scoped indexes on `(file_user_id, state, parent_id, updated_at DESC, id DESC)`, `(file_user_id, starred_at DESC, id DESC)` and a search strategy appropriate to the chosen PostgreSQL version. Start with indexed prefix/substring-safe fields and bounded `ILIKE` only if the pilot dataset proves adequate; do not claim full-text semantics without product requirements. Return `next_cursor`, `has_more`, and `applied_filters` so the UI can reconcile a filter change. [ASSUMED]

## Durable Uploads and Bulk Operations

The client currently creates an intent, sends raw 8 MiB chunks, and loses state on refresh; the server already stores `received_bytes`, provider session files and a 24-hour held reservation. [VERIFIED: file-web/src/api.js:62-72; file-service/src/server.js:177-224; file-service/src/google-drive.js:129-195.] Close the gap with:

1. `GET /api/files/uploads/:id` returning authoritative state and offset, owner-scoped and subject to the existing revoke grace.
2. `POST /api/files/uploads/:id/cancel` releasing the reservation and discarding provider staging idempotently; keep completed uploads immutable.
3. Chunk requests carrying an explicit `Content-Range`/offset or server-checked offset; reject gaps and duplicate ranges with a stable conflict response.
4. A browser IndexedDB queue with `queued`, `uploading`, `paused`, `retrying`, `completed`, `failed`, `canceled` client states. Store only metadata/offset and a recoverable `File`/Blob reference where browser support permits; otherwise mark a refresh as requiring file re-selection instead of pretending it can resume. [ASSUMED]
5. Retry with exponential backoff and jitter for retryable API/provider codes only; use `AbortController` for cancel; reconcile status before resending a chunk.
6. Multi-file UI rows keyed by upload ID, with one aggregate progress display and per-item retry/cancel. Never report success before the API returns completed provider confirmation.

For bulk trash/restore, add a bounded `POST /api/files/bulk` (or separate `/bulk-trash` and `/bulk-restore`) accepting owned node IDs, operation and one idempotency key. Validate all IDs and max batch size before mutation, then return `{ succeeded: [...], failed: [{ id, code, message }] }`; if provider work is asynchronous, return an operation ID and expose status. The UI must refresh from the server and preserve failed selections. Sequential client calls may remain as a temporary fallback only when the endpoint is unavailable.

## Worker, Maintenance and Operation Status

`file-service/src/job-queue.js` currently stores running/dead-letter counters but has no consumer or payload; `server.js` invokes it around synchronous provider retries. [VERIFIED: file-service/src/job-queue.js:4-25; docs/file-storage/phase-f5/UI-REVIEW.md:42-44.] Implement a real worker as a separate Compose service using the same image and a `WORKER_MODE` entrypoint:

- Redis job hash/stream fields: `id`, `type`, bounded JSON payload, `state`, `attempts`, `available_at`, `lease_until`, `request_id`, `actor_id` (when applicable), `created_at`, `updated_at`, `last_error_code`.
- Claim with a lease and heartbeat; reclaim expired leases; cap attempts and move to dead letter.
- Keep provider IDs and file-user scope in the payload only as opaque identifiers; worker reloads authorization-relevant rows before acting.
- Maintenance job invokes the same idempotent purge/expired-reservation logic currently exposed at `POST /api/admin/file-maintenance`, but scheduled execution must use a service identity and emit an auditable system event. [VERIFIED: file-service/src/server.js:150-152; quote: `route === '/api/admin/file-maintenance'` and audit action `admin_maintenance`]
- Add `GET /api/files/operations/:id` for the current user and admin health aggregation; redact provider details and file content.
- Expose queue depth, oldest pending age, retry/dead-letter counts, maintenance last-run/last-success, provider availability and backup freshness in health/metrics. The existing `/metrics` already reports upload counts and provider availability. [VERIFIED: file-service/src/server.js:92; quote: `hippy_file_uploads_completed` and `hippy_file_provider_available`]

## PostgreSQL Migration Strategy

### Current state

`0001_file_storage.sql` creates six JSON `record` tables plus a metadata table. `PostgresStore.load()` reads all rows into one JavaScript object; `save()` deletes and reinserts all rows under one advisory transaction lock. [VERIFIED: file-service/migrations/0001_file_storage.sql:1-8; file-service/src/postgres-store.js:18-44.] This blocks efficient filtering/activity pagination and causes write amplification.

### Target typed model

Add typed columns that mirror the architecture contract: users (`app_user_id`, mailbox/status/quota/revoked timestamps), nodes (`storage_root_id`, owner/parent/provider ID/kind/name/MIME/size/checksum/state/starred/created/updated/trash/purge timestamps), uploads (idempotency/provider session/state/expected/received/provider ID/last error), reservations (bytes/state/expiry/commit), audits (actor/subject/node/action/result/request ID/IP/metadata), and idempotency (actor/key/operation/status/response/expiry). Preserve `record` during migration for rollback and forensic comparison. [VERIFIED: docs/file-storage/ARCHITECTURE.md:29-82; quote: field lists for `file_nodes`, `file_uploads`, `file_reservations`, and `file_audit_events`.]

### Safe sequence

1. **Expand:** add nullable typed columns, check constraints that tolerate null during backfill, indexes concurrently where supported, and a schema-version row. No read behavior changes.
2. **Dual-write:** update repository methods so every mutation writes typed columns and JSON `record` in one transaction. Keep the old snapshot loader as the canonical response until comparison is green.
3. **Backfill:** process each table in stable ID batches, parse JSON, write typed values, record checkpoints and counts. Make the command resumable and idempotent; stop on malformed records rather than silently dropping data.
4. **Verify:** compare canonical JSON projections against typed rows for count, owner scope, lifecycle state, quota totals, provider IDs, audit ordering and idempotency keys. Run read-only reconciliation against provider metadata before cutover.
5. **Dual-read shadow:** for a bounded observation window, read typed rows for API responses and compare to snapshot responses in logs/metrics without exposing differences to users. Bound logs to IDs/counts; never log file content/tokens.
6. **Cut over:** feature-flag typed reads, then remove full-table delete/reinsert from normal transactions. Retain snapshot writes and an emergency snapshot-read flag until at least one backup and restore drill passes.
7. **Enforce:** make required typed columns `NOT NULL`, add uniqueness/foreign-key/check constraints, then remove snapshot writes only in a later cleanup phase. Keep `record` or an export until rollback retention expires.

### Rollback

If typed comparisons diverge, disable typed reads and use the still-maintained snapshot projection. If dual-write fails, fail the mutation before commit rather than accepting only one representation. If cutover data is corrupted, restore the last verified PostgreSQL backup, replay provider-safe idempotent operations from the job ledger, and re-enable snapshot reads. Never delete provider bytes as part of database rollback; reconciliation must classify missing/orphan bytes for an explicit recovery action.

## Live Google Drive UAT and Promotion Gates

The adapter refreshes OAuth credentials server-side, discovers a root/user folder, persists resumable session files, streams downloads and handles 429/5xx retry normalization. [VERIFIED: file-service/src/google-drive.js:33-77,100-118,133-213.] Roadmap and F5 status explicitly say live authorization/UAT remain pending and fake-provider evidence does not promote the personal account. [VERIFIED: docs/file-storage/ROADMAP.md:43-63; docs/file-storage/phase-f5/STATUS.md:39-42.]

Run live UAT only in a dedicated non-production account/root with an organizational owner, 2FA/recovery, quota alerts and a tested refresh token. Capture request IDs and safe result metadata, not tokens or provider account identifiers.

Minimum matrix:

| Scenario | Evidence required | Promotion failure |
|---|---|---|
| OAuth authorization and refresh | authorize script output, token refresh after expiry simulation, health state | token reaches browser, stale token loops, or health falsely reports available |
| User isolation | two File Users create/list/preview/download/trash only own nodes | any cross-user node/provider access |
| Upload resume | interrupt after chunk, restart API/worker/browser, resume and finalize once | duplicate provider file, lost reservation or success before provider confirmation |
| Provider transient/rate-limit | injected/observed 429/5xx bounded retry and operation status | unbounded retry, duplicate commit or leaked upstream detail |
| Quota/revocation | concurrent reservations, cPanel revoke, five-minute grace and post-grace failure | overcommit or new mutation after revoke |
| Preview/download | inline preview and attachment download through API only | permanent Drive URL or MIME/content disclosure |
| Trash/restore/purge | 30-day policy simulation, restore conflict and scheduled worker | premature purge, silent loss or manual-only cleanup |
| Backup/recovery | second-byte backup, metadata restore, provider reconciliation, RPO <=24h/RTO <=4h | no independent recovery or unresolved orphan bytes |
| Release integrity | clean checkout image build, served build ID/chunk hashes, browser console | stale/mixed bundle, missing File PWA source or runtime error |

Promotion is blocked until all F6 requirements have automated evidence plus manual browser evidence for desktop/mobile action flows. The roadmap's existing production decision requires second-byte backup outside the personal account, recovery RPO/RTO, organizational ownership/recovery, cost/API/capacity alerts and UAT sign-off for revoke, quota, retry, restore and export. [VERIFIED: docs/file-storage/ROADMAP.md:92-100; quote: "second byte backup exists outside the personal Google account" and "UAT signs off on revoke, quota, upload retry, restore and export."]

## Recommended Vertical Slicing

### Slice 1 - Release and action correctness (P0)

- Track source/build from clean checkout; add build ID, cache headers, service-worker verification and deployment smoke script.
- Wire real download/trash/restore actions; remove Shared from MVP or mark disabled.
- Add preview endpoint only for authorized supported MIME types, and activity/created metadata contract.
- Tests: web action regressions, API auth/IDOR/Content-Disposition, cache smoke, no-console-error browser check.

### Slice 2 - Durable metadata views (P1)

- Add `starred_at`, star toggle, Starred list filter, node activity endpoint and typed server-side list/search query parsing.
- Add cursor response and indexes while retaining current response compatibility during rollout.
- Tests: reload persistence, filter/date boundaries in UTC, cursor duplicate/skip checks, cross-user cursor rejection.

### Slice 3 - Upload queue and bulk UX (P1)

- Add upload status/cancel/reconcile APIs; IndexedDB queue, retry/cancel/multi-file UI; bounded bulk trash/restore with per-item outcomes.
- Tests: refresh/reconnect resume, duplicate chunk/idempotency, provider failure/retry, quota/revocation, partial bulk failure.

### Slice 4 - Worker and relational migration (P1/P0 scale)

- Add worker lease/status/maintenance/reconcile jobs and health metrics.
- Execute expand/dual-write/backfill/dual-read/cutover in separate deploys; keep snapshot rollback flag.
- Tests: migration parity, crash/retry/lease recovery, maintenance idempotency, backup/restore and load at 20-50 users/100-300GB-shaped metadata.

### Slice 5 - Live provider and promotion gate

- Authorize organizationally controlled Google account, run live matrix, verify second-byte backup/recovery and cache-safe release in staging.
- Promote only with signed evidence bundle and manual desktop/mobile UAT.

## Common Pitfalls

### Pitfall 1: Marking local state as saved

**What goes wrong:** A toast or React state update says star/trash/download succeeded while the API did not change state. **Why:** UI handlers are currently local-only. [VERIFIED: docs/file-storage/phase-f5/UI-REVIEW.md:28-32.] **How to avoid:** await API result, then reload or apply returned authoritative row. **Warning signs:** reload loses a star, Trash still lists an item, or a download button creates no network request.

### Pitfall 2: Cursor leaks scope or becomes invalid after filter changes

**What goes wrong:** A cursor from one filter/user is reused for another query. **How:** bind a hash of actor/filter/sort into an opaque cursor and reject mismatch. [ASSUMED]

### Pitfall 3: Dual-write silently diverges

**What goes wrong:** JSON and typed columns disagree after a partial write. **How:** one DB transaction, parity counters, fail closed on typed-write error, and keep snapshot rollback available. [ASSUMED]

### Pitfall 4: Worker duplicates provider effects

**What goes wrong:** Lease expiry causes two workers to commit/purge the same provider object. **How:** operation idempotency key, provider object lookup by upload ID, state transition checks, and bounded leases. Existing Google adapter already checks `hippy_upload_id` before commit. [VERIFIED: file-service/src/google-drive.js:124-163; quote: `existingUpload(uploadId)` and `if (already && Number(already.size) === stat.size)`]

### Pitfall 5: Cache fixes only the CDN, not the service worker

**What goes wrong:** HTML updates but an old service worker serves cached shell/chunks. **How:** no-store navigation/SW, explicit cache versioning, `skipWaiting`/`clients.claim` review, and post-deploy browser check. [VERIFIED: file-web/public/sw.js:1-13]

### Pitfall 6: Live Drive UAT proves health only

**What goes wrong:** `/health` says provider available while real OAuth refresh, upload resume, quota and recovery are untested. **How:** require the matrix above and record real browser/API evidence; F5 fake-provider status cannot be reused as live proof. [VERIFIED: docs/file-storage/phase-f5/STATUS.md:20-42]

## Runtime State Inventory

This phase is a migration/refactor, so runtime state was checked explicitly:

| Category | Items Found | Action Required |
|---|---|---|
| Stored data | PostgreSQL tables contain JSON `record` snapshots; provider upload staging/session files live under `FILE_DATA_DIR`; Redis stores `file-job:*` hashes/sets when configured. [VERIFIED: file-service/src/postgres-store.js:21-39; file-service/src/job-queue.js:17-22; file-service/src/google-drive.js:30-31] | Schema expand/backfill and queue/session compatibility migration; do not delete old records until parity and restore checks pass. |
| Live service config | Compose/env controls DB, Redis, provider type, OAuth credentials, root folder and web/API origins. [VERIFIED: docs/file-storage/docker-compose.file-pwa.yml:28-48] | Version and validate config; keep secrets in deployment secret store; no code migration of secret values unless names change. |
| OS-registered state | No launchd/systemd/PM2 registrations for File PWA were found under repository-scoped files. [VERIFIED: repository `rg --files` audit this session] | Deployment should document the worker supervisor/Compose restart policy; verify host configuration during staging, because it is not represented in git. |
| Secrets/env vars | `FILE_GOOGLE_REFRESH_TOKEN`, OAuth client fields, DB/Redis URLs, lifecycle sync secret and session secret are runtime inputs. [VERIFIED: docs/file-storage/docker-compose.file-pwa.yml:35-48; file-service/src/config.js] | Preserve names, rotate through secret store, never copy into migration rows/logs/browser bundles. |
| Build artifacts/installed packages | `.next` artifacts and `node_modules` are present locally; clean deployment must rebuild from tracked source. [VERIFIED: repository file inventory and file-web/Dockerfile:1-31] | Rebuild/tag images per commit; purge/revalidate HTML/SW; do not ship local `.next` as source of truth. |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---:|---|---|
| Node.js | service/web tests and build | yes | `v26.5.0` local; containers target Node 22 | Use container baseline for parity. |
| npm | package scripts | yes | `11.17.0` | — |
| Docker | Compose/live-like UAT | yes | `29.6.1` | — |
| PostgreSQL CLI | migration/restore checks | yes | command found; server not probed | Run DB through Compose if no local server. |
| Redis CLI | queue checks | not found in local shell probe | — | Use Compose `redis:7-alpine` and service integration tests. |
| Live Google OAuth/Drive account | live UAT | not verified in this session | — | Blocks F6-LIVE promotion; fake provider remains test fallback. |
| In-app browser | manual visual UAT | unavailable in F5 evidence | — | Use Playwright/production scripts only for automated evidence; manual gate remains open. |

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Node built-in `node:test` for service/web tests |
| Config file | None; scripts in `file-service/package.json` and `file-web/package.json` |
| Quick run command | `cd file-service && npm test`; `cd file-web && npm test` |
| Full suite command | `cd file-service && npm run check && cd ../file-web && npm run lint && npm test && npm run build` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test type | Automated command | File exists? |
|---|---|---|---|---|
| F6-REL | Clean build serves one build ID, coherent chunks and no runtime console error | smoke/e2e | `node scripts/production-file-uat.mjs` plus a new release smoke script | Partial; add Wave 0 smoke fixture |
| F6-ACTIONS | Download/preview/trash/restore are authorized and mutate/render correctly | integration + web regression | `cd file-service && node --test test/service.test.js`; `cd ../file-web && node --test test/main-regression.test.js` | Existing tests need cases |
| F6-FAVORITES | Star survives reload and cannot cross user scope | integration + web | new service star tests and web API/main tests | Missing; Wave 0 |
| F6-LIST | Filters/cursors stable, bounded and scoped | integration | new service list/search tests | Missing; Wave 0 |
| F6-UPLOAD | Refresh/reconnect resumes, cancel releases quota, duplicate chunk is safe | integration + browser | new service upload status tests and browser queue tests | Missing; Wave 0 |
| F6-BULK | Bulk returns per-item outcomes and partial failure is reconciled | integration | new service bulk tests | Missing; Wave 0 |
| F6-WORKER | Lease/retry/dead-letter and scheduled maintenance are idempotent | integration | new worker tests with fake Redis or Compose Redis | Missing; Wave 0 |
| F6-DB | Snapshot/typed parity and rollback | migration/integration | new migration parity script against a disposable Postgres | Missing; Wave 0 |
| F6-LIVE | Real Drive OAuth, upload/download/retry/recovery and promotion evidence | manual/e2e | `scripts/run-production-file-uat.mjs` after credentials and staging are available | Existing script; live evidence missing |

### Sampling Rate

- **Per task commit:** targeted `node --test` file plus `npm run lint` for touched package.
- **Per wave merge:** complete service tests, web tests/lint/build, migration parity checks and Compose health checks.
- **Phase gate:** full suite, release smoke, backup/restore, worker maintenance run, security/IDOR checks and live-provider UAT evidence before `$gsd-verify-work`.

### Wave 0 Gaps

- Add service contract fixtures for stars, typed filters/cursors, preview/activity, upload status/cancel, bulk outcomes and operation status.
- Add browser IndexedDB test adapter and multi-file queue fixtures.
- Add disposable PostgreSQL migration/backfill/parity harness.
- Add worker lease/retry tests with Redis Compose; local `redis-cli` is unavailable.
- Add release smoke script that verifies build ID, HTML/SW cache headers, chunk coherence and console errors.
- Add live Google credential/staging checklist; this is a human/environment gate, not a package install.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard control |
|---|---:|---|
| V2 Authentication | yes | Existing OIDC Authorization Code + PKCE/session validation; no browser provider credentials. [VERIFIED: docs/file-storage/API-CONTRACT.md:3-8] |
| V3 Session Management | yes | HttpOnly session, lifecycle/revocation checks, five-minute upload grace only. [VERIFIED: docs/file-storage/API-CONTRACT.md:82-90; file-service/README.md:8-18] |
| V4 Access Control | yes | Resolve actor to `file_user_id`; scope nodes/uploads/cursors/operations; admin step-up for purge/export/recovery. [VERIFIED: docs/file-storage/API-CONTRACT.md:55-80] |
| V5 Input Validation | yes | Validate names, MIME/size, cursor/filter bounds, batch size, upload ranges and safe preview MIME; use existing error envelope. [VERIFIED: file-service/src/server.js:8-9,183-185; docs/file-storage/API-CONTRACT.md:20-36] |
| V6 Cryptography | yes | Use existing cryptographic IDs/idempotency/session mechanisms; never hand-roll provider token storage or expose refresh tokens. [VERIFIED: file-service/src/server.js:11-12; docs/file-storage/THREAT-MODEL.md:5-16] |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Mitigation |
|---|---|---|
| Cross-user node/provider ID or cursor | Elevation of privilege | Scope every query by authenticated user, bind cursor to actor/filter, and check provider ID through metadata. |
| Permanent preview/download URL | Information disclosure | Stream through API with authorization and short-lived request context; never return Drive URLs. |
| Duplicate retry/worker execution | Tampering/repudiation | Actor-scoped idempotency keys, provider upload ID lookup, job leases and audit events. |
| Upload body/log leakage | Information disclosure | Do not log content/tokens; cap error details and redact provider responses. |
| Cache mixing old/new bundles | Tampering/availability | No-store HTML/SW, immutable hashed assets, build-ID smoke verification and rollbackable image tags. |
| Maintenance/purge overreach | Destruction | Step-up for manual admin purge; worker uses bounded idempotent state transitions and retention cutoff; never purge active nodes. |

## Code Examples

### Existing provider-safe resumable commit

The adapter probes an existing Google session, resumes from the returned `Range`, and checks an existing upload by opaque upload ID before creating a duplicate. [VERIFIED: file-service/src/google-drive.js:124-195; quote: `existingUpload(uploadId)`, `content-range`, and `if (response.status === 308)`.] The planner should preserve this behavior while adding API status/cancel and browser persistence.

### Existing authorization boundary

The API's node lookup requires both node ID and authenticated user ID: `state.nodes.find(n => n.id === nodeId && n.file_user_id === user.id ...)`. [VERIFIED: file-service/src/server.js:63; quote exact predicate.] New preview/activity/star/bulk/status routes must use the same scope before reading or mutating any row.

## State of the Art

| Old approach | Current approach for F6 | Impact |
|---|---|---|
| React-only stars/actions | API-confirmed durable metadata and action responses | Reload and multi-device behavior become correct. |
| Client-array search/localized date strings | Typed server filters, ISO timestamps and keyset cursors | Bounded, stable list behavior. |
| Sequential browser bulk calls | Bounded server bulk mutation with per-item results/operation status | Partial failures are visible and retryable. |
| Admin-only maintenance hook | Scheduled worker using same idempotent handler | Retention and reservations no longer depend on manual calls. |
| Whole-state JSON snapshot rewrite | Typed incremental writes with snapshot rollback | Lower contention and queryable activity/search. |
| Fake-provider-only gate | Real OAuth/Drive UAT plus second-byte recovery gate | Production decision reflects actual provider behavior. |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | Native IndexedDB plus a small local queue is sufficient without a new library. | Standard Stack / Upload | Browser compatibility or queue complexity may require a reviewed dependency. |
| A2 | Keyset cursor ordering and cursor integrity are preferred for the pilot. | Search / Alternatives | Product may require arbitrary sorting or offset-compatible URLs. |
| A3 | A MIME allowlist and bounded stream/range behavior are acceptable preview semantics. | Actions / Security | Product may need a richer document preview service. |
| A4 | One worker image/process can own maintenance and provider jobs initially. | Worker | Deployment may require an external scheduler or separate scaling profile. |
| A5 | Live Google credentials, organizational account ownership and staging access can be supplied before F6-LIVE. | Live UAT | Without them, promotion remains blocked even if code tests pass. |

## Open Questions (RESOLVED)

1. **Inline preview types and size — D-03.** Support PNG, JPEG, WebP, GIF, `text/plain`, and PDF up to 25 MiB through the authorized API stream. SVG, HTML, unsafe MIME types, and larger files use the attachment-download fallback.
2. **Starred storage — D-08.** Store nullable `starred_at` in the existing private node record during F6-03. F6-06 projects it into typed node columns. A separate user-node relation is unnecessary while sharing remains outside MVP.
3. **Production worker scheduling — D-07.** The dedicated Compose worker owns scheduling through Redis Streams `file:jobs:v1`, consumer group `file-workers-v1`, an atomic Redis scheduler lock, `XAUTOCLAIM`, AOF persistence, and `file:jobs:dead:v1`. No host cron is required for the phase contract.
4. **Snapshot rollback window — D-09.** Require at least 24 hours of zero-divergence shadow reads before typed-read cutover. Retain JSON `record`, snapshot dual-writes, and the emergency snapshot-read flag through all of F6; removal belongs to a later cleanup only after backup/restore evidence and production observation pass.
5. **Browser file retention after reload — D-05.** Persist queue metadata and an optional permitted `FileSystemFileHandle`, never file bytes. When the handle is absent or permission is lost, preserve the server session/offset and show `needs_file_reselect`; this does not claim offline upload support.

## Sources

### Primary (HIGH confidence)

- `docs/file-storage/phase-f5/UI-REVIEW.md` - UI gaps and evidence.
- `docs/file-storage/PRODUCT-BRIEF.md` - MVP constraints and invariants.
- `docs/file-storage/API-CONTRACT.md` - auth, idempotency, errors and endpoint scope.
- `docs/file-storage/ARCHITECTURE.md` - data model and provider boundary.
- `file-service/src/server.js`, `src/postgres-store.js`, `src/job-queue.js`, `src/google-drive.js` - current runtime behavior.
- `file-web/src/main.jsx`, `src/api.js`, `public/sw.js` - current UI/API/cache behavior.
- `file-service/migrations/0001_file_storage.sql`, package manifests and Compose/Nginx files - schema, versions and deployment.

### Secondary (MEDIUM confidence)

- [MDN IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) - browser durable storage API reference.
- [PostgreSQL documentation: indexes](https://www.postgresql.org/docs/current/indexes.html) - index/query planning reference.
- [Google Drive API resumable uploads](https://developers.google.com/drive/api/guides/manage-uploads) - provider protocol reference; live behavior still requires account UAT.

### Tertiary (LOW confidence)

- No web-search provider was available in this session; operational recommendations marked `[ASSUMED]` require planner/user confirmation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - versions and dependencies read from repository manifests/Compose.
- Architecture: HIGH - current routes, migrations, provider and product contracts inspected directly.
- Pitfalls/migration operations: MEDIUM - repository evidence is strong, but final scheduler, preview limits, cursor encoding and live Drive behavior require staging decisions.

**Research date:** 2026-10-01
**Valid until:** 2026-10-31, or until API/storage/deployment contracts change.
