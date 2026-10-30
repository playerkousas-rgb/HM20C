const LANDSD_API = 'https://mapapi.hkmapservice.gov.hk/gs/api/v1.0.0/xyz';
export const TILE_CACHE = 'scout-offline-map-tiles-v1';
export const CONTOUR_CACHE = 'scout-offline-contours-v1';
export const CONTOUR_STAGING_PREFIX = 'scout-offline-contours-pending-';
const PACKS_KEY = 'scout-trail-map.offline-areas.v1';
const VERIFY_PATH = '/__scout_verify_offline_tile__';
// Only the current viewport at the locked scale, not entire regions or several
// zoom levels. Sequential, paced requests avoid a burst to public map servers.
export const MAX_AREA_TILES = 80;
const TILE_DELAY_MS = 350;
const TILE_TIMEOUT_MS = 15_000;

const clamp = (number, min, max) => Math.min(max, Math.max(min, number));
function tileX(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function tileY(lat, z) {
  const rad = clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  return Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * 2 ** z);
}
function lonForTile(x, z) { return x / 2 ** z * 360 - 180; }
function latForTile(y, z) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI; }

export function planOfflineArea({ bounds, center, zoom, basemap, tileRange }) {
  if (!bounds || !center || !Number.isFinite(zoom) || !['hm20c', 'countryside'].includes(basemap)) throw new Error('未能取得地圖範圍。');
  const { south, west, north, east } = bounds;
  if (![south, west, north, east, center.lat, center.lon].every(Number.isFinite) || south >= north || west >= east || west < -180 || east > 180) throw new Error('地圖範圍無效，請移回香港再試。');
  const z = clamp(Math.round(zoom), 10, basemap === 'countryside' ? 17 : 20);
  const limit = 2 ** z - 1;
  const hasRange = tileRange?.zoom === z && [tileRange.minX, tileRange.maxX, tileRange.minY, tileRange.maxY].every(Number.isInteger);
  // One extra tile at each edge is useful for a small pan, but never let it
  // push the request past the conservative limit on public map servers.
  const original = {
    x0: hasRange ? tileRange.minX : tileX(west, z), x1: hasRange ? tileRange.maxX : tileX(east, z),
    y0: hasRange ? tileRange.minY : tileY(north, z), y1: hasRange ? tileRange.maxY : tileY(south, z),
  };
  const withMargin = (margin) => ({
    x0: clamp(original.x0 - margin, 0, limit), x1: clamp(original.x1 + margin, 0, limit),
    y0: clamp(original.y0 - margin, 0, limit), y1: clamp(original.y1 + margin, 0, limit),
  });
  let range = withMargin(1);
  const count = (r) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) * (basemap === 'hm20c' ? 2 : 1);
  if (count(range) > MAX_AREA_TILES) range = withMargin(0);
  const { x0, x1, y0, y1 } = range;
  if (x0 > x1 || y0 > y1) throw new Error('地圖圖磚範圍無效，請移動地圖後重試。');
  if (count(range) > MAX_AREA_TILES) throw new Error(`目前範圍過大；每次最多 ${MAX_AREA_TILES} 張圖磚。請在手機畫面分區下載。`);
  const coverageBounds = { west: lonForTile(x0, z), east: lonForTile(x1 + 1, z), north: latForTile(y0, z), south: latForTile(y1 + 1, z) };
  const tiles = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      if (basemap === 'hm20c') {
        tiles.push(`${LANDSD_API}/basemap/WGS84/${z}/${x}/${y}.png`);
        tiles.push(`${LANDSD_API}/label/hk/tc/WGS84/${z}/${x}/${y}.png`);
      } else {
        const subdomain = 'abc'[Math.abs(x + y) % 3]; // Leaflet's subdomain choice
        tiles.push(`https://${subdomain}.tile.opentopomap.org/${z}/${x}/${y}.png`);
      }
      if (tiles.length > MAX_AREA_TILES) throw new Error(`目前範圍過大；每次最多 ${MAX_AREA_TILES} 張圖磚。請在手機畫面分區下載。`);
    }
  }
  return { basemap, bounds, coverageBounds, center, zoom: z, mapZoom: zoom, tiles };
}

