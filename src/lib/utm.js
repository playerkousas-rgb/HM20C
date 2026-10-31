import proj4 from 'proj4';

// Hong Kong straddles the 114°E boundary between UTM zones 49 and 50.
// These are WGS84 UTM coordinates, NOT the HK1980 government sheet grid.
export const HK_UTM_BOUNDS = { south: 22.0, north: 22.65, west: 113.75, east: 114.55 };
const projections = {
  49: '+proj=utm +zone=49 +datum=WGS84 +units=m +no_defs',
  50: '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs',
};
const columns = { 49: 'ABCDEFGH', 50: 'JKLMNPQR' };
const rows = { 49: 'ABCDEFGHJKLMNPQRSTUV', 50: 'FGHJKLMNPQRSTUVABCDE' };

export function zoneForLongitude(lon) { return lon < 114 ? 49 : 50; }
export function inHongKongGrid(point) {
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
    point.lat >= HK_UTM_BOUNDS.south && point.lat <= HK_UTM_BOUNDS.north &&
    point.lon >= HK_UTM_BOUNDS.west && point.lon <= HK_UTM_BOUNDS.east;
}
export function toUtm(point, zone = zoneForLongitude(point.lon)) {
  if (!projections[zone] || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  const [easting, northing] = proj4('WGS84', projections[zone], [point.lon, point.lat]);
  return { zone, easting, northing };
}
export function fromUtm(easting, northing, zone) {
  if (!projections[zone] || !Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  const [lon, lat] = proj4(projections[zone], 'WGS84', [easting, northing]);
  return { lat, lon };
}

// MGRS eight-figure references identify a 10 m cell. Do NOT round to the
// nearest metre first: that moves points just below a cell edge into the next
// square (including at 100 km boundaries).
export function gridReference(point) {
  if (!inHongKongGrid(point)) return null;
  const { zone, easting, northing } = toUtm(point);
  const col = Math.floor(easting / 100000) - 1;
  const row = ((Math.floor(northing / 100000) % 20) + 20) % 20;
  const square = `${columns[zone][col] || ''}${rows[zone][row] || ''}`;
  if (square.length !== 2) return null;
  const east = Math.floor((easting % 100000) / 10).toString().padStart(4, '0');
  const north = Math.floor((northing % 100000) / 10).toString().padStart(4, '0');
  return { zone, band: 'Q', square, east, north, text: `${zone}Q ${square} ${east} ${north}` };
}

// Liang–Barsky clip in lon/lat. The line itself was generated in projected
// metres before conversion: this merely clips each short segment to its UTM zone.
function clipSegment(a, b, rect) {
  const dx = b.lon - a.lon; const dy = b.lat - a.lat;
  const p = [-dx, dx, -dy, dy];
  const q = [a.lon - rect.west, rect.east - a.lon, a.lat - rect.south, rect.north - a.lat];
  let low = 0; let high = 1;
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(p[i]) < 1e-14) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) low = Math.max(low, t); else high = Math.min(high, t);
    if (low > high) return null;
  }
  return [
    { lon: a.lon + low * dx, lat: a.lat + low * dy },
    { lon: a.lon + high * dx, lat: a.lat + high * dy },
  ];
}
function clippedPaths(points, rect) {
  const paths = []; let current = [];
  for (let i = 1; i < points.length; i += 1) {
    const segment = clipSegment(points[i - 1], points[i], rect);
    if (!segment) { if (current.length > 1) paths.push(current); current = []; continue; }
    if (!current.length) current.push(segment[0]);
    current.push(segment[1]);
  }
  if (current.length > 1) paths.push(current);
  return paths;
}

/** Visible 1 km projected lines. Returns no synthetic screen-space grid. */
export function utmGridLines(bounds) {
  if (!bounds || ![bounds.south, bounds.north, bounds.west, bounds.east].every(Number.isFinite)) return [];
  const result = [];
  for (const zone of [49, 50]) {
    const rect = {
      south: Math.max(HK_UTM_BOUNDS.south, bounds.south), north: Math.min(HK_UTM_BOUNDS.north, bounds.north),
      west: Math.max(HK_UTM_BOUNDS.west, zone === 50 ? 114 : HK_UTM_BOUNDS.west, bounds.west),
      east: Math.min(HK_UTM_BOUNDS.east, zone === 49 ? 114 : HK_UTM_BOUNDS.east, bounds.east),
    };
    if (rect.south >= rect.north || rect.west >= rect.east) continue;
    // Sampling all four sides covers the rotated screen's geographic bbox.
    const projected = [];
    for (let i = 0; i <= 4; i += 1) {
      const t = i / 4;
      const lat = rect.south + (rect.north - rect.south) * t;
      const lon = rect.west + (rect.east - rect.west) * t;
      projected.push(toUtm({ lat, lon: rect.west }, zone), toUtm({ lat, lon: rect.east }, zone),
        toUtm({ lat: rect.south, lon }, zone), toUtm({ lat: rect.north, lon }, zone));
    }
    const es = projected.map((p) => p.easting); const ns = projected.map((p) => p.northing);
    const minE = Math.min(...es) - 100; const maxE = Math.max(...es) + 100;
    const minN = Math.min(...ns) - 100; const maxN = Math.max(...ns) + 100;
    // Refuse an enormous workload if a view is outside the intended locked scale.
    if (maxE - minE > 60000 || maxN - minN > 60000) continue;
    for (const axis of ['easting', 'northing']) {
      const min = axis === 'easting' ? minE : minN;
      const max = axis === 'easting' ? maxE : maxN;
      for (let value = Math.ceil(min / 1000) * 1000; value <= max; value += 1000) {
        const points = [];
        for (let i = 0; i <= 24; i += 1) {
          const t = i / 24;
          const e = axis === 'easting' ? value : minE + (maxE - minE) * t;
          const n = axis === 'northing' ? value : minN + (maxN - minN) * t;
          points.push(fromUtm(e, n, zone));
        }
        for (const path of clippedPaths(points, rect)) {
          result.push({ zone, axis, value, label: (Math.floor(value / 1000) % 100).toString().padStart(2, '0'), points: path });
        }
      }
    }
  }
  return result;
}
