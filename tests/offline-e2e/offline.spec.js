import { expect, test } from '@playwright/test';
import QRCode from 'qrcode';
import { exerciseUrl } from '../../src/lib/exercise';
import { answerPacket, answerShare, questionShare, standaloneAnswerPacket } from '../../src/lib/questionSet';

// These are deliberately synthetic fixtures, not real navigable map data.
const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e8d6"/></svg>';
const radius = 6378137;
const x = radius * 114.3225 * Math.PI / 180;
const y = radius * Math.log(Math.tan(Math.PI / 4 + 22.3835 * Math.PI / 360));
const feature = { attributes: { HEIGHT: 100 }, geometry: { paths: [[[x - 500, y], [x + 500, y]]] } };

async function mockProviders(context, state) {
  await context.route('**/mapapi.hkmapservice.gov.hk/**', (route) => {
    if (state.offline) return route.abort('internetdisconnected');
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: tile });
  });
  await context.route('https://*.tile.opentopomap.org/**', (route) => {
    if (state.offline) return route.abort('internetdisconnected');
    if (state.rateLimit) {
      state.rateLimitHits = (state.rateLimitHits || 0) + 1;
      return route.fulfill({ status: 429, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'slow down' });
    }
    if (state.invalidTiles) return route.fulfill({ status: 200, contentType: 'text/html', body: 'not an image' });
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: tile });
  });
  await context.route('**/services3.arcgis.com/**', (route) => {
    if (state.offline) return route.abort('internetdisconnected');
    const offset = Number(new URL(route.request().url()).searchParams.get('resultOffset') || 0);
    // The first page is valid, while the second can fail to ensure a partial
    // refresh never replaces previously saved complete contour pages.
    const body = state.badContourPage && offset > 0
      ? (state.badContourPage === 'malformed'
        ? { features: [{ attributes: { HEIGHT: 100 }, geometry: {} }], exceededTransferLimit: false }
        : { error: { message: 'simulated incomplete page' } })
      : offset === 0 ? { features: [feature], exceededTransferLimit: true } : { features: [], exceededTransferLimit: false };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
}

async function startDownload(page) {
  await page.getByRole('button', { name: '離線預載地圖' }).click();
  await page.getByRole('tab', { name: '目前畫面' }).click();
  await page.getByRole('button', { name: '下載目前畫面' }).click();
}

async function finishDownload(page) {
  await expect(page.locator('.offline-job')).toContainText('目前畫面已下載', { timeout: 70_000 });
}

async function cacheSnapshot(page, cacheName) {
  return page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const values = await Promise.all(keys.map(async (request) => [request.url, await (await cache.match(request)).text()]));
    return values.sort((a, b) => a[0].localeCompare(b[0]));
  }, cacheName);
}