// The service worker strips this marker before fetching the provider. Unlike
// cache:reload, it cannot be confused with a normal browser page reload.
export function freshRequestUrl(url) {
  const fresh = new URL(url);
  fresh.searchParams.set('__scout_fresh', '1');
  return fresh.href;
}

function timeout(promise, ms, message, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已停止', 'AbortError')); return; }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('已停止', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

async function controllingShellInfo() {
  const worker = navigator.serviceWorker.controller;
  if (!worker || typeof MessageChannel === 'undefined') return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish(null), 1000);
    function finish(value) { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(value); }
    channel.port1.onmessage = (event) => finish(event.data);
    try { worker.postMessage({ type: 'SCOUT_SHELL_INFO' }, [channel.port2]); }
    catch { finish(null); }
  });
}

async function waitForCurrentShell(registration, signal) {
  const entry = document.querySelector('script[type="module"][src]');
  if (!entry) throw new Error('未能確認離線程式版本，請重新整理後再試。');
  const currentScript = new URL(entry.src, location.href);
  if (currentScript.origin !== location.origin) throw new Error('離線程式來源不符，請重新整理後再試。');
  let requestedUpdate = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const info = await timeout(controllingShellInfo(), 2000, '離線程式未有回應。', signal);
    if (typeof info?.appCache === 'string' && info.appCache.startsWith('scout-offline-app-')) {
      const names = await caches.keys();
      const cache = names.includes(info.appCache) ? await caches.open(info.appCache) : null;
      const script = cache && await cache.match(currentScript.href, { ignoreVary: true });
      const html = cache && await cache.match('/index.html', { ignoreVary: true });
      if (script && html) return;
      // A new worker controlling an older open page (or an evicted shell)
      // cannot guarantee that this exact app will reopen offline.
      throw new Error('離線程式已更新或檔案不完整；請連線重新整理 App，再下載圖幅。');
    }
    if (!requestedUpdate) {
      requestedUpdate = true;
      try { await timeout(registration.update(), 8000, '', signal); }
      catch (error) { if (signal?.aborted) throw error; /* controller may update independently */ }
    }
    await wait(500, signal);
  }
  throw new Error('離線程式未更新完成；請連線重新整理 App，再下載圖幅。');
}

export async function prepareOfflineEngine(signal) {
  if (!import.meta.env.PROD) throw new Error('離線預載需使用正式建置版；開發伺服器不能保證離線開啟。');
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('caches' in window)) throw new Error('此瀏覽器未支援離線儲存；請在 HTTPS 網址的新分頁開啟。');
  const registration = await timeout(navigator.serviceWorker.register('/sw.js'), 45_000, '離線程式未能準備，請檢查網絡及儲存空間。', signal);
  await timeout(navigator.serviceWorker.ready, 45_000, '離線程式未能準備，請檢查網絡及儲存空間。', signal);
  if (!navigator.serviceWorker.controller) {
    await timeout(new Promise((resolve) => {
      const changed = () => {
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      changed();
    }), 10_000, '離線程式尚未接管頁面，請重新整理後再試。', signal);
  }
  await waitForCurrentShell(registration, signal);
  return registration;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已停止', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(new DOMException('已停止', 'AbortError')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function verifySavedTile(url, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let timer;
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      image.onload = null; image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); } else resolve();
    }
    function onAbort() { done(new DOMException('已停止', 'AbortError')); }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    image.onload = () => done(null);
    image.onerror = () => done(new Error('已儲存的圖磚未能解碼。'));
    timer = setTimeout(() => done(new Error('驗證圖磚逾時。')), TILE_TIMEOUT_MS);
    image.src = `${VERIFY_PATH}?url=${encodeURIComponent(url)}`;
  });
}

