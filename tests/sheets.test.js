// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { writeArrayBuffer } from 'geotiff';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { affineFromDirectory, project, rasterGeometry, sheetAtCenter, sheetCoverage, sheetGridBounds, sheetUrl } from '../src/sheets/geometry.js';
import { extractTiff, inspectTiff } from '../src/sheets/files.js';

// geotiff.fromBlob uses FileReader in browsers; the fixture runs in Node.
beforeAll(() => {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((result) => this.onload?.({ target: { result } }), (error) => this.onerror?.(error)); }
    abort() { this.onabort?.(); }
  };
});

async function tiffFixture({ id = 'T8', crs = 2326, extent = null, rasterType = 1 } = {}) {
  const { west, north, east, south } = extent || sheetGridBounds(id);
  const width = 80, height = 64;
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) { pixels[i] = 90; pixels[i + 1] = 150; pixels[i + 2] = 200; }
  const buffer = await writeArrayBuffer(pixels, {
    width, height, ProjectedCSTypeGeoKey: crs, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: rasterType,
    ModelPixelScale: [(east - west) / width, (north - south) / height, 0], ModelTiepoint: [0, 0, 0, west, north, 0],
  });
  return new Blob([buffer], { type: 'image/tiff' });
}

async function zipFiles(files, { level = 6 } = {}) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [name, blob] of files) await writer.add(name, new BlobReader(blob), { useWebWorkers: false, level });
  return writer.close();
}

