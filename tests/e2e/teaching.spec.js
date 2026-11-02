import { test, expect } from '@playwright/test';

// Synthetic tiles and synthetic routing geometry. No external trail or real
// government map is claimed to have been tested by these fixtures.
const blankTile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
const contour = JSON.stringify({ features: [], exceededTransferLimit: false });
async function mockMaps(page) {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blankTile }));
  await page.route('https://*.tile.opentopomap.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blankTile }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: contour }));
}
async function ready(page) {
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await expect(page.locator('.map-error')).toHaveCount(0);
}
async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function nearestPath(page, selector, position) {
  return page.evaluate(({ selector, position }) => {
    let best = Infinity;
    for (const path of document.querySelectorAll(selector)) {
      const matrix = path.getScreenCTM(); if (!matrix) continue;
      const length = path.getTotalLength();
      for (let i = 0; i <= Math.ceil(length); i += 1) {
        const point = path.getPointAtLength(Math.min(i, length));
        const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
        const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
        best = Math.min(best, Math.hypot(position.x - x, position.y - y));
      }
    }
    return best;
  }, { selector, position });
}
async function login(page) {
  await page.getByRole('button', { name: '開啟領袖模式' }).click();
  await page.getByLabel('領袖密碼').fill('playwright-only-test-secret');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.locator('.leader-coordinate')).toBeVisible();
}
async function stroke(page, offsets) {
  const box = await page.locator('.map-canvas').boundingBox();
  await page.mouse.move(box.x + offsets[0][0], box.y + offsets[0][1]);
  await page.mouse.down();
  for (const [x, y] of offsets.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 5 });
  await page.mouse.up();
}
function mockResult(request) {
  const url = new URL(request.url());
  const points = url.searchParams.get('lonlats').split('|').map((pair) => pair.split(',').map(Number));
  const geometry = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    geometry.push(points[i]);
    geometry.push([(points[i][0] + points[i + 1][0]) / 2 + 0.00008, (points[i][1] + points[i + 1][1]) / 2]);
  }
  geometry.push(points.at(-1));
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: geometry } }] };
}

// Centred at exactly E=224000 m, N=2478000 m, independently calculated using
// PROJ, with a marker at the same point; both grid lines must hit that marker.
test('UTM kilometre lines pass through the real projected intersection, rotate with the map and can be hidden', async ({ page }) => {
  await mockMaps(page);
  await page.addInitScript(() => localStorage.setItem('scout-trail-map.map-centre.v1', JSON.stringify({ lat: 22.385884806530495, lon: 114.31950625137192 })));
  await ready(page);
  const xml = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="22.385884806530495" lon="114.31950625137192"/></gpx>';
  await page.locator('input[type=file]').setInputFiles({ name: 'intersection.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await expect(page.locator('.utm-grid-easting').first()).toBeAttached();
  const point = await center(page.locator('.route-marker--waypoint'));
  expect(await nearestPath(page, '.utm-grid-easting', point)).toBeLessThan(3);
  expect(await nearestPath(page, '.utm-grid-northing', point)).toBeLessThan(3);
  const parent = await page.locator('.leaflet-utmGrid-pane').evaluate((pane) => pane.parentElement.className);
  expect(parent).toContain('leaflet-rotate-pane');
  await page.getByRole('button', { name: '設定地圖方向', exact: true }).click();
  await page.getByLabel('地形圖旋轉方式').selectOption('sheet:5');
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  const rotated = await center(page.locator('.route-marker--waypoint'));
  expect(await nearestPath(page, '.utm-grid-easting', rotated)).toBeLessThan(3);
  expect(await nearestPath(page, '.utm-grid-northing', rotated)).toBeLessThan(3);
  await page.getByRole('button', { name: '顯示 UTM 網格線' }).click();
  await expect(page.locator('.utm-grid-easting')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '顯示 UTM 網格線' })).toHaveAttribute('aria-pressed', 'false');
});

