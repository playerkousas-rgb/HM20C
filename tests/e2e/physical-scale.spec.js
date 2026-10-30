import { test, expect } from '@playwright/test';

const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
const latitude = 22.3835, longitude = 114.3225;
const earthRadius = 6378137;
async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a calibrated 1:20,000 map preserves its physical pixel scale through rotation and pan', async ({ page }) => {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blank }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"features":[]}' }));
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '比例已鎖定，設定螢幕校準' }).click();
  await expect(page.locator('.calibration-line')).toHaveCSS('width', '200px');
  await page.locator('.calibration-input input').fill('50'); // 4 CSS pixels per physical mm
  await page.getByRole('button', { name: '儲存校準' }).click();
  await expect(page.locator('.scale-lock')).toContainText('已校準');
  await expect(page.locator('.map-scale')).toContainText('500 m');
  expect(await page.locator('.scale-line').evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(100, 1);

  const endLon = longitude + 0.004;
  const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="${latitude}" lon="${longitude}"/><trkpt lat="${latitude}" lon="${endLon}"/></trkseg></trk></gpx>`;
  await page.locator('input[type=file]').setInputFiles({ name: 'scale.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  const start = page.locator('.route-marker--start'), end = page.locator('.route-marker--end');
  async function pixelDistance() {
    const a = await center(start), b = await center(end);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  // 20,000 / (1000*4) = 5 metres per CSS pixel. Rotation must not change
  // the distance; Mercator world metres are corrected at the centre latitude.
  const expectedPixels = earthRadius * (endLon - longitude) * Math.PI / 180 * Math.cos(latitude * Math.PI / 180) / 5;
  expect(Math.abs(await pixelDistance() - expectedPixels)).toBeLessThan(1.5);

  await page.getByRole('button', { name: '設定地圖方向', exact: true }).click();
  await page.getByLabel('地形圖旋轉方式').selectOption('sheet:5');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  expect(Math.abs(await pixelDistance() - expectedPixels)).toBeLessThan(1.5);

  const box = await page.locator('.map-canvas').boundingBox();
  await page.mouse.move(box.x + 310, box.y + 310);
  await page.mouse.wheel(0, -900);
  await page.mouse.dblclick(box.x + 310, box.y + 310);
  expect(Math.abs(await pixelDistance() - expectedPixels)).toBeLessThan(1.5);
  await page.mouse.move(box.x + 310, box.y + 310);
  await page.mouse.down();
  await page.mouse.move(box.x + 285, box.y + 330, { steps: 10 });
  await page.mouse.up();
  expect(Math.abs(await pixelDistance() - expectedPixels)).toBeLessThan(1.5);
  expect(await page.locator('.scale-line').evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(100, 1);
});

test('mobile layout and viewport resizes preserve the geographic center at any bearing', async ({ page }) => {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blank }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"features":[]}' }));
  await page.goto('/');
  const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="${latitude}" lon="${longitude}"/><trkpt lat="22.384" lon="114.323"/></trkseg></trk></gpx>`;
  await page.locator('input[type=file]').setInputFiles({ name: 'resize.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  const map = page.locator('.map-canvas'), marker = page.locator('.route-marker--start');
  async function offsetFromCenter() {
    const m = await center(marker), box = await map.boundingBox();
    return { x: m.x - box.x - box.width / 2, y: m.y - box.y - box.height / 2 };
  }
  for (const mode of ['auto', 'sheet:5', 'true']) {
    await page.getByRole('button', { name: '設定地圖方向', exact: true }).click();
    await page.getByLabel('地形圖旋轉方式').selectOption(mode);
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const initial = await offsetFromCenter(), height = (await map.boundingBox()).height;
    // Simulate another mobile panel changing height without a window resize.
    await page.locator('.planner').evaluate((element) => { element.style.paddingBottom = '112px'; });
    await expect.poll(async () => (await map.boundingBox()).height).toBeLessThan(height - 90);
    await expect.poll(async () => {
      const current = await offsetFromCenter();
      return Math.hypot(current.x - initial.x, current.y - initial.y);
    }).toBeLessThan(2);
    await page.locator('.planner').evaluate((element) => { element.style.paddingBottom = ''; });
    await expect.poll(async () => Math.abs((await map.boundingBox()).height - height)).toBeLessThan(1);
    await expect.poll(async () => {
      const current = await offsetFromCenter();
      return Math.hypot(current.x - initial.x, current.y - initial.y);
    }).toBeLessThan(2);
  }
  const initial = await offsetFromCenter();
  await page.setViewportSize({ width: 393, height: 752 });
  await expect.poll(async () => {
    const current = await offsetFromCenter();
    return Math.hypot(current.x - initial.x, current.y - initial.y);
  }).toBeLessThan(2);
});
