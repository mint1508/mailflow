# Hippy File PWA - Threat Model

## Assets

- Google OAuth refresh token for the dedicated Storage Account.
- File bytes and metadata, including names, sizes and folder relationships.
- Per-user quota state and upload reservations.
- OIDC sessions and identity claims.
- Admin audit history and export archives.

## Trust boundaries

1. Browser/PWA to File API: untrusted client; all authorization is server-side.
2. File API to PostgreSQL/Redis: trusted private network, least-privilege
   credentials.
3. File API to Google Drive: external provider; use encrypted refresh token,
   bounded timeouts and normalized errors.
4. Mailflow/cPanel to File API: external lifecycle source; sync is treated as
   eventually consistent and fail-closed for new sessions.
5. Admin console to recovery operations: privileged boundary requiring step-up
   2FA and audit.

## Main threats and controls

| Threat | Control |
| --- | --- |
| Browser obtains Google credential or permanent file URL | Token stays server-side; backend streams or issues short-lived access only |
| User bypasses quota via concurrent uploads | Transactional File Reservations and provider-confirmed commit |
| User sees another user's file by guessing an ID | Every query scopes immutable `file_user_id`; deny tests cover all routes |
| Suspended mailbox keeps a live session | cPanel sync plus session revocation check, max five-minute lag |
| Google API retry creates duplicates | Client idempotency key mapped to one upload intent and provider file ID |
| Admin abuse is invisible | Step-up 2FA for recovery/export and immutable audit events |
| Personal Google account is lost or locked | Dedicated owner, 2FA/recovery, billing alerts, metadata backup and export drill |
| Malicious filename or archive | Normalize names, reject path traversal, stream ZIP creation and scan uploads asynchronously |
| Provider SSRF or callback abuse | Fixed Google endpoints, no user-supplied provider URLs, strict redirect handling |
| Queue/backlog silently loses work | Durable job states, retry budget, dead-letter state and health alerts |

## Security decisions

- MVP uses TLS and provider/server encryption at rest, not client-side
  encryption. Client-side encryption is a later architecture requiring an
  explicit key recovery design.
- Google account access is pilot-only. Production promotion requires a second
  byte backup and an account model with organizational ownership.
- Audit records contain actor, target user, file ID, action, result, request ID,
  timestamp and source IP; never include tokens or file contents.

## Recovery targets

- Pilot: metadata backup plus manual per-user export.
- Production gate: encrypted byte backup outside Google, RPO <= 24 hours and
  RTO <= 4 hours, with a documented restore drill.
