import proj4 from 'proj4';

// EPSG:1825 publishes rotations in the *coordinate-frame* convention. proj4js
// interprets +towgs84 rotations as position-vector, so their signs MUST be
// reversed. The tempting epsg.io .proj4 string uses the published signs and
// produces ~17 m east / ~52 m north of error with proj4js. Regression tests
// compare this definition with independent CSDI TileIndex control points.
export const HK1980 = '+proj=tmerc +lat_0=22.3121333333333 +lon_0=114.178555555556 +k=1 +x_0=836694.05 +y_0=819069.8 +ellps=intl +towgs84=-162.619,-276.959,-161.764,0.067753,-2.243648,-1.158828,-1.094246 +units=m +no_defs';
const CRS = { 2326: HK1980, 4326: 'EPSG:4326', 3857: 'EPSG:3857' };
const converters = new Map();

export function project(point, from, to) {
  if (!CRS[from] || !CRS[to]) throw new Error('不支援此座標系統。');
  if (from === to) return [...point];
  const key = `${from}:${to}`;
  if (!converters.has(key)) converters.set(key, proj4(CRS[from], CRS[to]));
  const result = converters.get(key).forward(point);
  if (!result.every(Number.isFinite)) throw new Error('地圖座標無效。');
  return result;
}

export function isSheetId(id) {
  return typeof id === 'string' && /^T(?:[1-9]|1[0-8])$/.test(id);
}

// LandsD CSDI iB20000 TileIndex. These are DIGITAL sheet extents in EPSG:2326,
// not a claim that the paper HM20C boundaries or contents are identical.
export function sheetGridBounds(id) {
  if (!isSheetId(id)) throw new Error('請選擇有效的數碼圖幅。');
  const n = Number(id.slice(1));
  const row = n <= 16 ? Math.floor((n - 1) / 4) : n - 17;
  const col = n <= 16 ? (n - 1) % 4 : 4;
  const west = 800000 + col * 15000;
  const south = 836000 - row * 12000;
  return { west, south, east: west + 15000, north: south + 12000 };
}

export function sheetAtCenter(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 21.5 || lat > 23 || lon < 113 || lon > 115) return null;
  try {
    const [x, y] = project([lon, lat], 4326, 2326);
    const col = Math.floor((x - 800000) / 15000);
    const row = Math.floor((848000 - y) / 12000);
    if (col < 0 || col > 4 || row < 0 || row > 3 || (col === 4 && row > 1)) return null;
    return `T${col === 4 ? 17 + row : row * 4 + col + 1}`;
  } catch { return null; }
}

export function sheetUrl(id, productPage = false) {
  if (!isSheetId(id)) throw new Error('請選擇有效的數碼圖幅。');
  const params = new URLSearchParams({ productName: 'iB20000', sheetName: id, productFormat: 'TIFF' });
  if (productPage) params.set('locale', 'zh_hk');
  return `https://open.hkmapservice.gov.hk/OpenData/${productPage ? 'productView' : 'directDownload'}?${params}`;
}

/** Pixel (column,row) <-> image CRS, including a rotated affine transform. */
export function affineFromDirectory(directory) {
  const matrix = directory.ModelTransformation;
  let a, b, c, d, e, f;
  if (matrix?.length === 16) {
    // Projective/3D transforms cannot safely be represented by this viewer.
    if (Math.abs(matrix[12]) > 1e-12 || Math.abs(matrix[13]) > 1e-12 || Math.abs(matrix[15] - 1) > 1e-12) {
      throw new Error('此 GeoTIFF 使用了未支援的地理轉換。');
    }
    [a, b, c, d, e, f] = [matrix[0], matrix[1], matrix[3], matrix[4], matrix[5], matrix[7]];
  } else {
    const scale = directory.ModelPixelScale, tie = directory.ModelTiepoint;
    if (!scale || scale.length < 2 || !tie || tie.length < 6) throw new Error('檔案缺少 GeoTIFF 地理參考；不能安全顯示。');
    a = scale[0]; b = 0; d = 0; e = -scale[1];
    c = tie[3] - a * tie[0]; f = tie[4] - e * tie[1];
    // Multiple control points must agree with the single scale; do not guess a
    // transformation for an image with incompatible ground-control points.
    for (let i = 6; i + 5 < tie.length; i += 6) {
      if (Math.abs(a * tie[i] + c - tie[i + 3]) > 0.01 || Math.abs(e * tie[i + 1] + f - tie[i + 4]) > 0.01) {
        throw new Error('檔案的地理參考點不一致，暫未支援。');
      }
    }
  }
  if (![a, b, c, d, e, f].every(Number.isFinite) || Math.abs(a * e - b * d) < 1e-18) throw new Error('檔案的地理參考無效。');
  const determinant = a * e - b * d;
  return {
    forward: ([x, y]) => [a * x + b * y + c, d * x + e * y + f],
    inverse: ([x, y]) => [(e * (x - c) - b * (y - f)) / determinant, (-d * (x - c) + a * (y - f)) / determinant],
  };
}

