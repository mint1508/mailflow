# Use IMAP-backed authentication for mailbox users

Status: accepted

Mailbox-backed App Users authenticate with their full email address and mailbox password through an isolated auth provider. A successful IMAP authentication resolves the App User and Mailbox, refreshes the encrypted Mailbox Connection credential needed for background sync, and then creates the normal Mailflow session. This preserves Mailflow's session and 2FA flow while making cPanel mail credentials the login authority; cPanel UAPI is not placed in the login path.

The existing local-password flow remains only for the controlled migration/bootstrap step and is disabled for normal registration once the new provider is enabled. Owner and Mod sessions still require TOTP after primary authentication. When IMAP cannot validate new sessions, the app reports maintenance instead of silently falling back to a different password authority.

