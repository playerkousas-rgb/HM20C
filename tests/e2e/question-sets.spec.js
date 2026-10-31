import { test, expect } from '@playwright/test';
import { decodeShared } from '../../src/lib/questionSet';

const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
async function mockMaps(page) {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blank }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ features: [] }) }));
  await page.route('https://*.tile.opentopomap.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blank }));
}
async function login(page) {
  await page.getByRole('button', { name: '開啟領袖模式' }).click();
  await page.getByLabel('領袖密碼').fill('playwright-only-test-secret');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.locator('.leader-coordinate')).toBeVisible();
}
async function openBank(page) {
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /領袖題庫及同步活動/ }).click();
}
async function makeSet(page) {
  await openBank(page);
  await page.getByRole('button', { name: '建立題組' }).click();
  await page.getByLabel('題組名稱').fill('西貢雙題');
  await page.getByLabel('第 1 題題型').selectOption('identify');
  await page.getByLabel('第 1 題題目').fill('這個座標的圖例是甚麼？');
  await page.getByLabel('第 1 題八位座標').fill('50Q KK 2430 7773');
  await page.getByLabel('第 1 題答案').fill('秘密圖例：涼亭');
  await page.getByRole('button', { name: '新增一題' }).click();
  await page.getByLabel('第 2 題題點座標').fill('49Q HE 0199 6342');
  await page.getByRole('button', { name: '使用這個座標' }).click();
  await expect(page.getByText('領袖答案：49Q HE 0199 6342')).toBeVisible();
  await page.getByRole('button', { name: '儲存題組' }).click();
  await expect(page.getByRole('dialog')).toContainText('西貢雙題');
}
async function currentQr(page, label) {
  await expect(page.getByAltText(`${label} QR Code`)).toBeVisible();
  return await page.getByAltText(`${label} QR Code`).getAttribute('src');
}
async function uploadQr(page, dataUrl) {
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'share.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
}

test('leader saves two questions; separate offline QR packets do not contain or reveal answers prematurely', async ({ browser }) => {
  const leaderContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const leader = await leaderContext.newPage(); await mockMaps(leader); await leader.goto('/'); await login(leader); await makeSet(leader);
  await leader.getByRole('button', { name: '題目 QR／JSON' }).click();
  const questionQr = await currentQr(leader, '離線題目');
  const questionLink = await leader.getByLabel('離線題目分享連結').inputValue();
  const packet = decodeShared(questionLink);
  expect(packet.set.questions).toHaveLength(2);
  expect(JSON.stringify(packet)).not.toContain('秘密圖例');
  expect(JSON.stringify(packet)).not.toContain('answer');
  await leader.getByRole('button', { name: '返回題組' }).click();
  await leader.getByRole('button', { name: '答案 QR／JSON' }).click();
  await leader.getByLabel('答案分享範圍').selectOption({ label: '第 1 題' });
  const answerQr = await currentQr(leader, '離線答案');
  const answerLink = await leader.getByLabel('離線答案分享連結').inputValue();
  expect(decodeShared(answerLink).answers).toEqual([{ id: packet.set.questions[0].id, answer: '秘密圖例：涼亭' }]);

  const memberContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const member = await memberContext.newPage(); await mockMaps(member); await member.goto('/');
  await member.getByRole('button', { name: '題目', exact: true }).click();
  await member.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await uploadQr(member, questionQr);
  await expect(member.getByRole('dialog')).toContainText('西貢雙題');
  await expect(member.getByRole('dialog')).toContainText('50Q KK 2430 7773');
  await expect(member.getByRole('dialog')).not.toContainText('秘密圖例');
  await expect(member.getByText('答案尚未公布')).toHaveCount(2);
  await member.getByRole('button', { name: '讀取題目／答案' }).click(); await uploadQr(member, answerQr);
  await expect(member.getByText('秘密圖例：涼亭')).toBeVisible();
  await expect(member.getByText('答案尚未公布')).toHaveCount(1);
  await member.reload();
  await member.getByRole('button', { name: '題目', exact: true }).click();
  await member.getByRole('button', { name: /查看多題套題/ }).click();
  await expect(member.getByText('秘密圖例：涼亭')).toBeVisible();
  await memberContext.close(); await leaderContext.close();
});

