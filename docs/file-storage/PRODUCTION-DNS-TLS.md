# Hippy Files DNS and TLS

Create these Cloudflare DNS records for the zone `hippy.vn`:

| Type | Name | Content | Proxy | TTL |
| --- | --- | --- | --- | --- |
| A | `files` | `14.225.204.112` | DNS only | Auto |
| A | `files-api` | `14.225.204.112` | DNS only | Auto |

The VPS already has HTTP reverse-proxy routes for both names. After public DNS
resolves, issue certificates on the VPS:

```sh
sudo certbot --nginx -d files.hippy.vn -d files-api.hippy.vn
sudo nginx -t && sudo systemctl reload nginx
```

After certificates are issued, Cloudflare proxying can be enabled. Keep the
API record DNS-only if large uploads or long-lived downloads are affected by
Cloudflare request-size or timeout limits.
