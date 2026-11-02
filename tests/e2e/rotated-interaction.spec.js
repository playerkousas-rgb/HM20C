import { test, expect } from '@playwright/test';
import { waitForMapReady } from './helpers';

const blankTile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
const R = 6378137, lat = 22.3835, lon = 114.3225;
const x = R * lon * Math.PI / 180;
const y = R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const fixture = JSON.stringify({ features: [{ attributes: { HEIGHT: 100 }, geometry: { paths: [[[x - 500, y], [x + 500, y]]] } }] });

async function point(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function nearestPath(page, selector, at) {
  return page.evaluate(({ selector, at }) => {
    let nearest = Infinity;
    for (const path of document.querySelectorAll(selector)) {
      const length = path.getTotalLength(), matrix = path.getScreenCTM();
      if (!length || !matrix) continue;
      for (let i = 0; i <= 500; i += 1) {
        const p = path.getPointAtLength(length * i / 500).matrixTransform(matrix);
        nearest = Math.min(nearest, Math.hypot(p.x - at.x, p.y - at.y));
      }
    }
    return nearest;
  }, { selector, at });
}

test('panning and changing direction keep vectors and coordinates aligned', async ({ page }) => {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blankTile }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fixture }));
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="${lat}" lon="${lon}"/><trkpt lat="22.3855" lon="114.3245"/></trkseg></trk></gpx>`;
  await page.locator('input[type=file]').setInputFiles({ name: 'alignment.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  let start = await point(page.locator('.route-marker--start'));
  expect(await nearestPath(page, '.leaflet-contourLines-pane path', start)).toBeLessThan(3);
  expect(await nearestPath(page, '.leaflet-overlay-pane path[stroke="#a33555"]', start)).toBeLessThan(3);

  const map = page.locator('.map-canvas');
  const box = await map.boundingBox();
  const coordsBefore = await page.locator('.map-coordinates').innerText();
  await page.mouse.move(box.x + 310, box.y + 315);
  await page.mouse.down();
  await page.mouse.move(box.x + 280, box.y + 340, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.map-coordinates')).not.toHaveText(coordsBefore);
  start = await point(page.locator('.route-marker--start'));
  expect(await nearestPath(page, '.leaflet-contourLines-pane path', start)).toBeLessThan(3);
  expect(await nearestPath(page, '.leaflet-overlay-pane path[stroke="#a33555"]', start)).toBeLessThan(3);

  await page.getByRole('button', { name: '設定地圖方向', exact: true }).click();
  await page.getByLabel('地形圖旋轉方式').selectOption('sheet:5');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-rotation', '-1.13');
  start = await point(page.locator('.route-marker--start'));
  expect(await nearestPath(page, '.leaflet-contourLines-pane path', start)).toBeLessThan(3);
  expect(await nearestPath(page, '.leaflet-overlay-pane path[stroke="#a33555"]', start)).toBeLessThan(3);

  // A selected bearing cross is fixed; it cannot move the recorded route.
  const routeBefore = await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'));
  await page.getByRole('button', { name: '兩點方位直線' }).click();
  await expect(page.getByRole('button', { name: '兩點方位直線' })).toHaveAttribute('aria-pressed', 'true');
  await waitForMapReady(page);
  const currentBox = await map.boundingBox();
  const tap = { x: currentBox.x + 200, y: currentBox.y + 220 };
  await page.mouse.click(tap.x, tap.y);
  const fixed = await point(page.locator('.bearing-marker-a'));
  await page.mouse.move(fixed.x, fixed.y); await page.mouse.down();
  await page.mouse.move(fixed.x + 35, fixed.y + 25, { steps: 10 }); await page.mouse.up();
  const after = await point(page.locator('.bearing-marker-a'));
  expect(Math.hypot(after.x - fixed.x, after.y - fixed.y)).toBeLessThan(1);
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(routeBefore);
});
