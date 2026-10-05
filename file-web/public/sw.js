const CACHE_PREFIX = 'hippy-files-';
const APP_SHELL = ['/manifest.webmanifest', '/icon.svg'];
const buildCache = async () => {
  const response = await fetch('/build-info.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to read build ID');
  const { build_sha: buildId } = await response.json();
  if (!/^[a-zA-Z0-9._-]+$/.test(buildId)) throw new Error('Invalid build ID');
  return CACHE_PREFIX + buildId;
};
self.addEventListener('install', (event) => { event.waitUntil(buildCache().then((name) => caches.open(name).then((cache) => cache.addAll(APP_SHELL)))); self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(buildCache().then((name) => caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== name).map((key) => caches.delete(key))))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (event) => {
  const {request} = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^(\/api\/|\/auth\/|\/download\/|\/preview\/)/.test(url.pathname) || ['/health', '/build-info.json', '/sw.js'].includes(url.pathname)) return;
  if (request.mode === 'navigate') { event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => new Response('Offline', { status: 503 }))); return; }
  if (url.pathname.startsWith('/_next/')) return;
  event.respondWith(buildCache().then((name) => caches.open(name).then((cache) => cache.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  }))));
});
