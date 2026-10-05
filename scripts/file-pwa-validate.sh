#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

manifest_args=(--root "$root_dir")
if [[ "${FILE_PWA_ALLOW_WORKING_TREE:-0}" == 1 ]]; then manifest_args+=(--allow-working-tree); fi
node scripts/verify-file-pwa-source-manifest.mjs "${manifest_args[@]}"

(cd file-service && npm run check)
(cd file-web && npm run lint && npm test && npm run build)

if command -v docker >/dev/null 2>&1; then
  docker compose -f docs/file-storage/docker-compose.file-pwa.yml config --quiet
fi

bash -n scripts/file-pwa-validate.sh
node --check scripts/file-pwa-contract-uat.mjs
git diff --check

if [[ -n "${FILE_PWA_UAT_URL:-${FILE_UAT_URL:-}}" ]]; then
  node scripts/file-pwa-contract-uat.mjs
else
  echo 'Skipping authenticated contract UAT (set FILE_PWA_UAT_URL and credentials to run it).'
fi

echo 'File PWA validation passed.'
