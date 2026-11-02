import { test, expect } from '@playwright/test';

// Synthetic geometry only: 100 m contours through the initial and Phoenix Hill centres.
const blankTile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
const radius = 6378137;
const latitude = 22.3835;
const longitude = 114.3225;
const mercatorY = (lat) => radius * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const x = radius * longitude * Math.PI / 180;
const y = mercatorY(latitude);
const phoenixX = radius * 113.9341 * Math.PI / 180;
const phoenixY = mercatorY(22.2559);
const contour = JSON.stringify({ features: [
  { attributes: { HEIGHT: 100 }, geometry: { paths: [[[x - 500, y], [x + 500, y]]] } },
  { attributes: { HEIGHT: 100 }, geometry: { paths: [[[phoenixX - 500, phoenixY], [phoenixX + 500, phoenixY]]] } },
], exceededTransferLimit: false });

async function mockMaps(page) {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blankTile }));
  await page.route('https://*.tile.opentopomap.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blankTile }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({
    contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: contour,
  }));
}

async function rotationMatrix(page) {
  return page.locator('.leaflet-rotate-pane').evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d };
  });
}

async function centreOf(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Return the shortest screen-space distance from any synthetic contour to a
// marker, independently of Leaflet's own coordinate conversion helpers.
async function contourDistanceTo(page, point) {
  return page.locator('.leaflet-contourLines-pane').evaluate((pane, { x: mx, y: my }) => {
    let closest = Infinity;
    for (const path of pane.querySelectorAll('path')) {
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM();
      if (!length || !matrix) continue;
      for (let i = 0; i <= 300; i += 1) {
        const pointOnPath = path.getPointAtLength(length * i / 300).matrixTransform(matrix);
        closest = Math.min(closest, Math.hypot(pointOnPath.x - mx, pointOnPath.y - my));
      }
    }
    return closest;
  }, point);
}

test('rotates tiles, labels and contours together; clicks and points remain georeferenced', async ({ page }) => {
  await mockMaps(page);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await expect(page.locator('.orientation-pill')).toContainText('自動圖幅 8 · +1.03°（估算）');
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-rotation', '1.03');
  const matrix = await rotationMatrix(page);
  expect(matrix.b).toBeCloseTo(Math.sin(1.03 * Math.PI / 180), 5); // positive is clockwise on screen

  const panes = await page.evaluate(() => Object.fromEntries(Object.entries({ tilePane: 'tile', placeLabels: 'placeLabels', contourLines: 'contourLines', contourLabels: 'contourLabels', markerPane: 'marker' }).map(([name, pane]) => {
    return [name, document.querySelector(`.leaflet-${pane}-pane`).parentElement.className];
  })));
  expect(panes.tilePane).toContain('leaflet-rotate-pane');
  expect(panes.placeLabels).toContain('leaflet-rotate-pane');
  expect(panes.contourLines).toContain('leaflet-rotate-pane');
  expect(panes.contourLabels).toContain('leaflet-norotate-pane');
  expect(panes.markerPane).toContain('leaflet-norotate-pane');
  const label = page.locator('.leaflet-contourLabels-pane .contour-label span').first();
  await expect(label).toBeVisible();
  await expect(label).toHaveAttribute('style', /rotate\(1\.0deg\)/);

  // The route contains a centre point and another point due true north.
  const northLat = 22.3905;
  const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="${latitude}" lon="${longitude}"/><trkpt lat="${northLat}" lon="${longitude}"/></trkseg></trk></gpx>`;
  await page.locator('input[type=file]').setInputFiles({ name: 'north.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  const start = await centreOf(page.locator('.route-marker--start'));
  const north = await centreOf(page.locator('.route-marker--end'));
  // Independent Web Mercator projection at the default 96 dpi scale. Leaflet
  // rounds layer pixels, so allow 1.5 px for that rounding.
  const metresPerPixel = 20000 / (1000 * (96 / 25.4));
  const projectedPixels = (mercatorY(northLat) - mercatorY(latitude)) * Math.cos(latitude * Math.PI / 180) / metresPerPixel;
  const theta = 1.03 * Math.PI / 180;
  expect(north.x - start.x).toBeGreaterThan(1);
  expect(Math.abs((north.x - start.x) - projectedPixels * Math.sin(theta))).toBeLessThan(1.5);
  expect(Math.abs((north.y - start.y) + projectedPixels * Math.cos(theta))).toBeLessThan(1.5);
  expect(await contourDistanceTo(page, start)).toBeLessThan(3);

  const bearingTool = page.getByRole('button', { name: '兩點方位直線' });
  await bearingTool.click();
  // Wait for React to activate the tool before exercising Leaflet's click.
  await expect(bearingTool).toHaveAttribute('aria-pressed', 'true');
  const map = page.locator('.map-canvas');
  const box = await map.boundingBox();
  const tap = { x: box.x + 275, y: box.y + 265 };
  const hit = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).map((element) => ({
    tag: element.tagName, class: typeof element.className === 'string' ? element.className : element.getAttribute('class'),
    aria: element.getAttribute('aria-label'),
  })), tap);
  await page.mouse.click(tap.x, tap.y);
  await expect(page.locator('.bearing-marker-a'), `Hit test at ${JSON.stringify(tap)}: ${JSON.stringify(hit)}`).toHaveCount(1);
  const added = await centreOf(page.locator('.bearing-marker-a'));
  expect(Math.hypot(added.x - tap.x, added.y - tap.y)).toBeLessThan(2);
});

test('auto-selects both signs, keeps scale locked, and preserves manual choice separately from countryside', async ({ page }) => {
  await mockMaps(page);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  const scaleBefore = await page.locator('.scale-line').evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole('button', { name: '選擇地區' }).click();
  await page.getByRole('button', { name: /鳳凰山/ }).click();
  await expect(page.locator('.orientation-pill')).toContainText('自動圖幅 9 · −1.12°');
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-rotation', '-1.12');
  await expect.poll(async () => (await rotationMatrix(page)).b).toBeLessThan(0);
  await expect(page.locator('.map-coordinates')).toContainText('113.934');
  const scaleAfter = await page.locator('.scale-line').evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(scaleBefore - scaleAfter)).toBeLessThan(0.1);

  await page.getByRole('button', { name: '設定地圖方向', exact: true }).click();
  const picker = page.getByLabel('地形圖旋轉方式');
  await picker.selectOption('sheet:5');
  await expect(page.locator('.orientation-current')).toContainText('手選圖幅 5 · −1.13°');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-rotation', '-1.13');
  await page.reload();
  await expect(page.locator('.map-coordinates')).toContainText('113.934');
  await expect(page.locator('.orientation-pill')).toContainText('手選圖幅 5 · −1.13°');
  await expect.poll(async () => (await rotationMatrix(page)).b).toBeCloseTo(Math.sin(-1.13 * Math.PI / 180), 5);

  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-rotation', '0');
  await expect(page.locator('.orientation-pill')).toContainText('真北向上');
  await expect(page.locator('.leaflet-placeLabels-pane .leaflet-tile')).toHaveCount(0);
  await expect(page.locator('.leaflet-contourLines-pane path')).toHaveCount(0);
  await page.getByRole('button', { name: '地形圖', exact: true }).click();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-rotation', '-1.13');
  await expect(page.locator('.leaflet-contourLines-pane path').first()).toBeAttached();
});

test('touch tap under rotated view adds a point at the touched location', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await mockMaps(page);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '兩點方位直線' }).click();
  const box = await page.locator('.map-canvas').boundingBox();
  const target = { x: Math.round(box.x + 240), y: Math.round(box.y + 250) };
  await page.touchscreen.tap(target.x, target.y);
  await expect(page.locator('.bearing-marker-a')).toHaveCount(1);
  const actual = await centreOf(page.locator('.bearing-marker-a'));
  expect(Math.hypot(actual.x - target.x, actual.y - target.y)).toBeLessThan(2);
  await context.close();
});
