import { describe, expect, it } from 'vitest';
import { magvar } from 'magvar';
import { bearingAnswers, formatBearing, magneticDeclination } from '../src/lib/bearing';
import { fromUtm, gridLineLabel, gridReference, parseGridReference, toUtm, utmGridLines } from '../src/lib/utm';
import { extendToViewport } from '../src/map/bearingLayer';

describe('WGS84 UTM teaching grid', () => {
  it('formats both Hong Kong zones as eight figures', () => {
    expect(gridReference({ lat: 22.3835, lon: 114.3225 }).text).toBe('50Q KK 2430 7773');
    expect(gridReference({ lat: 22.25, lon: 113.93 }).text).toBe('49Q HE 0199 6342');
    expect(gridReference({ lat: 22.3835, lon: 113.999999 }).zone).toBe(49);
    expect(gridReference({ lat: 22.3835, lon: 114 }).zone).toBe(50);
    expect(gridReference({ lat: 10, lon: 114 })).toBeNull();
  });
  it('decodes a full eight-figure grid reference as the centre of the correct cell', () => {
    const point = parseGridReference('50Q KK 2430 7773');
    expect(point.text).toBe('50Q KK 2430 7773');
    const utm = toUtm(point, 50);
    expect(utm.easting).toBeCloseTo(224305, 3);
    expect(utm.northing).toBeCloseTo(2477735, 3);
    expect(gridReference(point).text).toBe(point.text);
    expect(parseGridReference('49Q HE 0199 6342').zone).toBe(49);
    expect(parseGridReference('50Q HE 0199 6342')).toBeNull();
    const north = gridReference({ lat: 22.64, lon: 114.3 });
    expect(north.square).toBe('KL');
    expect(parseGridReference(north.text).text).toBe(north.text);
    const northWest = gridReference({ lat: 22.64, lon: 113.85 });
    expect(northWest.square).toBe('GF');
    expect(parseGridReference(northWest.text).text).toBe(northWest.text);
    // Lands Department control point: south-west corner of the example cell.
    const corner = fromUtm(224300, 2477730, 50);
    expect(corner.lat).toBeCloseTo(22.383496510, 8);
    expect(corner.lon).toBeCloseTo(114.322464053, 8);
    expect(parseGridReference('KK 2430 7773')).toBeNull();
    expect(parseGridReference('50Q KK 243 777')).toBeNull();
  });
  it('truncates 10 m cells and 100 km letters without prematurely rounding metres', () => {
    const before = gridReference(fromUtm(199999.8, 2477739.8, 50));
    const after = gridReference(fromUtm(200000.2, 2477740.2, 50));
    expect(before.text).toBe('50Q JK 9999 7773');
    expect(after.text).toBe('50Q KK 0000 7774');
  });
  it('labels 100 km boundaries on their positive side without floating-point square errors', () => {
    const eastBoundary = fromUtm(200000, 2477730, 50);
    expect(gridLineLabel({ zone: 50, axis: 'easting', value: 200000, label: '00' }, eastBoundary)).toBe('50Q KK · X 00');
    const northBoundary = fromUtm(224300, 2500000, 50);
    expect(gridLineLabel({ zone: 50, axis: 'northing', value: 2500000, label: '00' }, northBoundary)).toBe('50Q KL · Y 00');
  });
  it('projects kilometre lines separately and clips them at 114°', () => {
    const lines = utmGridLines({ south: 22.37, north: 22.40, west: 113.97, east: 114.03 });
    expect(lines.some((line) => line.zone === 49)).toBe(true);
    expect(lines.some((line) => line.zone === 50)).toBe(true);
    expect(lines.some((line) => line.axis === 'easting')).toBe(true);
    expect(lines.some((line) => line.axis === 'northing')).toBe(true);
    for (const line of lines) {
      expect(line.value % 1000).toBe(0);
      for (const point of line.points) {
        expect(point.lon).toBeGreaterThanOrEqual(113.97 - 1e-8);
        expect(point.lon).toBeLessThanOrEqual(114.03 + 1e-8);
        if (line.zone === 49) expect(point.lon).toBeLessThanOrEqual(114 + 1e-8);
        else expect(point.lon).toBeGreaterThanOrEqual(114 - 1e-8);
        expect(Math.abs(toUtm(point, line.zone)[line.axis] - line.value)).toBeLessThan(0.1);
      }
    }
  });
});

describe('two-point teaching bearings', () => {
  it('uses one UTM zone for both points, and separates magnetic from true north', () => {
    const a = fromUtm(224000, 2477000, 50);
    const b = fromUtm(225000, 2478000, 50);
    const values = bearingAnswers(a, b, new Date('2026-10-31T00:00:00Z'));
    expect(values.forwardGrid).toBeCloseTo(45, 5);
    expect(values.backGrid).toBeCloseTo(225, 5);
    expect(values.forwardTrue).not.toBeCloseTo(values.forwardGrid, 1);
    expect(values.declinationA).toBeCloseTo(-3.34, 1);
    expect(values.forwardMagnetic).toBeCloseTo((values.forwardTrue - values.declinationA + 360) % 360, 8);
    expect(values.backMagnetic).toBeCloseTo((values.backTrue - values.declinationB + 360) % 360, 8);
    expect(formatBearing(359.99)).toBe('0.0°');
    expect(formatBearing(null)).toBe('—');
  });
  it('does not mix false eastings across 114° and suppresses short or expired answers', () => {
    const a = { lat: 22.4, lon: 113.999 };
    const b = { lat: 22.4, lon: 114.001 };
    const value = bearingAnswers(a, b, new Date('2026-01-01T00:00:00Z'));
    expect(value.crossesZone).toBe(true);
    expect(value.zone).toBe(49);
    expect(value.forwardGrid).toBeGreaterThan(80);
    expect(value.forwardGrid).toBeLessThan(100);
    expect(bearingAnswers(a, a)).toBeNull();
    expect(magneticDeclination(a, new Date('2030-01-01T00:00:00Z'))).toBeNull();
    expect(magneticDeclination(a, new Date('2029-12-31T00:00:00Z'))).not.toBeNull();
    expect(magneticDeclination(a, new Date('2024-12-31T00:00:00Z'))).toBeNull();
  });
  it('matches a published WMM2025 reference value', () => {
    // NOAA/NCEI WMM2025 published test case: 2025.0, 80°N, 0°E, sea level.
    expect(magvar(80, 0, 0, new Date('2025-01-01T00:00:00Z'))).toBeCloseTo(1.28, 2);
    // Independently cross-checked with geomagnetism 0.2.0 / WMM2025.
    expect(magneticDeclination({ lat: 22.3835, lon: 114.3225 }, new Date('2026-10-31T00:00:00Z'))).toBeCloseTo(-3.34, 2);
  });
  it('extends an infinite line precisely to both sides of the viewport', () => {
    const [a, b] = extendToViewport({ x: 100, y: 150 }, { x: 200, y: 200 }, 400, 300);
    expect(a.x).toBeCloseTo(0); expect(a.y).toBeCloseTo(100);
    expect(b.x).toBeCloseTo(400); expect(b.y).toBeCloseTo(300);
    expect(extendToViewport({ x: 2, y: 2 }, { x: 2, y: 2 }, 400, 300)).toBeNull();
  });
});
