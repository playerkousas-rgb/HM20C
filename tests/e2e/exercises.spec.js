import { test, expect } from '@playwright/test';
import QRCode from 'qrcode';
import { decodeExercise, exerciseUrl } from '../../src/lib/exercise';
import { fromUtm } from '../../src/lib/utm';
import { waitForMapReady } from './helpers';

const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>';
async function mockMaps(page) {
  await page.route('**/mapapi.hkmapservice.gov.hk/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blank }));
  await page.route('**/services3.arcgis.com/**', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"features":[]}' }));
  await page.route('https://*.tile.opentopomap.org/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: blank }));
}
async function login(page) {
  await page.getByRole('button', { name: '開啟領袖模式' }).click();
  await page.getByLabel('領袖密碼').fill('playwright-only-test-secret');
  await page.getByRole('button', { name: '解鎖領袖模式' }).click();
  await expect(page.locator('.leader-coordinate')).toBeVisible();
}
async function point(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function nearestPath(page, selector, at) {
  return page.locator(selector).evaluate((path, value) => {
    const len = path.getTotalLength(), matrix = path.getScreenCTM();
    let closest = Infinity;
    for (let i = 0; i <= Math.ceil(len); i += 1) {
      const p = path.getPointAtLength(Math.min(i, len)).matrixTransform(matrix);
      closest = Math.min(closest, Math.hypot(p.x - value.x, p.y - value.y));
    }
    return closest;
  }, at);
}

// A precise synthetic position. Each separate UTM back bearing points at it.
test('three fixed landmarks and directional rays rotate or accept back bearings, independently of map rotation and GPX', async ({ page }) => {
  await mockMaps(page);
  const target = fromUtm(224000, 2478000, 50);
  const points = [fromUtm(223700, 2478000, 50), fromUtm(224000, 2478300, 50), fromUtm(224300, 2477700, 50)];
  await page.addInitScript((center) => localStorage.setItem('scout-trail-map.map-centre.v1', JSON.stringify(center)), target);
  await page.goto('/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="${target.lat}" lon="${target.lon}"/></gpx>`;
  await page.locator('input[type=file]').setInputFiles({ name: 'reference.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await expect(page.locator('.route-marker--waypoint')).toHaveCount(1);
  await expect.poll(async () => JSON.parse(await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).waypoints.length).toBe(1);
  const routeBefore = await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'));
  const task = { kind: 'resection', title: '三地標測試', description: '', points: points.map((p, i) => ({ ...p, name: ['山', '樓', '碼頭'][i] })) };
  const link = exerciseUrl(task, 'http://127.0.0.1:5175/');
  await page.evaluate((url) => { location.hash = new URL(url).hash; }, link);
  await expect(page.locator('.resection-landmark')).toHaveCount(3);
  await expect(page.locator('.resection-handle')).toHaveCount(3);
  await expect(page.locator('.exercise-name-label')).toHaveText(['山', '樓', '碼頭']);
  await expect(page.locator('.bearing-answers')).toHaveCount(0);
  await page.getByRole('button', { name: '展開工具' }).click();
  for (const [letter, value] of [['A', '90'], ['B', '180'], ['C', '315']]) {
    await page.getByLabel(`${letter} 後視方位`).fill(value);
    await page.getByLabel(`${letter} 後視方位`).press('Enter');
  }
  await expect(page.getByLabel('A 後視方位')).toHaveValue('90.0');
  await expect(page.getByLabel('B 後視方位')).toHaveValue('180.0');
  await expect(page.getByLabel('C 後視方位')).toHaveValue('315.0');
  await page.getByRole('button', { name: '縮小三角網測工具' }).click();
  let control = await point(page.locator('.route-marker--waypoint'));
  for (const letter of ['a', 'b', 'c']) {
    expect(await nearestPath(page, `.resection-line-${letter}`, control)).toBeLessThan(3);
    expect(await nearestPath(page, `.resection-line-${letter}`, await point(page.locator(`.resection-landmark-${letter}`)))).toBeLessThan(3);
  }
  await page.getByRole('button', { name: '設定地圖方向', exact: true }).click();
  await page.getByLabel('地形圖旋轉方式').selectOption('sheet:5');
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  control = await point(page.locator('.route-marker--waypoint'));
  for (const letter of ['a', 'b', 'c']) expect(await nearestPath(page, `.resection-line-${letter}`, control)).toBeLessThan(3);

  const landmark = await point(page.locator('.resection-landmark-a'));
  const handle = await point(page.locator('.resection-handle-a'));
  const beforePath = await page.locator('.resection-line-a').getAttribute('d');
  await page.mouse.move(handle.x, handle.y); await page.mouse.down();
  await page.mouse.move(handle.x - 30, handle.y + 60, { steps: 10 }); await page.mouse.up();
  await expect(page.locator('.resection-line-a')).not.toHaveAttribute('d', beforePath);
  const after = await point(page.locator('.resection-landmark-a'));
  expect(Math.hypot(after.x - landmark.x, after.y - landmark.y)).toBeLessThan(1);
  await page.getByRole('button', { name: '展開工具' }).click();
  await expect(page.getByLabel('A 後視方位')).not.toHaveValue('90.0');
  await expect(page.getByLabel('B 後視方位')).toHaveValue('180.0');
  const selectedAngle = await page.getByLabel('A 後視方位').inputValue();
  await expect.poll(async () => JSON.parse(await page.evaluate(() => localStorage.getItem('scout-trail-map.resection.v1')))[0].set).toBe(true);
  await page.reload();
  await expect(page.locator('.resection-landmark')).toHaveCount(3);
  await page.getByRole('button', { name: '展開工具' }).click();
  await expect(page.getByLabel('A 後視方位')).toHaveValue(selectedAngle);
  await expect(page.getByLabel('B 後視方位')).toHaveValue('180.0');
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(routeBefore);
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: '清除題目' }).click();
  await expect(page.getByRole('dialog')).toContainText('三角地標及方向');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '清除題目' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '清除題目' }).click();
  await expect(page.locator('.resection-landmark')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(routeBefore);
});

test('leader creates a named QR on one device; a member imports the QR image and sees the same points without changing GPX', async ({ browser }) => {
  const leaderContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const leader = await leaderContext.newPage(); await mockMaps(leader); await leader.goto('http://127.0.0.1:5175/');
  await expect(leader.locator('.source-pill')).toContainText('iB20000'); await login(leader);
  await leader.getByRole('button', { name: '題目', exact: true }).click();
  await leader.getByRole('button', { name: /領袖設題及分享/ }).click();
  await leader.getByLabel('題目類型').selectOption('resection');
  await leader.getByLabel('題目名稱').fill('三角網測練習');
  await leader.getByLabel('題目說明').fill('量度三個地標的後視');
  await leader.getByRole('button', { name: '到地圖標記' }).click();
  await expect(leader.getByLabel('題目地標標記')).toBeVisible();
  await waitForMapReady(leader);
  const map = await leader.locator('.map-canvas').boundingBox();
  for (const [x, y] of [[110, 180], [160, 270], [270, 340]]) await leader.touchscreen.tap(map.x + x, map.y + y);
  await expect(leader.locator('.exercise-marker')).toHaveCount(3);
  await leader.getByRole('button', { name: '完成選點' }).click();
  await leader.getByLabel('地點 A 名稱').fill('大帽山');
  await leader.getByLabel('地點 B 名稱').fill('高樓');
  await leader.getByLabel('地點 C 名稱').fill('碼頭');
  await leader.getByRole('button', { name: '產生 QR Code' }).click();
  await expect(leader.locator('.exercise-qr img')).toBeVisible();
  const qr = await leader.locator('.exercise-qr img').getAttribute('src');
  const link = await leader.getByLabel('題目分享連結').inputValue();
  const expected = decodeExercise(link);
  expect(expected.points.map((p) => p.name)).toEqual(['大帽山', '高樓', '碼頭']);
  expect(JSON.stringify(expected)).not.toMatch(/password|answer|angle/i);

  const memberContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const member = await memberContext.newPage(); await mockMaps(member); await member.goto('http://127.0.0.1:5175/');
  await expect(member.locator('.source-pill')).toContainText('iB20000');
  const xml = '<gpx xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="22.3835" lon="114.3225"><name>原本路線航點</name></wpt></gpx>';
  await member.locator('input[type=file]').setInputFiles({ name: 'route.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(xml) });
  await expect.poll(async () => JSON.parse(await member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).waypoints.length).toBe(1);
  const existing = await member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'));
  await member.getByRole('button', { name: '題目', exact: true }).click();
  await expect(member.getByRole('button', { name: /領袖設題及分享/ })).toHaveCount(0);
  await member.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await member.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'exercise.png', mimeType: 'image/png', buffer: Buffer.from(qr.split(',')[1], 'base64') });
  await expect(member.locator('.resection-landmark')).toHaveCount(3);
  await expect(member.locator('.exercise-name-label')).toHaveText(['大帽山', '高樓', '碼頭']);
  expect(JSON.parse(await member.evaluate(() => localStorage.getItem('scout-trail-map.exercise.v1')))).toEqual(expected);
  expect(await member.evaluate(() => localStorage.getItem('scout-trail-map.route.v1'))).toBe(existing);
  await member.getByRole('button', { name: '題目', exact: true }).click();
  await expect(member.locator('.exercise-current')).toContainText('三角網測練習');
  await expect(member.locator('.exercise-current')).toContainText('量度三個地標的後視');
  await member.getByRole('button', { name: /高樓.*移至地點/ }).click();
  await expect(member.locator('.map-coordinates')).toContainText(expected.points[1].lat.toFixed(4));
  await member.reload(); await expect(member.locator('.resection-landmark')).toHaveCount(3);

  // Native camera / link opening also works without an account or server-side task store.
  const linkContext = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const viaLink = await linkContext.newPage(); await mockMaps(viaLink); await viaLink.goto(link);
  await expect(viaLink.locator('.resection-landmark')).toHaveCount(3);
  expect(new URL(viaLink.url()).hash).toBe('');
  await expect(viaLink.locator('.exercise-name-label')).toHaveText(['大帽山', '高樓', '碼頭']);
  await leaderContext.close(); await memberContext.close(); await linkContext.close();
});

test('scanner rejects unrelated QR codes and confirms replacement; names are rendered as text', async ({ page }) => {
  await mockMaps(page); await page.goto('/'); await expect(page.locator('.source-pill')).toContainText('iB20000');
  const first = { kind: 'points', title: '地點題目', description: '', points: [{ lat: 22.3835, lon: 114.3225, name: '<img>' }] };
  const second = { kind: 'bearing', title: '方位題目', description: '', points: [
    { lat: 22.3835, lon: 114.3225, name: 'A 山' }, { lat: 22.384, lon: 114.324, name: 'B 樓' },
  ] };
  const firstUrl = exerciseUrl(first, 'http://127.0.0.1:5175/');
  await page.evaluate((url) => { location.hash = new URL(url).hash; }, firstUrl);
  await expect(page.locator('.exercise-marker')).toHaveCount(1);
  await expect(page.locator('.exercise-marker small')).toHaveText('<img>');
  await expect(page.locator('.exercise-marker img')).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem('scout-trail-map.exercise.v1'));
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  const invalidPng = await QRCode.toBuffer('https://example.com/ordinary', { width: 400, margin: 4 });
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: invalidPng });
  await expect(page.getByRole('alert')).toContainText('不是有效');
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.exercise.v1'))).toBe(stored);
  const validPng = await QRCode.toBuffer(exerciseUrl(second, 'http://127.0.0.1:5175/'), { width: 400, margin: 4 });
  await page.getByLabel('選擇題目 QR 圖片').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: validPng });
  await expect(page.getByRole('dialog')).toContainText('取代目前的題目');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.exercise.v1'))).toBe(stored);
  await page.evaluate((url) => { location.hash = new URL(url).hash; }, exerciseUrl(second, 'http://127.0.0.1:5175/'));
  await expect(page.getByRole('dialog')).toContainText('取代目前的題目');
  await page.getByRole('dialog').getByRole('button', { name: '讀取題目', exact: true }).click();
  await expect(page.locator('.bearing-marker')).toHaveCount(2);
  await expect(page.locator('.bearing-answers')).toHaveCount(0);
  await expect(page.locator('.exercise-name-label')).toHaveText(['A 山', 'B 樓']);
});

