# Treat message bodies as an evictable cache

Status: accepted

Mail metadata remains in PostgreSQL, while message bodies are cached for at most seven days and within one configured organization budget of 1, 2, 5, or 10 GB, defaulting to 2 GB. Eviction clears cached bodies by expiry and least recent access without deleting message metadata; a later read fetches the body again from IMAP. Attachments continue to stream from IMAP and are not persistently stored on the VPS.

This design preserves fast recent mail access and search metadata while keeping VPS disk use bounded. The cache is excluded from backup recovery guarantees because cPanel remains the durable mail store.

