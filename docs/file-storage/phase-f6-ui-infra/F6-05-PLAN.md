---
phase: f6-ui-infra
plan: F6-05
type: execute
wave: 4
depends_on: [F6-04]
requirements: [F6-WORKER]
autonomous: true
files_modified: [docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, docs/file-storage/file-pwa.env.example, docs/file-storage/docker-compose.file-pwa.yml, docs/file-storage/docker-compose.production.yml, file-service/src/config.js, file-service/src/job-queue.js, file-service/src/jobs/handlers.js, file-service/src/worker.js, file-service/src/server.js, file-service/test/worker.test.js, file-service/test/service.test.js, docs/file-storage/phase-f6-ui-infra/WORKER-RUNBOOK.md]
estimate: {raw_tokens: 26000, tokens: 26000, tasks: 3, confidence: low}
must_haves:
  truths: ["Jobs survive worker restart", "Maintenance has a durable schedule", "Users/admins can inspect safe operation status"]
  artifacts: ["file-service/src/worker.js", "file-service/src/jobs/handlers.js", "file-service/test/worker.test.js"]
  key_links: ["API enqueue -> Redis Stream/group -> lease claim -> handler -> operation status/metrics"]
---

# F6-05 - Durable Worker, Scheduled Maintenance, and Operation Status

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Enqueue, claim, and complete one durable provider operation</name>
  <files>docs/file-storage/API-CONTRACT.md, docs/file-storage/ARCHITECTURE.md, file-service/src/config.js, file-service/src/job-queue.js, file-service/src/jobs/handlers.js, file-service/src/worker.js, file-service/src/server.js, file-service/test/worker.test.js, file-service/test/service.test.js</files>
  <behavior>API writes Redis Stream job and 202 operation ID; worker consumer group claims once; completion is durable; owner can GET status; another user cannot; worker restart claims stale pending entry.</behavior>
  <action>Implement D-07 exactly: stream/group/DLQ names, XADD payload schema v1, XREADGROUP, XACK, XAUTOCLAIM after lease timeout, attempts/next_retry_at, and max attempts. Redis must use appendonly yes everysec in production compose. Operation payloads contain internal node/upload IDs only and status responses redact queue/provider details.</action>
  <verify><automated>docker compose -f docs/file-storage/docker-compose.file-pwa.yml up -d redis &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml run --rm -e FILE_REDIS_URL=redis://redis:6379 file-service node --test test/worker.test.js &amp;&amp; cd file-service &amp;&amp; node --test --test-name-pattern="operation status" test/service.test.js</automated></verify>
  <done>A job survives worker termination and is reclaimed/completed once with authorized status.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Schedule maintenance and reconciliation durably</name>
  <files>file-service/src/jobs/handlers.js, file-service/src/worker.js, file-service/src/server.js, file-service/test/worker.test.js, docs/file-storage/phase-f6-ui-infra/WORKER-RUNBOOK.md</files>
  <behavior>Maintenance scheduler enqueues once per interval across workers; rerun is idempotent; expired reservations release/discard staging; purge respects retention; reconcile reports without silent deletion.</behavior>
  <action>Use a Redis SET NX PX scheduler lock and durable last-success keys for maintenance/reconcile. Extract existing admin logic into shared handlers. Admin endpoints enqueue the same job. Add queue depth, pending age, retries, DLQ, maintenance age, and anomaly metrics/health fields with alert thresholds.</action>
  <verify><automated>docker compose -f docs/file-storage/docker-compose.file-pwa.yml run --rm -e FILE_REDIS_URL=redis://redis:6379 file-service node --test --test-name-pattern="maintenance|scheduler|reconcile" test/worker.test.js test/service.test.js</automated></verify>
  <done>Retention and reconciliation run without operator calls and are safe under duplicate scheduling.</done>
</task>

<task type="auto">
  <name>Task 3: Deploy and recover the worker process</name>
  <files>docs/file-storage/file-pwa.env.example, docs/file-storage/docker-compose.file-pwa.yml, docs/file-storage/docker-compose.production.yml, file-service/src/config.js, file-service/src/worker.js, docs/file-storage/phase-f6-ui-infra/WORKER-RUNBOOK.md</files>
  <action>Add a worker service using the same image digest, command node src/worker.js, Redis/Postgres health dependencies, graceful shutdown, restart policy, and Redis AOF volume/config per D-07. Production must fail readiness when Redis durability is unavailable. Document enqueue inspection, DLQ replay, pause, scale, and rollback commands.</action>
  <verify><automated>docker compose -f docs/file-storage/docker-compose.file-pwa.yml config &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml up -d --build postgres redis file-service file-worker &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml kill file-worker &amp;&amp; docker compose -f docs/file-storage/docker-compose.file-pwa.yml up -d file-worker &amp;&amp; node scripts/file-pwa-contract-uat.mjs --suite worker --output artifacts/file-pwa/f6/worker-uat.json</automated></verify>
  <done>Compose recovery UAT proves pending work completes after worker restart and emits a redacted artifact.</done>
</task>

</tasks>

## Threat model and rollback

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Duplicate/destructive replay | high | mitigate | stream ID, consumer group, idempotent handlers, lifecycle checks |
| Redis data loss | high | mitigate | AOF everysec, health/readiness, DLQ, persistent audit events |

Pause schedulers, stop worker replicas, and retain API synchronous reads/single-item mutations. Inspect/drain the stream before reverting; never purge provider data from a retry-only rollback.
