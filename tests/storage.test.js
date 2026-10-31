import { beforeEach, describe, expect, it } from 'vitest';
import { emptyRoute } from '../src/lib/gpx';
import { loadPreferences, loadResection, loadRoute, savePreferences, saveResection, saveRoute } from '../src/lib/storage';

describe('local storage', () => {
  beforeEach(() => localStorage.clear());
  it('persists route and independent map settings', () => {
    const route = { ...emptyRoute(), name: '遠足', segments: [{ kind: 'draw', points: [{ lat: 22.4, lon: 114.1 }] }] };
    expect(saveRoute(route)).toBe(true);
    expect(loadRoute()).toEqual(route);
    savePreferences({ basemap: 'countryside', pixelsPerMm: 4, orientation: 'sheet:9' });
    expect(loadPreferences()).toEqual({ basemap: 'countryside', pixelsPerMm: 4, orientation: 'sheet:9', gridVisible: true });
    savePreferences({ basemap: 'countryside', pixelsPerMm: 4, orientation: 'sheet:9', gridVisible: false });
    expect(loadPreferences().gridVisible).toBe(false);
  });
  it('retains only valid resection landmarks and user-entered directions', () => {
    const lines = [{ lat: 22.4, lon: 114.1, name: '山', angle: 275.5, set: true }];
    expect(saveResection(lines)).toBe(true); expect(loadResection()).toEqual(lines);
    for (const invalid of [[{ ...lines[0], lat: 0 }], [{ ...lines[0], angle: 360 }], [{ ...lines[0], set: 'true' }], [...lines, ...lines, ...lines, ...lines]]) {
      localStorage.setItem('scout-trail-map.resection.v1', JSON.stringify(invalid));
      expect(loadResection()).toEqual([]);
    }
  });
  it('rejects damaged or unsafe stored coordinates', () => {
    localStorage.setItem('scout-trail-map.route.v1', '{broken');
    expect(loadRoute()).toEqual(emptyRoute());
    localStorage.setItem('scout-trail-map.route.v1', JSON.stringify({ name: 'bad', segments: [{ points: [{ lat: 100, lon: 114 }] }], waypoints: [] }));
    expect(loadRoute()).toEqual(emptyRoute());
    localStorage.setItem('scout-trail-map.prefs.v1', JSON.stringify({ basemap: 'other', pixelsPerMm: 100, orientation: 'sheet:99' }));
    expect(loadPreferences()).toEqual({ basemap: 'hm20c', pixelsPerMm: null, orientation: 'auto', gridVisible: true });
    // Old saved preferences migrate to the new default without discarding calibration.
    localStorage.setItem('scout-trail-map.prefs.v1', JSON.stringify({ basemap: 'hm20c', pixelsPerMm: 4 }));
    expect(loadPreferences()).toEqual({ basemap: 'hm20c', pixelsPerMm: 4, orientation: 'auto', gridVisible: true });
  });
});
