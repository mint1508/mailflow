# Hippy File PWA - Delivery Roadmap

This roadmap is separate from the existing Mailflow mailbox roadmap. The file
feature must not reduce mail sync, send or read reliability.

## Phase F0 - Contract and foundation

- Freeze glossary, threat model, API error envelope and acceptance tests.
- Choose deployment boundary (separate service/container, shared OIDC issuer).
- Add provider credential storage and health-check interfaces without real file
  writes.
- Deliver: `PRODUCT-BRIEF.md`, `THREAT-MODEL.md`, `ARCHITECTURE.md`.

Gate: threat model reviewed; no browser path can reach Google APIs directly.

Current status: **complete**. Contracts, threat model, deployment boundary,
fake-provider runtime, and browser/backend separation are implemented.

## Phase F1 - Identity and lifecycle projection

- Integrate OIDC Authorization Code + PKCE with `auth.hippy.vn`.
- Project cPanel mailbox state into `file_users`.
- Implement five-minute revoke checks and admin lock/quota controls.

Gate: suspended users cannot establish new sessions and active sessions are
revoked within the target window.

Current status: **complete for the pilot runtime**.
Authorization Code + PKCE, signed HttpOnly sessions, userinfo validation,
lifecycle projection sync, revocation grace and admin quota/lock controls are
implemented and tested. Mailflow pushes the cPanel projection after inventory
sync and on a bounded background interval. Pointing OIDC at live
`auth.hippy.vn` remains deployment configuration.

## Phase F2 - Storage adapter and metadata

- Implement Google Drive adapter behind provider-neutral interface.
- Create File Homes lazily and persist provider IDs.
- Implement folder listing, create, rename, move and reconciliation.

Gate: repeated sync is idempotent; users cannot cross File Home boundaries.

Current status: **Google Drive adapter implemented; live authorization pending**.
The provider now refreshes OAuth credentials server-side, discovers/creates one
app root and one isolated folder per File User, performs idempotent resumable
uploads, streams downloads, and supports reconciliation. Unit coverage uses a
simulated Drive API; live-account verification waits for the production OAuth
client and storage-account authorization.

## Phase F3 - Upload, quota and download

- Implement resumable upload intents, reservations and idempotency keys.
- Add queue retry/backoff, streamed download and quota/usage UI.
- Add transient-provider failure states and dead-letter handling.

Gate: concurrent uploads never exceed hard quota; successful files are never
reported before provider confirmation.

Current status: **production transport implemented; live Drive UAT pending**.
Concurrent reservation and quota rules remain authoritative. The PWA sends raw
8 MiB chunks to disk-backed staging, Drive commit uses a persisted resumable
session, and downloads stream through the backend. Provider failure and
rate-limit normalization are covered by tests.

## Phase F4 - Trash, search, admin recovery and audit

- Add 30-day Trash/restore/purge workflow.
- Add PostgreSQL metadata search and orphan/quota reconciliation.
- Add admin audit, export ZIP and recovery controls.

Gate: restore/export drill passes and every privileged file action is auditable.

Current status: **complete for fake-disk pilot**. Trash/restore, ZIP export,
reconciliation, and privileged audit tests pass.

## Phase F5 - Pilot hardening

- Load test 20-50 users and 100-300GB-shaped metadata/workloads.
- Add provider/API dashboards, backup freshness alerts and incident runbook.
- Validate mobile PWA, accessibility, localization and Mailflow branding.

Gate: pilot acceptance checklist passes; no unresolved high-severity security or
data-loss finding.

Current status: **complete for the automated fake-disk pilot**. Compose runtime,
29 service tests, web tests/lint/build, 20-user end-to-end UAT, a 200GB-shaped
sparse workload, health load, backup/restore, freshness alerting, responsive
rules, localization, and zero-vulnerability npm audit have recorded evidence
under `phase-f5/`. Manual browser visual review remains recommended before
external pilot enrollment.

## Phase F6 - Production decision

Promote beyond pilot only after:

- second byte backup exists outside the personal Google account;
- recovery drill meets RPO 24h / RTO 4h;
- account ownership/recovery is organizational, not one person's mailbox;
- cost, API quota and capacity alerts are operational;
- UAT signs off on revoke, quota, upload retry, restore and export.
