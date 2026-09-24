# Phase 1 Status

Status: repository and local staging foundation complete; real VPS/domain gate pending.

## Completed

- Source Compose builds pin Node, nginx, PostgreSQL, Redis, and Caddy by digest.
- Staging and production use independent Compose project names, secrets, and volumes.
- `scripts/deploy/init-env.sh` generates mode-600 environment files without overwriting existing secrets.
- `/api/version` reports app version, fork commit, upstream commit, and schema version.
- Sanitized diagnostics include the same version metadata.
- Frontend, backend, PostgreSQL, and Redis survive recreate/restart with user data intact.
- Reverse-proxied WebSocket connection and PWA manifest pass local verification.
- cPanel port 2083 remains directly reachable with valid TLS.
- Domain, Cloudflare, deployment, and verification instructions are documented.

## External gate pending

- Real staging hostname and Cloudflare DNS record
- VPS OS, CPU, RAM, free disk, and current port 80/443 usage
- HTTPS certificate on the real hostname
- Desktop/mobile PWA install through the real hostname
- Direct IMAP 993 and SMTP 465/587 checks against the selected provider hostname

No real cPanel token or mailbox password is required for these infrastructure
checks. Those credentials remain deferred to the direct setup flow in Phase 2.
