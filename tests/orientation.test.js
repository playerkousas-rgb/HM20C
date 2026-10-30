import { describe, expect, it } from 'vitest';
import { isOrientationPreference, orientationForView, SHEET_ROTATIONS, sheetAt, signedAngle } from '../src/lib/orientation';

describe('approximate sheet orientation', () => {
  const centres = [
    [2, 22.50, 114.03, 1.12], [3, 22.50, 114.19, 1.10], [4, 22.50, 114.33, 1.03],
    [5, 22.40, 113.89, -1.13], [6, 22.40, 114.04, 1.13], [7, 22.40, 114.19, 1.07], [8, 22.40, 114.33, 1.03],
    [9, 22.30, 113.89, -1.12], [10, 22.30, 114.04, 1.14], [11, 22.30, 114.19, 1.07], [12, 22.30, 114.33, 1.03],
    [13, 22.19, 113.89, -1.10], [14, 22.19, 114.04, 1.12], [15, 22.19, 114.19, 1.08], [16, 22.19, 114.33, 1.02],
  ];

  it('maps all 15 supplied estimates to the corresponding digital sheet centres', () => {
    expect(SHEET_ROTATIONS).toHaveLength(15);
    for (const [number, lat, lon, angle] of centres) {
      expect(sheetAt(lat, lon)?.number).toBe(number);
      expect(orientationForView('hm20c', 'auto', lat, lon)).toMatchObject({ mode: 'auto', sheet: { number }, angle });
    }
  });

  it('uses the actual slightly tilted index rather than the 114° UTM boundary', () => {
    expect(sheetAt(22.4, 113.9702)?.number).toBe(5);
    expect(sheetAt(22.4, 113.97045)?.number).toBe(6);
    expect(sheetAt(22.4, 114.0001)?.number).toBe(6);
    expect(sheetAt(22.50, 113.89)).toBeNull(); // physical sheet 1 is the legend
    expect(sheetAt(22.42, 114.52)).toBeNull(); // digital sheet 18 has no supplied estimate
    expect(sheetAt(0, 0)).toBeNull();
    expect(sheetAt(NaN, 114)).toBeNull();
    expect(orientationForView('hm20c', 'auto', 0, 0)).toMatchObject({ sheet: null, angle: 0 });
  });

  it('supports a fixed manual sheet, true north, and an independent countryside view', () => {
    expect(orientationForView('hm20c', 'sheet:9', 22.40, 114.33)).toMatchObject({ mode: 'manual', sheet: { number: 9 }, angle: -1.12 });
    expect(orientationForView('hm20c', 'true', 22.40, 114.33).angle).toBe(0);
    expect(orientationForView('countryside', 'sheet:9', 22.40, 114.33).angle).toBe(0);
    expect(isOrientationPreference('sheet:1')).toBe(false);
    expect(isOrientationPreference('sheet:99')).toBe(false);
    expect(orientationForView('hm20c', 'bad', 22.40, 114.33).angle).toBe(1.03);
    expect(signedAngle(1.1)).toBe('+1.10°');
    expect(signedAngle(-1.1)).toBe('−1.10°');
    expect(signedAngle(0)).toBe('0°');
  });
});
