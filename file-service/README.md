# Hippy File Service

Policy-enforcing backend for the Hippy file PWA. It supports a local fake-disk
provider for tests and a server-side Google Drive provider for production.

## Run

```sh
cp .env.example .env
FILE_AUTH_MODE=mock npm start
```

Development mock requests must explicitly send `X-Dev-User-Id`. Production
defaults to OIDC and validates bearer tokens through the configured OIDC
`userinfo` endpoint. Never enable mock mode on a public deployment.

Browser SSO starts at `GET /auth/oidc/login` and uses Authorization Code +
PKCE. The callback exchanges the code server-side, validates identity through
OIDC userinfo, stores tokens only for the duration of the exchange, and issues
a signed `HttpOnly; SameSite=Lax` pilot session cookie (`Secure` in production).
Configure fixed API callback and web redirect URLs; request-controlled redirect
targets are intentionally unsupported. `GET|POST /auth/logout` revokes the
local session.

OIDC identities are fail-closed: a valid IdP login is still denied until the
same immutable user ID has been projected by the lifecycle-sync endpoint.
Automatic pilot provisioning exists only in explicit mock auth mode.

Authorized file downloads return binary HTTP responses with the stored MIME
type and an RFC 5987 content-disposition filename. Downloads and production UI
upload chunks stream through the service instead of being embedded as base64.

## Google Drive provider

Set `FILE_STORAGE_PROVIDER=google-drive` and provide
`FILE_GOOGLE_CLIENT_ID`, `FILE_GOOGLE_CLIENT_SECRET`, and
`FILE_GOOGLE_REFRESH_TOKEN` through the deployment secret store. The OAuth
client needs Drive API access; use the narrow `drive.file` scope and authorize
the dedicated personal storage account with offline access. Tokens never reach
the browser.

Production rejects the fake provider by default. Set
`FILE_ALLOW_FAKE_PROVIDER=true` only in an explicitly isolated pilot or test
deployment; never use that override on a public environment.

The adapter discovers or creates one `Hippy Files` root, creates one child
folder per immutable File User ID, and uses Google resumable upload sessions.
`FILE_GOOGLE_ROOT_FOLDER_ID` can pin an app-created root. Staged chunks and the
resumable session reference remain in `FILE_DATA_DIR` until Drive confirms the
file, after which quota is committed and staging is removed.

```sh
npm run check
```

Compose deployments persist normalized metadata in PostgreSQL and provider job
state/dead letters in Redis. Provider bytes and resumable upload parts live in
`FILE_DATA_DIR`. The JSON metadata store and in-memory job tracker are retained
only as dependency-free isolated-test fallbacks when `FILE_DB_URL` and
`FILE_REDIS_URL` are absent.

Mailflow/cPanel lifecycle projections are accepted only at
`POST /api/internal/lifecycle-sync` with `X-Lifecycle-Sync-Secret` matching
`FILE_LIFECYCLE_SYNC_SECRET`. Rotate this secret like any server credential.

Admin exports require step-up authentication. `GET
/api/admin/file-users/:id/export` returns a ZIP containing `metadata.json` and
the user's file bytes. Maintenance cleanup is exposed as an authenticated,
step-up protected job hook at `POST /api/admin/file-maintenance`.

In explicit mock auth mode only, `POST /api/admin/synthetic-load` can create
capped sparse files for capacity-shaped tests. It is unavailable in OIDC mode;
`FILE_SYNTHETIC_MAX_BYTES` is an additional hard logical-size cap.

## Current limitations

- Fake provider bytes remain local to one service volume; PostgreSQL metadata
  alone does not make the byte layer horizontally scalable.
- JSON/base64 upload chunks remain accepted for backward-compatible tests; the
  PWA sends raw 8 MiB chunks.
- ZIP export buffers the archive in memory for the pilot. Large production
  exports must move to a streamed background job before Google Drive rollout.
- OIDC token signature validation is delegated to the trusted `userinfo`
  endpoint; TLS and issuer-side audience policy are required.
