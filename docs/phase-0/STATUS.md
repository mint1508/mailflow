# Phase 0 Status

Status: complete for the local baseline on 2026-09-24.

## Gate

- [x] Upstream source is checked out on `internal-main` at pinned tag `v3.5.6`.
- [x] AGPL and commercial license files remain unchanged.
- [x] Frontend and backend tests, lints, and builds pass under Node 22.
- [x] Frontend, backend, PostgreSQL, and Redis run healthy in Docker Compose.
- [x] Clean database migration applies all 58 upstream migrations.
- [x] Baseline register/login, IMAP connect, SMTP send, sync, and read pass with GreenMail.
- [x] IMAP auth, RBAC, Shared Mailbox, dynamic PWA branding, and Storage Lite spikes have accepted conclusions.
- [x] cPanel adapter boundary and UAPI response fixtures are recorded.
- [x] Fork migration naming, core patch tracking, and database-safe rollback are documented.

## Deferred inputs

- Configure `origin` after the user creates or supplies the GitHub fork URL.
- Real cPanel mutation tests wait for a dedicated test Mailbox and direct token entry path.
- VPS staging, domain, TLS, and Cloudflare work begins in Phase 1.
