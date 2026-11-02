import { test, expect } from '@playwright/test';
import { decodeShared } from '../../src/lib/questionSet';
import { waitForMapReady } from './helpers';

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
  await expect(page.getByLabel('題目地標標記')).toBeVisible();
  await waitForMapReady(page);
  const map = await page.locator('.map-canvas').boundingBox();
  await page.mouse.click(map.x + map.width * .35, map.y + map.height * .5);
  await expect(page.locator('.exercise-marker')).toHaveCount(1);
  await expect(page.locator('.exercise-marker small')).toContainText('50Q');
  await expect(page.getByLabel('題目地標標記')).toContainText('領袖答案：50Q');
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

test('draft overview, independent answer QR/JSON, privacy, locking and GPX coexist on small phones', async ({ browser }) => {
  test.setTimeout(90_000);
  const leaderContext = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
  const leader = await leaderContext.newPage(); await mockMaps(leader); await leader.goto('/'); await login(leader); await openBank(leader);
  await leader.getByRole('button', { name: '建立題組' }).click();
  await leader.getByLabel('題組名稱').fill('獨立答案測試');
  await leader.getByLabel('第 1 題題型').selectOption('identify');
  await leader.getByLabel('第 1 題八位座標').fill('50Q KK 2430 7773');
  const answer = '<img src=x onerror=alert(1)> 圖例';
  await leader.getByLabel('第 1 題答案').fill(answer);
  await leader.getByRole('button', { name: '新增一題' }).click();
  await leader.getByLabel('第 2 題題點座標').fill('49Q HE 0199 6342');
  await leader.getByRole('button', { name: '使用這個座標' }).click();
  await leader.getByRole('button', { name: '在地圖總覽所有答案' }).click();
  const card = leader.getByLabel('領袖答案地圖總覽');
  await expect(card).toBeVisible();
  await expect(leader.locator('.question-overview-marker')).toHaveCount(2);
  await expect(leader.locator('.question-overview-marker img')).toHaveCount(0);
  await card.locator('summary').click();
  await expect(card).toContainText(answer);
  await expect(card).toContainText('49Q HE 0199 6342');
  await card.getByRole('button', { name: '移至地點' }).first().click();
  expect(await leader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.getByRole('button', { name: '返回題組' }).click();
  await expect(leader.getByLabel('第 1 題答案')).toHaveValue(answer);
  await leader.getByRole('button', { name: '儲存題組' }).click();
  await leader.getByRole('button', { name: '答案 QR／JSON' }).click();
  await leader.getByLabel('答案分享範圍').selectOption({ label: '第 1 題' });
  const answerQr = await currentQr(leader, '離線答案');
  const downloadEvent = leader.waitForEvent('download');
  await leader.getByRole('button', { name: '下載離線答案 JSON' }).click();
  const answerJson = await (await downloadEvent).createReadStream();
  const chunks = []; for await (const chunk of answerJson) chunks.push(chunk);
  const jsonPacket = JSON.parse(Buffer.concat(chunks).toString());
  expect(jsonPacket.v).toBe(2); expect(jsonPacket.set.questions).toHaveLength(2); expect(jsonPacket.answers).toHaveLength(1);
  await leader.getByRole('button', { name: '返回題組' }).click();
  await leader.getByRole('button', { name: '在地圖總覽所有答案' }).click();
  await leader.getByRole('button', { name: '領袖模式已開啟' }).click();
  await leader.getByRole('button', { name: '返回成員模式' }).click();
  await expect(leader.locator('.question-overview-marker')).toHaveCount(0);
  await expect(leader.getByLabel('領袖答案地圖總覽')).toHaveCount(0);
  await expect(leader.locator('body')).not.toContainText(answer);

  const memberContext = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
  const member = await memberContext.newPage(); await mockMaps(member);
  await member.addInitScript(() => localStorage.setItem('scout-trail-map.exercise.v1', JSON.stringify({kind:'points',title:'舊題',description:'',points:[{lat:22.38,lon:114.32,name:'舊標記'}]})));
  await member.goto('/');
  await expect(member.locator('.exercise-marker')).toHaveCount(1);
  const oldExercise = await member.evaluate(() => localStorage.getItem('scout-trail-map.exercise.v1'));
  const gpx = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="22.3835" lon="114.3225"><name>保留航點</name></wpt></gpx>';
  await member.locator('input[type=file]').first().setInputFiles({ name:'route.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from(gpx) });
  await expect.poll(() => member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toContain('保留航點');
  const before = await member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'));
  await member.getByRole('button', { name:'題目', exact:true }).click();
  await member.getByRole('button', { name:/讀取題目 QR Code/ }).click();
  await uploadQr(member, answerQr); // Deliberately no question QR first.
  await expect(member.getByRole('dialog')).toContainText('獨立答案測試');
  await expect(member.getByRole('dialog')).toContainText(answer);
  await expect(member.getByText('答案尚未公布')).toHaveCount(1);
  await member.getByRole('button', { name:'在地圖總覽已公布答案' }).click();
  const memberCard = member.getByLabel('已公布答案地圖總覽');
  await memberCard.locator('summary').click();
  await expect(memberCard).toContainText(answer);
  await expect(memberCard).toContainText('答案尚未公布');
  await expect(member.locator('.question-overview-marker')).toHaveCount(2);
  await expect(member.locator('.question-overview-marker img')).toHaveCount(0);
  await expect(member.locator('.exercise-marker')).toHaveCount(0);
  await expect(member.locator('.question-overview-marker').last()).toContainText('答案尚未公布');
  await member.getByRole('button', { name:'關閉答案地圖總覽' }).click();
  await expect(member.locator('.exercise-marker')).toHaveCount(1);
  expect(await member.evaluate(() => localStorage.getItem('scout-trail-map.exercise.v1'))).toBe(oldExercise);
  expect(await member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(before);
  expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await memberContext.close(); await leaderContext.close();
});

test('slow basemap clearly blocks marking until tiles finish, then accepts the same point', async ({ page }) => {
  test.setTimeout(60_000);
  let releaseTiles;
  const gate = new Promise((resolve) => { releaseTiles = resolve; });
  await mockMaps(page);
  // Hold only the base tiles: the contour label is independent and may already
  // say iB20000 while the basemap is still loading.
  await page.route('**/basemap/WGS84/**', async (route) => {
    await gate;
    await route.fulfill({ contentType: 'image/svg+xml', body: blank }).catch(() => {});
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await login(page); await openBank(page);
    await page.getByRole('button', { name:'建立題組' }).click();
    await page.getByRole('button', { name:'在地圖選點' }).click();
    await expect(page.getByLabel('題目地標標記')).toBeVisible();
    await expect(page.locator('.map-panel')).toHaveAttribute('data-tile-status', 'loading');
    await expect(page.getByText('底圖載入中 · 載妥後可選點或繪路')).toBeVisible();
    const map = await page.locator('.map-canvas').boundingBox();
    const target = { x: map.x + map.width * .65, y: map.y + map.height * .35 };
    await page.mouse.click(target.x, target.y);
    await expect(page.locator('.toast')).toContainText('底圖未完整載入');
    await expect(page.locator('.exercise-marker')).toHaveCount(0);
    releaseTiles();
    await waitForMapReady(page);
    await expect(page.getByText('底圖載入中 · 載妥後可選點或繪路')).toHaveCount(0);
    await page.mouse.click(target.x, target.y);
    await expect(page.locator('.exercise-marker')).toHaveCount(1);
    await expect(page.getByLabel('題目地標標記')).toContainText('領袖答案：50Q');
  } finally {
    releaseTiles();
  }
});

test('bearing answers update immediately when draft points change and survive saving', async ({ page }) => {
  test.setTimeout(60_000);
  await mockMaps(page); await page.goto('/'); await login(page); await openBank(page);
  await page.getByRole('button', { name:'建立題組' }).click();
  await page.getByLabel('題組名稱').fill('方位自動答案');
  await page.getByLabel('第 1 題題型').selectOption('bearing');
  await page.getByRole('button', { name:'在地圖選點' }).click();
  await expect(page.getByLabel('題目地標標記')).toBeVisible();
  await waitForMapReady(page);
  const map = await page.locator('.map-canvas').boundingBox();
  const firstPoint = { x: map.x + map.width * .35, y: map.y + map.height * .35 };
  await page.mouse.click(firstPoint.x, firstPoint.y);
  const diagnostic = await page.evaluate(({ x, y }) => ({
    tileStatus: document.querySelector('.map-panel')?.dataset.tileStatus,
    message: document.querySelector('.toast')?.textContent,
    hit: document.elementsFromPoint(x, y).map((element) => ({ tag: element.tagName, class: element.getAttribute('class'), aria: element.getAttribute('aria-label') })),
  }), firstPoint);
  await expect(page.locator('.exercise-marker'), `First point ${JSON.stringify(firstPoint)}: ${JSON.stringify(diagnostic)}`).toHaveCount(1);
  await page.mouse.click(map.x + map.width * .65, map.y + map.height * .5);
  await expect(page.getByLabel('題目地標標記')).toContainText('方格北前視');
  await page.getByRole('button', { name:'完成選點' }).click();
  const preview = page.locator('.question-answer-preview');
  const first = await preview.innerText(); expect(first).toContain('方格北前視');
  await page.getByRole('button', { name:'在地圖選點' }).click();
  await page.getByRole('button', { name:'重選' }).click();
  await waitForMapReady(page);
  const updatedMap = await page.locator('.map-canvas').boundingBox();
  await page.mouse.click(updatedMap.x + updatedMap.width * .4, updatedMap.y + updatedMap.height * .4);
  await page.mouse.click(updatedMap.x + updatedMap.width * .3, updatedMap.y + updatedMap.height * .6);
  await page.getByRole('button', { name:'完成選點' }).click();
  const second = await preview.innerText(); expect(second).not.toBe(first); expect(second).toContain('方格北前視');
  await page.getByRole('button', { name:'儲存題組' }).click();
  await expect(page.getByRole('dialog')).toContainText(second.replace('方格北參考：', ''));
});

test('an emergency backup keeps an activity key when phone storage refuses the write', async ({ page }) => {
  await mockMaps(page); await page.goto('/'); await login(page); await makeSet(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'scout-trail-map.question-activities.v1') throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', {name:'建立連網活動'}).click();
  await expect(page.getByRole('alert')).toContainText('管理鑰匙未能儲存');
  await page.getByRole('button', {name:'返回題庫'}).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', {name:'私人備份'}).click();
  const stream = await (await downloadEvent).createReadStream();
  const parts = []; for await (const part of stream) parts.push(part);
  const packet = JSON.parse(Buffer.concat(parts).toString());
  const savedActivity = Object.values(packet.activities)[0];
  expect(savedActivity.ownerKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(packet.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test('oversized self-contained QR fails clearly while JSON remains available', async ({ page }) => {
  await mockMaps(page);
  await page.addInitScript(() => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    function text() { return [...crypto.getRandomValues(new Uint8Array(150))].map((n) => alphabet[n % alphabet.length]).join(''); }
    const questions = Array.from({length:15}, (_, i) => ({id:(i+1).toString(16).padStart(16,'0'),type:'free',prompt:text(),reference:'',points:[],answer:text()}));
    localStorage.setItem('scout-trail-map.question-bank.v1', JSON.stringify([{id:'abcdef0123456789',name:'超長題組',revision:1,questions}]));
  });
  await page.goto('/'); await login(page); await openBank(page);
  await page.getByRole('button', {name:/超長題組/}).click();
  await page.getByRole('button', {name:'答案 QR／JSON'}).click();
  await expect(page.getByRole('status')).toContainText('QR 太密或資料過長');
  await expect(page.getByAltText('離線答案 QR Code')).toHaveCount(0);
  const event = page.waitForEvent('download');
  await page.getByRole('button',{name:'下載離線答案 JSON'}).click();
  const stream = await (await event).createReadStream(); const parts = []; for await (const part of stream) parts.push(part);
  const packet = JSON.parse(Buffer.concat(parts).toString());
  expect(packet.set.questions).toHaveLength(15); expect(packet.answers).toHaveLength(15);
});
