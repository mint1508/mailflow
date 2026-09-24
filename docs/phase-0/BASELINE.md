# Phase 0 Baseline

## Upstream pin

- Repository: `https://github.com/maathimself/mailflow.git`
- Remote: `upstream`
- Release: `v3.5.6`
- Commit: `c034f33f8f07bf90af8de496828bd97458b411ac`
- Baseline date: 2026-09-24
- Runtime: Node 22, PostgreSQL 16, Redis 7

The working branch is `internal-main`. Add the user's GitHub fork as `origin` when
its URL exists; do not point `origin` at upstream. The local tag
`internal-baseline-v3.5.6` marks the unmodified application baseline.

## Verification evidence

Commands ran in Node 22 containers because the host Node version was newer than
the backend's supported `>=22 <23` range.

| Check | Result |
| --- | --- |
| Frontend `npm test` | Passed |
| Frontend `npm run lint` | Passed |
| Frontend `npm run build` | Passed; existing large chunk warnings only |
| Backend `npm test` | Passed: 100 files, 1,751 tests |
| Backend `npm run lint` | Passed |
| Backend `npm run lint:plugins` | Passed |
| `docker compose build frontend backend` | Passed |
| PostgreSQL migrations | 58 applied on a clean database |
| Service health | Frontend, backend, PostgreSQL, and Redis healthy |
| Mail smoke | Register/session, two IMAP connections, SMTP send, recipient sync, and message read passed with GreenMail 2.1.5 |

`npm ci` reported the upstream dependency baseline of two moderate findings in
the frontend and one moderate finding in the backend. Phase 0 does not change
upstream dependency versions; security dependency changes need their own tested
patch.

## Repeatable commands

```bash
docker run --rm -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  -v "$PWD/frontend:/app" -w /app node:22-alpine npm ci
docker run --rm -v "$PWD/backend:/app" -w /app node:22-alpine npm ci

docker run --rm -v "$PWD:/repo" -w /repo/backend node:22-alpine npm test
docker run --rm -v "$PWD/backend:/app" -w /app node:22-alpine npm run lint
docker run --rm -v "$PWD/backend:/app" -w /app node:22-alpine npm run lint:plugins
docker run --rm -v "$PWD/frontend:/app" -w /app node:22-alpine npm test
docker run --rm -v "$PWD/frontend:/app" -w /app node:22-alpine npm run lint
docker run --rm -v "$PWD/frontend:/app" -w /app node:22-alpine npm run build

docker compose build frontend backend
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
```

The frontend and backend builds must continue to receive the pinned Git commit
through `GIT_SHA`. Prebuilt deployments must set `MAILFLOW_VERSION=3.5.6`; never
deploy the implicit `latest` value.
