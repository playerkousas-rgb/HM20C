import { test, expect } from '@playwright/test';
import { drawStroke, mockHiking, waitForMapReady } from './helpers';

// The test environment does not depend on external map services. Empty tiles
// are ONLY test fixtures, never an application fallback or navigable map.
const blankTile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
// One synthetic 100 m contour close to the initial map centre, in EPSG:3857.
// This exercises the real contour decoder/layer lifecycle, not real terrain.
const radius = 6378137;
const x = radius * 114.3225 * Math.PI / 180;
const y = radius * Math.log(Math.tan(Math.PI / 4 + 22.3835 * Math.PI / 360));
const contourFixture = JSON.stringify({ features: [{ attributes: { HEIGHT: 100 }, geometry: { paths: [[[x - 300, y], [x + 300, y]]] } }], exceededTransferLimit: false });
async function mockMaps(page, failTiles = false) {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => failTiles
    ? route.abort('failed')
    : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: blankTile }));
  await page.route('https://*.tile.opentopomap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: blankTile }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: contourFixture,
  }));
}

test('draw, undo, GPX download/import, and local persistence', async ({ page }) => {
  await mockMaps(page); await mockHiking(page);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000 等高距');
  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  await waitForMapReady(page);
  await drawStroke(page, [[150, 220], [225, 300]]);
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')))).segments[0]?.points.length || 0).toBeGreaterThan(1);
  await expect(page.locator('.route-marker')).toHaveCount(2);
  await page.getByRole('button', { name: '撤回上一步' }).click();
  await expect(page.locator('.stat').nth(1)).toContainText('0 點');
  await drawStroke(page, [[150, 220], [240, 340]]);
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')))).segments.length).toBe(1);
  const exportedPointCount = await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')).segments[0].points.length);
  await page.getByRole('button', { name: '完成繪畫' }).click();
  await page.getByRole('button', { name: 'GPX', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /下載 GPX/ }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let exported = '';
  for await (const chunk of stream) exported += chunk.toString();
  expect(exported.match(/<trkpt /g)).toHaveLength(exportedPointCount);
  expect(exported).not.toContain('<ele>');

  const xml = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><metadata><name>測試山徑</name></metadata><wpt lat="22.38" lon="114.32"><name>CP1</name></wpt><trk><trkseg><trkpt lat="22.380" lon="114.320"/><trkpt lat="22.381" lon="114.321"/></trkseg><trkseg><trkpt lat="22.39" lon="114.33"/><trkpt lat="22.391" lon="114.331"/></trkseg></trk></gpx>`;
  await page.locator('input[type=file]').setInputFiles({ name: 'route.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await page.getByRole('button', { name: '確認匯入' }).click();
  await expect(page.getByLabel('路線名稱')).toHaveValue('測試山徑');
  await expect(page.locator('.stat').nth(1)).toContainText('5 點');
  await expect(page.locator('.route-marker--start')).toHaveCount(2);
  await expect(page.locator('.route-marker--waypoint')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('路線名稱')).toHaveValue('測試山徑');
});

test('exclusive basemaps, fixed scale, calibration and manual region selection', async ({ page }) => {
  await mockMaps(page);
  await page.goto('/');
  await expect(page.locator('.leaflet-contourLines-pane path').first()).toBeAttached();
  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  await expect(page.getByRole('button', { name: '郊遊圖', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.scale-lock')).toContainText('25,000');
  await expect(page.locator('.leaflet-placeLabels-pane .leaflet-tile')).toHaveCount(0);
  await expect(page.locator('.leaflet-contourLines-pane path')).toHaveCount(0);
  const before = await page.locator('.scale-line').getAttribute('style');
  await page.mouse.move(200, 300);
  await page.mouse.wheel(0, -800);
  await expect(page.locator('.scale-line')).toHaveAttribute('style', before);
  await page.getByRole('button', { name: '比例已鎖定，設定螢幕校準' }).click();
  await page.locator('.calibration-input input').fill('50');
  await page.getByRole('button', { name: '儲存校準' }).click();
  await expect(page.locator('.scale-line')).not.toHaveAttribute('style', before);
  await page.getByRole('button', { name: '選擇地區' }).click();
  await page.getByRole('button', { name: /大帽山/ }).click();
  await expect(page.locator('.map-coordinates')).toContainText('22.410');
  await expect(page.locator('.scale-lock')).toContainText('25,000');
});

test('never draws on a failed basemap or silently presents it as navigable', async ({ page }) => {
  await mockMaps(page, true);
  await page.goto('/');
  await expect(page.getByText('地圖暫時未能載入')).toBeVisible();
  await expect(page.getByText('未載入的地圖不能作導航', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '開始繪畫路線' }).click();
  await drawStroke(page, [[5, 180], [80, 210]]);
  await expect(page.locator('.stat').nth(1)).toContainText('0 點');
});


test('warns when the locked contour service fails and can retry', async ({ page }) => {
  let failing = true;
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: blankTile }));
  await page.route('**/services3.arcgis.com/**', (route) => {
    if (failing) return route.abort('failed');
    const callback = new URL(route.request().url()).searchParams.get('callback');
    return route.fulfill(callback
      ? { status: 200, contentType: 'text/javascript', body: `${callback}(${contourFixture})` }
      : { status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: contourFixture });
  });
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('等高線未能載入');
  await expect(page.locator('.source-pill')).toHaveClass(/source-pill--warn/);
  failing = false;
  await page.getByRole('button', { name: /等高線未能載入/ }).click();
  await expect(page.locator('.source-pill')).toContainText('iB20000 等高距');
  await expect(page.locator('.leaflet-contourLines-pane path').first()).toBeAttached();
});

test('limits simultaneous map tile requests', async ({ page }) => {
  let active = 0;
  let peak = 0;
  await page.route('**/mapapi.hkmapservice.gov.hk/**', async (route) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: blankTile });
    active -= 1;
  });
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: contourFixture }));
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000 等高距');
  await page.waitForTimeout(800);
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(6);
});

test('imported track points stay fixed and retain their recorded time and elevation', async ({ page }) => {
  await mockMaps(page);
  await page.goto('/');
  const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="22.3835" lon="114.3225"><ele>123</ele><time>2026-01-01T10:00:00Z</time></trkpt><trkpt lat="22.3855" lon="114.3245"/></trkseg></trk></gpx>`;
  await page.locator('input[type=file]').setInputFiles({ name: 'recorded.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.route.v1')))).segments.length).toBe(1);
  const before = await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'));
  const bounds = await page.locator('.route-marker--start').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + 45, bounds.y + 35, { steps: 8 }); await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(before);
  const first = JSON.parse(before).segments[0].points[0];
  expect(first.ele).toBe(123); expect(first.time).toBe('2026-01-01T10:00:00Z');
});

