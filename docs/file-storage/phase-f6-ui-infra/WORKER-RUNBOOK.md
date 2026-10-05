# File PWA Worker Runbook

The API and worker use the same image and data volume. Redis is the durable
source for queued operations; metadata remains in the configured store.

## Inspect

```sh
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml exec redis redis-cli XINFO GROUPS file-jobs:v1
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml exec redis redis-cli XPENDING file-jobs:v1 file-workers:v1
curl -fsS https://files-api.hippy.vn/health
curl -fsS https://files-api.hippy.vn/metrics
```

Operation status is owner scoped: `GET /api/files/operations/:id`. Responses
contain safe state and bounded result fields only.

## Operate

```sh
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml up -d file-worker
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml scale file-worker=2
docker compose --env-file .env.production -f docs/file-storage/docker-compose.production.yml stop file-worker
```

The scheduler is embedded in each worker and protected by Redis locks. Do not
run ad-hoc purge scripts while a maintenance job is pending.

## DLQ and recovery

Inspect `XINFO STREAM file-jobs:dlq:v1` and the corresponding safe operation
status before replay. Replay only after correcting the underlying condition;
copy the original operation type and bounded payload into a new idempotency
operation. Never delete provider bytes as part of a queue rollback.

## Rollback

Stop worker replicas first, leave API reads and single-item mutations online,
inspect pending entries, and deploy the previous image. Redis AOF and the
metadata backup must be retained. Restore provider bytes only through the
documented backup/recovery procedure.
