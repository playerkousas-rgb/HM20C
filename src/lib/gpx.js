export const MAX_GPX_BYTES = 5 * 1024 * 1024;
export const MAX_GPX_POINTS = 30000;

export function emptyRoute() {
  return { name: '未命名路線', segments: [], waypoints: [] };
}

function children(parent, name) {
  return Array.from(parent?.children || []).filter((child) => child.localName === name);
}

function childText(parent, name) {
  return children(parent, name)[0]?.textContent?.trim() || '';
}

function parsePoint(element) {
  const latitude = element.getAttribute('lat');
  const longitude = element.getAttribute('lon');
  if (latitude === null || longitude === null || latitude.trim() === '' || longitude.trim() === '') {
    throw new Error('GPX 有路點缺少經緯度，請檢查檔案。');
  }
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('GPX 包含無效經緯度，請檢查檔案。');
  }
  const point = { lat, lon };
  const elevation = childText(element, 'ele');
  if (elevation !== '') {
    const ele = Number(elevation);
    if (!Number.isFinite(ele)) throw new Error('GPX 包含無效高度，請檢查檔案。');
    point.ele = ele;
  }
  const time = childText(element, 'time');
  if (time) point.time = time;
  const name = childText(element, 'name');
  if (name) point.name = name.slice(0, 200);
  return point;
}

/** Parse tracks, track segments, routes and standalone waypoints without joining gaps. */
export function parseGpx(xml, fallbackName = '匯入的路線') {
  if (typeof xml !== 'string' || !xml.trim() || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('不是有效的 GPX 檔案。');
  }
  // Reject enormous files before constructing a DOM (particularly important on
  // phones). This is a conservative preflight; the actual parsed point count is
  // checked again below.
  const pointTag = /<(?:[A-Za-z_][\w.-]*:)?(?:wpt|rtept|trkpt)(?=[\s/>])/g;
  let candidateCount = 0;
  while (pointTag.exec(xml)) {
    candidateCount += 1;
    if (candidateCount > MAX_GPX_POINTS) throw new Error(`GPX 超過 ${MAX_GPX_POINTS.toLocaleString()} 個點，請先精簡檔案。`);
  }
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement?.localName !== 'gpx') {
    throw new Error('GPX 格式有誤，請選擇有效的 GPX 檔案。');
  }
  const root = parsed.documentElement;
  const segments = [];
  let count = 0;
  const collect = (nodes) => {
    count += nodes.length;
    if (count > MAX_GPX_POINTS) throw new Error(`GPX 超過 ${MAX_GPX_POINTS.toLocaleString()} 個點，請先精簡檔案。`);
    return nodes.map(parsePoint);
  };
  const waypoints = collect(children(root, 'wpt'));
  for (const route of children(root, 'rte')) {
    const points = collect(children(route, 'rtept'));
    if (points.length) segments.push({ kind: 'route', name: childText(route, 'name').slice(0, 200), points });
  }
  for (const track of children(root, 'trk')) {
    const name = childText(track, 'name').slice(0, 200);
    for (const segment of children(track, 'trkseg')) {
      const points = collect(children(segment, 'trkpt'));
      if (points.length) segments.push({ kind: 'track', name, points });
    }
  }
  if (!count) throw new Error('GPX 沒有可用的路線點或航點。');
  const metadata = children(root, 'metadata')[0];
  const name = childText(metadata, 'name') || childText(children(root, 'trk')[0], 'name') ||
    childText(children(root, 'rte')[0], 'name') || fallbackName;
  return { name: name.slice(0, 100), segments, waypoints };
}

function escapeXml(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[<>&'"]/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[char]);
}

function pointXml(point, tag, indent = '    ') {
  const data = [];
  if (Number.isFinite(point.ele)) data.push(`<ele>${point.ele}</ele>`);
  if (point.time) data.push(`<time>${escapeXml(point.time)}</time>`);
  if (point.name) data.push(`<name>${escapeXml(point.name)}</name>`);
  return `${indent}<${tag} lat="${point.lat}" lon="${point.lon}">${data.join('')}</${tag}>`;
}

/** Keep elevations/times if present; do not invent either for hand-drawn points. */
export function makeGpx(route) {
  const name = escapeXml(route.name.trim() || '未命名路線');
  const waypoints = route.waypoints.map((point) => pointXml(point, 'wpt', '  ')).join('\n');
  const routes = route.segments.filter((s) => s.kind === 'route' && s.points.length).map((segment) => {
    const segmentName = escapeXml(segment.name || route.name || '路線');
    return `  <rte><name>${segmentName}</name>\n${segment.points.map((p) => pointXml(p, 'rtept')).join('\n')}\n  </rte>`;
  }).join('\n');
  const tracks = route.segments.filter((s) => s.kind !== 'route' && s.points.length).map((segment) => {
    const segmentName = escapeXml(segment.name || route.name || '路線');
    return `  <trk><name>${segmentName}</name><trkseg>\n${segment.points.map((p) => pointXml(p, 'trkpt', '      ')).join('\n')}\n  </trkseg></trk>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="山野地圖 Scout Trail Map" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${name}</name></metadata>\n${[waypoints, routes, tracks].filter(Boolean).join('\n')}\n</gpx>\n`;
}
