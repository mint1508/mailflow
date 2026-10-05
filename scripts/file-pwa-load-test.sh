#!/usr/bin/env bash
set -euo pipefail

base_url="${FILE_SERVICE_URL:-http://127.0.0.1:4310}"
requests="${LOAD_TEST_REQUESTS:-100}"
concurrency="${LOAD_TEST_CONCURRENCY:-10}"
request_health() {
  if [[ -n "${FILE_TEST_TOKEN:-}" ]]; then
    curl --fail --silent --show-error --max-time "${LOAD_TEST_TIMEOUT_SECONDS:-10}" \
      -H "Authorization: Bearer ${FILE_TEST_TOKEN}" -o /dev/null "${base_url%/}/health"
  else
    curl --fail --silent --show-error --max-time "${LOAD_TEST_TIMEOUT_SECONDS:-10}" \
      -o /dev/null "${base_url%/}/health"
  fi
}
export base_url LOAD_TEST_TIMEOUT_SECONDS FILE_TEST_TOKEN
export -f request_health
seq "$requests" | xargs -P "$concurrency" -I{} bash -c request_health
printf 'load test passed: %s health requests, concurrency %s\n' "$requests" "$concurrency"
