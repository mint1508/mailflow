# Serve PWA branding from runtime configuration

Status: accepted

The PWA manifest and icon URLs are served dynamically from a public read-only branding endpoint backed by the Branding Profile, while writes require `manage_branding`. Uploaded PNG, JPEG, or WebP logos are validated, normalized into required raster sizes, stored on the VPS, and addressed with a branding version so browser caches receive new assets.

Static build-time replacement was rejected because a Mod must change branding without rebuilding containers. Installed iOS and browser PWAs may retain old names or icons until refresh or reinstall, so the settings screen must explain that platform limitation.

