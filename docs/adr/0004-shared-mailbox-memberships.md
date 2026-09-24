# Model shared access as mailbox memberships

Status: accepted

One Mailbox Connection is synchronized once, then related to any number of App Users through Mailbox Membership rows with `read` or `read_send` permission. Duplicating an `email_accounts` row per user was rejected because it would duplicate IMAP sessions, cached messages, and mutation races.

During migration, existing `email_accounts.user_id` values seed owner memberships and remain as an upstream compatibility field. All content authorization moves to a shared account-scope resolver before shared access is enabled; role alone never grants mail visibility.

