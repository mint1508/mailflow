#!/usr/bin/env bash
set -euo pipefail

data_dir="${FILE_DATA_DIR:-./file-service/data}"
backup_dir="${FILE_BACKUP_DIR:-./backups/file-pwa}"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$backup_dir/file-pwa-$stamp.tar.gz"
evidence="${FILE_BACKUP_OUTPUT:-}"
started_epoch="$(date +%s)"
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
if [[ -d "$data_dir" ]]; then
  tar -C "$data_dir" -czf "$archive" .
else
  compose_file="${FILE_COMPOSE_FILE:-docs/file-storage/docker-compose.file-pwa.yml}"
  volume="${FILE_DATA_VOLUME:-file-storage_file_service_data}"
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  docker compose -f "$compose_file" exec -T postgres pg_dump -U "${FILE_DB_USER:-file_storage}" "${FILE_DB_NAME:-file_storage}" > "$stage/metadata.sql"
  docker run --rm -v "$volume:/source:ro" -v "$stage:/backup" alpine:3.22 sh -c 'apk add --no-cache tar >/dev/null && tar --sparse -C /source -czf /backup/provider-data.tar.gz .'
  printf '{"created_at":"%s","format":"postgres-plus-provider-volume"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/backup-marker.json"
  tar -C "$stage" -czf "$archive" .
fi
digest="$(sha256_file "$archive")"
printf '%s  %s\n' "$digest" "$(basename "$archive")" > "$archive.sha256"
if [[ -d "$data_dir" ]]; then
  printf '{"created_at":"%s","archive":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$archive" > "$data_dir/backup-marker.json"
else
  marker="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  docker compose -f "$compose_file" exec -T file-service sh -c "printf '{\"created_at\":\"$marker\"}\\n' > /data/backup-marker.json"
fi
printf '%s\n' "$archive" > "$backup_dir/latest"
if [[ -n "$evidence" ]]; then
  mkdir -p "$(dirname "$evidence")"
  finished_epoch="$(date +%s)"
  printf '{"schema_version":1,"ok":true,"phase":"backup","archive":"%s","sha256":"%s","started_at":"%s","finished_at":"%s","duration_seconds":%d,"restore_verified":false}\n' \
    "$(basename "$archive")" "$digest" "$(date -u -r "$started_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((finished_epoch-started_epoch))" > "$evidence"
  chmod 600 "$evidence"
fi
printf '%s\n' "$archive"
