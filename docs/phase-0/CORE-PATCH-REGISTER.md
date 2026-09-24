# Core Patch Register

Use this register for fork changes that touch upstream Mailflow core. Update it in
the same change that introduces or removes a patch.

| Area | Expected paths | Isolation strategy | Upstream conflict risk | Status |
| --- | --- | --- | --- | --- |
| Authentication provider | `backend/src/routes/auth.js`, new auth provider service | Provider interface; keep session and TOTP code shared | High | Spike accepted |
| RBAC | `backend/src/middleware/auth.js`, admin routes, frontend guards | Permission service and middleware | High | Spike accepted |
| Mailbox scope | Mail/account/search/send routes | One account-scope resolver used by all routes | High | Spike accepted |
| cPanel | New adapter, routes, jobs, UI pages | No cPanel calls from existing mail services | Low | Spike accepted |
| Dynamic branding | Public manifest/icon endpoint, `frontend/index.html`, shell UI | Branding service with versioned assets | Medium | Spike accepted |
| Storage Lite | Message body service, migrations, eviction job | Cache policy service; no attachment persistence | Medium | Spike accepted |
| Vietnamese locale | `frontend/src/locales/vi.json`, locale registry | Follow existing locale contract tests | Low | Planned |

