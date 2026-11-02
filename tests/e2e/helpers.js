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
