import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { extendRayToViewport } from '../src/map/resectionLayer';
import { routeMarkers } from '../src/lib/routeMarkers';
import { gridAngleBetween, gridToMagnetic, magneticToGrid, pointAlongGrid } from '../src/lib/resection';
import { bearingAnswers } from '../src/lib/bearing';
import { fromUtm } from '../src/lib/utm';
import { decodeExercise, exerciseUrl, loadExercise, saveExercise, validateExercise } from '../src/lib/exercise';

const p = (lat, lon) => ({ lat, lon });
const a = p(22.38, 114.32), b = p(22.381, 114.321), c = p(22.382, 114.322), d = p(22.383, 114.323);

describe('route labels across stored strokes', () => {
  it('uses one start, numbered joins and one end while preserving separate GPX segments', () => {
    const result = routeMarkers({ segments: [{ points: [a, b] }, { points: [b, c] }, { points: [c, d] }] });
    expect(result.map((marker) => marker.label)).toEqual(['起', '1', '2', '終']);
    expect(result.map((marker) => marker.point)).toEqual([a, b, c, d]);
    expect(routeMarkers({ segments: [{ points: [a, b] }, { points: [c, d] }] }).map((marker) => marker.label)).toEqual(['起', '終', '起', '終']);
    expect(routeMarkers({ segments: [{ points: [a, b] }, { points: [b, c] }] }).map((marker) => marker.label)).toEqual(['起', '1', '終']);
    expect(routeMarkers({ segments: [{ points: [a, b] }] }).map((marker) => marker.label)).toEqual(['起', '終']);
    expect(routeMarkers({ segments: [{ points: [a] }] }).map((marker) => marker.label)).toEqual(['起']);
    expect(routeMarkers({ segments: [{ points: [a, b, a] }] }).map((marker) => marker.label)).toEqual(['起終']);
  });
});

describe('resection grid and magnetic bearings', () => {
  it('preserves bearings in each UTM zone, including across the zone boundary', () => {
    for (const origin of [{ lat: 22.4, lon: 113.999 }, { lat: 22.3835, lon: 114.3225 }]) {
      for (const angle of [0, 37, 90, 180, 270, 359.9]) {
        const point = pointAlongGrid(origin, angle, 1500);
        expect(Math.abs(((gridAngleBetween(origin, point) - angle + 540) % 360) - 180)).toBeLessThan(1e-6);
      }
      expect(gridAngleBetween(origin, origin)).toBeNull();
    }
    const origin = fromUtm(224000, 2477000, 50), target = fromUtm(225000, 2478000, 50);
    expect(gridAngleBetween(origin, target)).toBeCloseTo(45, 6);
  });
  it('distinguishes WMM magnetic from grid north, and does not extrapolate after 2029', () => {
    const origin = { lat: 22.3835, lon: 114.3225 }, date = new Date('2026-10-31T00:00:00Z');
    for (const angle of [0, 45, 125, 270, 359]) {
      const target = pointAlongGrid(origin, angle);
      const independent = bearingAnswers(origin, target, date);
      const magnetic = gridToMagnetic(origin, angle, date);
      expect(magnetic).toBeCloseTo(independent.forwardMagnetic, 6);
      expect(Math.abs(((magneticToGrid(origin, magnetic, date) - angle + 540) % 360) - 180)).toBeLessThan(1e-5);
    }
    expect(gridToMagnetic(origin, 45, new Date('2030-01-01T00:00:00Z'))).toBeNull();
    expect(magneticToGrid(origin, 45, new Date('2030-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('resection ray clipping', () => {
  it('draws only in the selected back-bearing direction, even after panning the landmark off screen', () => {
    let ray = extendRayToViewport({ x: 100, y: 100 }, { x: 200, y: 100 }, 400, 300);
    expect(ray[0].x).toBeCloseTo(100); expect(ray[1].x).toBeCloseTo(400);
    ray = extendRayToViewport({ x: -50, y: 100 }, { x: 50, y: 100 }, 400, 300);
    expect(ray[0].x).toBeCloseTo(0); expect(ray[1].x).toBeCloseTo(400);
    expect(extendRayToViewport({ x: -50, y: 100 }, { x: -150, y: 100 }, 400, 300)).toBeNull();
    expect(extendRayToViewport({ x: 100, y: 100 }, { x: 100, y: 100 }, 400, 300)).toBeNull();
  });
});

describe('offline QR exercise format', () => {
  const example = { kind: 'resection', title: '三角網測練習', description: '從同一位置量度後視', points: [
    { ...a, name: '大帽山' }, { ...b, name: '高樓' }, { ...c, name: '碼頭' },
  ] };
  it('round-trips named points without passwords, directions, network or mutating a route', () => {
    const url = exerciseUrl(example, 'https://example.com/?secret=discard#other');
    expect(url).toMatch(/^https:\/\/example.com\/#exercise=/);
    expect(url).not.toContain('secret');
    const restored = decodeExercise(url);
    expect(restored).toEqual(example);
    expect(JSON.stringify(restored)).not.toMatch(/password|angle|answer/i);
    expect(saveExercise(restored)).toBe(true); expect(loadExercise()).toEqual(restored);
    expect(saveExercise(null)).toBe(true); expect(loadExercise()).toBeNull();
  });
  it('actually decodes the generated QR image, including Unicode labels', async () => {
    const url = exerciseUrl(example, 'https://hm20c.vercel.app/');
    const pngBuffer = await QRCode.toBuffer(url, { width: 400, margin: 4, errorCorrectionLevel: 'M' });
    const png = PNG.sync.read(pngBuffer);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded).not.toBeNull(); expect(decodeExercise(decoded.data)).toEqual(example);
  });
  it('rejects invalid QR content, malformed fields and unsafe coordinates before changing state', () => {
    expect(() => decodeExercise('https://not-a-task.example/')).toThrow();
    expect(() => decodeExercise('javascript:alert(1)#exercise=abc')).toThrow();
    expect(() => decodeExercise('https://example.com/#exercise=' + 'x'.repeat(1400))).toThrow();
    expect(() => validateExercise({ ...example, kind: 'resection', points: [example.points[0]] })).toThrow();
    expect(() => validateExercise({ ...example, kind: '__proto__' })).toThrow();
    expect(() => validateExercise({ ...example, points: [example.points[0], example.points[0], example.points[2]] })).toThrow(/10 米/);
    expect(() => validateExercise({ ...example, points: [{ ...example.points[0], lat: NaN }, ...example.points.slice(1)] })).toThrow();
    expect(() => validateExercise({ ...example, title: 'x'.repeat(29) })).toThrow();
    expect(() => validateExercise({ ...example, points: [{ ...example.points[0], name: 'x'.repeat(13) }, ...example.points.slice(1)] })).toThrow();
    expect(() => validateExercise({ ...example, points: [{ ...example.points[0], lon: 0 }, ...example.points.slice(1)] })).toThrow();
  });
});