test('manual map reading does not request or access device geolocation', async ({ page }) => {
  await page.addInitScript(() => {
    window.geolocationAccessCount = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      get() {
        window.geolocationAccessCount += 1;
        return { getCurrentPosition() { throw new Error('unexpected location request'); }, watchPosition() { throw new Error('unexpected location watch'); } };
      },
    });
  });
  await mockMaps(page);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await expect(page.getByRole('button', { name: /定位我的位置/ })).toHaveCount(0);
  await expect(page.locator('.map-coordinates')).toContainText('圖心');
  await expect(page.locator('.map-coordinates')).toHaveAttribute('aria-label', '地圖中心座標，並非使用者位置');
  await page.getByRole('button', { name: '選擇地區' }).click();
  await page.getByRole('button', { name: /大帽山/ }).click();
  await expect(page.locator('.map-coordinates')).toContainText('22.410');
  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  await page.getByRole('button', { name: '地形圖', exact: true }).click();
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '兩點方位直線' }).click();
  await expect(page.getByRole('button', { name: '兩點方位直線' })).toHaveAttribute('aria-pressed', 'true');
  await waitForMapReady(page);
  await page.locator('.map-canvas').click({ position: { x: 150, y: 260 } });
  await expect(page.locator('.bearing-marker')).toHaveCount(1);
  await page.getByRole('button', { name: '三角網測法' }).click();
  await expect(page.getByRole('button', { name: '三角網測法' })).toHaveAttribute('aria-pressed', 'true');
  await waitForMapReady(page);
  await page.locator('.map-canvas').click({ position: { x: 150, y: 260 } });
  await expect(page.locator('.resection-landmark')).toHaveCount(1);
  expect(await page.evaluate(() => window.geolocationAccessCount)).toBe(0);
});
