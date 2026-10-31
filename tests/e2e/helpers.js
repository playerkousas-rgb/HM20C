// Synthetic routed geometry: these fixtures do not exercise real BRouter/OSM.
export async function mockHiking(page) {
  await page.route('https://brouter.de/brouter**', (route) => {
    const url = new URL(route.request().url());
    const coordinates = url.searchParams.get('lonlats').split('|').map((pair) => pair.split(',').map(Number));
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates } }] }) });
  });
}
export async function drawStroke(page, coords) {
  const box = await page.locator('.map-canvas').boundingBox();
  await page.mouse.move(box.x + coords[0][0], box.y + coords[0][1]);
  await page.mouse.down();
  for (const [x, y] of coords.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await page.mouse.up();
}
