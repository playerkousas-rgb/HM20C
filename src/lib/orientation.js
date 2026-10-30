// User-provided, approximate map-image rotations. Positive is clockwise.
// These values are NOT official sheet bearings or a magnetic declination.
export const SHEET_ROTATIONS = [
  { number: 2, name: '新田', zone: 50, angle: 1.12 },
  { number: 3, name: '上水及粉嶺', zone: 50, angle: 1.10 },
  { number: 4, name: '吉澳洲', zone: 50, angle: 1.03 },
  { number: 5, name: '青山', zone: 49, angle: -1.13 },
  { number: 6, name: '元朗', zone: 50, angle: 1.13 },
  { number: 7, name: '沙田', zone: 50, angle: 1.07 },
  { number: 8, name: '西貢半島', zone: 50, angle: 1.03 },
  { number: 9, name: '東涌', zone: 49, angle: -1.12 },
  { number: 10, name: '銀礦灣', zone: 50, angle: 1.14 },
  { number: 11, name: '香港及九龍', zone: 50, angle: 1.07 },
  { number: 12, name: '清水灣', zone: 50, angle: 1.03 },
  { number: 13, name: '石壁', zone: 49, angle: -1.10 },
  { number: 14, name: '長洲', zone: 50, angle: 1.12 },
  { number: 15, name: '香港南部及南丫島', zone: 50, angle: 1.08 },
  { number: 16, name: '橫瀾島', zone: 50, angle: 1.02 },
];

export const DEFAULT_ORIENTATION = 'auto';

// Approximate WGS84 vertices of the iB20000 1–16 digital sheet index,
// rounded to seven decimal places. Sheet 1 is a paper-map legend and is
// deliberately not assigned an angle. Data: LandsD CSDI TileIndex (EPSG:4326):
// https://portal.csdi.gov.hk/server/rest/services/common/landsd_rcd_1637224132564_22637/FeatureServer/0
// It is only a centre-based convenience: printed maps may have overlaps or
// different margins, and the user's per-sheet angles have not been verified.
const INDEX_VERTICES = [
  [[113.8242233, 22.5714686], [113.9700745, 22.5717225], [114.1159272, 22.5718439], [114.2617804, 22.5718330], [114.4076330, 22.5716898]],
  [[113.8244981, 22.4631062], [113.9702356, 22.4633587], [114.1159747, 22.4634795], [114.2617142, 22.4634687], [114.4074532, 22.4633262]],
  [[113.8247712, 22.3547424], [113.9703958, 22.3549935], [114.1160219, 22.3551136], [114.2616485, 22.3551028], [114.4072744, 22.3549611]],
  [[113.8250426, 22.2463770], [113.9705549, 22.2466268], [114.1160688, 22.2467463], [114.2615831, 22.2467356], [114.4070967, 22.2465946]],
  [[113.8253124, 22.1380103], [113.9707131, 22.1382587], [114.1161153, 22.1383776], [114.2615180, 22.1383669], [114.4069201, 22.1382266]],
];

function pointInPolygon(lon, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[j];
    // Boundaries count as belonging to both sheets; the first one wins.
    const cross = (lon - x1) * (y2 - y1) - (lat - y1) * (x2 - x1);
    if (Math.abs(cross) < 1e-11 && lon >= Math.min(x1, x2) - 1e-9 && lon <= Math.max(x1, x2) + 1e-9 &&
        lat >= Math.min(y1, y2) - 1e-9 && lat <= Math.max(y1, y2) + 1e-9) return true;
    if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

export function sheetAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const number = row * 4 + column + 1;
      if (number === 1) continue;
      const polygon = [INDEX_VERTICES[row][column], INDEX_VERTICES[row][column + 1], INDEX_VERTICES[row + 1][column + 1], INDEX_VERTICES[row + 1][column]];
      if (pointInPolygon(lon, lat, polygon)) return SHEET_ROTATIONS.find((sheet) => sheet.number === number) || null;
    }
  }
  return null;
}

export function isOrientationPreference(value) {
  if (value === 'auto' || value === 'true') return true;
  return SHEET_ROTATIONS.some((sheet) => value === `sheet:${sheet.number}`);
}

export function signedAngle(angle) {
  if (!angle) return '0°';
  return `${angle > 0 ? '+' : '−'}${Math.abs(angle).toFixed(2)}°`;
}

/** Image rotation, not a bearing or magnetic-north correction. */
export function orientationForView(basemap, preference, lat, lon) {
  // The independent countryside basemap keeps its original true-north view.
  if (basemap !== 'hm20c') return { mode: 'countryside', sheet: null, angle: 0 };
  const selected = isOrientationPreference(preference) ? preference : DEFAULT_ORIENTATION;
  if (selected === 'true') return { mode: 'true', sheet: null, angle: 0 };
  if (selected === 'auto') {
    const sheet = sheetAt(lat, lon);
    return { mode: 'auto', sheet, angle: sheet?.angle || 0 };
  }
  const sheet = SHEET_ROTATIONS.find((item) => selected === `sheet:${item.number}`);
  return { mode: 'manual', sheet, angle: sheet.angle };
}
