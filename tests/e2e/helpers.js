import { expect } from '@playwright/test';

// React has mounted the map, but expanding it can schedule a ResizeObserver
// and a new Leaflet tile load. Wait for those frames and the actual BASE tile
// status, not the separate contour-source label, before a gesture needs tiles.
export async function waitForMapReady(page) {
  await page.locator('.map-canvas').waitFor({ state: 'visible' });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.map-panel')).toHaveAttribute('data-tile-status', 'ready', { timeout: 15_000 });
}

// Synthetic routed geometry: these fixtures do not exercise real BRouter/OSM.
export async function mockHiking(page) {
  await page.route('https://brouter.de/brouter**', (route) => {
    const url = new URL(route.request().url());
    const coordinates = url.searchParams.get('lonlats').split('|').map((pair) => pair.split(',').map(Number));
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates } }] }) });
  });
}
export async function drawStroke(page, coords) {
  const box = await page.locator('.map-canvas').boundingBox();
  await page.mouse.move(box.x + coords[0][0], box.y + coords[0][1]);
  await page.mouse.down();
  for (const [x, y] of coords.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await page.mouse.up();
}

// entry-gate 白名單：e2e 直接開 http://127.0.0.1 會被攔截（正確行為）。
// 測試用 route 模擬「由指定入口撳入」的 Referer，等同 APP STORE 入口；
// 這只是本機模擬，唔等於真機由 APP STORE 進入的驗收。
export async function enterFromStore(page) {
  await page.setExtraHTTPHeaders({ referer: 'https://scoutappstore.vercel.app/' });
  return page;
}
