# Phase F5 Status

**Status: AUTOMATED PILOT GATE PASSED (fake provider).**

Delivered in this phase directory/repository:

- fake-provider pilot compose contract;
- non-secret environment example;
- health, load, backup, and restore scripts;
- pilot runbook and evidence-based UAT checklist.

Verified locally on 2026-09-29:

- `docker compose ... config` renders the fake-provider service/web boundary;
- both runtime images build and the full compose stack starts successfully;
- compose reported `file-service` healthy and served `file-web` over HTTP;
- the mock browser API URL and pilot identity were present in the built web bundle;
- an authenticated mock request resolved only the configured pilot identity and
  returned the expected File Home/quota response;
- `/health` returned `ok: true`, provider `available`, type `fake-disk`;
- 100 health requests at concurrency 10 completed without a request failure;
- 24/24 service tests and 3/3 web API tests passed;
- the scripted 20-user pilot completed create, upload, search, download,
  trash, restore, revoke, provider-health, and audit flows;
- the mock-only sparse fixture created 20 user homes with 200GB logical usage
  while preserving the 300GB hard safety cap;
- OIDC Authorization Code + PKCE, one-time state, signed HttpOnly sessions,
  lifecycle sync, ZIP export, retry/release and retention maintenance passed
  integration tests without contacting a live identity or storage provider;
- accessibility lint completed with zero warnings, the responsive Next.js
  production build passed, and Vietnamese UI/error strings were verified;
- `npm audit` reported zero vulnerabilities;
- backup freshness/checksum alerting passed against a newly created archive;
- backup archive creation, checksum verification, and restore into a clean
  temporary directory passed;
- all operational shell scripts pass `bash -n` and the repository diff passes
  whitespace validation.

The F5 automated gate is complete for the fake-disk pilot. Google Drive remains
deferred by design and no evidence here promotes the personal Google account to
production. A manual browser visual click-through was unavailable during this
CLI run and remains recommended before inviting external pilot users.

## F6 readiness update

F6 adds redacted tracer/full UAT runners for resume, Starred, activity, cursor,
bulk outcomes, worker status, maintenance, and reconciliation; recovery evidence
with checksum/RPO/RTO fields; and cache/build/digest promotion gates. These
artifacts have only been exercised with local fake-disk storage so far.

**Live Google Drive UAT, clean PostgreSQL/provider restore, immutable-digest
promotion, production smoke, and rollback evidence remain pending.** Follow
`phase-f6-ui-infra/UAT-CHECKLIST.md` and `phase-f6-ui-infra/PROMOTION-RUNBOOK.md`;
do not change this status to promoted until those redacted artifacts exist and
have operator/reviewer sign-off.
