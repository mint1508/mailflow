# Hippy File PWA - Product Brief

## Product decision

Build a focused file-management PWA for active Mailflow/cPanel users. The PWA
uses a custom Next.js interface and a separate backend storage service. Google
Drive on a dedicated personal Google account is the pilot byte store; it is not
the long-term production architecture for sensitive data.

## Users and authority

- A File User is an existing Mailflow App User whose cPanel mailbox is active.
- cPanel remains authoritative for mailbox existence, suspension and mailbox
  quota. File Quota is a separate allowance managed by File administrators.
- `auth.hippy.vn` is the shared OIDC identity provider. Mailflow and the File
  PWA are OIDC clients using Authorization Code + PKCE.
- No public registration, password storage or shared browser cookie exists in
  the File PWA.
- File Users see only their own File Home and their own `used / allocated`
  usage. They never see the 5TB total or another user's metadata.

## MVP user journeys

1. Sign in through Hippy SSO and land on My Files.
2. Create folders, upload files with resumable progress, list/search metadata,
   download, rename and move files.
3. Trash and restore files during the retention window.
4. See committed usage, active reservations and allocated quota.
5. Admins provision/lock users, set quota, inspect health, recover files and
   review audit events.

## Explicit non-goals

Sharing, public links, direct Google Drive access, desktop sync, collaborative
editing, offline upload, version history and multi-tenant self-service are not
MVP features.

## Product invariants

- A successful upload is not reported until the storage provider confirms it.
- A File User cannot exceed hard quota, including concurrent uploads and Trash.
- A locked/suspended mailbox cannot start a new file session; existing sessions
  are revoked within five minutes.
- Every admin read/download/recovery action is auditable.
- File bytes are never exposed through a permanent Google URL.
- Retry is idempotent: one logical upload cannot create duplicate committed
  files.

## MVP acceptance criteria

- Pilot supports 20-50 users and 100-300GB without quota overcommit.
- Upload, download, listing and search remain usable during transient Google
  API failures; queued operations show an explicit state.
- Revoke lag is <= 5 minutes after cPanel suspension is observed.
- Trash retention is 30 days; restore never deletes or overwrites another file.
- A per-user ZIP export preserves the folder tree and basic metadata.
- Admin can identify queue depth, provider errors, quota mismatches and backup
  freshness without reading application logs.
