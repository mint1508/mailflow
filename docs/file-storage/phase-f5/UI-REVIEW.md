# Hippy Files UI and Infrastructure Review

Date: 2026-10-01
Scope: `file-web` UI, `file-service` API, production evidence, and the File PWA contracts.

## Score

| Pillar | Score | Notes |
| --- | ---: | --- |
| Copywriting | 3/4 | Vietnamese labels and failure states are generally clear, but Shared and starred navigation imply persistence/collaboration that the API does not provide. |
| Visuals | 3/4 | The redesign has a coherent Drive-like shell, useful empty/loading/error states, and responsive layout rules. |
| Color | 3/4 | The green/neutral and blue/neutral variants are legible and consistent in the captured artifacts. |
| Typography | 3/4 | DM Sans/Manrope and the hierarchy read well; metadata is small in dense rows and needs real content-length testing. |
| Spacing | 3/4 | Desktop composition is balanced; mobile and long-name/large-list behavior still need manual browser verification. |
| Experience design | 1/4 | Several visible actions are local-only or placeholders, and the deployed bundle has previously crashed at runtime. |

Overall: **16/24**. The visual foundation is ready for another implementation pass, but the UI should not be treated as a complete storage product until the P0/P1 contracts below are closed.

## Findings

### P0 - Release and deployment integrity

1. `file-web` and `file-service` are untracked in Git (`git ls-files` returns zero files for both). A clean CI checkout or deployment from the repository will omit the entire File PWA. The UI cannot be promoted safely until these files are committed and included in the release pipeline.
2. Existing production browser evidence contains repeated `ReferenceError: List is not defined` errors for `files.hippy.vn` (`.playwright-mcp/console-2026-09-30T16-08-48-917Z.log`). The current local source/build no longer references `List` and passes lint/build, so production is serving a different/stale bundle. The web response is cached with `s-maxage=31536000`, which makes stale HTML/chunks persist after a release. Add an immutable release/version check, purge or revalidate HTML, and verify the deployed chunk hash after every UI release.

### P1 - UI controls without durable backend contracts

3. Starred files are held only in React state (`file-web/src/main.jsx:49`, `file-web/src/main.jsx:67`). There is no star field, endpoint, or migration in `file-service`; reload loses stars and the Starred view is empty for live data. Add a `starred_at`/favorite model and idempotent PATCH endpoint, or remove the star affordance until persistence exists.
4. `Được chia sẻ` is a navigation item (`file-web/src/main.jsx:17`) but the service only lists nodes for the authenticated `file_user_id` (`file-service/src/server.js:166-174`). The product brief explicitly excludes sharing. Either remove/rename this nav item for MVP or implement ACLs, shared roots, permission checks, audit events, and a dedicated list endpoint.
5. Preview and several download actions are placeholders. The preview renders `/icon.svg` for image files (`file-web/src/main.jsx:855-881`), the preview/download buttons only show a toast (`file-web/src/main.jsx:718-723`, `file-web/src/main.jsx:863-864`), and there is no preview/range/thumbnail API. Keep the real `fileApi.download` path for download and add an authorized inline/thumbnail endpoint before advertising preview.
6. The context-menu delete handler toggles the star and then claims the item was trashed (`file-web/src/main.jsx:721`). This is a user-visible destructive-action bug. Route it through the existing `fileApi.trash`/restore flow and show the undo action consistently.
7. The Activity tab is hardcoded (`file-web/src/main.jsx:834-847`) and the created date is hardcoded to `20/09/2026` (`file-web/src/main.jsx:826`). The service has audit records but no node activity endpoint. Add node-scoped activity/history data or remove the tab and fabricated metadata.

### P1 - Search, list and upload semantics

8. Advanced filters are implemented against the current client array and localized display strings (`file-web/src/main.jsx:72-110`). The API search accepts only `q` and returns an unbounded filtered array (`file-service/src/server.js:233`). Owner is always effectively the current user and date matching depends on strings such as `09/2026`. Add typed server-side filters, pagination/cursors, total/next-page metadata, and stable ISO timestamps; otherwise label the controls as local filters and limit them to loaded rows.
9. Upload transport is chunked, but the browser does not persist the upload intent or resume offset (`file-web/src/api.js:62-72`). A refresh loses the upload, there is no cancel/retry/resume UI, and the progress panel supports one file only (`file-web/src/main.jsx:660-670`). Add an upload-session status/resume endpoint, durable client queue (IndexedDB), retry/backoff/cancel state, and multi-file progress if the UI promises resumable uploads.
10. Bulk trash/restore sends one mutation per item in sequence (`file-web/src/main.jsx:283-295`). A mid-batch failure leaves a partial result with no per-item report. Add a bulk mutation endpoint or explicit per-item result handling and refresh reconciliation.

### P1 - Operations and provider readiness

11. Trash purge and expired-reservation cleanup are exposed as an admin HTTP action (`file-service/src/server.js:150-152`) but there is no scheduler/worker invocation in the service or compose files. The 30-day retention promise therefore depends on an operator manually calling the endpoint. Run maintenance from a dedicated worker/cron with alerting and idempotent retry.
12. The job queue currently tracks provider operations and dead letters but does not process an asynchronous queue (`file-service/src/server.js:37`, `file-service/src/job-queue.js:1-25`). This is enough for synchronous retry metrics, not for queued UI states or recovery. Add a worker, durable job payload/status, retry timestamps, and a UI endpoint for operation status before showing queued/degraded workflows.
13. PostgreSQL is used as a serialized JSON snapshot: every transaction loads all records, deletes every table, and reinserts the complete state (`file-service/src/postgres-store.js:18-44`). This will become a latency/contention bottleneck as the UI grows to 20-50 users and large metadata sets, and it prevents efficient search/activity pagination. Move nodes, uploads, reservations and audit events to typed columns with indexes and incremental writes before production scale.
14. Live Google Drive authorization and live-account UAT remain pending by the roadmap's own status (`docs/file-storage/ROADMAP.md:43-48`, `docs/file-storage/ROADMAP.md:59-63`). The public API currently reports a healthy Google provider, but the recorded acceptance evidence is fake-provider based. Do not promote the UI as production-ready until OAuth refresh, quota/rate-limit behavior, recovery, and the browser flows pass against the real provider.

## Recommended order

1. Commit and deploy the File PWA, invalidate stale HTML/service-worker assets, and verify the production bundle has no runtime errors.
2. Fix destructive/download/preview behavior and remove or gate unsupported Shared/starred/Activity affordances.
3. Add typed list/search/filter/pagination contracts and durable upload resume/status.
4. Add scheduled maintenance, a real worker/status model, and incremental PostgreSQL persistence.
5. Complete Google Drive live UAT and only then re-run manual desktop/mobile visual review.

## Validation performed

- `file-service`: lint and 38 tests passed.
- `file-web`: lint and Next production build passed; Next emitted only the existing ESLint plugin warning.
- `git diff --check` passed.
- Production health endpoint reported Google Drive available; unauthenticated File API correctly returned 401.
- In-app browser was unavailable, so manual click-through remains outstanding; captured repository artifacts and prior Playwright logs were used for visual/runtime evidence.
