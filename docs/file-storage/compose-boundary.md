# File PWA Deployment Boundary

This is the F0 boundary contract. It does not add a runnable service yet; it
defines the package and container seam that F0 implementation must create.

## Services

- `file-service`: Node 22 API, queue workers and storage policy. Owns the File
  PWA schema and Redis namespace.
- `file-web`: Next.js PWA. Talks only to `file-service` and the OIDC issuer.
- `postgres`: separate database/schema credentials from Mailflow's mail data.
- `redis`: separate namespace and credentials from Mailflow's mail jobs.
- `auth.hippy.vn`: external/shared OIDC issuer.

The services may share a Docker host, but File API deployment, environment,
database credentials and health checks remain independently restartable.

## Secret rules

- `OIDC_CLIENT_SECRET` and the encrypted Storage Account credential reference are
  server-only values.
- Browser-exposed configuration contains only issuer URL, client ID and public
  app URL.
- No secret is committed to `file-service`, Docker Compose, fixtures or logs.
- Google endpoints are fixed in the adapter; users cannot configure arbitrary
  callback or provider URLs.

## Outbound allowlist

F0 reserves egress for the configured OIDC issuer and Google APIs. The actual
Google SDK and endpoints are introduced in F2; F0 tests use a fake adapter and
must not perform network calls.

## Health contract

File service health is split into process health and dependency health. A live
process with an unavailable provider is `degraded`/`unavailable`, not healthy.
Health responses expose normalized codes and timestamps, never credentials or
raw upstream response bodies.
