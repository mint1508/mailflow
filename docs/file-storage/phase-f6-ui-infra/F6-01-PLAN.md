---
phase: f6-ui-infra
plan: F6-01
type: execute
wave: 1
depends_on: [F6-VALIDATION]
requirements: [F6-REL]
autonomous: true
files_modified: [.github/workflows/ci.yml, .github/workflows/file-pwa.yml, file-service/Dockerfile, file-web/Dockerfile, file-web/next.config.mjs, file-web/app/layout.jsx, file-web/public/sw.js, docs/file-storage/docker-compose.production.yml, docs/file-storage/nginx/files.hippy.vn.conf, docs/file-storage/nginx/files-api.hippy.vn.conf, scripts/file-pwa-release-smoke.mjs, file-web/test/release-cache.test.js, docs/file-storage/phase-f6-ui-infra/RELEASE-RUNBOOK.md]
estimate: {raw_tokens: 18000, tokens: 18000, tasks: 3, confidence: low}
must_haves:
  truths: ["Clean checkout builds the File PWA", "Every deployed shell exposes one immutable build ID", "HTML/SW cannot pin stale chunks"]
  artifacts: [".github/workflows/file-pwa.yml", "scripts/file-pwa-release-smoke.mjs", "docs/file-storage/phase-f6-ui-infra/RELEASE-RUNBOOK.md"]
  key_links: ["source manifest -> CI checkout -> Docker digest -> Nginx cache policy -> smoke artifact"]
---

# F6-01 - Release, Source Tracking, and Cache Integrity

<tasks>

<task type="tracer">
  <name>Task 1: Prove a clean checkout produces versioned service and web images</name>
  <files>.github/workflows/ci.yml, .github/workflows/file-pwa.yml, file-service/Dockerfile, file-web/Dockerfile, docs/file-storage/docker-compose.production.yml</files>
  <action>Per D-01, add File PWA CI using Node 22 and lockfiles: run the Wave 0 manifest verifier, npm ci/check for service, npm ci/lint/test/build for web, then build both images. Pass FILE_BUILD_SHA/FILE_RELEASE_VERSION into both images and label them with git revision. The workflow must verify the exact digest it built; do not install packages or rely on a dirty checkout.</action>
  <verify><automated>node scripts/verify-file-pwa-source-manifest.mjs --root . &amp;&amp; cd file-service &amp;&amp; npm ci &amp;&amp; npm run check &amp;&amp; cd ../file-web &amp;&amp; npm ci &amp;&amp; npm run lint &amp;&amp; npm test &amp;&amp; npm run build &amp;&amp; cd .. &amp;&amp; docker compose -f docs/file-storage/docker-compose.production.yml config &gt;/tmp/f6-compose.yml</automated></verify>
  <done>A clean checkout passes manifest, package, build, and compose gates and both images carry the same revision.</done>
</task>

<task type="auto">
  <name>Task 2: Enforce build identity and cache policy</name>
  <files>file-web/next.config.mjs, file-web/app/layout.jsx, file-web/public/sw.js, docs/file-storage/nginx/files.hippy.vn.conf, docs/file-storage/nginx/files-api.hippy.vn.conf, file-web/test/release-cache.test.js</files>
  <action>Expose the non-secret build SHA in a meta tag and GET /build-info.json. Set HTML, build-info, manifest, and /sw.js to no-store; serve /_next/static hashed assets with public,max-age=31536000,immutable. Per D-01, set API/auth/preview/download no-store and retain upload/download buffering/timeouts. Version SW caches by build SHA, use network-first navigation, and never cache API/provider responses.</action>
  <verify><automated>cd file-web &amp;&amp; node --test test/release-cache.test.js &amp;&amp; npm run build &amp;&amp; rg -n "no-store|immutable|/_next/static|/sw.js" ../docs/file-storage/nginx/files.hippy.vn.conf ../docs/file-storage/nginx/files-api.hippy.vn.conf</automated></verify>
  <done>Automated tests prove cache classification and a build change creates a new SW cache/build ID.</done>
</task>

<task type="auto">
  <name>Task 3: Gate deployment on coherent remote assets</name>
  <files>scripts/file-pwa-release-smoke.mjs, .github/workflows/file-pwa.yml, docs/file-storage/phase-f6-ui-infra/RELEASE-RUNBOOK.md</files>
  <action>Fetch HTML/build-info/SW/chunks and API health, assert a single expected build ID and correct cache headers, and write artifacts/file-pwa/f6/release-smoke.json. When BROWSER_SMOKE_URL is configured, run the approved browser harness and fail on console errors including the historical List reference. Redact cookies/tokens/provider IDs. Document exact deploy, purge, verify, and digest rollback commands.</action>
  <verify><automated>node scripts/file-pwa-release-smoke.mjs --base-url http://127.0.0.1:4300 --api-url http://127.0.0.1:4310 --expected-build-id local-f6 --output artifacts/file-pwa/f6/release-smoke.json &amp;&amp; node -e "const r=require('./artifacts/file-pwa/f6/release-smoke.json');if(!r.ok)process.exit(1)"</automated></verify>
  <done>Release promotion consumes a redacted passing smoke artifact tied to the deployed digest.</done>
</task>

</tasks>

## Threat model and rollback

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Missing/untracked source in image | high | mitigate | Wave 0 manifest plus clean checkout CI |
| Mixed or stale shell/SW | high | mitigate | build-bound cache, no-store shell/SW, remote smoke |

Rollback to the prior immutable digest, purge HTML/SW only, and retain old hashed assets until references expire.
