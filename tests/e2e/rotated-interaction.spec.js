import { test, expect } from '@playwright/test';

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

test('panning, changing direction and dragging keep vectors and coordinates aligned', async ({ page }) => {
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

  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  await page.getByRole('button', { name: '直線路點', exact: true }).click();
  start = await point(page.locator('.route-marker--start'));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 35, start.y + 25, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')).segments[0].points[0].lat)).not.toBe(lat);
  const dragged = await point(page.locator('.route-marker--start'));
  expect(Math.hypot(dragged.x - (start.x + 35), dragged.y - (start.y + 25))).toBeLessThan(2);
  expect(await nearestPath(page, '.leaflet-overlay-pane path[stroke="#a33555"]', dragged)).toBeLessThan(3);

  // Independently invert the screen rotation and Mercator projection for the
  // 35x25 pixel drag. Tolerance allows Leaflet's pixel rounding at each end.
  const actual = await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')).segments[0].points[0]);
  const theta = -1.13 * Math.PI / 180;
  const dx = 35 * Math.cos(theta) + 25 * Math.sin(theta);
  const dy = -35 * Math.sin(theta) + 25 * Math.cos(theta);
  const mercatorMetresPerPixel = (20000 / (1000 * (96 / 25.4))) / Math.cos(lat * Math.PI / 180);
  const expectedLon = (x + dx * mercatorMetresPerPixel) / R * 180 / Math.PI;
  const expectedLat = (2 * Math.atan(Math.exp((y - dy * mercatorMetresPerPixel) / R)) - Math.PI / 2) * 180 / Math.PI;
  expect(Math.abs(actual.lat - expectedLat)).toBeLessThan(0.00006);
  expect(Math.abs(actual.lon - expectedLon)).toBeLessThan(0.00006);
});
