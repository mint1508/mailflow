---
phase: f6-ui-infra
plan: F6-07
type: execute
wave: 6
depends_on: [F6-01, F6-02, F6-03, F6-04, F6-05, F6-06]
requirements: [F6-LIVE]
autonomous: false
user_setup:
  - service: Google OAuth and organizational storage account
    why: Dedicated live-provider root, refresh token, 2FA/recovery, quota alerts
    env_vars: [FILE_GOOGLE_CLIENT_ID, FILE_GOOGLE_CLIENT_SECRET, FILE_GOOGLE_REFRESH_TOKEN, FILE_GOOGLE_ROOT_FOLDER_ID]
  - service: staging/production and second-backup access
    why: Immutable-digest deployment, recovery drill, RPO/RTO evidence
    env_vars: [FILE_UAT_URL, FILE_SERVICE_URL, FILE_UAT_ACCESS_TOKEN, FILE_UAT_OTHER_ACCESS_TOKEN]
files_modified: [scripts/production-file-uat.mjs, scripts/run-production-file-uat.mjs, scripts/file-pwa-contract-uat.mjs, scripts/file-pwa-backup.sh, scripts/file-pwa-restore.sh, scripts/file-pwa-backup-freshness.sh, scripts/file-pwa-release-smoke.mjs, docs/file-storage/phase-f6-ui-infra/UAT-CHECKLIST.md, docs/file-storage/phase-f6-ui-infra/PROMOTION-RUNBOOK.md, docs/file-storage/phase-f5/STATUS.md]
estimate: {raw_tokens: 18000, tokens: 18000, tasks: 3, confidence: low}
must_haves:
  truths: ["Live Drive matrix passes with redacted evidence", "Second backup meets RPO/RTO", "The exact staging digest is promoted and rollback-tested"]
  artifacts: ["artifacts/file-pwa/f6/live-uat.json", "artifacts/file-pwa/f6/recovery-drill.json", "artifacts/file-pwa/f6/production-smoke.json"]
  key_links: ["live UAT -> recovery gate -> immutable staging digest -> production smoke -> operator sign-off"]
---

# F6-07 - Live Google Drive UAT and Promotion

## Preconditions

Use a dedicated organizationally controlled Google account/root in staging first. Credentials are environment-only; artifacts contain request IDs, codes, counts, checksums, durations, and digests, never tokens/account IDs/content.

<tasks>

<task type="tracer">
  <name>Task 1: Complete one live OAuth upload-resume-download lifecycle</name>
  <files>scripts/production-file-uat.mjs, scripts/run-production-file-uat.mjs, scripts/file-pwa-contract-uat.mjs, docs/file-storage/phase-f6-ui-infra/UAT-CHECKLIST.md</files>
  <action>Authorize/refresh server-side Google credentials, create an owned folder, interrupt a chunked upload, restart API/worker, resume from status, finalize once, preview/download/checksum, trash/restore, and verify another user cannot access it. Per D-01/D-10, assert no provider URL/token reaches responses and success follows provider confirmation. Write artifacts/file-pwa/f6/live-uat.json.</action>
  <verify><automated>FILE_UAT_PROVIDER=google-drive FILE_UAT_OUTPUT=artifacts/file-pwa/f6/live-uat.json node scripts/run-production-file-uat.mjs --suite tracer &amp;&amp; node -e "const r=require('./artifacts/file-pwa/f6/live-uat.json');if(!r.ok||r.provider!=='google-drive')process.exit(1)"</automated></verify>
  <done>One complete live provider path passes with cross-user denial and redacted evidence.</done>
</task>

<task type="auto">
  <name>Task 2: Run the full live and recovery matrix</name>
  <files>scripts/production-file-uat.mjs, scripts/file-pwa-contract-uat.mjs, scripts/file-pwa-backup.sh, scripts/file-pwa-restore.sh, scripts/file-pwa-backup-freshness.sh, docs/file-storage/phase-f6-ui-infra/UAT-CHECKLIST.md, docs/file-storage/phase-f6-ui-infra/PROMOTION-RUNBOOK.md</files>
  <action>Run OAuth refresh, isolation, star/activity/cursor, multi-upload/reselect, duplicate finalize, quota with held/Trash, revoke grace/post-grace, bulk partial outcomes, worker reclaim/DLQ, maintenance, export, and provider rate-limit cases. Create a second byte backup outside Drive, restore into clean Postgres/service storage, reconcile, and measure RPO <=24h/RTO <=4h. Write live-full.json and recovery-drill.json.</action>
  <verify><automated>FILE_UAT_PROVIDER=google-drive FILE_UAT_OUTPUT=artifacts/file-pwa/f6/live-full.json node scripts/run-production-file-uat.mjs --suite full &amp;&amp; FILE_BACKUP_OUTPUT=artifacts/file-pwa/f6/recovery-drill.json bash scripts/file-pwa-backup.sh &amp;&amp; bash scripts/file-pwa-restore.sh &amp;&amp; bash scripts/file-pwa-backup-freshness.sh &amp;&amp; node -e "const r=require('./artifacts/file-pwa/f6/recovery-drill.json');if(r.rpo_hours&gt;24||r.rto_hours&gt;4)process.exit(1)"</automated></verify>
  <done>All checklist rows pass and recovery evidence meets RPO/RTO.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Promote the verified immutable digest</name>
  <what-built>Staging deployment with passing live UAT, recovery drill, release smoke, queue/backup/quota alerts, and recorded web/service/worker digests.</what-built>
  <how-to-verify>Run `node scripts/file-pwa-release-smoke.mjs --base-url "$FILE_UAT_URL" --api-url "$FILE_SERVICE_URL" --expected-build-id "$FILE_BUILD_SHA" --output artifacts/file-pwa/f6/staging-smoke.json`; manually test desktop/mobile login, list/grid, upload queue, preview, details/activity, Starred, Trash/restore, bulk errors, and logout; promote the exact same digest; rerun smoke to artifacts/file-pwa/f6/production-smoke.json; execute a staging rollback to the previous digest and confirm health.</how-to-verify>
  <verify><automated>node scripts/file-pwa-release-smoke.mjs --base-url "$FILE_UAT_URL" --api-url "$FILE_SERVICE_URL" --expected-build-id "$FILE_BUILD_SHA" --output artifacts/file-pwa/f6/production-smoke.json &amp;&amp; node -e "const s=require('./artifacts/file-pwa/f6/staging-smoke.json'),p=require('./artifacts/file-pwa/f6/production-smoke.json');if(!s.ok||!p.ok||s.image_digest!==p.image_digest)process.exit(1)"</automated></verify>
  <resume-signal>Approve only with digest equality, zero unresolved high-severity findings, and links/hashes for live-uat, recovery-drill, staging-smoke, production-smoke, and rollback evidence.</resume-signal>
  <done>The exact verified digest is live, production smoke passes, and rollback evidence is recorded.</done>
</task>

</tasks>

## Threat model and rollback

| Threat | Severity | Disposition | Mitigation |
| --- | --- | --- | --- |
| Credential leakage in UAT | critical | mitigate | environment-only secrets, dedicated account, redacted artifacts |
| Wrong/stale production build | high | mitigate | digest equality, D-01 cache smoke, rollback drill |

Roll back web/service/worker to the last verified digest, invalidate HTML/SW, switch DB reads to snapshot if needed, and run provider reconciliation. Never delete provider bytes during release rollback.
