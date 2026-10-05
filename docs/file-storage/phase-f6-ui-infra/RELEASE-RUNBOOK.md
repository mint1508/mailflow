# File PWA release runbook

Every release starts from a clean checkout. The web and service images use the
same `FILE_BUILD_SHA`; deploy by immutable digest and retain old hashed web
assets during rollback.

Before the first promotion, copy `docs/file-storage/file-pwa.production.env.example`
to the repository root as `.env.production`, replace every placeholder through
the deployment secret store, and keep the file mode at `600`. The production
Compose file forces OIDC and Google Drive; do not use the pilot
`docs/file-storage/file-pwa.env.example` for this deployment.

## Build and publish

```sh
export FILE_BUILD_SHA="$(git rev-parse HEAD)"
export FILE_RELEASE_VERSION="${FILE_RELEASE_VERSION:-$(git describe --tags --always)}"
node scripts/verify-file-pwa-source-manifest.mjs --root .
(cd file-service && npm ci && npm run check)
(cd file-web && npm ci && npm run lint && npm test && FILE_BUILD_SHA="$FILE_BUILD_SHA" FILE_RELEASE_VERSION="$FILE_RELEASE_VERSION" npm run build)
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml config --quiet
```

The File PWA workflow builds both images from this checkout, labels them with
`org.opencontainers.image.revision`, and records the registry digest. Promote
the exact digest printed by that workflow:

```sh
export FILE_SERVICE_IMAGE="ghcr.io/ORG/REPO-file-service@sha256:..."
export FILE_WEB_IMAGE="ghcr.io/ORG/REPO-file-web@sha256:..."
export FILE_BUILD_SHA="..."
export FILE_IMAGE_DIGEST="${FILE_WEB_IMAGE#*@}"
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml pull file-service file-worker file-web
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml up -d file-service file-worker file-web
```

## Verify and purge

```sh
node scripts/file-pwa-release-smoke.mjs \
  --base-url https://files.hippy.vn \
  --api-url https://files-api.hippy.vn \
  --expected-build-id "$FILE_BUILD_SHA" \
  --expected-image-digest "$FILE_IMAGE_DIGEST" \
  --output artifacts/file-pwa/f6/production-smoke.json
```

The artifact must report `ok: true`, one build ID across HTML and
`/build-info.json`, 200 responses for every referenced `/_next/static` asset,
and no console errors from the configured browser harness. Purge only the
shell endpoints after a successful deploy; hashed assets stay available:

```sh
curl -X PURGE https://files.hippy.vn/
curl -X PURGE https://files.hippy.vn/sw.js
curl -X PURGE https://files.hippy.vn/build-info.json
```

## Rollback

Set both image variables to the previously verified service/web digests, then
recreate only those services and rerun the smoke command:

```sh
export FILE_SERVICE_IMAGE="ghcr.io/ORG/REPO-file-service@sha256:PREVIOUS"
export FILE_WEB_IMAGE="ghcr.io/ORG/REPO-file-web@sha256:PREVIOUS"
export FILE_IMAGE_DIGEST="${FILE_WEB_IMAGE#*@}"
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml up -d file-service file-worker file-web
curl -X PURGE https://files.hippy.vn/
curl -X PURGE https://files.hippy.vn/sw.js
node scripts/file-pwa-release-smoke.mjs --base-url https://files.hippy.vn --api-url https://files-api.hippy.vn --expected-build-id "$FILE_BUILD_SHA" --expected-image-digest "$FILE_IMAGE_DIGEST" --output artifacts/file-pwa/f6/rollback-smoke.json
```

Never delete old `/_next/static` assets during a rollback. Provider bytes,
database volumes, and Redis data are independent of the web shell rollback.