test('one activity QR syncs questions and selective answers; edits reset release and keep GPX', async ({ browser }) => {
  test.setTimeout(90_000);
  const leaderContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const leader = await leaderContext.newPage(); await mockMaps(leader); await leader.goto('/'); await login(leader); await makeSet(leader);
  await leader.getByRole('button', { name: '建立連網活動' }).click();
  await expect(leader.getByRole('button', { name: '活動 QR' })).toBeVisible();
  await leader.getByRole('button', { name: '活動 QR' }).click();
  const activityQr = await currentQr(leader, '連網活動');
  const activityLink = await leader.getByLabel('連網活動分享連結').inputValue();
  expect(decodeShared(activityLink).kind).toBe('activity');
  expect(activityLink).not.toContain('秘密圖例');
  await leader.getByRole('button', { name: '返回題組' }).click();

  const memberContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const member = await memberContext.newPage(); await mockMaps(member); await member.goto('/');
  const gpx = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="22.3835" lon="114.3225"><name>保留航點</name></wpt></gpx>';
  await member.locator('input[type=file]').first().setInputFiles({ name: 'route.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
  await expect.poll(() => member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toContain('保留航點');
  const before = await member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'));
  await member.getByRole('button', { name: '題目', exact: true }).click();
  await member.getByRole('button', { name: /讀取題目 QR Code/ }).click(); await uploadQr(member, activityQr);
  await expect(member.getByRole('dialog')).toContainText('西貢雙題');
  await expect(member.getByRole('dialog')).not.toContainText('秘密圖例');
  await expect(member.getByText('答案尚未公布')).toHaveCount(2);
  const id = decodeShared(activityLink).id;
  const publicBefore = await member.evaluate(async (activityId) => (await fetch(`/api/activity?id=${activityId}`)).text(), id);
  expect(publicBefore).not.toContain('秘密圖例'); expect(publicBefore).not.toContain('ownerKey');

  await memberContext.setOffline(true);
  await expect(member.locator('.question-sync-status')).toContainText('離線', { timeout: 8000 });
  await leader.getByRole('button', { name: '公布第 1 題' }).click();
  await expect(member.getByRole('dialog')).not.toContainText('秘密圖例：涼亭');
  await memberContext.setOffline(false);
  await expect(member.getByText('秘密圖例：涼亭')).toBeVisible({ timeout: 12_000 });
  await expect(member.getByText('答案尚未公布')).toHaveCount(1);
  await leader.getByRole('button', { name: '修改題目' }).click();
  await leader.getByLabel('第 1 題題目').fill('新版本：這是甚麼圖例？');
  await leader.getByLabel('第 1 題答案').fill('新秘密答案');
  await leader.getByRole('button', { name: '儲存題組' }).click();
  await expect(leader.getByRole('dialog')).toContainText('線上題組版本 2');
  await expect(member.getByText('新版本：這是甚麼圖例？')).toBeVisible({ timeout: 12_000 });
  await expect(member.getByRole('dialog')).not.toContainText('秘密圖例：涼亭');
  await expect(member.getByRole('dialog')).not.toContainText('新秘密答案');
  await expect(member.getByText('答案尚未公布')).toHaveCount(2);
  await leader.getByRole('button', { name: '公布全部答案' }).click();
  await expect(member.getByText('新秘密答案')).toBeVisible({ timeout: 12_000 });
  expect(await member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(before);
  await memberContext.close(); await leaderContext.close();
});

test('marking a question on a rotated mobile map returns the chosen coordinate to the editor', async ({ page }) => {
  await mockMaps(page); await page.goto('/'); await login(page);
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /領袖設題及分享/ }).click();
  await page.getByLabel('題目名稱').fill('原來的單題草稿');
  await page.getByRole('button', { name: '關閉' }).click();
  await openBank(page);
  await page.getByRole('button', { name: '建立題組' }).click();
  await page.getByLabel('題組名稱').fill('地圖選點');
  await page.getByRole('button', { name: '在地圖選點' }).click();
  const map = await page.locator('.map-canvas').boundingBox();
  await page.mouse.click(map.x + map.width * .35, map.y + map.height * .5);
  await expect(page.locator('.exercise-marker')).toHaveCount(1);
  await page.getByRole('button', { name: '完成選點' }).click();
  await expect(page.getByText(/領袖答案：50Q/)).toBeVisible();
  await page.getByRole('button', { name: '儲存題組' }).click();
  await expect(page.getByRole('dialog')).toContainText('地圖選點');
  await page.getByRole('button', { name: '關閉' }).click();
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /領袖設題及分享/ }).click();
  await expect(page.getByLabel('題目名稱')).toHaveValue('原來的單題草稿');
});

test('a private backup restores a leader’s activity management on another phone', async ({ browser }) => {
  const aContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const a = await aContext.newPage(); await mockMaps(a); await a.goto('/'); await login(a); await makeSet(a);
  await a.getByRole('button', { name: '建立連網活動' }).click();
  await expect(a.getByRole('button', { name: '活動 QR' })).toBeVisible();
  await a.getByRole('button', { name: '返回題庫' }).click();
  const downloadPromise = a.waitForEvent('download');
  await a.getByRole('button', { name: '私人備份' }).click();
  const download = await downloadPromise;
  const backupPath = await download.path();

  const bContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const b = await bContext.newPage(); await mockMaps(b); await b.goto('/'); await login(b); await openBank(b);
  await b.getByLabel('匯入私人題庫備份').setInputFiles(backupPath);
  await expect(b.getByRole('button', { name: /西貢雙題/ })).toBeVisible();
  await b.getByRole('button', { name: /西貢雙題/ }).click();
  await b.getByRole('button', { name: '重新整理狀態' }).click();
  await expect(b.getByRole('button', { name: '公布第 1 題' })).toBeEnabled();
  await b.getByRole('button', { name: '公布第 1 題' }).click();
  await expect(b.getByRole('button', { name: '第 1 題已公布' })).toBeDisabled();
  await b.getByRole('button', { name: '結束連網活動' }).click();
  await b.getByRole('button', { name: '確認結束活動' }).click();
  await expect(b.getByRole('button', { name: '建立連網活動' })).toBeVisible();
  await a.getByRole('button', { name: /西貢雙題/ }).click();
  await a.getByRole('button', { name: '重新整理狀態' }).click();
  await expect(a.getByRole('alert')).toContainText('已過期');
  await a.getByRole('button', { name: '解除本機活動連結' }).click();
  await a.getByRole('button', { name: '確認解除連結' }).click();
  await expect(a.getByRole('button', { name: '建立連網活動' })).toBeVisible();
  await aContext.close(); await bContext.close();
});
