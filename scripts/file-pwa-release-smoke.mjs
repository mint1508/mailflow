import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const baseUrl = (value('--base-url', process.env.FILE_UAT_URL || 'http://127.0.0.1:4300')).replace(/\/$/, '');
const apiUrl = (value('--api-url', process.env.FILE_SERVICE_URL || baseUrl)).replace(/\/$/, '');
const expected = value('--expected-build-id', process.env.FILE_BUILD_SHA || '');
const expectedDigest = value('--expected-image-digest', process.env.FILE_IMAGE_DIGEST || '');
const output = value('--output', 'artifacts/file-pwa/f6/release-smoke.json');
const checks = [];
const redacted = (text) => String(text).replace(/(authorization|cookie|token|secret|provider[_-]?id)\s*[:=]\s*[^,\s}]+/gi, '$1=[REDACTED]');
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail: redacted(detail) }); if (!ok) throw new Error(`${name}: ${detail}`); };
const get = async (url) => { const response = await fetch(url, { redirect: 'manual' }); const body = await response.text(); return { response, body }; };
let failure = null;
let servedDigest = null;
try {
  const html = await get(baseUrl + '/');
  check('html status', html.response.ok, `${html.response.status}`);
  check('html no-store', /no-store/i.test(html.response.headers.get('cache-control') || ''), html.response.headers.get('cache-control') || 'missing');
  const meta = html.body.match(/name=["']file-build-sha["'][^>]*content=["']([^"']+)["']/i) || html.body.match(/content=["']([^"']+)["'][^>]*name=["']file-build-sha["']/i);
  check('html build ID', meta && meta[1], 'file-build-sha meta tag missing');
  const info = await get(baseUrl + '/build-info.json');
  check('build-info status', info.response.ok, `${info.response.status}`);
  check('build-info no-store', /no-store/i.test(info.response.headers.get('cache-control') || ''), info.response.headers.get('cache-control') || 'missing');
  const build = JSON.parse(info.body);
  servedDigest = build.image_digest || null;
  check('single build ID', meta[1] === build.build_sha && (!expected || expected === build.build_sha), `html=${meta[1]} info=${build.build_sha} expected=${expected || '(any)'}`);
  if (expectedDigest) {
    check('expected digest format', /^sha256:[a-f0-9]{64}$/i.test(expectedDigest), expectedDigest);
    check('build-info image digest', build.image_digest === expectedDigest, `build-info=${build.image_digest || '(missing)'} expected=${expectedDigest}`);
  }
  const sw = await get(baseUrl + '/sw.js');
  check('service worker status', sw.response.ok, `${sw.response.status}`);
  check('service worker no-store', /no-store/i.test(sw.response.headers.get('cache-control') || ''), sw.response.headers.get('cache-control') || 'missing');
  check('service worker build ID', sw.response.headers.get('x-file-build-id') === build.build_sha, sw.response.headers.get('x-file-build-id') || 'missing');
  check('service worker build-bound', /CACHE_PREFIX/.test(sw.body) && /build-info\.json/.test(sw.body), 'build-bound cache logic missing');
  const assetUrls = [...html.body.matchAll(/(?:src|href)=["'](\/_next\/static\/[^"']+)["']/gi)].map((match) => match[1]);
  check('hashed assets present', assetUrls.length > 0, 'HTML did not reference a Next static asset');
  for (const asset of [...new Set(assetUrls)]) { const chunk = await get(baseUrl + asset); check(`chunk ${asset}`, chunk.response.ok, `${chunk.response.status}`); check(`chunk ${asset} immutable`, /immutable/i.test(chunk.response.headers.get('cache-control') || '') && /max-age=31536000/i.test(chunk.response.headers.get('cache-control') || ''), chunk.response.headers.get('cache-control') || 'missing'); }
  const health = await get(apiUrl + '/health');
  check('API health', health.response.ok, `${health.response.status}`);
  let healthBody = null;
  try { healthBody = JSON.parse(health.body); } catch { /* status check below reports the useful failure */ }
  check('API readiness', healthBody?.ok === true, healthBody ? JSON.stringify({ status: healthBody.status, queue: healthBody.queue }) : 'health response was not JSON');
  const apiCache = health.response.headers.get('cache-control') || '';
  const directApi = ['localhost', '127.0.0.1'].includes(new URL(apiUrl).hostname);
  check('API no-store', /no-store/i.test(apiCache) || (directApi && !apiCache), apiCache || 'direct local service');
  if (process.env.BROWSER_SMOKE_URL) {
    const command = process.env.BROWSER_SMOKE_COMMAND;
    check('browser harness configured', command, 'set BROWSER_SMOKE_COMMAND when BROWSER_SMOKE_URL is used');
    await new Promise((resolve, reject) => { const child = spawn(command, { shell: true, env: { ...process.env, BROWSER_SMOKE_URL: process.env.BROWSER_SMOKE_URL }, stdio: ['ignore', 'pipe', 'pipe'] }); let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; }); child.on('close', (code) => { try { check('browser console', code === 0 && !/console\.(?:error|warn)|List is not defined|ReferenceError/i.test(logs), redacted(logs.slice(-1000))); resolve(); } catch (error) { reject(error); } }); });
  }
} catch (error) { failure = error; }
const artifact = { schema_version: 1, ok: !failure && checks.every((item) => item.ok), base_url: baseUrl, api_url: apiUrl, expected_build_id: expected || null, build_id: checks.find(item => item.name === 'single build ID')?.ok ? expected || null : null, image_digest: servedDigest, checks, error: failure ? redacted(failure.message) : null, generated_at: new Date().toISOString() };
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(path.resolve(output), JSON.stringify(artifact, null, 2) + '\n');
console.log(JSON.stringify({ ok: artifact.ok, output, checks: checks.length }));
if (!artifact.ok) process.exitCode = 1;