test('camera stream scans locally and is stopped immediately after reading', async ({ page }) => {
  const task = { kind: 'points', title: '相機讀取', description: '', points: [{ lat: 22.3835, lon: 114.3225, name: '集合點' }] };
  const url = exerciseUrl(task, 'http://127.0.0.1:5175/');
  const image = await QRCode.toDataURL(url, { width: 500, margin: 4 });
  await page.addInitScript((src) => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 500;
      const img = new Image(); await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = src; });
      canvas.getContext('2d').drawImage(img, 0, 0);
      const stream = canvas.captureStream(5); window.testCameraTrack = stream.getVideoTracks()[0]; return stream;
    } } });
  }, image);
  await mockMaps(page); await page.goto('/'); await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await page.getByRole('button', { name: '開啟相機' }).click();
  await expect(page.locator('.exercise-marker')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.exercise-marker small')).toHaveText('集合點');
  expect(await page.evaluate(() => window.testCameraTrack.readyState)).toBe('ended');
});

test('small touchscreen can place landmarks and rotate a handle without moving the fixed anchor', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage(); await mockMaps(page); await page.goto('http://127.0.0.1:5175/');
  await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '三角網測法' }).click();
  await expect(page.getByRole('button', { name: '三角網測法' })).toHaveAttribute('aria-pressed', 'true');
  await waitForMapReady(page);
  const box = await page.locator('.map-canvas').boundingBox();
  for (const [x, y] of [[70, 160], [160, 200], [270, 225]]) await page.touchscreen.tap(box.x + x, box.y + y);
  await expect(page.locator('.resection-landmark')).toHaveCount(3);
  const anchor = await point(page.locator('.resection-landmark-a'));
  const handle = await point(page.locator('.resection-handle-a'));
  const previous = await page.locator('.resection-line-a').getAttribute('d');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: handle.x, y: handle.y, id: 1 }] });
  for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: handle.x + i * 5, y: handle.y + i * 4, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.resection-line-a')).not.toHaveAttribute('d', previous);
  const after = await point(page.locator('.resection-landmark-a'));
  expect(Math.hypot(after.x - anchor.x, after.y - anchor.y)).toBeLessThan(1);
  await context.close();
});


test('denied camera permissions explain the image fallback without modifying a task', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } }));
  await mockMaps(page); await page.goto('/'); await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await page.getByRole('button', { name: '開啟相機' }).click();
  await expect(page.getByRole('alert')).toContainText('未獲授權');
  await expect(page.getByLabel('選擇題目 QR 圖片')).toBeAttached();
  expect(await page.evaluate(() => localStorage.getItem('scout-trail-map.exercise.v1'))).toBe(null);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0);
});

test('closing the scanner stops an active camera without waiting for a code', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 120;
    const stream = canvas.captureStream(5); window.testCameraTrack = stream.getVideoTracks()[0]; return stream;
  } } }));
  await mockMaps(page); await page.goto('/'); await expect(page.locator('.source-pill')).toContainText('iB20000');
  await page.getByRole('button', { name: '題目', exact: true }).click();
  await page.getByRole('button', { name: /讀取題目 QR Code/ }).click();
  await page.getByRole('button', { name: '開啟相機' }).click();
  await expect.poll(() => page.evaluate(() => window.testCameraTrack?.readyState)).toBe('live');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  expect(await page.evaluate(() => window.testCameraTrack.readyState)).toBe('ended');
});
