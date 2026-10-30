// Adapted from playerkousas-rgb/HKMAP, js/contours.js.
import * as L from "leaflet";
import { CONTOUR_CACHE, CONTOUR_STAGING_PREFIX, freshRequestUrl } from '../lib/offline';

/**
 * 等高線疊加層（主頁「等高線」開關）
 * ------------------------------------------------------------------
 * 資料：地政總署 iB20000 數碼地形圖的等高線圖層 ELEVLINE
 *       （每 20 m 一條；欄位 HEIGHT＝高度，米，主水平基準以上）。
 * 來源：Esri China (HK) 在 ArcGIS Online 公開的同一套 iB20000 圖層，
 *       這裏只作即時查詢顯示（只供參考，以地政總署原檔為準）。
 *
 * 做法：
 *  - 以 Web Mercator 方格分批查詢並快取：比例較細（約 1:12 000–1:33 000）用 z13
 *    （每格約 4.9 km），比例較大用 z14（每格約 2.4 km）。
 *  - 回應使用坐標量化（quantization）＋伺服器簡化，檔案細很多；量化網格與方格邊界對齊，
 *    每條線再裁剪到所屬方格，所以相鄰方格無縫接駁、不會重複畫線。
 *  - 線用 SVG 畫（列印清晰），每 100 m 的計曲線加粗。
 *  - 高度數字沿線擺放，自動避開檢查點、方格數字及互相重疊。
 *
 * 只依賴全域 Leaflet（L）。
 */

export const CONTOUR_SERVICE =
  "https://services3.arcgis.com/6j1KwZfY2fZrfNMR/arcgis/rest/services/ELEVLINE/FeatureServer/4";
export const CONTOUR_ITEM_URL = "https://www.arcgis.com/home/item.html?id=566289c35c214178b572a7e934a1cd9a";
/** 等高距（米）及計曲線（加粗）間距。 */
export const CONTOUR_INTERVAL_M = 20;
export const CONTOUR_INDEX_M = 100;
/** 縮放低於此值（香港約 1:33 000 或更細比例）不載入，避免一次下載太多線。 */
export const CONTOUR_MIN_ZOOM = 14;
export const CONTOUR_ATTRIBUTION =
  `等高線 iB20000 © Lands Department（經 <a href="${CONTOUR_ITEM_URL}" target="_blank" rel="noopener">Esri China (HK)</a>）`;

/** 紙圖底圖用柔和棕色；其他底圖保留原有配色及所有線寬。 */
export function contourStyleForBasemap(basemap, isIndex) {
  const palette = basemap === "imagery"
    ? { color: "#ffd27f", opacity: 0.92 }
    : basemap === "countryside"
    ? { color: "#8a4a14", opacity: 0.85 }
    : { color: "#be998a", opacity: 0.85 };
  return { ...palette, weight: isIndex ? 1.5 : 0.75 };
}

const R = 6378137;
const HALF = Math.PI * R; // Web Mercator 半周長
const DEG = 180 / Math.PI;
/** ELEVLINE 圖層範圍（EPSG:3857，四邊各放大約 100 m）；範圍外不查詢。 */
const DATA_EXTENT = { xmin: 12671890, ymin: 2529910, xmax: 12739440, ymax: 2578995 };

/** 兩級細節：量化間距＝方格闊度 ÷ cells，令量化網格與方格邊界完全對齊。 */
const LODS = [
  { id: "c", z: 13, cells: 2048 }, // 每格約 4.9 km，量化約 2.4 m
  { id: "f", z: 14, cells: 4096 }, // 每格約 2.4 km，量化約 0.6 m
].map((lod) => {
  const size = (2 * HALF) / 2 ** lod.z;
  return { ...lod, size, tol: size / lod.cells };
});
/** 縮放 ≥ 此值（約 1:12 000 或更大比例）用精細資料。 */
const FINE_ZOOM = 15.5;
/** 縮放 ≥ 此值（約 1:7 500 或更大比例）連 20 m 線都標高度；否則只標 100 m 計曲線。 */
const LABEL_ALL_ZOOM = 16.1;

