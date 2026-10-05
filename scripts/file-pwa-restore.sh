#!/usr/bin/env bash
set -euo pipefail

backup_dir="${FILE_BACKUP_DIR:-./backups/file-pwa}"
archive="${1:-}"
data_dir="${FILE_DATA_DIR:-./file-service/data}"
if [[ -z "$archive" && -f "$backup_dir/latest" ]]; then archive="$(cat "$backup_dir/latest")"; fi
[[ -n "$archive" && -f "$archive" ]] || { echo "usage: $0 [BACKUP.tar.gz] (or create $backup_dir/latest)" >&2; exit 2; }
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
if [[ -f "$archive.sha256" ]]; then
  expected="$(awk '{print $1}' "$archive.sha256")"
  actual="$(sha256_file "$archive")"
  [[ "$expected" == "$actual" ]] || { echo "backup checksum mismatch" >&2; exit 1; }
fi
mkdir -p "$data_dir"
restore_dir="$(mktemp -d)"
trap 'rm -rf "$restore_dir"' EXIT
tar -xzf "$archive" -C "$restore_dir"
if [[ -f "$restore_dir/metadata.sql" && -f "$restore_dir/provider-data.tar.gz" ]]; then
  if [[ "${CONFIRM_FILE_RESTORE:-}" != "yes" ]]; then
    echo "Dry-run Compose restore verified (PostgreSQL dump + provider volume). Set CONFIRM_FILE_RESTORE=yes to apply." >&2
    exit 0
  fi
  echo "Applying a Compose database/volume restore requires the incident runbook and stopped writers; refusing automated overwrite." >&2
  exit 3
fi
if [[ "${CONFIRM_FILE_RESTORE:-}" != "yes" ]]; then
  echo "Dry-run restore verified. Set CONFIRM_FILE_RESTORE=yes to apply to $data_dir." >&2
  exit 0
fi
find "$data_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "$restore_dir"/. "$data_dir"/
echo "restored $archive into $data_dir"
if [[ -n "${FILE_BACKUP_OUTPUT:-}" && -f "$FILE_BACKUP_OUTPUT" ]]; then
  node - "$FILE_BACKUP_OUTPUT" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const value = JSON.parse(fs.readFileSync(file));
value.restore_verified = true; value.restore_finished_at = new Date().toISOString(); value.rto_hours = (Date.now() - Date.parse(value.started_at)) / 3600000;
fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
NODE
fi
