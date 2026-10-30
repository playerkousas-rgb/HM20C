import { expect, test } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { writeArrayBuffer } from 'geotiff';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { project, sheetGridBounds } from '../../src/sheets/geometry.js';

// Intentionally synthetic gradient images: they are NOT real or usable maps.
async function syntheticSheet(id = 'T8', blue = 91, fraction = 1) {
  const { west, east: fullEast, south, north } = sheetGridBounds(id);
  const east = west + (fullEast - west) * fraction;
  const width = 600, height = 480;
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 3;
    pixels[i] = Math.round(x * 255 / (width - 1));
    pixels[i + 1] = Math.round(y * 255 / (height - 1));
    pixels[i + 2] = blue;
  }
  const buffer = await writeArrayBuffer(pixels, {
    width, height, ProjectedCSTypeGeoKey: 2326, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1,
    ModelPixelScale: [(east - west) / width, (north - south) / height, 0], ModelTiepoint: [0, 0, 0, west, north, 0],
  });
  return Buffer.from(buffer);
}

// A realistic full-sheet pixel geometry with 12,000 independently indexed
// deflate strips. Each points to the same synthetic row to keep the fixture
// tiny; no real government map is included in the repository.
async function stripedDeflateSheet() {
  const width = 15000, height = 12000;
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x += 1) { row[x * 3] = Math.round(x * 255 / (width - 1)); row[x * 3 + 1] = 73; row[x * 3 + 2] = 160; }
  const compressed = deflateSync(row);
  const base = Buffer.from(await writeArrayBuffer(new Uint8Array([1, 2, 3]), {
    width: 1, height: 1, ProjectedCSTypeGeoKey: 2326, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1,
    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 845000, 836000, 0],
  }));
  const header = Buffer.from(base.subarray(0, 1000));
  const offsetsAt = header.length + compressed.length, countsAt = offsetsAt + height * 4;
  const n = header.readUInt16BE(8);
  for (let i = 0; i < n; i += 1) {
    const pos = 10 + i * 12, tag = header.readUInt16BE(pos), value = pos + 8;
    if (tag === 256) header.writeUInt16BE(width, value);
    if (tag === 257) header.writeUInt16BE(height, value);
    if (tag === 259) header.writeUInt16BE(8, value);
    if (tag === 278) header.writeUInt32BE(1, value);
    if (tag === 273 || tag === 279) {
      header.writeUInt32BE(height, pos + 4);
      header.writeUInt32BE(tag === 273 ? offsetsAt : countsAt, value);
    }
  }
  const offsets = Buffer.alloc(height * 4), counts = Buffer.alloc(height * 4);
  for (let i = 0; i < height; i += 1) { offsets.writeUInt32BE(header.length, i * 4); counts.writeUInt32BE(compressed.length, i * 4); }
  return Buffer.concat([header, compressed, offsets, counts]);
}

async function syntheticZip(tiff) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add('iB20000/T8.tif', new BlobReader(new Blob([tiff])), { useWebWorkers: false });
  await writer.add('readme.txt', new BlobReader(new Blob(['synthetic test data'])), { useWebWorkers: false });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

async function mockOnlineMaps(context, calls = []) {
  const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dcead6"/></svg>';
  await context.route('**/mapapi.hkmapservice.gov.hk/**', (route) => {
    calls.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: tile });
  });
  await context.route('https://*.tile.opentopomap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: tile }));
  await context.route('**/services3.arcgis.com/**', (route) => {
    calls.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ features: [], exceededTransferLimit: false }) });
  });
}

async function openSheetPanel(page) {
  await page.getByRole('button', { name: '離線預載地圖' }).click();
  await page.getByRole('tab', { name: /整幅地形圖/ }).click();
}

async function importFixture(page, buffer, filename = 'T8.tif') {
  await page.locator('#sheet-file').setInputFiles({ name: filename, mimeType: filename.endsWith('.zip') ? 'application/zip' : 'image/tiff', buffer });
}

