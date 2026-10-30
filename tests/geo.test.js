import { describe, expect, it } from 'vitest';
import { distanceMeters, formatLatitude, formatLongitude, metersPerPixel, routeDistance, routePointCount, scaleBarForMetersPerPixel, zoomForScale } from '../src/lib/geo';

describe('geodesy and locked display scale', () => {
  it('formats coordinates with the correct hemisphere', () => {
    expect(formatLatitude(22.3835, 5)).toBe('22.38350° N');
    expect(formatLongitude(114.3225, 5)).toBe('114.32250° E');
    expect(formatLatitude(-22.3835)).toBe('22.3835° S');
    expect(formatLongitude(-114.3225)).toBe('114.3225° W');
  });

  it('measures great-circle distances in metres', () => {
    expect(distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111195, -1);
    expect(distanceMeters({ lat: 22, lon: 114 }, { lat: 22, lon: 114 })).toBe(0);
  });

  it('never adds distance across separate GPX segments', () => {
    const a = { lat: 22.3, lon: 114.1 }, b = { lat: 22.301, lon: 114.1 };
    const c = { lat: 22.4, lon: 114.3 }, d = { lat: 22.401, lon: 114.3 };
    const route = { segments: [{ points: [a, b] }, { points: [c, d] }], waypoints: [] };
    expect(routeDistance(route)).toBeCloseTo(distanceMeters(a, b) + distanceMeters(c, d), 6);
    expect(routePointCount(route)).toBe(4);
  });

  it('chooses a correctly labelled scale bar even on highly dense displays', () => {
    for (const mpp of [20 / 12, 20 / 4, 25 / 2.5]) {
      const bar = scaleBarForMetersPerPixel(mpp);
      expect(bar.pixels).toBeLessThanOrEqual(110);
      expect(bar.pixels * mpp).toBeCloseTo(bar.meters, 8);
    }
  });

  it('maintains the requested metres-per-physical-pixel at map centre', () => {
    for (const latitude of [22.15, 22.4, 22.58]) {
      for (const denominator of [20000, 25000]) {
        const pxPerMm = 4;
        const zoom = zoomForScale(latitude, denominator, pxPerMm);
        expect(metersPerPixel(latitude, zoom)).toBeCloseTo(denominator / (1000 * pxPerMm), 9);
      }
    }
  });
});