test('member gets a fixed extended A/B line without numeric answers; leader can see answers', async ({ page }) => {
  await mockMaps(page); await ready(page);
  const routeBefore = await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'));
  await page.getByRole('button', { name: '兩點方位直線' }).click();
  const box = await page.locator('.map-canvas').boundingBox();
  const a = { x: box.x + 205, y: box.y + 185 };
  const b = { x: box.x + 290, y: box.y + 300 };
  await page.mouse.click(a.x, a.y); await page.mouse.click(b.x, b.y);
  await expect(page.locator('.bearing-marker')).toHaveCount(2);
  await expect(page.locator('.bearing-answers')).toHaveCount(0);
  let actualA = await center(page.locator('.bearing-marker-a'));
  let actualB = await center(page.locator('.bearing-marker-b'));
  expect(Math.hypot(actualA.x - a.x, actualA.y - a.y)).toBeLessThan(2);
  expect(Math.hypot(actualB.x - b.x, actualB.y - b.y)).toBeLessThan(2);
  expect(await nearestPath(page, '.bearing-extension', actualA)).toBeLessThan(3);
  expect(await nearestPath(page, '.bearing-extension', actualB)).toBeLessThan(3);
  const edges = await page.locator('.bearing-extension').evaluate((path) => {
    const matrix = path.getScreenCTM(); const n = path.getTotalLength();
    return [0, n].map((i) => {
      const p = path.getPointAtLength(i);
      return { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f };
    });
  });
  for (const endpoint of edges) {
    expect(Math.min(Math.abs(endpoint.x - box.x), Math.abs(endpoint.x - (box.x + box.width)), Math.abs(endpoint.y - box.y), Math.abs(endpoint.y - (box.y + box.height)))).toBeLessThan(3);
  }
  await page.getByRole('button', { name: '設定地圖方向', exact: true }).click();
  await page.getByLabel('地形圖旋轉方式').selectOption('sheet:5');
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  actualA = await center(page.locator('.bearing-marker-a'));
  actualB = await center(page.locator('.bearing-marker-b'));
  expect(await nearestPath(page, '.bearing-extension', actualA)).toBeLessThan(3);
  expect(await nearestPath(page, '.bearing-extension', actualB)).toBeLessThan(3);
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(routeBefore);

  await login(page);
  const answers = page.locator('.bearing-answers');
  await expect(answers).toContainText('前視 A→B');
  await expect(answers).toContainText('後視 B→A');
  await expect(answers).toContainText('方格');
  await expect(answers).toContainText('真北');
  await expect(answers).toContainText('磁北');
  await expect(answers).toContainText('50Q 方格北');
  const textBefore = await answers.innerText();
  await page.mouse.move(actualB.x, actualB.y); await page.mouse.down();
  await page.mouse.move(actualB.x - 30, actualB.y + 20, { steps: 8 }); await page.mouse.up();
  expect(await answers.innerText()).toBe(textBefore);
  const fixed = await center(page.locator('.bearing-marker-b'));
  expect(Math.hypot(fixed.x - actualB.x, fixed.y - actualB.y)).toBeLessThan(1);
  expect(await nearestPath(page, '.bearing-extension', fixed)).toBeLessThan(3);
  await page.getByRole('button', { name: '領袖模式已開啟' }).click();
  await page.getByRole('button', { name: '返回成員模式' }).click();
  await expect(page.locator('.bearing-answers')).toHaveCount(0);
  await expect(page.locator('.bearing-marker')).toHaveCount(2);
});

test('leader password is verified on the server; live centre works offline until reload', async ({ page, context }) => {
  await mockMaps(page); await ready(page);
  await page.getByRole('button', { name: '開啟領袖模式' }).click();
  await page.getByLabel('領袖密碼').fill('incorrect');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.getByRole('alert')).toContainText('密碼不正確');
  await page.getByLabel('領袖密碼').fill('playwright-only-test-secret');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.locator('.leader-coordinate strong')).toHaveText(/^50Q KK \d{4} \d{4}$/);
  const before = await page.locator('.leader-coordinate strong').innerText();
  const box = await page.locator('.map-canvas').boundingBox();
  await page.mouse.move(box.x + 230, box.y + 260); await page.mouse.down();
  await page.mouse.move(box.x + 270, box.y + 290, { steps: 8 });
  // During the pan, before releasing the pointer, the reference has changed.
  await expect(page.locator('.leader-coordinate strong')).not.toHaveText(before);
  await page.mouse.up();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('playwright-only-test-secret');
  await context.setOffline(true);
  await expect(page.locator('.leader-coordinate')).toBeVisible();
  await context.setOffline(false); // Vite dev shell is not offline-enabled; production is covered by offline E2E.
  await page.reload();
  await expect(page.locator('.leader-coordinate')).toHaveCount(0);
  await page.getByRole('button', { name: '開啟領袖模式' }).click();
  await context.setOffline(true);
  await page.getByLabel('領袖密碼').fill('playwright-only-test-secret');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.getByRole('alert')).toContainText('需要網絡');
  await context.setOffline(false);
});