const PAGE_SIZE = 2000; // 圖層 maxRecordCount
const MAX_PAGES = 10;
const MAX_PARALLEL = 4;
const MAX_CACHED_TILES = 40;
const MAX_VIEW_TILES = 64;
const RETRY_MS = 30000;
const FETCH_TIMEOUT_MS = 25000;
const MAX_LABELS = 400;
const LABEL_FONT_PX = 8.5;
const DIGIT_W = LABEL_FONT_PX * 0.58;

/* ---------- 坐標 ---------- */
function mercToLatLng(x, y) {
  return L.latLng((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG, (x / R) * DEG);
}

function latLngToMerc(lat, lng) {
  const clamped = Math.max(-85, Math.min(85, lat));
  const s = Math.sin(clamped / DEG);
  return [(lng / DEG) * R, (R / 2) * Math.log((1 + s) / (1 - s))];
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function tileExtent(lod, tx, ty) {
  const xmin = -HALF + tx * lod.size;
  const ymax = HALF - ty * lod.size;
  return { xmin: round3(xmin), ymin: round3(ymax - lod.size), xmax: round3(xmin + lod.size), ymax: round3(ymax) };
}

/* ---------- 查詢 ---------- */
function queryUrl(ext, tol, offset) {
  const env = { ...ext, spatialReference: { wkid: 102100 } };
  const params = new URLSearchParams({
    where: "1=1",
    geometry: JSON.stringify(env),
    geometryType: "esriGeometryEnvelope",
    inSR: "102100",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "HEIGHT",
    returnGeometry: "true",
    returnZ: "false",
    outSR: "102100",
    // 伺服器先按量化間距簡化線條（偏差 ≤ 一格量化，列印睇唔出），回應細大約一半。
    maxAllowableOffset: String(tol),
    quantizationParameters: JSON.stringify({ mode: "view", originPosition: "upperLeft", tolerance: tol, extent: env }),
    orderByFields: "OBJECTID",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    cacheHint: "true",
    f: "json",
  });
  return `${CONTOUR_SERVICE}/query?${params}`;
}

class HttpError extends Error {}

let useJsonp = false;
let jsonpSeq = 0;

/** 先用 fetch（CORS）；如瀏覽器擋住（網絡／CORS 錯誤），自動改用 ArcGIS 支援的 JSONP。 */
async function getJson(url) {
  // A controlled page may have a saved CORS response even if a previous
  // online request had to use JSONP. Always give the worker/cache a chance.
  const controlled = typeof navigator !== 'undefined' && navigator.serviceWorker?.controller;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (!useJsonp || controlled || offline) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : 0;
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit", signal: ctrl?.signal });
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (offline || err instanceof HttpError || err?.name === "AbortError" || err instanceof SyntaxError) throw err;
      useJsonp = true;
    } finally {
      clearTimeout(timer);
    }
  }
  return jsonp(url);
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const name = `__scoutContour${(jsonpSeq += 1)}`;
    const script = document.createElement("script");
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      // 逾時後才到的回應會呼叫這個空函數，不會報錯。
      window[name] = () => {
        delete window[name];
      };
      script.remove();
    };
    window[name] = (data) => {
      done();
      delete window[name];
      resolve(data);
    };
    script.onerror = () => {
      done();
      reject(new Error("等高線服務連線失敗"));
    };
    timer = setTimeout(() => {
      done();
      reject(new Error("等高線服務逾時"));
    }, FETCH_TIMEOUT_MS);
    script.src = `${url}&callback=${name}`;
    script.async = true;
    document.head.appendChild(script);
  });
}

