# Replace is_admin authorization with roles and permissions

Status: accepted

Authorization uses one role per App User (`owner`, `mod`, or `member`) plus explicit permission grants for Mods. Owner receives the complete permission set, Members receive only self-service mail access, and Mods receive only grants assigned by Owner. Mailbox content access is checked separately through Mailbox Membership, so a Mod who can provision Mailboxes cannot read personal mail.

The existing `is_admin` field is retained temporarily as a migration compatibility field, but new endpoints must call permission middleware and Mailbox Membership scope helpers. The cutover requires allow and deny tests for every permission because a boolean admin fallback would violate the product's privacy boundary.

