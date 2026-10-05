# Limit personal Google Drive to the pilot

Status: accepted

The initial file pilot uses a dedicated Google personal account because the available 5TB is already provisioned. The account is infrastructure, not an end-user identity; its refresh token stays server-side, access is never granted directly to users, and promotion to production requires organizational ownership plus a second byte backup.
