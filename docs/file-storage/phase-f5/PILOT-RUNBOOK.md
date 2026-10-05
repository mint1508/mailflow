# File PWA Pilot Runbook (fake provider)

This runbook exercises the service boundary without Google credentials. It is
safe for local/staging use only; `FILE_AUTH_MODE=mock` must never be enabled in
production.

## Start

```sh
docker compose -f docs/file-storage/docker-compose.file-pwa.yml --env-file docs/file-storage/file-pwa.env.example up -d --build
./scripts/file-pwa-healthcheck.sh
```

The compose file expects `file-service/Dockerfile` and `file-web/Dockerfile` to
be supplied by the implementation phase. Until those images exist, run the
scripts against the locally started service instead.

## Verification

```sh
FILE_SERVICE_URL=http://127.0.0.1:4310 ./scripts/file-pwa-healthcheck.sh
LOAD_TEST_REQUESTS=100 LOAD_TEST_CONCURRENCY=10 ./scripts/file-pwa-load-test.sh
FILE_UAT_USERS=20 node scripts/file-pwa-uat.mjs
```

Record the commit, environment, request count, failures, and response latency
in the pilot checklist. A green health load is not evidence that quota,
revocation, restore, or authorization passed.

## Backup and restore drill

```sh
FILE_DATA_DIR=./file-service/data ./scripts/file-pwa-backup.sh
CONFIRM_FILE_RESTORE=yes FILE_DATA_DIR=./tmp/file-pwa-restore \
  ./scripts/file-pwa-restore.sh backups/file-pwa/<archive>.tar.gz
```

Keep backup archives outside the host running the service for a real pilot.
Fake-provider backups validate metadata/blob handling only and do not satisfy
the F6 second-byte-backup requirement.

Check freshness from cron or the host monitoring agent. A non-zero exit is an
alert condition:

```sh
FILE_BACKUP_DIR=./backups/file-pwa FILE_BACKUP_MAX_AGE_SECONDS=86400 \
  ./scripts/file-pwa-backup-freshness.sh
```

### Snapshot the Compose named volume

Stop writes before copying the volume so `metadata.json` and blobs represent
one point in time. The command uses a temporary Alpine container and writes the
archive to the host backup directory.

```sh
docker compose -f docs/file-storage/docker-compose.file-pwa.yml stop file-service
mkdir -p backups/file-pwa
docker run --rm \
  -v file-storage_file_service_data:/source:ro \
  -v "$PWD/backups/file-pwa:/backup" \
  alpine:3.22 sh -c 'tar -C /source -czf /backup/file-pwa-volume.tar.gz .'
docker compose -f docs/file-storage/docker-compose.file-pwa.yml start file-service
sha256sum backups/file-pwa/file-pwa-volume.tar.gz > \
  backups/file-pwa/file-pwa-volume.tar.gz.sha256
```

Confirm the actual volume name with `docker volume ls` when using a custom
Compose project name. Always perform a restore drill into a separate volume or
directory before treating a snapshot as recoverable.

## Stop

```sh
docker compose -f docs/file-storage/docker-compose.file-pwa.yml down
```
