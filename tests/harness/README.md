# Phase 0 Integration Harness

This harness provides disposable IMAP, SMTP, and cPanel UAPI substitutes. It must
never contain real mailbox passwords or cPanel tokens.

## Mail server

```bash
docker compose -f tests/harness/docker-compose.yml up -d
```

GreenMail exposes its test services only to the Compose network by default:

- IMAP: `greenmail:3143`
- SMTP: `greenmail:3025`
- Users: `sender` and `recipient`
- Test-only password: `secret`

Connect a running Mailflow backend to that network before creating test accounts:

```bash
docker network connect mailflow-harness mailflow-backend
```

Use `greenmail` as the IMAP and SMTP hostname. Docker reports an error if the
backend is already connected; that case is safe to ignore.

Enable private hosts, nonstandard ports, and insecure TLS only in the disposable
local Mailflow database used by this harness. Production keeps those controls off
unless the real infrastructure requires them.

## cPanel mock

```bash
node tests/harness/cpanel-mock.mjs
```

The mock listens on `127.0.0.1:20830`. Select a response with the
`x-mailflow-test-scenario` header: `success`, `permission-denied`, or `malformed`.
Use client-side delay or an unreachable port to test timeout handling.