describe('iB20000 experimental local sheets', () => {
  it('uses the correct coordinate-frame rotation convention and matches independent CSDI index control points', () => {
    const controls = [
      [[113.82422325129087, 22.571468634879416], [800000, 848000]],
      [[113.97007445850862, 22.571722458082657], [815000, 848000]],
      [[114.26171424779582, 22.463468659291582], [845000, 836000]],
      [[114.40727440886259, 22.354961091390276], [860000, 824000]],
    ];
    for (const [wgs, expected] of controls) {
      const hk = project(wgs, 4326, 2326);
      expect(Math.hypot(hk[0] - expected[0], hk[1] - expected[1])).toBeLessThan(0.01);
      const back = project(hk, 2326, 4326);
      expect(back[0]).toBeCloseTo(wgs[0], 7);
      expect(back[1]).toBeCloseTo(wgs[1], 7);
    }
  });

  it('covers all 18 digital indices without pretending paper-map boundaries are verified', () => {
    expect(sheetAtCenter(22.3835, 114.3225)).toBe('T8');
    for (let n = 1; n <= 18; n += 1) {
      const id = `T${n}`;
      const b = sheetGridBounds(id);
      const [lon, lat] = project([(b.west + b.east) / 2, (b.south + b.north) / 2], 2326, 4326);
      expect(sheetAtCenter(lat, lon)).toBe(id);
      expect(sheetUrl(id)).toContain(`sheetName=${id}&`);
    }
    expect(() => sheetUrl('T19')).toThrow();
    expect(() => sheetUrl('T8&productName=other')).toThrow();
  });

  it('inverts rotated GeoTIFF affine transforms and rejects inconsistent control points', () => {
    const matrix = [2, .2, 0, 845000, -.1, -2, 0, 836000, 0, 0, 1, 0, 0, 0, 0, 1];
    const affine = affineFromDirectory({ ModelTransformation: matrix });
    const original = [71.3, 29.8];
    const restored = affine.inverse(affine.forward(original));
    expect(restored[0]).toBeCloseTo(original[0], 8);
    expect(restored[1]).toBeCloseTo(original[1], 8);
    expect(() => affineFromDirectory({ ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, 0, 0, 1, 1, 0, 3, 5, 0] })).toThrow(/不一致/);
    expect(() => affineFromDirectory({})).toThrow(/缺少/);
  });

  it('reads synthetic HK1980 GeoTIFF, checks selected sheet and distinguishes partial coverage', async () => {
    const blob = await tiffFixture();
    const result = await inspectTiff(blob, 'T8');
    expect(result.meta.crs).toBe(2326);
    expect(result.meta.coverage).toBe(1);
    expect(result.meta.bounds.west).toBeCloseTo(114.261648, 5);
    expect(result.geometry.contains(result.meta.center.lon, result.meta.center.lat)).toBe(true);
    expect(await result.image.readRGB({ window: [2, 2, 3, 3] })).toMatchObject({ 0: 90, 1: 150, 2: 200 });
    await expect(inspectTiff(blob, 'T7')).rejects.toThrow(/範圍與所選 T7/);
    await expect(inspectTiff(blob.slice(0, blob.size - 1), 'T8')).rejects.toThrow(/圖像區塊不完整/);
    const partial = await inspectTiff(await tiffFixture({ extent: { west: 845000, east: 852500, north: 836000, south: 824000 } }), 'T8');
    expect(partial.meta.coverage).toBeGreaterThan(.4);
    expect(partial.meta.coverage).toBeLessThan(.6);
    await expect(inspectTiff(await tiffFixture({ crs: 9999 }), 'T8')).rejects.toThrow(/座標系統/);
    await expect(inspectTiff(await tiffFixture({ rasterType: 2 }), 'T8')).rejects.toThrow(/點位型/);
  });

  it('reads a single TIFF from a ZIP and rejects ambiguous or corrupt archives', async () => {
    const tif = await tiffFixture();
    const zip = await zipFiles([['T8.tif', tif], ['notes.txt', new Blob(['not a map'])]]);
    const unpacked = await extractTiff(zip);
    expect(unpacked.size).toBe(tif.size);
    expect((await inspectTiff(unpacked, 'T8')).meta.coverage).toBe(1);
    await expect(extractTiff(await zipFiles([['one.tif', tif], ['two.tif', tif]]))).rejects.toThrow(/2 個 TIFF/);
    await expect(extractTiff(new Blob(['<html>not a map</html>']))).rejects.toThrow(/不是 TIFF 或 ZIP/);
    const uncompressed = await zipFiles([['T8.tif', tif]], { level: 0 });
    const bytes = new Uint8Array(await uncompressed.arrayBuffer());
    const fileStart = 30 + bytes[26] + 256 * bytes[27] + bytes[28] + 256 * bytes[29];
    bytes[fileStart + 1100] ^= 0xff;
    await expect(extractTiff(new Blob([bytes]))).rejects.toThrow(/完整性檢查失敗/);
  });

  it('keeps the 16 px reprojection grid within a centimetre of exact HK1980 coordinates at map scale', () => {
    const geometry = rasterGeometry({ width: 15000, height: 12000, keys: { ProjectedCSTypeGeoKey: 2326 },
      directory: { ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 845000, 836000, 0] } });
    expect(sheetCoverage(geometry, 'T8').fraction).toBe(1);
    const z = 15, lon = 114.33, lat = 22.40, world = 256 * 2 ** z;
    const tileX = Math.floor((lon + 180) / 360 * 2 ** z);
    const tileY = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
    const pixel = (x, y) => geometry.toPixel([((tileX * 256 + x) / world) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY * 256 + y) / world))) * 180 / Math.PI]);
    for (const [x, y] of [[3.5, 5.5], [101.5, 142.5], [254.5, 253.5], [77.5, 80.5]]) {
      const x0 = Math.floor(x / 16) * 16, y0 = Math.floor(y / 16) * 16;
      const dx = (x - x0) / 16, dy = (y - y0) / 16;
      const [a, b, c, d] = [pixel(x0, y0), pixel(x0 + 16, y0), pixel(x0, y0 + 16), pixel(x0 + 16, y0 + 16)];
      const interpolate = (i) => (a[i] * (1 - dx) + b[i] * dx) * (1 - dy) + (c[i] * (1 - dx) + d[i] * dx) * dy;
      const exact = pixel(x, y);
      expect(Math.hypot(interpolate(0) - exact[0], interpolate(1) - exact[1])).toBeLessThan(.01);
    }
  });
});
