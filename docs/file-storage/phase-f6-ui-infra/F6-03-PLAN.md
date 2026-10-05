---
phase: f6-ui-infra
plan: F6-03
type: execute
wave: 2
depends_on: [F6-02]
requirements: [F6-FAVORITES, F6-LIST]
autonomous: true
files_modified: [docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, docs/file-storage/file-pwa.env.example, file-service/src/config.js, file-service/src/cursor.js, file-service/src/server.js, file-service/test/cursor.test.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/main.jsx, file-web/test/api.test.js, file-web/test/main-regression.test.js, docs/file-storage/phase-f6-ui-infra/LIST-CONTRACT.md]
estimate: {raw_tokens: 24000, tokens: 24000, tasks: 3, confidence: low}
must_haves:
  truths: ["Stars survive service/browser reload", "Activity is persisted audit data", "List/search/filter uses bounded signed cursors"]
  artifacts: ["file-service/src/cursor.js", "file-service/test/cursor.test.js", "docs/file-storage/phase-f6-ui-infra/LIST-CONTRACT.md"]
  key_links: ["filter UI -> API query -> owner-scoped sort -> signed v1 cursor -> next page"]
---

# F6-03 - Durable Stars, Activity, and Server List/Search

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Persist one star and reload the Starred view</name>
  <files>docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, file-service/src/server.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/main.jsx, file-web/test/api.test.js, file-web/test/main-regression.test.js</files>
  <behavior>PATCH star writes starred_at; replay returns same result; GET nodes?starred=true returns only owned starred nodes; browser reload renders it starred.</behavior>
  <action>Per D-08, add starred_at inside existing node records only; do not create/modify SQL migrations. Document PATCH /api/files/nodes/:id/star and starred query ownership. Scope by authenticated user, require Idempotency-Key, audit star/unstar, and remove local starredIds as source of truth.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-name-pattern="star" test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test --test-name-pattern="star" test/api.test.js test/main-regression.test.js</automated></verify>
  <done>A star survives a new app/service instance backed by the same store and appears only for its owner.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Implement versioned signed cursor list/search</name>
  <files>docs/file-storage/API-CONTRACT.md, docs/file-storage/file-pwa.env.example, file-service/src/config.js, file-service/src/cursor.js, file-service/src/server.js, file-service/test/cursor.test.js, file-service/test/service.test.js, docs/file-storage/phase-f6-ui-infra/LIST-CONTRACT.md</files>
  <behavior>D-04 v1 cursor round-trips; tamper/expiry/actor/filter mismatch returns file_validation_failed; concurrent updates do not duplicate IDs across pages; limit caps at 200.</behavior>
  <action>Implement HMAC cursor codec from D-04 with payload {v,sub,filter_hash,updated_at,id,exp}; require FILE_CURSOR_SECRET in production, document it in the env example, and derive a deterministic test secret otherwise. Add typed q,parent_id,state,kind,mime_family,updated_after,updated_before,starred,limit,cursor to nodes/search. Sort updated_at DESC,id DESC and return {nodes,page:{next_cursor,has_more}}. Owner remains implicit.</action>
  <verify><automated>cd file-service &amp;&amp; node --test test/cursor.test.js &amp;&amp; node --test --test-name-pattern="pagination|filter|search" test/service.test.js</automated></verify>
  <done>All list/search paths are bounded, stable, owner-scoped, and protected from cursor tampering.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Render server filters, ISO metadata, and real activity</name>
  <files>docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, file-service/src/server.js, file-service/test/service.test.js, file-web/src/api.js, file-web/src/main.jsx, file-web/test/api.test.js, file-web/test/main-regression.test.js</files>
  <behavior>GET node activity returns newest-first bounded owned audit events; UI sends typed filters/cursor; created_at/updated_at display from ISO; next-page appends without local date/owner filtering.</behavior>
  <action>Document and add GET /api/files/nodes/:id/activity?limit=50&amp;cursor=..., redact metadata, and exclude admin-only fields. Replace client array filtering with query params and per-view cursor state. Remove fabricated activity/date content and load activity when the tab opens.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-name-pattern="activity|filter|pagination" test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test test/api.test.js test/main-regression.test.js &amp;&amp; npm run lint &amp;&amp; npm run build</automated></verify>
  <done>Starred, Recent, Trash, search, advanced filters, and Activity use persisted server data.</done>
</task>

</tasks>

## Threat model and rollback

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Cursor tampering/cross-user traversal | high | mitigate | D-04 signed actor/filter-bound v1 cursor |
| Sensitive audit metadata disclosure | high | mitigate | bounded allowlist and owner scope |

Feature flags `FILE_CURSOR_PAGINATION_ENABLED` and `FILE_NODE_ACTIVITY_ENABLED` may revert reads to the existing bounded snapshot path; existing node/audit data stays intact.
