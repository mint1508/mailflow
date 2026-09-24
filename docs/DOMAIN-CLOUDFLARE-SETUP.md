# Domain and Cloudflare Setup

Cloudflare proxies the browser-facing web app only. Email protocols must connect
directly to the mail provider because the normal Cloudflare proxy does not carry
IMAP, SMTP, or cPanel traffic.

## DNS layout

Replace `example.com` and the VPS address with the real values.

| Record | Name | Target | Cloudflare proxy |
| --- | --- | --- | --- |
| A/AAAA | `inbox` | App VPS | Proxied |
| A/AAAA | `staging-inbox` | Staging VPS | Proxied during pilot |
| MX | `@` | Provider mail host | DNS only |
| A/CNAME | `mail` | Provider mail host | DNS only |
| A/CNAME | `imap` | Provider mail host | DNS only |
| A/CNAME | `smtp` | Provider mail host | DNS only |
| A/CNAME | `autodiscover` | Provider target | DNS only |
| A/CNAME | cPanel/provider hostname | Provider target | DNS only |

Do not change the existing MX, SPF, DKIM, or DMARC records as part of the app
deployment. cPanel remains responsible for mail delivery.

## Cloudflare settings

1. Set SSL/TLS encryption mode to **Full (strict)**.
2. Keep **Always Use HTTPS** enabled after the origin certificate works.
3. Keep WebSockets enabled under Network settings.
4. Do not enable a site-wide `Cache Everything` rule.
5. Create bypass-cache rules for these paths:
   - `/api/*`
   - `/auth/*`
   - `/oauth/*`
   - `/ws`
   - `/activation/*`
   - `/manifest.webmanifest`
6. Do not create Cloudflare origin rules that rewrite IMAP, SMTP, or cPanel ports.

Cloudflare proxying is suitable for `inbox.example.com` over HTTPS 443. It is not
suitable for the Mailbox connection endpoints on 993, 465, 587, or 2083 under the
standard proxy service.

## Origin TLS

The bundled Caddy service obtains and renews a public certificate. Ports 80 and
443 must reach the VPS while the certificate is issued. Cloudflare Full (strict)
then validates that certificate when proxying requests to the origin.

Set these values in the environment file:

```dotenv
APP_URL=https://inbox.example.com
DOMAIN=inbox.example.com
ACME_EMAIL=ops@example.com
```

## Verification

Check the browser-facing app:

```bash
curl -I https://inbox.example.com
curl -fsS https://inbox.example.com/api/health
curl -fsS https://inbox.example.com/api/version
```

Check that email services still resolve and connect directly. Use the actual
provider hostname shown by cPanel rather than the proxied app hostname:

```bash
openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null
openssl s_client -connect mail.example.com:465 -servername mail.example.com </dev/null
curl -I https://mail49.vietnix.vn:2083/
```

For SMTP 587, a successful TCP connection followed by a `220` banner and STARTTLS
capability is expected. The cPanel request may redirect to login; reachability and
a valid TLS certificate are the checks at this phase.

## Common mistakes

- Orange-cloud proxying `mail`, `imap`, or `smtp`, which breaks email clients.
- Using Cloudflare **Flexible** SSL, which leaves the origin leg unencrypted and
  can break secure cookies or redirect behavior.
- Pointing MX to `inbox.example.com`; the app is a mail client, not the mail server.
- Deleting provider DNS records while adding the app hostname.
- Caching API or activation responses at Cloudflare.

