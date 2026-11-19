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

// entry-gate 白名單（docs/50 SG5）：e2e 直接開 127.0.0.1 會被攔，呢個係正確行為。
// 測試用真實機制繞過：導覽前寫入 entry-gate 自己嘅 session 通行證，等同「呢個分頁
// 已經由指定入口撳入過」。比起偽造 Referer 更穩（Chromium 會攔偽造 top-level Referer）。
// ⚠️ 純本機模擬，唔等於真機由 APP STORE 撳入／直打網址嘅驗收。
export const STORE_PASS_SCRIPT = "try { sessionStorage.setItem('hm20c.store_pass', '1'); } catch {}";