export function crsFromGeoKeys(keys) {
  if (keys?.GTRasterTypeGeoKey && keys.GTRasterTypeGeoKey !== 1) throw new Error('點位型 GeoTIFF 暫未支援，請選用像素面積型圖幅。');
  const projected = Number(keys?.ProjectedCSTypeGeoKey);
  const geographic = Number(keys?.GeographicTypeGeoKey);
  const code = projected || geographic;
  if (![2326, 3857, 4326].includes(code)) throw new Error('檔案沒有受支援的座標系統；目前支援 HK1980 (EPSG:2326)、WGS84 或 Web Mercator。');
  return code;
}

export function rasterGeometry({ width, height, directory, keys }) {
  const crs = crsFromGeoKeys(keys);
  const affine = affineFromDirectory(directory);
  const toPixel = (point, from = 4326) => affine.inverse(project(point, from, crs));
  const toCrs = (pixel, to = 4326) => project(affine.forward(pixel), crs, to);
  const contains = (lon, lat) => {
    // A user may pan far outside the projection's valid area; that is simply
    // outside this sheet, not an exception that should break the map UI.
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < 113 || lon > 115 || lat < 21.5 || lat > 23) return false;
    try {
      const [x, y] = toPixel([lon, lat]);
      return x >= 0 && x < width && y >= 0 && y < height;
    } catch { return false; }
  };
  // Transform the perimeter, not only the corners, to conservatively bound a
  // slightly curved reprojected edge. This limits rendering work off-image.
  const perimeter = [];
  for (let i = 0; i <= 8; i += 1) {
    const t = i / 8;
    perimeter.push(toCrs([width * t, 0]), toCrs([width * t, height]), toCrs([0, height * t]), toCrs([width, height * t]));
  }
  const lons = perimeter.map((p) => p[0]), lats = perimeter.map((p) => p[1]);
  const bounds = { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
  if (!(bounds.west >= 113 && bounds.east <= 115 && bounds.south >= 21.5 && bounds.north <= 23)) {
    throw new Error('地圖範圍不在香港附近，請確認所選檔案。');
  }
  return { width, height, crs, affine, toPixel, toCrs, contains, bounds };
}

// Approximate geometric coverage of the advertised DIGITAL sheet index. This
// cannot establish that the pixels contain valid map data or contour lines.
export function sheetCoverage(geometry, id) {
  const grid = sheetGridBounds(id);
  const count = 15;
  let inside = 0;
  for (let y = 0; y < count; y += 1) for (let x = 0; x < count; x += 1) {
    const p = [grid.west + (grid.east - grid.west) * (x + 0.5) / count, grid.south + (grid.north - grid.south) * (y + 0.5) / count];
    const [px, py] = geometry.toPixel(p, 2326);
    if (px >= 0 && px < geometry.width && py >= 0 && py < geometry.height) inside += 1;
  }
  const coverage = inside / (count * count);
  if (coverage === 0) throw new Error(`檔案範圍與所選 ${id} 數碼圖幅不符；請核對圖幅號碼。`);
  const intendedCenter = project([(grid.west + grid.east) / 2, (grid.south + grid.north) / 2], 2326, 4326);
  const center = geometry.contains(...intendedCenter) ? intendedCenter : geometry.toCrs([geometry.width / 2, geometry.height / 2]);
  return { fraction: coverage, center: { lon: center[0], lat: center[1] } };
}
