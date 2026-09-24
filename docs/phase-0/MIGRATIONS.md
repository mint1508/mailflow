# Fork Migration Convention

Upstream migrations use four digit sequential names and currently end at `0058`.
Fork-only migrations use the reserved range beginning at `9000`:

```text
9000_internal_identity_roles.sql
9001_internal_cpanel_connector.sql
9002_internal_mailbox_memberships.sql
```

Rules:

1. Keep upstream migration filenames unchanged when merging upstream.
2. Prefix every fork migration description with `internal_`.
3. Never edit an applied migration; add a new forward migration.
4. Use ordinary transactional migrations unless PostgreSQL requires the existing
   `-- no-transaction` mechanism.
5. Record destructive data changes and their restore procedure in the phase plan.
6. Test both a clean database and an upgrade from a copy of the previous schema.

The reserved range works with the existing migration runner and sorts after all
current upstream migrations. If upstream reaches `9000`, migrate the runner to a
two-lane version namespace before importing that upstream release.