/* ---------- 解碼＋裁剪 ---------- */
/** Liang–Barsky：把線段裁剪到方格內；完全在外回傳 null。未被裁剪的端點保留原物件。 */
function clipSegment(p0, p1, e) {
  let t0 = 0;
  let t1 = 1;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const tests = [
    [-dx, p0[0] - e.xmin],
    [dx, e.xmax - p0[0]],
    [-dy, p0[1] - e.ymin],
    [dy, e.ymax - p0[1]],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  const a = t0 === 0 ? p0 : [p0[0] + t0 * dx, p0[1] + t0 * dy];
  const b = t1 === 1 ? p1 : [p0[0] + t1 * dx, p0[1] + t1 * dy];
  return [a, b];
}

/** 把一條線裁剪到方格內，可能分成幾段。 */
function clipPath(pts, e) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipSegment(pts[i], pts[i + 1], e);
    if (!seg) {
      if (cur) pieces.push(cur);
      cur = null;
      continue;
    }
    const [a, b] = seg;
    if (cur && cur[cur.length - 1] === a) cur.push(b);
    else {
      if (cur) pieces.push(cur);
      cur = [a, b];
    }
    if (b !== pts[i + 1]) {
      pieces.push(cur);
      cur = null;
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

function boundsOf(paths) {
  let s = 90;
  let w = 180;
  let n = -90;
  let e = -180;
  for (const path of paths) {
    for (const ll of path) {
      if (ll.lat < s) s = ll.lat;
      if (ll.lat > n) n = ll.lat;
      if (ll.lng < w) w = ll.lng;
      if (ll.lng > e) e = ll.lng;
    }
  }
  return { s, w, n, e };
}

/** ArcGIS JSON（量化：每條線第一點絕對值，之後為差值）→ [{ h, paths: [[LatLng…]…], bounds }]。 */
function decodeInto(out, json, ext) {
  const tr = json.transform;
  const sx = tr?.scale?.[0] ?? 1;
  const sy = tr?.scale?.[1] ?? 1;
  const tx = tr?.translate?.[0] ?? 0;
  const ty = tr?.translate?.[1] ?? 0;
  const lowerLeft = tr?.originPosition === "lowerLeft";
  for (const f of json.features || []) {
    const hv = f?.attributes?.HEIGHT;
    const paths = f?.geometry?.paths;
    if (hv == null || !Array.isArray(paths)) continue;
    const h = Number(hv);
    if (!Number.isFinite(h)) continue;
    const latlngPaths = [];
    for (const path of paths) {
      if (!Array.isArray(path) || path.length < 2) continue;
      const pts = new Array(path.length);
      let qx = 0;
      let qy = 0;
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        if (tr) {
          qx += p[0];
          qy += p[1];
          pts[i] = [tx + qx * sx, lowerLeft ? ty + qy * sy : ty - qy * sy];
        } else {
          pts[i] = [p[0], p[1]];
        }
      }
      for (const piece of clipPath(pts, ext)) {
        if (piece.length >= 2) latlngPaths.push(piece.map(([x, y]) => mercToLatLng(x, y)));
      }
    }
    if (latlngPaths.length) out.push({ h, paths: latlngPaths, bounds: boundsOf(latlngPaths) });
  }
}

/* ---------- 沿線取點（標高度數字用） ---------- */
function cumulative(pts) {
  const cum = new Array(pts.length);
  cum[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return cum;
}

function pointAt(pts, cum, s) {
  const last = pts.length - 1;
  if (s <= 0) return pts[0];
  if (s >= cum[last]) return pts[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  const t = (s - cum[lo]) / span;
  return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * t, y: pts[lo].y + (pts[hi].y - pts[lo].y) * t };
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * 建立等高線疊加層。
 * @param {L.Map} map
 * @param {{ onStatus?: (status) => void }} [options]
 */
export function createContourOverlay(map, options = {}) {
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};

  // 等高線放喺底圖之上、方格網／地名／路線套印之下。
  // Lines share the rotated tile pane; label markers share the unrotated
  // marker pane, whose positions the rotation plugin transforms for us.
  const linePane = map.createPane("contourLines", map.getPane("tilePane").parentElement);
  linePane.style.zIndex = "350";
  linePane.style.pointerEvents = "none";
  const labelPane = map.createPane("contourLabels", map.getPane("markerPane").parentElement);
  labelPane.style.zIndex = "360";
  labelPane.style.pointerEvents = "none";
  labelPane.classList.add("contour-label-pane");

  // SVG：列印時係向量，線條最清晰（極舊瀏覽器冇 SVG 先用 canvas）。
  const renderer = L.svg({ pane: "contourLines", padding: 0.2 }) || L.canvas({ pane: "contourLines", padding: 0.2 });
  const lineGroup = L.layerGroup();
  const labelGroup = L.layerGroup();

  /** key → { key, lod, tx, ty, ext, state, features, normal, index, used, failedAt } */
  const tiles = new Map();
  let queue = [];
  let active = 0;
  let need = [];
  let shown = new Set();
  let enabled = false;
  let labelsOn = true;
  let basemap = "hm20c";
  let tooWide = false;
  let outside = false;
  let lastError = "";
  let lastSig = "";
  let moveTimer = 0;
  let labelTimer = 0;
  let retryTimer = 0;
  let attributionOn = false;
  let avoidProvider = () => [];

  map.on("moveend rotate", () => {
    if (!enabled) return;
    clearTimeout(moveTimer);
    // Rotation changes the visible bounding box and label directions too.
    moveTimer = setTimeout(update, 60);
  });

  function lineStyle(isIndex) {
    return contourStyleForBasemap(basemap, isIndex);
  }

  function buildLayers(tile) {
    const normal = [];
    const index = [];
    for (const f of tile.features) {
      const target = f.h % CONTOUR_INDEX_M === 0 ? index : normal;
      for (const path of f.paths) target.push(path);
    }
    const common = {
      renderer,
      pane: "contourLines",
      interactive: false,
      lineCap: "round",
      lineJoin: "round",
      smoothFactor: 1,
    };
    tile.normal = normal.length ? L.polyline(normal, { ...common, ...lineStyle(false) }) : null;
    tile.index = index.length ? L.polyline(index, { ...common, ...lineStyle(true) }) : null;
  }

  function tileLayers(tile) {
    return [tile?.normal, tile?.index].filter(Boolean);
  }

  /** 目前畫面（加 pad 比例的邊）需要的方格，按距離中心排序；方格太多（比例太細）回傳 null。 */
  function tilesFor(lod, bounds, pad) {
    const w = bounds.getEast() - bounds.getWest();
    const h = bounds.getNorth() - bounds.getSouth();
    const [x0, y0] = latLngToMerc(bounds.getSouth() - h * pad, bounds.getWest() - w * pad);
    const [x1, y1] = latLngToMerc(bounds.getNorth() + h * pad, bounds.getEast() + w * pad);
    const ax0 = Math.max(x0, DATA_EXTENT.xmin);
    const ax1 = Math.min(x1, DATA_EXTENT.xmax);
    const ay0 = Math.max(y0, DATA_EXTENT.ymin);
    const ay1 = Math.min(y1, DATA_EXTENT.ymax);
    if (ax0 > ax1 || ay0 > ay1) return [];
    const tx0 = Math.floor((ax0 + HALF) / lod.size);
    const tx1 = Math.floor((ax1 + HALF) / lod.size);
    const ty0 = Math.floor((HALF - ay1) / lod.size);
    const ty1 = Math.floor((HALF - ay0) / lod.size);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MAX_VIEW_TILES) return null;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const list = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const ext = tileExtent(lod, tx, ty);
        const d = Math.hypot((ext.xmin + ext.xmax) / 2 - cx, (ext.ymin + ext.ymax) / 2 - cy);
        list.push({ key: `${lod.id}/${tx}/${ty}`, lod, tx, ty, ext, d });
      }
    }
    return list.sort((a, b) => a.d - b.d);
  }

  function dropQueued() {
    for (const key of queue) {
      if (tiles.get(key)?.state === "queued") tiles.delete(key);
    }
    queue = [];
  }

  function update() {
    clearTimeout(moveTimer);
    moveTimer = 0;
    if (!enabled) return;
    const zoom = map.getZoom();
    tooWide = false;
    outside = false;
    if (zoom < CONTOUR_MIN_ZOOM - 1e-6) {
      need = [];
      dropQueued();
      refreshDisplay();
      return;
    }
    const lod = zoom >= FINE_ZOOM ? LODS[1] : LODS[0];
    const wanted = tilesFor(lod, map.getBounds(), 0.15);
    if (!wanted) {
      tooWide = true;
      need = [];
      dropQueued();
      refreshDisplay();
      return;
    }
    need = wanted;
    outside = wanted.length === 0;
    const now = Date.now();
    const needKeys = new Set(need.map((t) => t.key));
    // 已唔再需要、又未開始的請求：取消。
    queue = queue.filter((key) => {
      if (needKeys.has(key)) return true;
      if (tiles.get(key)?.state === "queued") tiles.delete(key);
      return false;
    });
    for (const t of need) {
      let tile = tiles.get(t.key);
      if (!tile) {
        tile = { ...t, state: "queued", features: [], normal: null, index: null, used: now, failedAt: 0 };
        tiles.set(t.key, tile);
        queue.push(t.key);
      } else if (tile.state === "error" && now - tile.failedAt > RETRY_MS) {
        tile.state = "queued";
        queue.push(t.key);
      }
      tile.used = now;
    }
    const order = new Map(need.map((t, i) => [t.key, i]));
    queue.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
    pump();
    refreshDisplay();
    evict();
  }

  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      const key = queue.shift();
      const tile = tiles.get(key);
      if (!tile || tile.state !== "queued") continue;
      tile.state = "loading";
      active += 1;
      loadTile(tile)
        .then((features) => {
          tile.features = features;
          buildLayers(tile);
          tile.state = "ready";
        })
        .catch((err) => {
          tile.state = "error";
          tile.failedAt = Date.now();
          lastError = (err && err.message) || String(err);
          scheduleRetry();
        })
        .finally(() => {
          active -= 1;
          pump();
          refreshDisplay();
        });
    }
  }

  async function loadTile(tile, getPage = getJson) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await getPage(queryUrl(tile.ext, tile.lod.tol, offset));
      if (!json || json.error) throw new Error(json?.error?.message || "等高線服務回應錯誤");
      const n = Array.isArray(json.features) ? json.features.length : 0;
      decodeInto(out, json, tile.ext);
      if (!json.exceededTransferLimit) break;
      if (!n || page === MAX_PAGES - 1) throw new Error("等高線資料未完整載入");
      offset += n;
    }
    return out;
  }

  /** Download every paginated contour query needed for the chosen viewport. */
  async function downloadOffline(bounds, zoom, { signal, onProgress = () => {} } = {}) {
    if (zoom < CONTOUR_MIN_ZOOM - 1e-6) throw new Error('目前比例不能下載等高線。');
    const lod = zoom >= FINE_ZOOM ? LODS[1] : LODS[0];
    const box = L.latLngBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]]);
    const wanted = tilesFor(lod, box, 0.15);
    if (!wanted?.length) throw new Error('目前範圍不在等高線資料範圍內。');
    if (wanted.length > 16) throw new Error('等高線範圍過大，請分區下載。');

    // Validate every page in a temporary cache first. A failed/cancelled
    // refresh must not replace the old complete pack with a partial one.
    const stagingName = `${CONTOUR_STAGING_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const staging = await caches.open(stagingName);
    let done = 0;
    let failed = 0;
    try {
      const getFreshPage = async (url) => {
        if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
        const ctrl = new AbortController();
        const abort = () => ctrl.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          // Do not fall back to an old page during a fresh download. CORS must
          // permit inspecting the JSON: opaque/unverifiable replies are rejected.
          const response = await fetch(freshRequestUrl(url), { mode: 'cors', credentials: 'omit', cache: 'reload', signal: ctrl.signal });
          if (!response.ok) throw new Error(`等高線服務 HTTP ${response.status}`);
          const json = await response.clone().json();
          if (!json || json.error || !Array.isArray(json.features)) throw new Error(json?.error?.message || '等高線資料不完整。');
          const validPair = (value) => Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
          const validTransform = !json.transform || (validPair(json.transform.scale) && validPair(json.transform.translate));
          const validFeatures = json.features.every((feature) => feature?.attributes?.HEIGHT != null && Number.isFinite(Number(feature.attributes.HEIGHT))
            && Array.isArray(feature?.geometry?.paths) && feature.geometry.paths.length > 0
            && feature.geometry.paths.every((path) => Array.isArray(path) && path.length >= 2 && path.every(validPair)));
          if (!validTransform || !validFeatures) throw new Error('等高線資料格式不完整。');
          await staging.put(url, response);
          return json;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        }
      };
      for (const tile of wanted) {
        if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
        try { await loadTile(tile, getFreshPage); }
        catch (error) {
          if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
          if (error?.name === 'QuotaExceededError') throw error;
          failed += 1;
        }
        done += 1;
        onProgress({ done, total: wanted.length, failed });
      }
      if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
      if (!failed) {
        const cache = await caches.open(CONTOUR_CACHE);
        const rollback = [];
        try {
          for (const request of await staging.keys()) {
            const response = await staging.match(request);
            if (!response) throw new Error('等高線暫存資料遺失，請重試。');
            // Keep the previous responses so a quota error partway through
            // committing can restore the earlier complete download.
            rollback.push({ request, previous: await cache.match(request, { ignoreVary: true }) });
            await cache.put(request, response);
          }
        } catch (error) {
          // Free temporary storage before attempting to restore old pages.
          await caches.delete(stagingName).catch(() => {});
          let restoreFailed = false;
          for (const { request, previous } of rollback.reverse()) {
            try {
              if (previous) await cache.put(request, previous);
              else await cache.delete(request, { ignoreVary: true });
            } catch { restoreFailed = true; }
          }
          if (restoreFailed) throw new Error('未能還原舊等高線；請勿依賴已存畫面，清理空間後重新下載並實測。');
          throw error;
        }
      }
      return { done, failed, total: wanted.length };
    } catch (error) {
      if (error?.name === 'QuotaExceededError') throw new Error('瀏覽器儲存空間不足，未能保存等高線；請清除舊地圖後重試。');
      throw error;
    } finally {
      await caches.delete(stagingName).catch(() => {});
    }
  }

  /** 有方格載入失敗：稍後自動再試（唔使等用家移動地圖）。 */
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (enabled) update();
    }, RETRY_MS + 500);
  }

  const settled = (key) => {
    const s = tiles.get(key)?.state;
    return s === "ready" || s === "error";
  };
  const ready = (key) => tiles.get(key)?.state === "ready";

  /** 決定顯示邊啲方格：新細節未載完時，先沿用另一級已載好的資料，避免縮放時閃爍。 */
  function refreshDisplay() {
    let keys = new Set();
    if (enabled && need.length) {
      const activeKeys = need.map((t) => t.key);
      if (activeKeys.every(settled)) {
        keys = new Set(activeKeys.filter(ready));
      } else {
        const other = need[0].lod === LODS[0] ? LODS[1] : LODS[0];
        const fallback = tilesFor(other, map.getBounds(), 0) || [];
        const useFallback = fallback.length > 0 && fallback.every((t) => ready(t.key));
        const source = useFallback ? fallback.map((t) => t.key) : activeKeys;
        keys = new Set(source.filter(ready));
        if (useFallback) {
          const now = Date.now();
          source.forEach((key) => {
            const tile = tiles.get(key);
            if (tile) tile.used = now;
          });
        }
      }
    }
    display(keys);
    scheduleLabels();
    emitStatus();
  }

  function display(keys) {
    for (const key of shown) {
      if (!keys.has(key)) tileLayers(tiles.get(key)).forEach((l) => lineGroup.removeLayer(l));
    }
    for (const key of keys) {
      if (!shown.has(key)) tileLayers(tiles.get(key)).forEach((l) => lineGroup.addLayer(l));
    }
    shown = keys;
  }

  function evict() {
    if (tiles.size <= MAX_CACHED_TILES) return;
    const victims = [...tiles.values()]
      .filter((t) => !shown.has(t.key) && (t.state === "ready" || t.state === "error"))
      .sort((a, b) => a.used - b.used);
    for (const t of victims) {
      if (tiles.size <= MAX_CACHED_TILES) break;
      tiles.delete(t.key);
    }
  }

  /* ---------- 高度數字 ---------- */
  function scheduleLabels(delay = 160) {
    clearTimeout(labelTimer);
    labelTimer = 0;
    if (!enabled || !labelsOn) {
      labelGroup.clearLayers();
      return;
    }
    labelTimer = setTimeout(placeLabels, delay);
  }

  function placeLabels() {
    labelTimer = 0;
    labelGroup.clearLayers();
    if (!enabled || !labelsOn || !shown.size) return;
    const size = map.getSize();
    if (!size.x || !size.y) return;
    const zoom = map.getZoom();
    // Use actual screen coordinates, not unrotated projected pixels. This
    // keeps collision checks and the label's angle aligned with rotated lines.
    const toPx = (ll) => map.latLngToContainerPoint(ll);
    const view = map.getBounds();
    const vs = view.getSouth();
    const vn = view.getNorth();
    const vw = view.getWest();
    const ve = view.getEast();
    const labelAll = zoom >= LABEL_ALL_ZOOM;
    const margin = 10;

    let avoid = [];
    try {
      avoid = (avoidProvider() || [])
        .filter((a) => a && Number.isFinite(a.lat) && Number.isFinite(a.lng))
        .map((a) => {
          const p = toPx(L.latLng(a.lat, a.lng));
          return { x: p.x + (a.dx || 0), y: p.y + (a.dy || 0), r: a.r || 20 };
        });
    } catch {
      avoid = [];
    }

    const feats = [];
    for (const key of [...shown].sort()) {
      const tile = tiles.get(key);
      if (!tile) continue;
      for (const f of tile.features) {
        const isIndex = f.h % CONTOUR_INDEX_M === 0;
        if (!isIndex && !labelAll) continue;
        const b = f.bounds;
        if (b.n < vs || b.s > vn || b.e < vw || b.w > ve) continue;
        feats.push({ f, isIndex });
      }
    }
    feats.sort((a, b) => Number(b.isIndex) - Number(a.isIndex)); // 計曲線優先

    const placed = [];
    const conflicts = (x, y, r, h, gap) => {
      for (const a of avoid) {
        if (Math.hypot(x - a.x, y - a.y) < a.r + r) return true;
      }
      for (const q of placed) {
        const d = Math.hypot(x - q.x, y - q.y);
        if (d < q.r + r + 10) return true;
        if (q.h === h && d < gap) return true;
      }
      return false;
    };

    for (const { f, isIndex } of feats) {
      if (placed.length >= MAX_LABELS) break;
      const text = String(f.h);
      const half = (text.length * DIGIT_W) / 2 + 2;
      const r = half + 1;
      const spacing = isIndex ? 300 : 380;
      for (const path of f.paths) {
        if (placed.length >= MAX_LABELS) break;
        const pts = path.map(toPx);
        const cum = cumulative(pts);
        const total = cum[cum.length - 1];
        if (total < half * 2 + 24) continue;
        const n = Math.max(1, Math.floor(total / spacing));
        const first = (total - (n - 1) * spacing) / 2;
        for (let i = 0; i < n; i++) {
          const s0 = first + i * spacing;
          for (const off of [0, 16, -16, 32, -32]) {
            const s = s0 + off;
            if (s - half < 0 || s + half > total) continue;
            const p = pointAt(pts, cum, s);
            if (p.x < margin + half || p.x > size.x - margin - half) continue;
            if (p.y < margin + half || p.y > size.y - margin - half) continue;
            const a = pointAt(pts, cum, s - half - 2);
            const b = pointAt(pts, cum, s + half + 2);
            // 線彎得太急就唔擺，避免數字歪斜。
            const turn = angleDiff(Math.atan2(p.y - a.y, p.x - a.x), Math.atan2(b.y - p.y, b.x - p.x));
            if (turn > 0.6) continue;
            if (conflicts(p.x, p.y, r, f.h, spacing * 0.5)) continue;
            let deg = Math.atan2(b.y - a.y, b.x - a.x) * DEG;
            if (deg > 90) deg -= 180;
            else if (deg < -90) deg += 180;
            placed.push({ x: p.x, y: p.y, r, h: f.h });
            const ll = map.containerPointToLatLng(L.point(p.x, p.y));
            L.marker(ll, {
              pane: "contourLabels",
              interactive: false,
              keyboard: false,
              icon: L.divIcon({
                className: `contour-label${isIndex ? " is-index" : ""}`,
                html: `<span style="transform:translate(-50%,-50%) rotate(${deg.toFixed(1)}deg)">${text}</span>`,
                iconSize: [0, 0],
              }),
            }).addTo(labelGroup);
            break;
          }
        }
      }
    }
  }

  /* ---------- 狀態 ---------- */
  function computePhase() {
    if (!enabled) return "off";
    if (tooWide || map.getZoom() < CONTOUR_MIN_ZOOM - 1e-6) return "zoom";
    if (outside) return "outside";
    if (!need.length) return "loading";
    const states = need.map((t) => tiles.get(t.key)?.state);
    if (states.some((s) => s === "queued" || s === "loading" || !s)) return "loading";
    if (states.every((s) => s === "error")) return "error";
    if (states.some((s) => s === "error")) return "partial";
    return "ready";
  }

  function status() {
    const total = need.length;
    const loaded = need.filter((t) => settled(t.key)).length;
    return {
      enabled,
      labelsOn,
      phase: computePhase(),
      loaded,
      total,
      error: lastError,
      minZoom: CONTOUR_MIN_ZOOM,
    };
  }

  function emitStatus() {
    const s = status();
    const sig = `${s.enabled}|${s.labelsOn}|${s.phase}|${s.loaded}|${s.total}`;
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      onStatus(s);
    } catch (err) {
      console.error(err);
    }
  }

  function setAttribution(on) {
    const ctl = map.attributionControl;
    if (!ctl || on === attributionOn) return;
    if (on) ctl.addAttribution(CONTOUR_ATTRIBUTION);
    else ctl.removeAttribution(CONTOUR_ATTRIBUTION);
    attributionOn = on;
  }

  return {
    /** 開／關等高線。 */
    setEnabled(on) {
      const want = Boolean(on);
      if (want === enabled) {
        if (want) update();
        emitStatus();
        return;
      }
      enabled = want;
      if (enabled) {
        lineGroup.addTo(map);
        labelGroup.addTo(map);
        setAttribution(true);
        update();
      } else {
        clearTimeout(moveTimer);
        clearTimeout(labelTimer);
        clearTimeout(retryTimer);
        moveTimer = 0;
        labelTimer = 0;
        retryTimer = 0;
        dropQueued();
        need = [];
        display(new Set());
        labelGroup.clearLayers();
        map.removeLayer(lineGroup);
        map.removeLayer(labelGroup);
        setAttribution(false);
      }
      emitStatus();
    },
    /** 開／關高度數字。 */
    setLabels(on) {
      labelsOn = Boolean(on);
      scheduleLabels(0);
      emitStatus();
    },
    /** 按底圖換顏色（航空照片用淺色）。 */
    setBasemap(id) {
      basemap = id || "hm20c";
      for (const tile of tiles.values()) {
        tile.normal?.setStyle(lineStyle(false));
        tile.index?.setStyle(lineStyle(true));
      }
      labelPane.classList.toggle("on-hm20c", basemap === "hm20c");
      labelPane.classList.toggle("on-imagery", basemap === "imagery");
    },
    /** 高度數字要避開的位置：() => [{ lat, lng, r, dx?, dy? }]（r、dx、dy 以 px 計）。 */
    setAvoidProvider(fn) {
      avoidProvider = typeof fn === "function" ? fn : () => [];
    },
    /** 檢查點／方格數字改變後，重新擺放高度數字。 */
    refreshLabels() {
      if (enabled && labelsOn) scheduleLabels();
    },
    /** Retry failed tiles on explicit user request, without waiting 30 seconds. */
    retry() {
      for (const tile of tiles.values()) {
        if (tile.state === "error") tile.failedAt = 0;
      }
      if (enabled) update();
    },
    /** Save the current area's 20 m contours, including all required pages. */
    downloadOffline,
    /** 仲有資料或數字未處理完（列印前會等）。 */
    isBusy() {
      return enabled && Boolean(moveTimer || labelTimer || active > 0 || queue.length > 0);
    },
    status,
  };
}
