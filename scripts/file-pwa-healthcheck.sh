#!/usr/bin/env bash
set -euo pipefail

base_url="${FILE_SERVICE_URL:-http://127.0.0.1:4310}"
health_url="${base_url%/}/health"
response="$(curl --fail --silent --show-error --max-time "${HEALTH_TIMEOUT_SECONDS:-5}" "$health_url")"
printf '%s\n' "$response"
if command -v jq >/dev/null 2>&1; then
  status="$(printf '%s' "$response" | jq -r 'if .ok == true then "ok" else (.status // .health // empty) end')"
  case "$status" in
    healthy|ok|ready) ;;
    *) echo "file-service health is not ready: ${status:-unknown}" >&2; exit 1 ;;
  esac
fi
