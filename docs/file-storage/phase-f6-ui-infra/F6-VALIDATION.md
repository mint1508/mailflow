---
phase: f6-ui-infra
plan: F6-VALIDATION
type: execute
wave: 0
depends_on: []
requirements: [F6-REL, F6-ACTIONS, F6-FAVORITES, F6-LIST, F6-UPLOAD, F6-BULK, F6-WORKER, F6-DB, F6-LIVE]
autonomous: true
files_modified:
  - .github/file-pwa-source-manifest.txt
  - scripts/verify-file-pwa-source-manifest.mjs
  - scripts/file-pwa-validate.sh
  - file-service/test/helpers/app-fixture.js
  - file-web/test/helpers/memory-upload-store.js
  - scripts/file-pwa-contract-uat.mjs
must_haves:
  truths: ["Every later plan has a runnable automated gate", "Required File PWA sources are tracked", "HTTP and upload-queue fixtures exist before behavior changes"]
  artifacts: ["scripts/file-pwa-validate.sh", ".github/file-pwa-source-manifest.txt", "scripts/file-pwa-contract-uat.mjs"]
  key_links: ["source manifest -> clean checkout gate", "shared fixtures -> service/web tests -> phase validation"]
---

# F6 Wave 0 - Validation Harness

<tasks>

<task type="tracer">
  <name>Task 1: Establish tracked-source manifest and clean-checkout verifier</name>
  <files>.github/file-pwa-source-manifest.txt, scripts/verify-file-pwa-source-manifest.mjs</files>
  <action>List every required File PWA source/config/lockfile path, excluding node_modules, .next, secrets, runtime data, and evidence. The verifier must assert every entry is returned by git ls-files, every package/Docker entry exists, and no ignored output is listed. Support --root for a temporary git archive checkout.</action>
  <verify><automated>node scripts/verify-file-pwa-source-manifest.mjs --root .</automated></verify>
  <done>The command fails on an untracked/missing required source and passes from a clean archive checkout.</done>
</task>

<task type="auto">
  <name>Task 2: Create reusable service and browser-state test fixtures</name>
  <files>file-service/test/helpers/app-fixture.js, file-web/test/helpers/memory-upload-store.js</files>
  <action>Extract a start/stop HTTP app fixture with isolated temp storage and deterministic auth/provider state. Create an injected in-memory upload queue storage implementation so Node tests exercise queue behavior without a fake IndexedDB package. Fixtures clean their own temp state.</action>
  <verify><automated>cd file-service &amp;&amp; node --test --test-concurrency=1 test/service.test.js &amp;&amp; cd ../file-web &amp;&amp; node --test</automated></verify>
  <done>Both suites pass using deterministic reusable fixtures and no new package.</done>
</task>

<task type="auto">
  <name>Task 3: Add canonical phase validation and contract UAT runners</name>
  <files>scripts/file-pwa-validate.sh, scripts/file-pwa-contract-uat.mjs</files>
  <action>Create one fail-fast shell gate for source manifest, service check, web lint/test/build, compose config, shell syntax, and git diff check. Create a configurable authenticated UAT runner writing redacted JSON to artifacts/file-pwa/f6/contract-uat.json without logging credentials or content.</action>
  <verify><automated>bash scripts/file-pwa-validate.sh</automated></verify>
  <done>The single command exercises all local gates and the UAT runner emits a redacted artifact when a stack URL is supplied.</done>
</task>

</tasks>

## Validation matrix

| Contract | Automated evidence |
| --- | --- |
| Release/source/cache | manifest verifier, web build, F6-01 smoke |
| Actions/auth | service HTTP fixture, web API tests, contract UAT |
| Stars/list/activity | service contract tests and cursor fixtures |
| Upload/bulk | injected queue store and HTTP range/idempotency tests |
| Worker | Redis integration tests under F6-05 compose profile |
| DB migration | disposable PostgreSQL tests under F6-06 compose profile |
| Live Drive | F6-07 redacted live artifact; excluded from local CI |

## Threat model

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Test fixture leaks secrets/content | high | mitigate | deterministic fake data, temp cleanup, redacted artifacts |
| Manifest omits required source | high | mitigate | explicit tracked-path index plus clean archive execution |
