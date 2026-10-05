import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = async (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('build identity is exposed by the shell and build-info route', async () => {
  const layout = await files('app/layout.jsx');
  const route = await files('app/build-info.json/route.js');
  assert.match(layout, /file-build-sha/);
  assert.match(layout, /FILE_BUILD_SHA/);
  assert.match(route, /build_sha/);
  assert.match(route, /Cache-Control.*no-store/);
  const previous = process.env.FILE_IMAGE_DIGEST;
  process.env.FILE_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
  try {
    const { GET } = await import('../app/build-info.json/route.js');
    const response = await GET();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).image_digest, process.env.FILE_IMAGE_DIGEST);
  } finally {
    if (previous === undefined) delete process.env.FILE_IMAGE_DIGEST;
    else process.env.FILE_IMAGE_DIGEST = previous;
  }
});

test('Next and Nginx classify shell and hashed assets safely', async () => {
  const next = await files('next.config.mjs');
  const nginx = await readFile(new URL('../../docs/file-storage/nginx/files.hippy.vn.conf', import.meta.url), 'utf8');
  assert.match(next, /_next\/static/);
  assert.match(next, /31536000, immutable/);
  assert.match(next, /no-store/);
  assert.match(nginx, /_next\/static/);
  assert.match(nginx, /no-store/);
  assert.match(nginx, /immutable/);
});

test('service worker versions caches from build-info and bypasses API responses', async () => {
  const sw = await files('public/sw.js');
  assert.match(sw, /CACHE_PREFIX/);
  assert.match(sw, /build-info\.json/);
  assert.match(sw, /\\\/api\\\//);
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /cache: 'no-store'/);
  assert.doesNotMatch(sw, /hippy-files-v3/);
});
