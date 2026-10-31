import { test, expect } from '@playwright/test';

// Synthetic tiles and contours only; these are not real map data.
const blankTile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
const contour = JSON.stringify({ features: [], exceededTransferLimit: false });
async function mockMaps(page) {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blankTile }));
  await page.route('https://*.tile.opentopomap.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blankTile }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({
    contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: contour,
  }));
}

async function watchGeolocation(page) {
  await page.addInitScript(() => {
    window.geolocationAccessCount = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      get() { window.geolocationAccessCount += 1; throw new Error('unexpected device location access'); },
    });
  });
}

test('mobile reading mode makes room without changing map centre or scale, and safely ends drawing', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockMaps(page);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  const coordinates = await page.locator('.map-coordinates').innerText();
  const scale = await page.locator('.scale-line').getAttribute('style');
  const rotation = await page.locator('.map-canvas').getAttribute('data-rotation');
  const heightBefore = (await page.locator('.map-panel').boundingBox()).height;
  const marker = page.locator('.map-center-marker');
  await expect(marker).toBeVisible();
  const markerBox = await marker.boundingBox();
  const mapBox = await page.locator('.map-panel').boundingBox();
  expect(Math.abs((markerBox.x + markerBox.width / 2) - (mapBox.x + mapBox.width / 2))).toBeLessThan(1);
  expect(Math.abs((markerBox.y + markerBox.height / 2) - (mapBox.y + mapBox.height / 2))).toBeLessThan(1);

  await page.getByRole('button', { name: '收起路線' }).click();
  await expect(page.getByRole('button', { name: '顯示路線' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#route-tools')).toBeHidden();
  const heightAfter = (await page.locator('.map-panel').boundingBox()).height;
  expect(heightAfter - heightBefore).toBeGreaterThan(75);
  await expect(page.locator('.map-coordinates')).toHaveText(coordinates);
  await expect(page.locator('.scale-line')).toHaveAttribute('style', scale);
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-rotation', rotation);

  await page.getByRole('button', { name: '繪路', exact: true }).click();
  await page.getByRole('button', { name: '直線路點', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成繪畫' })).toBeVisible();
  await expect(marker).toHaveCount(0);
  await page.locator('.map-canvas').click({ position: { x: 130, y: 160 } });
  await expect(page.locator('.stat').nth(1)).toContainText('1 點');
  await page.getByRole('button', { name: '收起路線' }).click();
  await expect(page.locator('.drawing-indicator')).toHaveCount(0);
  await expect(page.locator('.map-center-marker')).toBeVisible();
  await page.locator('.map-canvas').click({ position: { x: 130, y: 160 } });
  await page.getByRole('button', { name: '顯示路線' }).click();
  await expect(page.locator('.stat').nth(1)).toContainText('1 點');
  await expect(page.getByRole('button', { name: '開始繪畫路線' })).toBeVisible();
});

test('a manually selected centre can be saved, revisited on the current basemap, reloaded and deleted without GPS', async ({ page }) => {
  await watchGeolocation(page);
  await mockMaps(page);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');

  const map = await page.locator('.map-canvas').boundingBox();
  await page.mouse.move(map.x + 180, map.y + 300);
  await page.mouse.down();
  await page.mouse.move(map.x + 230, map.y + 340, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await expect(page.getByText('書籤只保存手選座標', { exact: false })).toBeVisible();
  const shownCentre = await page.locator('.place-center').innerText();
  await page.getByLabel('書籤名稱').fill('童軍集合點');
  await page.getByRole('button', { name: '儲存圖心' }).click();
  await expect(page.getByRole('status')).toContainText('書籤不包含地圖資料');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.bookmarks.v1')));
  expect(saved).toHaveLength(1);
  expect(saved[0].name).toBe('童軍集合點');
  expect(shownCentre).toContain(saved[0].lat.toFixed(5));
  expect(shownCentre).toContain(saved[0].lon.toFixed(5));

  await page.getByRole('button', { name: /大帽山/ }).click();
  await expect(page.locator('.map-coordinates')).toContainText('22.410');
  await page.getByRole('button', { name: '郊遊圖', exact: true }).click();
  await expect(page.locator('.scale-lock')).toContainText('25,000');
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await page.locator('.bookmark-open').filter({ hasText: '童軍集合點' }).click();
  await expect(page.locator('.map-coordinates')).toContainText(saved[0].lat.toFixed(4));
  await expect(page.locator('.map-coordinates')).toContainText(saved[0].lon.toFixed(4));
  await expect(page.getByRole('button', { name: '郊遊圖', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.scale-lock')).toContainText('25,000');
  await expect(page.locator('.leaflet-contourLines-pane path')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.map-coordinates')).toContainText(saved[0].lat.toFixed(4));
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await expect(page.locator('.bookmark-open')).toContainText('童軍集合點');
  await page.getByRole('button', { name: '刪除書籤 童軍集合點' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.bookmark-open')).toContainText('童軍集合點');
  await page.getByRole('button', { name: '刪除書籤 童軍集合點' }).click();
  await page.getByRole('button', { name: '確認刪除' }).click();
  await expect(page.locator('.bookmark-empty')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('scout-trail-map.bookmarks.v1')))).toEqual([]);
  expect(await page.evaluate(() => window.geolocationAccessCount)).toBe(0);
});

test('storage errors are shown instead of falsely claiming a bookmark was saved', async ({ page }) => {
  await mockMaps(page);
  await page.goto('/');
  await page.evaluate(() => {
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'scout-trail-map.bookmarks.v1') throw new DOMException('quota', 'QuotaExceededError');
      return realSet.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await page.getByLabel('書籤名稱').fill('未儲存');
  await page.getByRole('button', { name: '儲存圖心' }).click();
  await expect(page.getByRole('status')).toContainText('未能儲存書籤');
  await expect(page.locator('.bookmark-empty')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.bookmarks.v1'))).toBeNull();
});
