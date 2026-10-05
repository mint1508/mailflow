# Use a custom file PWA with a provider-neutral storage adapter

Status: accepted

The file product will use a custom Next.js PWA and separate storage backend rather than forking a general-purpose file platform. A provider-neutral adapter keeps Google Drive replaceable, while PostgreSQL remains the policy/read model and Google Drive holds pilot bytes. This preserves control over cPanel lifecycle, per-user quota, audit and a focused Mailflow UI.
