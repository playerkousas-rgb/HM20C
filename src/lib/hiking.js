import { distanceMeters, EARTH_RADIUS_M } from './geo';
import { inHongKongGrid } from './utm';

const BROUTER_URL = 'https://brouter.de/brouter';
const MAX_ANCHORS = 25;
const MAX_PER_REQUEST = 9;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_NETWORK_POINTS = 30000;
const MAX_SNAP_METRES = 150;
const MAX_JOIN_METRES = 10;

function localXY(point, origin) {
  const radians = Math.PI / 180;
  return {
    x: (point.lon - origin.lon) * radians * EARTH_RADIUS_M * Math.cos(origin.lat * radians),
    y: (point.lat - origin.lat) * radians * EARTH_RADIUS_M,
  };
}
function distanceToSegment(point, a, b) {
  const p = localXY(point, a); const q = localXY(b, a);
  const length2 = q.x ** 2 + q.y ** 2;
  const t = length2 ? Math.max(0, Math.min(1, (p.x * q.x + p.y * q.y) / length2)) : 0;
  return Math.hypot(p.x - t * q.x, p.y - t * q.y);
}
function simplify(points, tolerance = 18) {
  const keep = new Set([0, points.length - 1]); const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop(); let index = -1; let max = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const distance = distanceToSegment(points[i], points[first], points[last]);
      if (distance > max) { index = i; max = distance; }
    }
    if (index >= 0) { keep.add(index); stack.push([first, index], [index, last]); }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

/** Preserve hand-drawn bends; add intermediate via points on long strokes. */
export function strokeAnchors(rawPoints, start = null) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 2) throw new Error('筆畫太短；請沿山徑拖畫一段路。');
  if (rawPoints.length > 1000 || rawPoints.some((point) => !inHongKongGrid(point)) || (start && !inHongKongGrid(start))) {
    throw new Error('筆畫超出香港 UTM 範圍或太長，請在地圖內分段重畫。');
  }
  const filtered = [rawPoints[0]];
  for (let i = 1; i < rawPoints.length - 1; i += 1) {
    if (distanceMeters(filtered.at(-1), rawPoints[i]) >= 4) filtered.push(rawPoints[i]);
  }
  const last = rawPoints.at(-1);
  if (distanceMeters(filtered.at(-1), last) > 0.1) filtered.push(last);
  if (filtered.length < 2 || filtered.every((point) => distanceMeters(point, filtered[0]) < 12)) {
    throw new Error('筆畫太短；請沿山徑拖畫一段路。');
  }
  const anchors = simplify(filtered);
  // Connecting a prior stroke to the first drawn point must be routed by
  // BRouter, not forced through invented via points along a straight chord.
  const dense = start ? [start] : [anchors[0]];
  if (start && distanceMeters(start, anchors[0]) > 1) dense.push(anchors[0]);
  for (let i = 1; i < anchors.length; i += 1) {
    const a = anchors[i - 1]; const b = anchors[i];
    const parts = Math.ceil(distanceMeters(a, b) / 350);
    for (let j = 1; j <= parts; j += 1) {
      const t = j / parts;
      dense.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
  }
  if (dense.length > MAX_ANCHORS) throw new Error('這一筆太長或彎位太多，請分成較短的筆畫。');
  return dense;
}

async function boundedJson(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('沿徑服務回傳過大，路線未有更改。');
  // Limit the stream even when the server omits Content-Length.
  if (response.body?.getReader) {
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('沿徑服務回傳過大，路線未有更改。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const all = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(all));
  }
  // Test doubles / older browsers without streaming.
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error('沿徑服務回傳過大，路線未有更改。');
  return JSON.parse(text);
}
function parseGeometry(data) {
  const geometry = data?.type === 'FeatureCollection'
    ? data.features?.find((feature) => feature?.geometry?.type === 'LineString')?.geometry
    : data?.type === 'Feature' ? data.geometry : data;
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates) ||
      geometry.coordinates.length < 2 || geometry.coordinates.length > MAX_NETWORK_POINTS) {
    throw new Error('沿徑服務沒有回傳有效山徑，路線未有更改。');
  }
  const points = geometry.coordinates.map((coordinate) => ({ lon: Number(coordinate?.[0]), lat: Number(coordinate?.[1]) }));
  if (points.some((point) => !inHongKongGrid(point))) throw new Error('沿徑服務回傳了範圍外或無效的路點，路線未有更改。');
  return points;
}
async function requestChunk(anchors, signal, fetcher) {
  const url = new URL(BROUTER_URL);
  url.searchParams.set('lonlats', anchors.map((point) => `${point.lon.toFixed(7)},${point.lat.toFixed(7)}`).join('|'));
  url.searchParams.set('profile', 'hiking-mountain');
  url.searchParams.set('alternativeidx', '0'); url.searchParams.set('format', 'geojson');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetcher(url.toString(), { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`沿徑服務未能計算（${response.status}），路線未有更改。`);
    let data;
    try { data = await boundedJson(response); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(error.message?.includes('回傳過大') ? error.message : '沿徑服務回應無效，路線未有更改。');
    }
    const points = parseGeometry(data);
    for (const anchor of anchors) {
      let nearest = Infinity;
      for (let i = 1; i < points.length; i += 1) nearest = Math.min(nearest, distanceToSegment(anchor, points[i - 1], points[i]));
      if (nearest > MAX_SNAP_METRES) throw new Error('手畫位置離可用路網超過 150 米；請沿可見山徑重畫，路線未有更改。');
    }
    return points;
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new Error('沿徑服務逾時，路線未有更改；請檢查網絡並重試。');
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (error instanceof TypeError) throw new Error('未能連接 BRouter；請檢查網絡或跨域設定，路線未有更改。');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}

/** All chunks succeed or no geometry is returned. Never fall back to a straight line. */
export async function snapHikingStroke(rawPoints, { start = null, signal, fetcher = fetch } = {}) {
  const anchors = strokeAnchors(rawPoints, start);
  let combined = [];
  for (let offset = 0; offset < anchors.length - 1; offset += MAX_PER_REQUEST - 1) {
    const chunk = anchors.slice(offset, offset + MAX_PER_REQUEST);
    const points = await requestChunk(chunk, signal, fetcher);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (combined.length) {
      if (distanceMeters(combined.at(-1), points[0]) > MAX_JOIN_METRES) {
        throw new Error('沿徑服務回傳的分段無法接合，路線未有更改。');
      }
      // Use a single shared network endpoint; do not fabricate a connector.
      combined.push(...points.slice(1));
    } else combined = points;
    if (combined.length > MAX_NETWORK_POINTS) throw new Error('沿徑點數過多，請分段畫路。');
  }
  if (start) {
    if (distanceMeters(start, combined[0]) > MAX_JOIN_METRES) {
      throw new Error('現有路線終點離山徑太遠，未能接上；請先調整終點或另開路線。');
    }
    combined[0] = { lat: start.lat, lon: start.lon };
  }
  return combined;
}