test('magnet commits BRouter geometry, continues in separate strokes, exports GPX, and undoes a whole stroke', async ({ page }) => {
  await mockMaps(page);
  let requests = 0;
  await page.route('https://brouter.de/brouter**', (route) => {
    requests += 1;
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(mockResult(route.request())) });
  });
  await ready(page);
  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  await expect(page.getByRole('button', { name: '直線路點' })).toHaveCount(0);
  await expect(page.locator('.draw-mode-hint')).toContainText('BRouter');
  await stroke(page, [[130, 160], [170, 190], [220, 180], [250, 220]]);
  await expect(page.locator('.routing-status')).toContainText('已貼上路網');
  expect(requests).toBe(1);
  let route = await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')));
  expect(route.segments).toHaveLength(1);
  expect(route.segments[0].kind).toBe('snap');
  expect(route.segments[0].points.length).toBeGreaterThan(2);
  await expect(page.locator('.route-marker--start')).toHaveText('起');
  await expect(page.locator('.route-marker--end')).toHaveText('終');
  await expect(page.locator('.route-marker--via')).toHaveCount(0);
  const firstEnd = route.segments[0].points.at(-1);
  await stroke(page, [[250, 220], [220, 260], [200, 300]]);
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')))).segments.length).toBe(2);
  route = await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')));
  expect(route.segments[1].points[0]).toEqual(firstEnd);
  await expect(page.locator('.route-marker--start')).toHaveCount(1);
  await expect(page.locator('.route-marker--via')).toHaveText(['1']);
  await expect(page.locator('.route-marker--end')).toHaveCount(1);
  await stroke(page, [[200, 300], [170, 335], [145, 360]]);
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')))).segments.length).toBe(3);
  await expect(page.locator('.route-marker--via')).toHaveText(['1', '2']);
  await expect(page.locator('.route-marker--start')).toHaveCount(1);
  await expect(page.locator('.route-marker--end')).toHaveCount(1);
  await page.getByRole('button', { name: '撤回上一步' }).click();
  await expect(page.locator('.route-marker--via')).toHaveText(['1']);
  await page.getByRole('button', { name: '撤回上一步' }).click();
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')))).segments.length).toBe(1);
  await page.getByRole('button', { name: '完成繪畫' }).click();
  await page.getByRole('button', { name: 'GPX', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: /下載 GPX/ }).click();
  const download = await downloading; const stream = await download.createReadStream(); let content = '';
  for await (const chunk of stream) content += chunk.toString();
  expect((content.match(/<trkpt /g) || []).length).toBe(route.segments[0].points.length);
});

test('failed and cancelled magnet calculations do not overwrite a route or add straight lines', async ({ page }) => {
  await mockMaps(page);
  let release; let requestSeen = false;
  await page.route('https://brouter.de/brouter**', async (route) => {
    requestSeen = true;
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(mockResult(route.request())) }).catch(() => {});
  });
  await ready(page);
  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  await stroke(page, [[130, 160], [170, 190], [220, 220]]);
  await expect.poll(() => requestSeen).toBe(true);
  await page.getByRole('button', { name: '完成繪畫' }).click();
  release();
  await expect(page.locator('.stat').nth(1)).toContainText('0 點');
  await page.unroute('https://brouter.de/brouter**');
  await page.route('https://brouter.de/brouter**', (route) => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }));
  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  await stroke(page, [[130, 160], [170, 190], [220, 220]]);
  await expect(page.locator('.routing-status')).toContainText('路線未有更改');
  await expect(page.locator('.stat').nth(1)).toContainText('0 點');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')).segments)).toEqual([]);
});

test('touch-screen hand drawing and two-point markers work in a narrow mobile viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage(); await mockMaps(page);
  await page.route('https://brouter.de/brouter**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(mockResult(route.request())) }));
  await ready(page);
  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  const canvas = await page.locator('.map-canvas').boundingBox();
  const cdp = await context.newCDPSession(page);
  const path = [[90, 135], [120, 150], [165, 145], [195, 175]].map(([x, y]) => ({ x: canvas.x + x, y: canvas.y + y, id: 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [path[0]] });
  for (const point of path.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.routing-status')).toContainText('已貼上路網');
  const drawn = await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')));
  expect(drawn.segments[0].kind).toBe('snap');
  await page.getByRole('button', { name: '兩點方位直線' }).tap();
  await expect(page.getByRole('button', { name: '兩點方位直線' })).toHaveAttribute('aria-pressed', 'true');
  const box = await page.locator('.map-canvas').boundingBox();
  await page.touchscreen.tap(box.x + 215, box.y + 145);
  await expect(page.locator('.bearing-marker')).toHaveCount(1);
  await page.touchscreen.tap(box.x + 235, box.y + 195);
  await expect(page.locator('.bearing-marker')).toHaveCount(2);
  await expect(page.locator('.bearing-answers')).toHaveCount(0);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')))).segments).toEqual(drawn.segments);
  await context.close();
});
