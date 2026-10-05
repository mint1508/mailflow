# F5 Pilot UAT Checklist

Mark each item with evidence (test ID, timestamp, and commit). Do not mark
`PASS` from a static code review alone.

| Area | Scenario | Evidence | Status |
| --- | --- | --- | --- |
| Auth | OIDC PKCE session and mock user sign-in work; unknown user is denied | OIDC callback/session/replay tests; `requires authentication...`; 20-user UAT | PASS |
| Lifecycle | locked/revoked user cannot start a new session | service revoke/grace tests; 20-user UAT returns `file_access_revoked` | PASS |
| Isolation | user cannot list or mutate another user's home | service cross-user IDOR test | PASS |
| Quota | concurrent reservations never exceed hard quota | service hard-quota and concurrent-reservation tests | PASS |
| Upload | retry is idempotent and final state is explicit | service idempotency/upload tests; 20-user upload/download UAT | PASS |
| Provider | fake provider outage produces degraded/retryable state | provider-outage test; `/health` reports `fake-disk` | PASS |
| Recovery | trash/restore and ZIP export preserve metadata and bytes | service trash/ZIP export tests; 20-user trash/restore UAT | PASS |
| Audit | privileged actions record actor, subject, action, request ID | service audit test; UAT event-count assertion | PASS |
| Mobile | responsive contract builds and exposes mobile file controls | Next production build plus `max-width:780px` responsive rules | PASS (automated) |
| Accessibility | keyboard/label rules pass configured audit | `eslint` with `eslint-plugin-jsx-a11y`, zero warnings | PASS (automated) |
| Localization | Vietnamese navigation, actions and stable API errors exist | source inspection plus successful production build | PASS |

Evidence run: 2026-09-29. `file-service` passed 24/24 tests, `file-web` passed
3/3 tests, 20-user fake-disk UAT and a 200GB-shaped sparse capacity run passed,
production build/lint passed, and `npm audit` reported zero vulnerabilities. A
manual browser visual click-through was unavailable in this CLI verification;
the automatable mobile/a11y contracts passed and visual review remains a
recommended pre-public-pilot check.
