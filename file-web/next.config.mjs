import path from 'node:path';
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  outputFileTracingRoot: path.resolve(process.cwd()),
  async headers() {
    const buildId = process.env.FILE_BUILD_SHA || 'dev';
    const security = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
    ];
    return [
      { source: '/(.*)', headers: security },
      { source: '/', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      { source: '/_next/static/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/manifest.webmanifest', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'X-File-Build-Id', value: buildId }] },
    ];
  },
};
export default nextConfig;
