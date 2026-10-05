# F6 Promotion Runbook

Promote only the exact immutable web, API, and worker digests that passed staging UAT. A matching Git SHA or tag alone is insufficient.

## Gate inputs

Set and record these values without storing credentials in shell history or artifacts:

```sh
export FILE_BUILD_SHA="$(git rev-parse HEAD)"
export FILE_WEB_IMAGE_DIGEST="sha256:..."
export FILE_SERVICE_IMAGE_DIGEST="sha256:..."
export FILE_WORKER_IMAGE_DIGEST="$FILE_SERVICE_IMAGE_DIGEST"
```

Before promotion, require passing `live-full.json`, `recovery-drill.json`, `staging-smoke.json`, and a manual desktop/mobile checklist. Hash each artifact and place hashes in the change record.

Copy `docs/file-storage/file-pwa.production.env.example` to the repository
root as `.env.production`, fill the secret values, and keep it mode `600`.
Production Compose reads all runtime values from the explicit `--env-file`; the
pilot env file must not be used.

## Staging cache and digest gate

```sh
FILE_IMAGE_DIGEST="$FILE_WEB_IMAGE_DIGEST" node scripts/file-pwa-release-smoke.mjs \
  --base-url "$FILE_UAT_URL" \
  --api-url "$FILE_SERVICE_URL" \
  --expected-build-id "$FILE_BUILD_SHA" \
  --expected-image-digest "$FILE_WEB_IMAGE_DIGEST" \
  --output artifacts/file-pwa/f6/staging-smoke.json
```

The smoke requires no-store HTML, build metadata and service worker; a single build ID; a server-attested image digest; one-year immutable hashed assets; API health; and the optional browser harness with no console errors. Purge only `/`, `/sw.js`, and `/build-info.json`; retain old hashed chunks for rollback.

## Promote and verify

Resolve registry tags to digests again immediately before deployment. Abort if any digest differs from staging. Deploy the digest references, purge shell endpoints, and run the same smoke against production to `production-smoke.json`.

```sh
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml pull file-service file-worker file-web
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml up -d file-service file-worker file-web
```

```sh
node - <<'NODE'
const fs = require('node:fs');
const staging = JSON.parse(fs.readFileSync('artifacts/file-pwa/f6/staging-smoke.json'));
const production = JSON.parse(fs.readFileSync('artifacts/file-pwa/f6/production-smoke.json'));
if (!staging.ok || !production.ok || !staging.image_digest || staging.image_digest !== production.image_digest || staging.expected_build_id !== production.expected_build_id) process.exit(1);
NODE
```

Verify desktop and mobile login/logout, list/grid, filter/cursor navigation, multi-file resume after reload, preview/download, details/activity, Starred, Trash/restore, bulk partial errors, operation status, queue depth, DLQ count, maintenance age, reconcile age, quota alerts, and backup freshness.

## Rollback drill

Stop new worker claims, retain Redis AOF, database backup, and provider bytes, then deploy the previous web/service/worker digests:

```sh
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml up -d file-service file-worker file-web
```

Purge shell endpoints and write `rollback-smoke.json`. Re-enable workers only after pending operations are inspected. Never delete provider bytes or reverse a database expansion during release rollback.

Promotion is complete only after production smoke, alert checks, and rollback evidence have artifact hashes and two-person sign-off.
