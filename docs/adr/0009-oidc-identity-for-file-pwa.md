# Use a shared OIDC identity for Mailflow and the File PWA

Status: accepted

`auth.hippy.vn` is the central identity provider, with Mailflow and the File PWA as separate OIDC clients using Authorization Code + PKCE. The File PWA does not share Mailflow cookies, duplicate mailbox passwords or infer authorization from a browser-provided email address.
