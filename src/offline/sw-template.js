/* Generated with the production app's exact asset manifest at build time. */
const { appCache, assets } = __SCOUT_OFFLINE_MANIFEST__;
const TILE_CACHE = 'scout-offline-map-tiles-v1';
const CONTOUR_CACHE = 'scout-offline-contours-v1';
const CONTOUR_PATH = '/6j1KwZfY2fZrfNMR/arcgis/rest/services/ELEVLINE/FeatureServer/4/query';
const VERIFY_PATH = '/__scout_verify_offline_tile__';

// The page checks that its controlling worker actually cached this build
// before reporting any offline map as saved (important during PWA updates).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SCOUT_SHELL_INFO' && event.ports?.[0]) {
    event.ports[0].postMessage({ appCache });
  }
});

function isMapTile(url) {
  const government = url.hostname === 'mapapi.hkmapservice.gov.hk' &&
    /^\/gs\/api\/v1\.0\.0\/xyz\/(basemap\/WGS84|label\/hk\/tc\/WGS84)\/\d+\/\d+\/\d+\.png$/.test(url.pathname);
  const countryside = /^[abc]\.tile\.opentopomap\.org$/.test(url.hostname) &&
    /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname);
  return url.protocol === 'https:' && (government || countryside);
}

function isContourQuery(url) {
  return url.protocol === 'https:' && url.hostname === 'services3.arcgis.com' &&
    url.pathname === CONTOUR_PATH && !url.searchParams.has('callback');
}

self.addEventListener('install', (event) => {
  // Do not advertise an offline-ready app if any required app asset failed.
  event.waitUntil((async () => {
    const cache = await caches.open(appCache);
    await cache.addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Preserve downloaded maps when updating the application shell.
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('scout-offline-app-') && key !== appCache).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkOrSaved(request, cacheName) {
  // Explicit download requests use a private marker. Browser reloads can also
  // have cache mode 'reload', so cache mode alone must not bypass offline data.
  const url = new URL(request.url);
  if (url.searchParams.has('__scout_fresh')) {
    url.searchParams.delete('__scout_fresh');
    return fetch(new Request(url.href, {
      mode: request.mode, credentials: request.credentials, cache: 'reload', signal: request.signal,
    }));
  }
  const cache = await caches.open(cacheName);
  const saved = await cache.match(request, { ignoreVary: true });
  if (!saved) return fetch(request);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const response = await fetch(request, { signal: ctrl.signal });
    return response.ok || response.type === 'opaque' ? response : saved;
  } catch {
    return saved;
  } finally {
    clearTimeout(timer);
  }
}

async function appResource(request) {
  const cache = await caches.open(appCache);
  if (request.mode === 'navigate') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const response = await fetch(request, { signal: ctrl.signal });
      if (response.ok) return response;
    } catch { /* fall back to the pre-cached application */ }
    finally { clearTimeout(timer); }
    return (await cache.match('/index.html')) || Response.error();
  }
  // Hashed bundles and app assets belong to the installed shell. Other
  // same-origin requests go to the network; do not cache arbitrary user data.
  const saved = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  return saved || fetch(request);
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname === VERIFY_PATH) {
    event.respondWith((async () => {
      let original;
      try { original = new URL(url.searchParams.get('url')); } catch { return new Response('', { status: 404 }); }
      if (!isMapTile(original)) return new Response('', { status: 404 });
      return (await (await caches.open(TILE_CACHE)).match(original.href, { ignoreVary: true })) || new Response('', { status: 404 });
    })());
    return;
  }
  if (isMapTile(url)) {
    event.respondWith(networkOrSaved(event.request, TILE_CACHE));
  } else if (isContourQuery(url)) {
    event.respondWith(networkOrSaved(event.request, CONTOUR_CACHE));
  } else if (url.origin === self.location.origin && !url.pathname.startsWith('/_vercel/') && !url.pathname.startsWith('/api/')) {
    event.respondWith(appResource(event.request));
  }
});