export async function downloadAreaTiles(plan, { signal, onProgress = () => {} } = {}) {
  const cache = await caches.open(TILE_CACHE);
  let failed = 0, done = 0, opaqueCount = 0, consecutiveFailures = 0;
  for (const url of plan.tiles) {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT_MS);
    try {
      // Re-use a previously saved, decodable tile instead of repeatedly
      // downloading it from the public service. Clear maps to refresh it.
      const previous = await cache.match(url, { ignoreVary: true });
      if (previous) {
        try {
          await verifySavedTile(url, signal);
          if (previous.type === 'opaque') opaqueCount += 1;
          consecutiveFailures = 0;
          continue;
        } catch (error) {
          if (signal?.aborted) throw error;
          await cache.delete(url, { ignoreVary: true });
        }
      }
      // Prefer readable CORS responses: browsers may charge roughly 7 MB of
      // quota *per opaque tile*. If the provider has no CORS, fall back to an
      // opaque image and report the higher storage risk to the user.
      let response;
      try {
        response = await fetch(freshRequestUrl(url), { mode: 'cors', credentials: 'omit', cache: 'reload', signal: ctrl.signal });
      } catch (error) {
        if (ctrl.signal.aborted) throw error;
        response = await fetch(freshRequestUrl(url), { mode: 'no-cors', cache: 'reload', signal: ctrl.signal });
      }
      if (response.type !== 'opaque' && !response.ok) {
        if ([403, 429, 503].includes(response.status)) {
          const error = new Error(`地圖服務暫時拒絕請求（HTTP ${response.status}），已停止下載；請稍後重試。`);
          error.name = 'ProviderLimitError';
          throw error;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      if (response.type === 'opaque') opaqueCount += 1;
      await cache.put(url, response);
      try { await verifySavedTile(url, signal); }
      catch (error) {
        await cache.delete(url, { ignoreVary: true });
        throw error;
      }
      consecutiveFailures = 0;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
      if (error?.name === 'QuotaExceededError') throw new Error('瀏覽器儲存空間不足；部分跨網域圖磚可能每張佔用數 MB。請清除舊地圖或使用有足夠空間的裝置。');
      if (error?.name === 'ProviderLimitError') throw error;
      failed += 1;
      consecutiveFailures += 1;
      console.warn('離線圖磚下載失敗', url, error);
      if (consecutiveFailures >= 4) throw new Error('下載未完整：連續多張圖磚未能載入，已停止下載；請稍後重試。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done += 1;
      onProgress({ done, total: plan.tiles.length, failed, opaqueCount });
    }
    if (done < plan.tiles.length) await wait(TILE_DELAY_MS, signal);
  }
  return { done, failed, opaqueCount };
}

export function loadSavedAreas() {
  try {
    const saved = JSON.parse(localStorage.getItem(PACKS_KEY));
    if (!Array.isArray(saved)) return [];
    return saved.filter((p) => p && ['hm20c', 'countryside'].includes(p.basemap)
      && Number.isFinite(p.center?.lat) && Math.abs(p.center.lat) <= 90
      && Number.isFinite(p.center?.lon) && Math.abs(p.center.lon) <= 180
      && Number.isFinite(p.time) && Number.isInteger(p.zoom) && p.zoom >= 10 && p.zoom <= 20
      && Number.isInteger(p.tileCount) && p.tileCount > 0 && p.tileCount <= MAX_AREA_TILES).slice(0, 20);
  } catch { return []; }
}

export function recordSavedArea(plan) {
  const area = { basemap: plan.basemap, center: plan.center, bounds: plan.bounds, zoom: plan.zoom, time: Date.now(), tileCount: plan.tiles.length };
  try {
    // Re-downloading the same view updates its entry instead of filling the
    // list with duplicates. Different centres/scale levels remain separate.
    const isSame = (p) => p.basemap === area.basemap && p.zoom === area.zoom && p.tileCount === area.tileCount
      && Math.abs(p.center.lat - area.center.lat) < 1e-6 && Math.abs(p.center.lon - area.center.lon) < 1e-6;
    const saved = [area, ...loadSavedAreas().filter((p) => !isSame(p))].slice(0, 20);
    localStorage.setItem(PACKS_KEY, JSON.stringify(saved));
    return saved;
  } catch { throw new Error('無法儲存離線範圍清單，請檢查儲存空間。'); }
}

export async function clearSavedAreas() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name === TILE_CACHE || name === CONTOUR_CACHE || name.startsWith(CONTOUR_STAGING_PREFIX)).map((name) => caches.delete(name)));
  localStorage.removeItem(PACKS_KEY);
}
