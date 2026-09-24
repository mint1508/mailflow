# Baseline Rollback

The upstream application baseline is immutable at tag `v3.5.6` and local tag
`internal-baseline-v3.5.6`. Source rollback and database restore are separate
operations.

## Before each deployment

1. Stop writes or place the app in maintenance mode.
2. Back up PostgreSQL, `.env`/deployment configuration, and `ENCRYPTION_KEY`.
3. Record the deployed Git commit and highest schema migration.
4. Build images from that Git commit; do not pull `latest`.

## Roll back application code

Build and deploy the recorded earlier commit while keeping the database intact
only when its documented schema is backward compatible. A source checkout alone
does not reverse migrations.

## Roll back an incompatible schema

Stop the application, restore the matching PostgreSQL backup and encryption key,
then deploy the matching application commit. Validate `/api/health`, migration
state, login, IMAP sync, and SMTP send before reopening access.

Never use `docker compose down -v` for rollback because it deletes PostgreSQL and
Redis volumes.

