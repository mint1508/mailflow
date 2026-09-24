# Phase 0 Architecture Spikes

## Conclusions

| Spike | Feasibility | Main seam | Required core change |
| --- | --- | --- | --- |
| IMAP login provider | Feasible | Provider invoked by auth route before session creation | Extract primary authentication from `routes/auth.js`; reuse session, TOTP, encryption, and IMAP connection services |
| RBAC | Feasible | Permission middleware and policy service | Replace `requireAdmin` callers and direct `is_admin` checks incrementally |
| Shared Mailbox | Feasible | Central account-scope resolver | Add membership table and migrate every mail query from direct `user_id` ownership checks |
| Dynamic PWA branding | Feasible | Public branding read endpoint plus protected write endpoint | Change manifest/icon links and add versioned asset handling |
| Storage Lite | Feasible | Body fetch and cache write/read path | Add cache timestamps/byte accounting and an eviction job; attachment flow already streams from IMAP |

No spike requires replacing Express, PostgreSQL, Redis, IMAPFlow, Nodemailer, or
the existing encrypted credential store. The largest risk is the number of mail
queries that assume `email_accounts.user_id` means exclusive ownership. Shared
Mailbox work must not start until the common scope resolver has deny tests.

## Auth flow

1. Normalize the full mailbox email address.
2. Find an active App User and linked cPanel Mailbox projection.
3. Authenticate against the configured IMAP endpoint with the supplied password.
4. Encrypt and update the Mailbox Connection credential after successful auth.
5. Apply role status, suspension, and mandatory TOTP policy.
6. Regenerate and establish the existing Redis-backed session.

Failure is explicit: invalid credentials return an auth failure; unavailable IMAP
returns maintenance/retry; a missing local invitation never creates an App User.

## Shared access invariant

An App User can read an account only when an active Mailbox Membership exists.
Sending additionally requires `read_send`. Owner and Mod roles do not bypass this
invariant. Background synchronization operates once per Mailbox Connection and is
independent of how many memberships exist.

## Branding cache behavior

The public manifest response uses `Cache-Control: no-cache` and an ETag based on
the branding version. Generated icon assets use immutable versioned URLs. The web
document updates title, theme color, favicon, and Apple touch icon at runtime.
Installed PWA shells can remain stale according to browser or operating system
rules, so the UI shows the current branding version and reinstall guidance.

