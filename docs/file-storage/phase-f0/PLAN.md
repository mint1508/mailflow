# Phase F0 - Contract and Foundation Plan

## Goal

Create a reviewable foundation for the File PWA without changing Mailflow's
runtime behavior or writing user files to Google Drive. At the end of this
phase, the next engineer can implement identity, lifecycle projection and the
storage adapter against stable contracts.

## Scope boundary

In scope:

- File PWA service boundary and deployment decision.
- Provider-neutral storage interfaces.
- Identity, lifecycle and quota terminology.
- API error envelope and idempotency conventions.
- PostgreSQL migration design review (no production migration yet).
- Contract tests using fake identity, fake cPanel lifecycle and fake storage.
- Threat-model and acceptance-test traceability.

Out of scope:

- Real Google Drive writes.
- OIDC provider implementation.
- User-facing file UI.
- cPanel mutation workflows.
- Sharing, public links, desktop sync and client-side encryption.

## Work items

### F0.1 Deployment boundary

Decide and document that File API runs as a separate service/container with its
own PostgreSQL schema and Redis queue, while consuming the shared OIDC issuer.
The service may share infrastructure with Mailflow but must not share browser
cookies or Google credentials.

Concrete outputs:

- `file-service/package.json` (Node 22, ESM, Vitest scripts: `test`, `lint`).
- `file-service/src/index.js` as a no-provider-write bootstrap placeholder.
- `file-service/src/config.js` with a schema for environment names only.
- `file-service/tests/contract/` as the home for all F0 contract tests.
- `docs/file-storage/compose-boundary.md` describing container, network,
  database schema and Redis queue boundaries.

Verification:

- Architecture diagram names the browser, File API, OIDC issuer, DB, Redis and
  provider boundary.
- A configuration contract lists separate secrets and allowed outbound hosts.
- No frontend code path contains Google API credentials or provider URLs.

### F0.2 Domain and lifecycle contracts

Define typed/domain-level contracts for `FileUser`, `FileHome`, `FileQuota`,
`FileUsage`, `FileReservation`, `FileNode` and `FileLifecycle`. Map Mailflow's
`app_user_id` and `mailbox_id` without copying email as an identity key.

Verification:

- Contract fixtures cover active, suspended, deleted and unknown mailbox states.
- File access fails closed for suspended/deleted states.
- File Quota is proven separate from cPanel Mailbox quota in fixtures/docs.

Concrete outputs:

- `file-service/src/domain/fileUser.js`.
- `file-service/src/domain/fileLifecycle.js`.
- `file-service/src/domain/fileQuota.js`.
- `file-service/tests/contract/lifecycle.test.js` and
  `file-service/tests/contract/quota.test.js`.

### F0.3 Storage adapter interface

Define an interface with `ensureHome`, `listChildren`, `createFolder`,
`beginUpload`, `writeUploadPart`, `commitUpload`, `download`, `move`,
`trash`, `restore`, `purge` and `reconcile`. The interface returns normalized
provider-neutral errors and never leaks provider URLs or account identifiers.

Verification:

- A fake adapter passes contract tests for success, timeout, 429, 5xx,
  not-found and duplicate/idempotency cases.
- Adapter methods require a server-created authorization context, not a
  browser-supplied provider ID.

Concrete outputs:

- `file-service/src/storage/storageAdapter.js`.
- `file-service/src/storage/providerErrors.js`.
- `file-service/src/storage/fakeStorageAdapter.js`.
- `file-service/tests/contract/storage-adapter.test.js`.

The fake adapter is the only provider used in F0; no Google SDK dependency is
added until F2.

### F0.4 API conventions

Define the JSON error envelope and request correlation rules in
`API-CONTRACT.md`. All mutations accept `Idempotency-Key`; responses expose a
stable application error code, not raw Google/cPanel text.

Verification:

- Every planned MVP endpoint has an auth requirement, actor scope and error
  mapping.
- Validation errors, authorization errors, provider-unavailable errors and
  quota errors are distinguishable by code.

Concrete outputs:

- `file-service/src/http/errors.js`.
- `file-service/src/http/requestContext.js`.
- `file-service/tests/contract/api-errors.test.js`.

### F0.5 Provider credential and health contracts

Define server-only interfaces for encrypted provider credential references,
admin reauthorization/rotation and provider health. F0 validates shape and
authorization but must not create a live OAuth token or call Google.

Concrete outputs:

- `file-service/src/providers/providerCredentials.js`.
- `file-service/src/providers/providerHealth.js` with states `healthy`,
  `degraded`, `rate_limited`, `unavailable` and `not_configured`.
- `file-service/tests/contract/provider-boundary.test.js`.
- `docs/file-storage/compose-boundary.md` with fixed outbound endpoint
  allowlist and secret injection rules.

Verification:

- No credential value is returned from a public handler or serialized into a
  fixture.
- Health results contain normalized code, timestamps and retryability, never
  raw provider response bodies.
- Rotation/revocation requires an admin actor context and step-up marker.

### F0.6 Quota reservation model

Review the transaction boundaries for `file_reservations` and `file_uploads`.
Reserve before provider upload, commit only after provider confirmation, and
release on bounded failure/expiry. Keep committed usage and reservations
separate in all reads.

Concrete outputs:

- `file-service/src/domain/fileReservations.js` with atomic
  `hold/commit/release/expire` transitions and a transaction contract that
  locks the File User quota row while calculating available bytes.
- `file-service/tests/contract/reservations.test.js`.

Verification:

- Concurrent reservation test cannot exceed hard quota.
- Retry with the same idempotency key returns the existing upload intent.
- Expired reservations are released without changing committed usage.

### F0.7 Security and acceptance traceability

Map every threat-model control to one contract test, operational check or
later-phase gate. Record the pilot-only status of the personal Google account
and the production promotion blockers.

Concrete output:

- `docs/file-storage/phase-f0/TRACEABILITY.md` with columns for threat/control,
  requirement, implementation phase, executable test or operational check,
  owner and gate/evidence.

Verification:

- Traceability table covers browser credential isolation, IDOR, revoke lag,
  audit, retry duplication, quota race and recovery.
- No F0 task creates a production secret, real OAuth token or real file.

## Dependencies and order

1. F0.1 deployment boundary
2. F0.2 domain/lifecycle contracts
3. F0.3 storage adapter interface
4. F0.4 API conventions
5. F0.5 provider credential/health contracts
6. F0.6 quota reservation review
7. F0.7 traceability and gate review

F0.3 and F0.4 may be drafted in parallel after F0.2, but the final gate is
sequential because API authorization depends on the domain terms.

## Exit gate

- `API-CONTRACT.md` and contract fixtures exist under `file-service/tests/contract`.
- `file-service` has runnable `npm test` and `npm run lint` scripts.
- Fake storage and fake lifecycle tests pass.
- Provider credential and health tests pass without a live token.
- `TRACEABILITY.md` covers every F0 control and MVP acceptance criterion.
- No real provider write or credential is required to run the suite.
- Architecture, product brief, threat model, ADRs and plan contain no
  contradictory identity/quota/storage terminology.
- Phase F1 can begin without revisiting the personal-account pilot decision.

## Verification commands (after implementation)

```bash
cd file-service && npm test
cd file-service && npm run lint
cd backend && npm run lint
cd frontend && npm run build
! rg -n -i 'AIza|googleapis\.com|drive\.google\.com|refresh.?token\s*[:=]' file-service/src frontend/src
```

The static scan is scoped to File PWA source directories. Google SDK/provider
URLs are introduced only in the server-side adapter during F2, with an explicit
allowlist update in that phase.