async function fileTail(page, id = 'T8') {
  return page.evaluate(async (sheetId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('scout-trail-map.offline-sheets.v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const blob = await new Promise((resolve, reject) => {
      const request = db.transaction('sheet-files').objectStore('sheet-files').get(sheetId);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    return blob ? Array.from(new Uint8Array(await blob.slice(-3).arrayBuffer())) : null;
  }, id);
}

async function sampleCanvas(page) {
  return page.locator('canvas.sheet-raster-tile.leaflet-tile-loaded').evaluateAll((tiles) => tiles.map((tile) => {
    const pixel = Array.from(tile.getContext('2d').getImageData(128, 128, 1, 1).data);
    return { x: Number(tile.dataset.x), y: Number(tile.dataset.y), z: Number(tile.dataset.z), pixel };
  }).filter((item) => item.pixel[3] === 255));
}

test('synthetic local TIFF renders georeferenced tiles and route, survives offline reload and remains separate from countryside', async ({ page, context }) => {
  const providers = [];
  await mockOnlineMaps(context, providers);
  const outgoingUploads = [];
  page.on('request', (request) => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) outgoingUploads.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await openSheetPanel(page);
  await expect(page.getByLabel('選擇數碼圖幅')).toHaveValue('T8');
  await expect(page.locator('.offline-limitation')).toContainText('實際政府 TIFF');
  await importFixture(page, await syntheticSheet());
  await expect(page.locator('.sheet-download .offline-job')).toContainText('T8 已儲存在此裝置', { timeout: 30_000 });
  await expect(page.locator('.saved-sheet')).toContainText('索引範圍抽樣覆蓋');
  expect(await fileTail(page)).toEqual([255, 255, 91]);
  expect(outgoingUploads).toEqual([]);
  await page.getByRole('button', { name: '查看 T8', exact: true }).click();
  await expect(page.locator('.source-pill')).toContainText('T8 本機試用');
  await expect(page.locator('canvas.sheet-raster-tile.leaflet-tile-loaded').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.map-error')).toHaveCount(0);
  await expect(page.locator('.leaflet-placeLabels-pane .leaflet-tile')).toHaveCount(0);
  await expect(page.locator('.leaflet-contourLines-pane path')).toHaveCount(0);
  expect(await page.locator('.map-canvas').getAttribute('data-rotation')).toBe('1.03');
  await expect.poll(async () => (await sampleCanvas(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const sample of await sampleCanvas(page)) {
    const world = 256 * 2 ** sample.z;
    const lon = ((sample.x * 256 + 128.5) / world) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (sample.y * 256 + 128.5) / world))) * 180 / Math.PI;
    const [east, north] = project([lon, lat], 4326, 2326);
    const expectedR = (east - 845000) / 15000 * 255;
    const expectedG = (836000 - north) / 12000 * 255;
    expect(Math.abs(sample.pixel[0] - expectedR)).toBeLessThan(3);
    expect(Math.abs(sample.pixel[1] - expectedG)).toBeLessThan(3);
    expect(sample.pixel[2]).toBe(91);
  }
  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  await page.locator('.map-canvas').click({ position: { x: 150, y: 210 } });
  await expect(page.locator('.stat').nth(1)).toContainText('1 點');
  await page.getByRole('button', { name: '完成繪畫' }).click();
  await expect(page.getByRole('button', { name: /比例已鎖定/ })).toContainText('20,000');
  const beforeReload = await page.locator('.map-coordinates').innerText();
  // Only the selected TIFF and application shell are needed after reopening.
  await page.waitForLoadState('networkidle');
  providers.length = 0;
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.source-pill')).toContainText('T8 本機試用');
  await expect(page.locator('canvas.sheet-raster-tile.leaflet-tile-loaded').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.map-error')).toHaveCount(0);
  await expect(page.locator('.stat').nth(1)).toContainText('1 點');
  await expect(page.locator('.map-coordinates')).toHaveText(beforeReload);
  await expect(page.locator('.offline-indicator')).toContainText('離線');
  expect(providers).toEqual([]);
  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  await expect(page.locator('.source-pill')).toContainText('OpenTopoMap');
  await expect(page.locator('canvas.sheet-raster-tile')).toHaveCount(0);
  await page.getByRole('button', { name: '地形圖', exact: true }).click();
  await expect(page.locator('.source-pill')).toContainText('T8 本機試用');
  await expect(page.locator('canvas.sheet-raster-tile.leaflet-tile-loaded').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await page.getByRole('button', { name: /大帽山/ }).click();
  await expect(page.locator('.map-error')).toContainText('圖心已離開 T8 圖幅');
  await openSheetPanel(page);
  await page.getByRole('button', { name: '查看 T8', exact: true }).click();
  await expect(page.locator('.map-error')).toHaveCount(0);
  await openSheetPanel(page);
  await page.getByRole('button', { name: '刪除 T8', exact: true }).click();
  await page.getByRole('button', { name: '確認刪除 T8' }).click();
  await expect(page.locator('.sheet-download .offline-job')).toContainText('已刪除 T8');
  expect(await fileTail(page)).toBeNull();
  await page.getByRole('button', { name: '關閉' }).click();
  await expect(page.locator('.stat').nth(1)).toContainText('1 點');
  await expect(page.locator('.source-pill')).not.toContainText('T8 本機試用');
});

test('a CORS/network failure offers a direct government download and local ZIP fallback', async ({ page, context }) => {
  await mockOnlineMaps(context);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => String(typeof input === 'string' ? input : input.url).includes('open.hkmapservice.gov.hk/OpenData/directDownload')
      ? Promise.reject(new TypeError('simulated cross-origin refusal')) : original(input, options);
  });
  await page.goto('/');
  await openSheetPanel(page);
  await page.getByRole('button', { name: '嘗試直接下載 T8' }).click();
  await expect(page.locator('.sheet-download .offline-job')).toContainText('瀏覽器跨網站限制', { timeout: 30_000 });
  await expect(page.getByRole('link', { name: '官方下載 T8' })).toHaveAttribute('href', /open\.hkmapservice\.gov\.hk\/OpenData\/directDownload\?productName=iB20000&sheetName=T8&productFormat=TIFF/);
  await expect(page.getByRole('button', { name: '選取手機 TIFF／ZIP' })).toBeVisible();
  const zip = await syntheticZip(await syntheticSheet());
  await importFixture(page, zip, 'T8.zip');
  await expect(page.locator('.sheet-download .offline-job')).toContainText('T8 已儲存在此裝置', { timeout: 30_000 });
  expect(await fileTail(page)).toEqual([255, 255, 91]);
  await page.getByRole('button', { name: '查看 T8', exact: true }).click();
  await expect(page.locator('canvas.sheet-raster-tile.leaflet-tile-loaded').first()).toBeVisible({ timeout: 30_000 });
});

test('a readable official response downloads directly to the device, rejects wrong data, and atomic quota failure preserves the previous sheet', async ({ page, context }) => {
  await mockOnlineMaps(context);
  const tiff = await syntheticSheet();
  const requests = [];
  let invalid = true;
  await context.route('**/open.hkmapservice.gov.hk/OpenData/directDownload**', (route) => {
    requests.push({ url: route.request().url(), method: route.request().method() });
    return route.fulfill(invalid
      ? { status: 200, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<html>not a map</html>' }
      : { status: 200, contentType: 'image/tiff', headers: { 'Access-Control-Allow-Origin': '*' }, body: tiff });
  });
  await page.goto('/');
  await openSheetPanel(page);
  await page.getByRole('button', { name: '嘗試直接下載 T8' }).click();
  await expect(page.locator('.sheet-download .offline-job')).toContainText('不是 TIFF 或 ZIP');
  await expect(page.locator('.saved-sheet')).toHaveCount(0);
  invalid = false;
  await page.getByRole('button', { name: '嘗試直接下載 T8' }).click();
  await expect(page.locator('.sheet-download .offline-job')).toContainText('T8 已儲存在此裝置', { timeout: 30_000 });
  expect(requests.every((request) => request.method === 'GET' && new URL(request.url).hostname === 'open.hkmapservice.gov.hk')).toBe(true);
  expect(await fileTail(page)).toEqual([255, 255, 91]);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    window.failSheetWrites = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'sheet-files' && window.failSheetWrites) throw new DOMException('simulated quota', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await importFixture(page, await syntheticSheet('T8', 13));
  await expect(page.locator('.sheet-download .offline-job')).toContainText('儲存空間不足', { timeout: 30_000 });
  expect(await fileTail(page)).toEqual([255, 255, 91]);
  await expect(page.locator('.saved-sheet')).toHaveCount(1);
});


test('a full-resolution, deflate-compressed striped synthetic sheet can be read in bounded windows and reopens offline', async ({ page, context }) => {
  test.setTimeout(120_000);
  await mockOnlineMaps(context);
  await page.goto('/');
  await openSheetPanel(page);
  await importFixture(page, await stripedDeflateSheet());
  await expect(page.locator('.sheet-download .offline-job')).toContainText('T8 已儲存在此裝置', { timeout: 30_000 });
  await page.getByRole('button', { name: '查看 T8', exact: true }).click();
  await expect.poll(async () => (await sampleCanvas(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator('.map-error')).toHaveCount(0);
  const sample = (await sampleCanvas(page))[0];
  expect(sample.pixel[1]).toBe(73);
  expect(sample.pixel[2]).toBe(160);
  const cachedDecoder = await page.evaluate(async () => {
    const names = await caches.keys();
    const app = await caches.open(names.find((name) => name.startsWith('scout-offline-app-')));
    return (await app.keys()).some((request) => /\/assets\/deflate-[^/]+\.js$/.test(request.url));
  });
  expect(cachedDecoder).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect.poll(async () => (await sampleCanvas(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator('.map-error')).toHaveCount(0);
  expect((await sampleCanvas(page))[0].pixel.slice(1, 3)).toEqual([73, 160]);
});


test('partial or mismatched sheets are clearly marked, and an evicted active file fails closed after offline reload', async ({ page, context }) => {
  const providers = [];
  await mockOnlineMaps(context, providers);
  await page.goto('/');
  await openSheetPanel(page);
  await importFixture(page, await syntheticSheet('T7'));
  await expect(page.locator('.sheet-download .offline-job')).toContainText('範圍與所選 T8');
  await expect(page.locator('.saved-sheet')).toHaveCount(0);
  await importFixture(page, await syntheticSheet('T8', 91, .5));
  await expect(page.locator('.sheet-download .offline-job')).toContainText('T8 已儲存在此裝置');
  await expect(page.locator('.saved-sheet')).toContainText('並非整幅');
  await page.getByRole('button', { name: '查看 T8', exact: true }).click();
  await expect(page.locator('.source-pill')).toContainText('範圍不完整');
  await expect(page.locator('canvas.sheet-raster-tile.leaflet-tile-loaded').first()).toBeVisible();
  // Simulate the file being removed by the browser, while the remembered
  // selection remains. It must not silently substitute the online map.
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('scout-trail-map.offline-sheets.v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('sheet-files', 'readwrite'); tx.objectStore('sheet-files').delete('T8'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  });
  await page.waitForLoadState('networkidle');
  providers.length = 0;
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.source-pill')).toContainText('T8 本機試用');
  await expect(page.locator('.map-error')).toContainText('圖幅已遺失或被系統清除');
  await expect(page.locator('canvas.sheet-raster-tile')).toHaveCount(0);
  expect(providers).toEqual([]);
});

test('stopping a direct download preserves the previously stored sheet', async ({ page, context }) => {
  await mockOnlineMaps(context);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (!url.includes('open.hkmapservice.gov.hk/OpenData/directDownload')) return original(input, options);
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    };
  });
  await page.goto('/');
  await openSheetPanel(page);
  await importFixture(page, await syntheticSheet());
  await expect(page.locator('.sheet-download .offline-job')).toContainText('T8 已儲存在此裝置');
  await page.getByRole('button', { name: '嘗試直接下載 T8' }).click();
  await expect(page.getByRole('button', { name: '停止圖幅處理' })).toBeVisible();
  await page.getByRole('button', { name: '停止圖幅處理' }).click();
  await expect(page.locator('.sheet-download .offline-job')).toContainText('已停止');
  expect(await fileTail(page)).toEqual([255, 255, 91]);
  await expect(page.locator('.saved-sheet')).toHaveCount(1);
});

test('does not report an offline sheet saved if the controlling app shell has been evicted', async ({ page, context }) => {
  await mockOnlineMaps(context);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 }).toBe(true);
  const deleted = await page.evaluate(async () => {
    const cacheName = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data.appCache);
      navigator.serviceWorker.controller.postMessage({ type: 'SCOUT_SHELL_INFO' }, [channel.port2]);
    });
    const cache = await caches.open(cacheName);
    return cache.delete(document.querySelector('script[type="module"][src]').src);
  });
  expect(deleted).toBe(true);
  await openSheetPanel(page);
  await importFixture(page, await syntheticSheet());
  await expect(page.locator('.sheet-download .offline-job')).toContainText('離線程式已更新或檔案不完整');
  await expect(page.locator('.saved-sheet')).toHaveCount(0);
  expect(await fileTail(page)).toBeNull();
});

test('a previously installed shell can import an already downloaded file without network access', async ({ page, context }) => {
  await mockOnlineMaps(context);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 }).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await openSheetPanel(page);
  await importFixture(page, await syntheticZip(await syntheticSheet()), 'T8.zip');
  await expect(page.locator('.sheet-download .offline-job')).toContainText('T8 已儲存在此裝置', { timeout: 30_000 });
  await page.getByRole('button', { name: '立即查看 T8' }).click();
  await expect(page.locator('canvas.sheet-raster-tile.leaflet-tile-loaded').first()).toBeVisible({ timeout: 30_000 });
});
