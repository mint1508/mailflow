---
phase: f6-ui-infra
plan: F6-02
type: execute
wave: 1
depends_on: [F6-VALIDATION]
requirements: [F6-ACTIONS]
autonomous: true
files_modified: [docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, file-service/src/server.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/main.jsx, file-web/test/api.test.js, file-web/test/main-regression.test.js, docs/file-storage/phase-f6-ui-infra/ACTIONS-UAT.md]
estimate: {raw_tokens: 20000, tokens: 20000, tasks: 3, confidence: low}
must_haves:
  truths: ["Visible actions call authorized APIs", "Preview streams safe provider bytes", "MVP UI has no sharing affordance or fabricated details"]
  artifacts: ["docs/file-storage/API-CONTRACT.md", "file-service/test/service.test.js", "docs/file-storage/phase-f6-ui-infra/ACTIONS-UAT.md"]
  key_links: ["UI control -> fileApi -> owner-scoped route -> provider/audit -> reconciled UI"]
---

# F6-02 - Truthful Visible Actions and Authorized Preview

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Preview one owned image through the service</name>
  <files>docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, file-service/src/server.js, file-service/test/service.test.js, file-web/src/api.js, file-web/test/api.test.js</files>
  <behavior>Owned PNG returns 200 inline with nosniff; another user receives 404; SVG/HTML/over-25-MiB returns 415 preview_unsupported while attachment download remains available.</behavior>
  <action>Document GET /api/files/nodes/:id/preview and tier ownership first. Implement per D-01/D-03: resolve the node by authenticated file_user_id, stream through provider, never expose Drive URL/provider ID, set Content-Disposition inline and X-Content-Type-Options nosniff, and use the stable error envelope. Add fileApi.previewBlob/object-URL handling.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-name-pattern="preview" test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test --test-name-pattern="preview" test/api.test.js</automated></verify>
  <done>The owned safe preview path works end-to-end and unsafe/cross-user paths fail safely.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Make download, trash, restore, and details authoritative</name>
  <files>file-service/src/server.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/main.jsx, file-web/test/api.test.js, file-web/test/main-regression.test.js</files>
  <behavior>Overflow/details delete calls trash exactly once; success appears after response; undo restores; download uses attachment route; created/updated fields come from node data.</behavior>
  <action>Replace both erroneous toggleStar delete handlers with fileApi.trash, reuse one lifecycle action controller, reconcile list/details after the response, and keep undo for successful trash. Use fileApi.download for every download control. Remove hardcoded dates/activity from details; F6-03 will populate activity. Keep actor-scoped idempotency/audit on mutations.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-name-pattern="trash|restore|download" test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test test/api.test.js test/main-regression.test.js &amp;&amp; npm run lint &amp;&amp; npm run build</automated></verify>
  <done>No action emits success before its API response and no destructive handler changes star state.</done>
</task>

<task type="auto">
  <name>Task 3: Remove sharing claims and capture action UAT</name>
  <files>file-web/src/main.jsx, file-web/test/main-regression.test.js, docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, docs/file-storage/phase-f6-ui-infra/ACTIONS-UAT.md, scripts/file-pwa-contract-uat.mjs</files>
  <action>Per D-02, remove Shared navigation/view and explicitly retain sharing as an API/architecture non-goal. Extend contract UAT to upload, preview, download, trash, list Trash, restore, and cross-user denial; write artifacts/file-pwa/f6/actions-uat.json containing request IDs/status codes only.</action>
  <verify><automated>cd file-web &amp;&amp; node --test --test-name-pattern="sharing|file actions" test/main-regression.test.js &amp;&amp; cd .. &amp;&amp; FILE_UAT_OUTPUT=artifacts/file-pwa/f6/actions-uat.json node scripts/file-pwa-contract-uat.mjs --suite actions</automated></verify>
  <done>UI has no Shared route and action UAT proves the authorized lifecycle path.</done>
</task>

</tasks>

## Threat model and rollback

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Preview IDOR/provider URL exposure | critical | mitigate | owner lookup, opaque provider data, service stream |
| Active-content preview | high | mitigate | D-03 allowlist, nosniff, size cap, attachment fallback |

Disable preview through `FILE_PREVIEW_ENABLED=false` and retain attachment download; no data migration is involved.
