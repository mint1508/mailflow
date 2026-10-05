#!/usr/bin/env bash
set -euo pipefail

backup_dir="${FILE_BACKUP_DIR:-./backups/file-pwa}"
max_age="${FILE_BACKUP_MAX_AGE_SECONDS:-86400}"
[[ "$max_age" =~ ^[0-9]+$ ]] || { echo "FILE_BACKUP_MAX_AGE_SECONDS must be an integer" >&2; exit 2; }
[[ -d "$backup_dir" ]] || { echo "CRITICAL: backup directory is missing: $backup_dir" >&2; exit 1; }

if stat -f '%m' "$backup_dir" >/dev/null 2>&1; then
  latest="$(find "$backup_dir" -maxdepth 1 -type f -name 'file-pwa-*.tar.gz' -exec stat -f '%m %N' {} \; | sort -nr | head -1 || true)"
else
  latest="$(find "$backup_dir" -maxdepth 1 -type f -name 'file-pwa-*.tar.gz' -exec stat -c '%Y %n' {} \; | sort -nr | head -1 || true)"
fi
[[ -n "$latest" ]] || { echo "CRITICAL: no File PWA backup found in $backup_dir" >&2; exit 1; }
created="${latest%% *}"
archive="${latest#* }"
age="$(( $(date +%s) - created ))"
(( age <= max_age )) || { echo "CRITICAL: latest backup is ${age}s old (limit ${max_age}s): $archive" >&2; exit 1; }
[[ -f "$archive.sha256" ]] || { echo "CRITICAL: checksum file is missing: $archive.sha256" >&2; exit 1; }
expected="$(awk '{print $1}' "$archive.sha256")"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$archive" | awk '{print $1}')"; else actual="$(shasum -a 256 "$archive" | awk '{print $1}')"; fi
[[ "$expected" == "$actual" ]] || { echo "CRITICAL: checksum mismatch: $archive" >&2; exit 1; }
if [[ -n "${FILE_BACKUP_OUTPUT:-}" && -f "$FILE_BACKUP_OUTPUT" ]]; then
  node - "$FILE_BACKUP_OUTPUT" "$age" "$max_age" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const value = JSON.parse(fs.readFileSync(file));
value.freshness_verified = true; value.backup_age_seconds = Number(process.argv[3]); value.max_age_seconds = Number(process.argv[4]); value.rpo_hours = value.backup_age_seconds / 3600;
value.ok = value.restore_verified === true && value.rpo_hours <= 24 && Number(value.rto_hours) <= 4;
fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
NODE
fi
echo "OK: latest File PWA backup is ${age}s old: $archive"
