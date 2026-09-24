#!/bin/sh

set -eu

deployment=${1:-}
domain=${2:-}
acme_email=${3:-}
output=${4:-}

if [ "$deployment" != "staging" ] && [ "$deployment" != "production" ]; then
  echo "Usage: $0 <staging|production> <app-domain> <acme-email> [output-file]" >&2
  exit 1
fi

case "$domain" in
  *.*) ;;
  *) echo "app-domain must be a hostname such as inbox.example.com" >&2; exit 1 ;;
esac

case "$acme_email" in
  *@*.*) ;;
  *) echo "acme-email must be a valid email address" >&2; exit 1 ;;
esac

output=${output:-.env.$deployment}
if [ -e "$output" ]; then
  echo "$output already exists; refusing to overwrite secrets" >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required" >&2
  exit 1
}

git_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
upstream_sha=$(git rev-parse internal-baseline-v3.5.6 2>/dev/null || echo unknown)

if [ "$deployment" = "staging" ]; then
  app_port=8443
  app_http_port=8080
else
  app_port=443
  app_http_port=80
fi

umask 077
cat > "$output" <<EOF
COMPOSE_PROJECT_NAME=mailflow-$deployment
DEPLOYMENT_ENV=$deployment
APP_VERSION=3.5.6-internal.1
GIT_SHA=$git_sha
UPSTREAM_SHA=$upstream_sha

APP_URL=https://$domain
DOMAIN=$domain
ACME_EMAIL=$acme_email
APP_PORT=$app_port
APP_HTTP_PORT=$app_http_port

SESSION_SECRET=$(openssl rand -hex 32)
DB_PASSWORD=$(openssl rand -hex 24)
ENCRYPTION_KEY=$(openssl rand -hex 32)

DB_NAME=mailflow
DB_USER=mailflow
IMAP_MAX_PERSISTENT_PER_HOST=8
VITE_EMAIL_DIV_RENDER=false
EOF

chmod 600 "$output"
echo "Created $output with mode 600"

