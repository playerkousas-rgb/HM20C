import { test, expect } from '@playwright/test';

test('open tabs see bookmark changes from the same browser storage', async ({ page, context }) => {
  const tile = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
  await context.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: tile }));
  await context.route('**/services3.arcgis.com/**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"features":[],"exceededTransferLimit":false}' }));
  const second = await context.newPage();
  await page.goto('/');
  await second.goto('/');
  await second.getByRole('button', { name: '選擇地區與書籤' }).click();
  await expect(second.locator('.bookmark-empty')).toBeVisible();
  await page.getByRole('button', { name: '選擇地區與書籤' }).click();
  await page.getByLabel('書籤名稱').fill('同步測試');
  await page.getByRole('button', { name: '儲存圖心' }).click();
  await expect(second.locator('.bookmark-open')).toContainText('同步測試');
  await second.getByRole('button', { name: '刪除書籤 同步測試' }).click();
  await second.getByRole('button', { name: '確認刪除' }).click();
  await expect(page.locator('.bookmark-empty')).toBeVisible();
  await second.close();
});