test('production shell, rotated government tiles, labels, paginated contours and route survive offline reload', async ({ page, context }) => {
  const state = {};
  await mockProviders(context, state);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000 等高距');
  const xml = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="22.3835" lon="114.3225"/><trkpt lat="22.384" lon="114.323"/></trkseg></trk></gpx>';
  await page.locator('input[type=file]').setInputFiles({ name: 'offline.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await expect(page.locator('.stat').nth(1)).toContainText('2 點');
  const center = await page.locator('.map-coordinates').innerText();
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await page.getByLabel('書籤名稱').fill('已預載圖心');
  await page.getByRole('button', { name: '儲存圖心' }).click();
  await expect(page.locator('.bookmark-message')).toContainText('書籤不包含地圖資料');
  await page.getByRole('button', { name: '關閉' }).click();
  await startDownload(page);
  await expect(page.locator('.offline-plan')).toContainText('底圖、中文地名及 20 米等高線');
  await finishDownload(page);
  const tiles = await cacheSnapshot(page, 'scout-offline-map-tiles-v1');
  expect(tiles.length).toBeGreaterThan(24);
  expect(tiles.some(([url]) => url.includes('/basemap/'))).toBe(true);
  expect(tiles.some(([url]) => url.includes('/label/hk/tc/'))).toBe(true);
  const contours = await cacheSnapshot(page, 'scout-offline-contours-v1');
  expect(contours.some(([url]) => new URL(url).searchParams.get('resultOffset') === '1')).toBe(true);

  // Reuse existing tiles but fail the second contour page. No new complete
  // area is recorded, no partial contour refresh replaces the old pages.
  state.badContourPage = true;
  await page.getByRole('button', { name: '下載目前畫面' }).click();
  await expect(page.locator('.offline-job')).toContainText('下載未完整', { timeout: 30_000 });
  expect(await cacheSnapshot(page, 'scout-offline-contours-v1')).toEqual(contours);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.offline-areas.v1')).length)).toBe(1);
  expect(await page.evaluate(async () => (await caches.keys()).some((name) => name.startsWith('scout-offline-contours-pending-')))).toBe(false);

  state.badContourPage = 'malformed';
  await page.getByRole('button', { name: '下載目前畫面' }).click();
  await expect(page.getByRole('button', { name: '停止下載' })).toBeVisible();
  await expect(page.locator('.offline-job')).toContainText('下載未完整', { timeout: 30_000 });
  expect(await cacheSnapshot(page, 'scout-offline-contours-v1')).toEqual(contours);

  // Simulate running out of quota after the first page is committed. The
  // staged refresh must roll back to the prior complete contour pack.
  state.badContourPage = false;
  await page.evaluate(() => {
    const open = caches.open.bind(caches);
    window.simulateContourQuota = true;
    window.contourCommitWrites = 0;
    caches.open = async (name) => {
      const cache = await open(name);
      if (name === 'scout-offline-contours-v1' && window.simulateContourQuota) {
        const put = cache.put.bind(cache);
        cache.put = async (request, response) => {
          window.contourCommitWrites += 1;
          if (window.simulateContourQuota && window.contourCommitWrites === 2) {
            window.simulateContourQuota = false;
            throw new DOMException('simulated full storage during commit', 'QuotaExceededError');
          }
          return put(request, response);
        };
      }
      return cache;
    };
  });
  await page.getByRole('button', { name: '下載目前畫面' }).click();
  await expect(page.locator('.offline-job')).toContainText('未能保存等高線', { timeout: 30_000 });
  expect(await cacheSnapshot(page, 'scout-offline-contours-v1')).toEqual(contours);

  state.offline = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.map-coordinates')).toHaveText(center);
  await expect(page.locator('.stat').nth(1)).toContainText('2 點');
  await expect(page.locator('.source-pill')).toContainText('iB20000 等高距');
  await expect(page.locator('.leaflet-contourLines-pane path').first()).toBeAttached();
  await expect(page.locator('.leaflet-placeLabels-pane .leaflet-tile-loaded').first()).toBeAttached();
  await expect(page.locator('.map-partial')).toHaveCount(0);
  await expect(page.locator('.map-error')).toHaveCount(0);
  await expect(page.locator('.offline-indicator')).toContainText('離線 · 只顯示已存範圍');

  // The manually saved bookmark also survives offline reload. It stores only a
  // centre, not a map pack; this particular view was downloaded above.
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await expect(page.locator('.bookmark-open')).toContainText('已預載圖心');
  await page.locator('.bookmark-open').filter({ hasText: '已預載圖心' }).click();
  await expect(page.locator('.map-coordinates')).toHaveText(center);
  await expect(page.locator('.map-error')).toHaveCount(0);
  await page.getByRole('button', { name: '選擇地區' }).click();
  await page.getByRole('button', { name: /大帽山/ }).click();
  await expect(page.locator('.map-error')).toBeVisible();
  await expect(page.locator('.map-error')).toContainText('不能作導航');
});

test('opaque countryside tiles use a fallback, reload offline separately, and clear without deleting a route', async ({ page, context }) => {
  const state = {};
  await mockProviders(context, state);
  // Playwright fulfills bypass real CORS enforcement. Explicitly reject the
  // CORS attempt to exercise the browser's genuine opaque no-cors response.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, options) => String(input).includes('.tile.opentopomap.org/') && options?.mode === 'cors'
      ? Promise.reject(new TypeError('simulated CORS block')) : original(input, options);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  const xml = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="22.3835" lon="114.3225"/></trkseg></trk></gpx>';
  await page.locator('input[type=file]').setInputFiles({ name: 'offline.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await page.getByLabel('書籤名稱').fill('獨立書籤');
  await page.getByRole('button', { name: '儲存圖心' }).click();
  await page.getByRole('button', { name: '關閉' }).click();
  await startDownload(page);
  await expect(page.locator('.offline-job')).toContainText('可能佔用較多空間');
  await finishDownload(page);
  const types = await page.evaluate(async () => {
    const cache = await caches.open('scout-offline-map-tiles-v1');
    return Promise.all((await cache.keys()).map(async (key) => (await cache.match(key)).type));
  });
  expect(types.length).toBeGreaterThan(0);
  expect(types.every((type) => type === 'opaque')).toBe(true);
  state.offline = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.source-pill')).toContainText('OpenTopoMap');
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeAttached();
  await expect(page.locator('.map-error')).toHaveCount(0);
  await expect(page.locator('.map-partial')).toHaveCount(0);
  await expect(page.locator('.leaflet-placeLabels-pane .leaflet-tile')).toHaveCount(0);
  await expect(page.locator('.leaflet-contourLines-pane path')).toHaveCount(0);
  await expect(page.locator('.stat').nth(1)).toContainText('1 點');

  await page.getByRole('button', { name: '離線預載地圖' }).click();
  await page.getByRole('tab', { name: '目前畫面' }).click();
  await page.getByRole('button', { name: '刪除所有已存畫面' }).click();
  await page.getByRole('button', { name: '確認刪除' }).click();
  await expect(page.locator('.offline-job')).toContainText('路線不受影響');
  await expect(page.locator('.offline-empty')).toBeVisible();
  await page.reload();
  await expect(page.locator('.stat').nth(1)).toContainText('1 點');
  await expect(page.locator('.map-error')).toBeVisible();
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await expect(page.locator('.bookmark-open')).toContainText('獨立書籤');
});

test('cancelled downloads are not listed as complete', async ({ page, context }) => {
  await mockProviders(context, {});
  await page.goto('/');
  await startDownload(page);
  await page.getByRole('button', { name: '停止下載' }).click();
  await expect(page.locator('.offline-job')).toContainText('已停止');
  await expect(page.locator('.offline-empty')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.offline-areas.v1') || '[]'))).toEqual([]);
});

test('unreadable opaque tiles are not marked complete', async ({ page, context }) => {
  const state = {};
  await mockProviders(context, state);
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, options) => String(input).includes('.tile.opentopomap.org/') && options?.mode === 'cors'
      ? Promise.reject(new TypeError('simulated CORS block')) : original(input, options);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  state.invalidTiles = true;
  await startDownload(page);
  await expect(page.locator('.offline-job')).toContainText('下載未完整', { timeout: 50_000 });
  await expect(page.locator('.offline-empty')).toBeVisible();
  expect(await page.evaluate(async () => (await (await caches.open('scout-offline-map-tiles-v1')).keys()).length)).toBe(0);
});

test('quota errors stop promptly without marking the area complete', async ({ page, context }) => {
  await mockProviders(context, {});
  await page.addInitScript(() => {
    const original = Cache.prototype.put;
    Cache.prototype.put = function (request, response) {
      if (String(request?.url || request).includes('mapapi.hkmapservice.gov.hk')) throw new DOMException('simulated full storage', 'QuotaExceededError');
      return original.call(this, request, response);
    };
  });
  await page.goto('/');
  await startDownload(page);
  await expect(page.locator('.offline-job')).toContainText('儲存空間不足', { timeout: 20_000 });
  await expect(page.locator('.offline-empty')).toBeVisible();
});

test('provider rate limiting stops the download instead of sending a burst', async ({ page, context }) => {
  const state = {};
  await mockProviders(context, state);
  await page.goto('/');
  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  await page.waitForLoadState('networkidle');
  state.rateLimit = true;
  await startDownload(page);
  await expect(page.locator('.offline-job')).toContainText('HTTP 429');
  await expect(page.locator('.offline-empty')).toBeVisible();
  expect(state.rateLimitHits).toBe(1);
});

test('production registers its shell before download and explains home-screen installation and current limits', async ({ page, context }) => {
  await mockProviders(context, {});
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active)), { timeout: 30_000 }).toBe(true);
  expect(await page.evaluate(async () => (await caches.keys()).some((name) => name.startsWith('scout-offline-app-')))).toBe(true);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole('button', { name: '離線預載地圖' }).click();
  await expect(page.locator('.offline-limitation')).toContainText('整幅功能試用中');
  await expect(page.locator('.offline-limitation')).toContainText('實際政府 TIFF');
  await expect(page.getByLabel('選擇數碼圖幅')).toBeInViewport();
  await page.getByRole('tab', { name: '目前畫面' }).click();
  await expect(page.locator('.offline-limitation')).toContainText('只預載單一畫面');
  await expect(page.getByRole('button', { name: '下載目前畫面' })).toBeVisible();
  await page.locator('.install-guide summary').click();
  await expect(page.locator('.install-guide-content')).toContainText('Safari');
  await expect(page.locator('.install-guide-content')).toContainText('Chrome');
  await expect(page.locator('.install-guide-content')).toContainText('儲存可能分開');
  await page.locator('.official-options summary').click();
  await expect(page.locator('.official-options')).toContainText('GeoTIFF 匯入為試用功能');
  await expect(page.locator('.official-options')).toContainText('其離線資料不會出現在本 App');
  await expect(page.getByRole('link', { name: /iB20000 官方資料/ })).toHaveAttribute('href', /^https:\/\/data\.gov\.hk\//);
  await expect(page.getByRole('link', { name: /MyMapHK 官方介紹/ })).toHaveAttribute('href', /^https:\/\/www\.landsd\.gov\.hk\//);
  await expect(page.getByRole('link', { name: /iPhone／iPad 下載/ })).toHaveAttribute('href', 'https://apps.apple.com/hk/app/mymaphk/id793615275');
  await expect(page.getByRole('link', { name: /Android 下載/ })).toHaveAttribute('href', 'https://play.google.com/store/apps/details?id=gis.android.map');
  expect(await page.locator('.modal-card').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('an available install prompt is used once and a dismissed prompt falls back to instructions', async ({ page, context }) => {
  await mockProviders(context, {});
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  const prevented = await page.evaluate(() => {
    window.installPromptCalls = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { window.installPromptCalls += 1; return { outcome: 'dismissed' }; };
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.getByRole('button', { name: '離線預載地圖' }).click();
  await page.locator('.install-guide summary').click();
  await page.getByRole('button', { name: '加入主畫面', exact: true }).click();
  expect(await page.evaluate(() => window.installPromptCalls)).toBe(1);
  await expect(page.locator('.install-guide-content')).toContainText('已取消安裝提示');
  await expect(page.getByRole('button', { name: '加入主畫面', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.locator('.install-guide-content')).toContainText('已加入主畫面；請由圖示重新開啟');
});

test('a standalone app is not mistaken for a browser tab needing installation', async ({ page, context }) => {
  await mockProviders(context, {});
  await page.addInitScript(() => {
    const match = window.matchMedia.bind(window);
    window.matchMedia = (query) => query === '(display-mode: standalone)'
      ? { matches: true, addEventListener() {}, removeEventListener() {} }
      : match(query);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '離線預載地圖' }).click();
  await expect(page.locator('.install-guide summary')).toContainText('正以主畫面 App 開啟');
  await page.locator('.install-guide summary').click();
  await expect(page.locator('.install-guide-content')).toContainText('現正以主畫面 App 開啟');
  await expect(page.getByRole('button', { name: '加入主畫面', exact: true })).toHaveCount(0);
});

test('leader answers remain available in an unlocked tab offline, but reload does not cache the password or unlock', async ({ page, context }) => {
  await mockProviders(context, {});
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active)), { timeout: 30_000 }).toBe(true);
  await page.reload();
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '兩點方位直線' }).click();
  const box = await page.locator('.map-canvas').boundingBox();
  await page.mouse.click(box.x + 200, box.y + 185);
  await page.mouse.click(box.x + 290, box.y + 300);
  await expect(page.locator('.bearing-marker')).toHaveCount(2);
  await page.getByRole('button', { name: '開啟領袖模式' }).click();
  await page.getByLabel('領袖密碼').fill('playwright-only-test-secret');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.locator('.bearing-answers')).toContainText('磁北');
  await context.setOffline(true);
  await expect(page.locator('.leader-coordinate')).toBeVisible();
  await expect(page.locator('.bearing-answers')).toContainText('方格');
  await page.reload();
  await expect(page.locator('.leader-coordinate')).toHaveCount(0);
  await page.getByRole('button', { name: '開啟領袖模式' }).click();
  await page.getByLabel('領袖密碼').fill('playwright-only-test-secret');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.getByRole('alert')).toContainText('需要網絡');
  const cachedLeader = await page.evaluate(async () => {
    const names = await caches.keys();
    for (const name of names) if ((await (await caches.open(name)).keys()).some((request) => request.url.includes('/api/leader'))) return true;
    return false;
  });
  expect(cachedLeader).toBe(false);
});


test('a cached production app reads a QR image offline and restores its landmarks without uploading the question', async ({ page, context }) => {
  const state = {}; await mockProviders(context, state); await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active))).toBe(true);
  await startDownload(page); await finishDownload(page);
  await page.getByRole('button', { name: '關閉' }).click();
  const task = { kind: 'points', title: '離線集合點', description: '紙圖練習', points: [
    { lat: 22.3835, lon: 114.3225, name: '集合點' }, { lat: 22.384, lon: 114.3235, name: '檢查點' },
  ] };
  const url = exerciseUrl(task, 'http://127.0.0.1:5177/');
  const png = await QRCode.toBuffer(url, { width: 450, margin: 4 });
  const requests = [];
  page.on('request', (request) => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) requests.push(request.url()); });
  state.offline = true; await context.setOffline(true); await page.reload();
  await expect(page.locator('.offline-indicator')).toContainText('離線');
  await expect(page.locator('.map-error')).toHaveCount(0);
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.exercise-marker')).toHaveCount(2);
  await expect(page.locator('.exercise-marker small')).toHaveText(['集合點', '檢查點']);
  await page.reload();
  await expect(page.locator('.exercise-marker')).toHaveCount(2);
  await expect(page.locator('.map-error')).toHaveCount(0);
  // A valid question can be outside the saved screen; never imply the map exists there.
  const farTask = { kind: 'points', title: '其他地區', description: '', points: [{ lat: 22.438, lon: 114.16, name: '遠方地點' }] };
  const farPng = await QRCode.toBuffer(exerciseUrl(farTask, 'http://127.0.0.1:5177/'), { width: 450, margin: 4 });
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'far.png', mimeType: 'image/png', buffer: farPng });
  await expect(page.getByRole('dialog')).toContainText('取代目前的題目');
  await page.getByRole('dialog').getByRole('button', { name: '讀取題目', exact: true }).click();
  await expect(page.locator('.exercise-marker small')).toHaveText(['遠方地點']);
  await expect(page.locator('.map-error')).toContainText('不能作導航');
  await expect(page.locator('.offline-indicator')).toContainText('離線 · 只顯示已存範圍');
  await expect(page.getByRole('button', { name: '地形圖', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.source-pill')).toContainText('等高線未能載入');
  expect(requests).toEqual([]);
});


test('cached production app reads multi-question and matching answer QR offline without caching the activity API', async ({ page, context }) => {
  await mockProviders(context, {}); await page.goto('/');
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active)), { timeout: 30_000 }).toBe(true);
  await page.reload();
  const set = { id: 'aaaaaaaaaaaaaaaa', name: '離線兩題', revision: 1, questions: [
    { id: '1111111111111111', type: 'identify', prompt: '這格是甚麼圖例？', reference: '50Q KK 2430 7773', points: [], answer: '離線私人答案' },
    { id: '2222222222222222', type: 'free', prompt: '怎樣讀圖？', reference: '', points: [], answer: '先橫後直' },
  ] };
  const base = 'http://127.0.0.1:5177/';
  const questions = await QRCode.toBuffer(questionShare(set, base), { width: 512, margin: 4 });
  const answers = await QRCode.toBuffer(answerShare(set, [set.questions[0].id], base), { width: 512, margin: 4 });
  const newerQuestions = await QRCode.toBuffer(questionShare({ ...set, revision: 2 }, base), { width: 512, margin: 4 });
  // Even an API response received before going offline must not enter any SW cache.
  await page.evaluate(() => fetch('/api/activity?id=AAAAAAAAAAAAAAAAAAAAAA').catch(() => null));
  const cached = await page.evaluate(async () => {
    for (const name of await caches.keys()) if ((await (await caches.open(name)).keys()).some((request) => request.url.includes('/api/activity'))) return true;
    return false;
  });
  expect(cached).toBe(false);
  await context.setOffline(true); await page.reload();
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'questions.png', mimeType: 'image/png', buffer: questions });
  await expect(page.getByRole('dialog')).toContainText('離線兩題');
  await expect(page.getByRole('dialog')).not.toContainText('離線私人答案');
  await page.getByRole('button', { name: '讀取題目／答案' }).click();
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'answers.png', mimeType: 'image/png', buffer: answers });
  await expect(page.getByRole('dialog')).toContainText('離線私人答案');
  await expect(page.getByText('答案尚未公布')).toHaveCount(1);
  // A new question version must not accept an old answer, and previous
  // answers must not leak into the new version.
  await page.getByRole('button', { name: '讀取題目／答案' }).click();
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'newer.png', mimeType: 'image/png', buffer: newerQuestions });
  await expect(page.getByRole('dialog')).not.toContainText('離線私人答案');
  await page.getByRole('button', { name: '讀取題目／答案' }).click();
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'old-answer.png', mimeType: 'image/png', buffer: answers });
  await expect(page.getByRole('alert')).toContainText(/版本不同|較新版本/);
  await page.getByRole('button', { name: '返回' }).click();
  await page.reload();
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /查看多題套題/ }).click();
  await expect(page.getByRole('dialog')).toContainText('版本 2');
  await expect(page.getByRole('dialog')).not.toContainText('離線私人答案');
});


