# Phase F6 Plan Index - File PWA UI Infrastructure

## Outcome

Release the File PWA from a clean checkout and make visible workflows authorized, durable, observable, and safe to promote against live Google Drive.

## Resolved decisions

| ID | Decision |
| --- | --- |
| D-01 | Browser calls only `file-service`; Google credentials, provider IDs, and permanent provider URLs never enter the browser. |
| D-02 | Sharing/public links/offline upload/version history remain outside MVP; remove Shared UI. |
| D-03 | Preview allowlist is PNG/JPEG/WebP/GIF, plain text, and PDF up to 25 MiB; SVG/HTML and larger files use download fallback. |
| D-04 | Cursor format is versioned `v1`, HMAC-SHA256 signed with `FILE_CURSOR_SECRET`, actor/filter-bound, 15-minute expiry, default page 50/max 200. |
| D-05 | Browser queue stores metadata and optional `FileSystemFileHandle`, never file bytes; missing permission becomes `needs_file_reselect`. |
| D-06 | Bulk trash/restore is best-effort, max 100 IDs, one actor/idempotency scope, with stable per-item outcomes. |
| D-07 | Worker uses Redis Streams `file:jobs:v1`, consumer group `file-workers-v1`, AOF persistence, `XAUTOCLAIM`, and DLQ `file:jobs:dead:v1`. |
| D-08 | F6-03 adds metadata fields inside existing records/contracts only. F6-06 exclusively owns relational migrations `0002`-`0004`. |
| D-09 | Relational cutover retains JSON dual-write and snapshot-read rollback; database rollback never deletes provider bytes. |
| D-10 | Upload success appears only after provider confirmation; queued finalize returns 202/operation status, never false success. |

## Coverage

| Requirement | Plan |
| --- | --- |
| F6-REL | F6-01 |
| F6-ACTIONS | F6-02 |
| F6-FAVORITES, F6-LIST | F6-03 |
| F6-UPLOAD, F6-BULK | F6-04 |
| F6-WORKER | F6-05 |
| F6-DB | F6-06 |
| F6-LIVE | F6-07 |

Research recommendations for build/cache checks, authorized preview/activity, IndexedDB queue, Redis worker, relational migration, and live Drive gates are all assigned. Deferred sharing/public-link/offline/version-history ideas are absent.

## Waves

| Wave | Work | File-conflict rule |
| ---: | --- | --- |
| 0 | `F6-VALIDATION.md` test harness and source manifest verifier | Must complete before production code |
| 1 | F6-01 release/cache and F6-02 action correctness | Disjoint production ownership |
| 2 | F6-03 stars/activity/list contracts | Sequential ownership of `server.js`/`main.jsx`/`api.js` |
| 3 | F6-04 upload/bulk | Sequential monolith ownership |
| 4 | F6-05 worker/scheduler | Sequential service ownership |
| 5 | F6-06 relational migration | Exclusive migration/repository ownership |
| 6 | F6-07 live UAT/promotion | Requires every earlier gate |

## Canonical gate

```bash
bash scripts/file-pwa-validate.sh
```
