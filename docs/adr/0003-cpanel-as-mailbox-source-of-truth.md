# Put cPanel behind a source-of-truth adapter

Status: accepted

cPanel remains authoritative for Mailbox existence, quota, suspension, password changes, and forwarders. Application routes call a dedicated adapter that owns UAPI request signing, timeouts, bounded retries, response validation, and stable internal error codes; routes and jobs do not construct cPanel URLs directly. The API token is encrypted at rest and is never returned to the browser or written to logs.

Local records are projections used for roles, workflow state, audit, and display. A sync may update those projections after an out-of-band cPanel change, while a failed cPanel mutation never receives a locally successful state.

