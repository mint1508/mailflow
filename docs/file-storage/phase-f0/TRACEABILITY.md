# Phase F0 Traceability

This table is the review index for the File PWA foundation. Each row must point
to an executable test, an operational check or a later-phase gate before F0
closes.

| Threat/control or requirement | Implementation phase | Executable test/check | Owner | Gate/evidence |
| --- | --- | --- | --- | --- |
| Browser never receives Google credential or permanent URL | F0/F2 | static source scan; adapter contract test | File API | F0 exit / F2 security gate |
| User cannot cross File Home (IDOR) | F0/F4 | scope-deny contract tests | File API | F0 contract suite |
| Suspended mailbox is revoked within five minutes | F0/F1 | lifecycle/revocation test with `revoked_at + 5m` | Identity | F1 gate |
| In-flight upload grace cannot bypass revoke | F0/F3 | finalize after grace returns `file_access_revoked` | File API | F0 contract suite |
| Concurrent uploads cannot exceed File Quota | F0/F3 | reservation concurrency test | File API | F0 contract suite |
| Retry cannot create duplicate file | F0/F3 | same idempotency key returns same intent | File API | F0 contract suite |
| Provider failures are bounded and visible | F0/F3 | fake adapter 429/5xx/timeout tests; queue alert check | Operations | F0/F3 gates |
| Admin recovery is step-up authenticated and audited | F0/F4 | deny-without-step-up test; audit assertion | Admin | F4 gate |
| No production secret or live OAuth token in F0 | F0 | fixture scan and no-network test | File API | F0 exit |
| Personal Google account is pilot-only | F0/F6 | promotion checklist rejects missing org ownership/backup | Owner | F6 gate |
| Trash/restore retention is recoverable | F4 | 30-day state-machine test and restore drill | File API | F4 gate |
| Export preserves folder tree and metadata | F4 | per-user ZIP export test | File API | F4 gate |
| Backup meets RPO/RTO | F5/F6 | scheduled restore drill evidence | Operations | F5/F6 gate |

F0 exit evidence consists of contract test output, static scan output and a
reviewed copy of this table with no blank owner or gate cells.