test('an answer QR is a self-contained sheet on a fresh offline production install', async ({ page, context }) => {
  await mockProviders(context, {}); await page.goto('/');
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active)), {timeout:30_000}).toBe(true);
  await page.reload();
  const set = {id:'bbbbbbbbbbbbbbbb',name:'答案先掃',revision:1,questions:[
    {id:'1111111111111111',type:'identify',prompt:'這格是甚麼？',reference:'50Q KK 2430 7773',points:[],answer:'涼亭'},
    {id:'2222222222222222',type:'free',prompt:'怎樣讀圖？',reference:'',points:[],answer:'先橫後直'},
  ]};
  const qr = await QRCode.toBuffer(answerShare(set, [set.questions[0].id], 'http://127.0.0.1:5177/'), {width:512,margin:4});
  await context.setOffline(true); await page.reload();
  await page.getByRole('button',{name:'題目',exact:true}).click();
  await page.getByRole('button',{name:/讀取題目 QR Code/}).click();
  const oldAnswer = answerPacket(set, [set.questions[0].id]);
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(oldAnswer))});
  await expect(page.getByRole('alert')).toContainText('舊版答案不屬於目前題組');
  const selfContainedJson = standaloneAnswerPacket(set, [set.questions[0].id]);
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({name:'answers.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(selfContainedJson))});
  await expect(page.getByRole('dialog')).toContainText('答案先掃');
  await expect(page.getByRole('dialog')).toContainText('涼亭');
  await page.evaluate(() => localStorage.removeItem('scout-trail-map.question-member.v1'));
  await page.reload();
  await page.getByRole('button',{name:'題目',exact:true}).click();
  await page.getByRole('button',{name:/讀取題目 QR Code/}).click();
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({name:'answer-first.png',mimeType:'image/png',buffer:qr});
  await expect(page.getByRole('dialog')).toContainText('答案先掃');
  await expect(page.getByRole('dialog')).toContainText('涼亭');
  await expect(page.getByText('答案尚未公布')).toHaveCount(1);
  await page.getByRole('button',{name:'在地圖總覽已公布答案'}).click();
  await expect(page.locator('.question-overview-marker')).toHaveCount(1);
  await expect(page.locator('.question-overview-marker')).toContainText('涼亭');
});
