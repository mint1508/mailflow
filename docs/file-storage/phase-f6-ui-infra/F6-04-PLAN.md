---
phase: f6-ui-infra
plan: F6-04
type: execute
wave: 3
depends_on: [F6-03]
requirements: [F6-UPLOAD, F6-BULK]
autonomous: true
files_modified: [docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, file-service/src/server.js, file-service/src/storage.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/upload-queue.js, file-web/src/main.jsx, file-web/test/api.test.js, file-web/test/upload-queue.test.js, file-web/test/main-regression.test.js]
estimate: {raw_tokens: 28000, tokens: 28000, tasks: 3, confidence: low}
must_haves:
  truths: ["Upload intent/offset survives reload", "Cancel releases reservation", "Bulk partial outcomes are explicit"]
  artifacts: ["file-web/src/upload-queue.js", "file-web/test/upload-queue.test.js", "docs/file-storage/API-CONTRACT.md"]
  key_links: ["IndexedDB metadata -> upload status -> Content-Range -> provider confirmation -> completed UI"]
---

# F6-04 - Durable Resumable Uploads and Bulk Operations

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Resume one interrupted upload from authoritative offset</name>
  <files>docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, file-service/src/server.js, file-service/src/storage.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/upload-queue.js, file-web/test/api.test.js, file-web/test/upload-queue.test.js</files>
  <behavior>GET upload status returns offset/state; matching Content-Range appends; gap/overlap returns 409 file_conflict with expected_offset; reload resumes; completed only after provider confirm.</behavior>
  <action>Document GET status, PATCH chunk Content-Range, POST cancel, and state machine pending/uploading/ready/finalizing/completed/failed/canceled. Per D-05/D-10, persist queue metadata and optional handle only, reconcile server offset before every resume, and return needs_file_reselect when access is unavailable. Use explicit stable idempotency keys per logical create/finalize/cancel.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-name-pattern="upload status|content-range|resume" test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test test/upload-queue.test.js test/api.test.js</automated></verify>
  <done>An interrupted upload resumes at the server offset without duplicate bytes or premature success.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Cancel/retry and render a durable multi-file queue</name>
  <files>file-service/src/server.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/upload-queue.js, file-web/src/main.jsx, file-web/test/upload-queue.test.js, file-web/test/main-regression.test.js</files>
  <behavior>Cancel replay is stable and releases held quota; reload restores all queue rows; retry uses bounded exponential backoff; revoked uploads stop after grace; each row exposes progress/error/reselect/cancel.</behavior>
  <action>Implement idempotent cancel and provider staging discard. Build multi-file coordinator with AbortController, max three active uploads, retry delays capped at 30 seconds, and status reconciliation. Keep queue accessible/localized and remove a row only after confirmed completion or acknowledged cancel.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-name-pattern="cancel|reservation|revoked" test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test test/upload-queue.test.js test/main-regression.test.js &amp;&amp; npm run build</automated></verify>
  <done>Multiple uploads survive reload, show honest states, and cancel without quota leakage.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Execute bounded bulk lifecycle actions with reconciliation</name>
  <files>docs/file-storage/API-CONTRACT.md, file-service/src/server.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/main.jsx, file-web/test/api.test.js, file-web/test/main-regression.test.js</files>
  <behavior>Up to 100 IDs return ordered per-item outcomes; cross-user IDs are not found; replay is stable; UI shows failures and undo only for successful trash IDs.</behavior>
  <action>Per D-06, add POST /api/files/nodes/bulk with action trash|restore, deduplicated IDs, best-effort independent outcomes, one actor-scoped idempotency result, and audit summary plus item request IDs. Replace sequential UI loop, show outcome counts/details, and reload the current cursor view after completion.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-name-pattern="bulk" test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test --test-name-pattern="bulk" test/api.test.js test/main-regression.test.js</automated></verify>
  <done>Bulk partial success is deterministic, visible, replayable, and reconciled.</done>
</task>

</tasks>

## Threat model and rollback

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Offset/quota/duplicate upload abuse | critical | mitigate | server offset, reservation, idempotency, provider confirmation |
| Browser storage leakage | high | mitigate | D-05 metadata/handle only |

Flags disable auto-resume and bulk UI while status/cancel/single-item routes remain. Never reset server offsets or delete committed provider bytes during rollback.
