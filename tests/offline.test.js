import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSavedAreas, freshRequestUrl, loadSavedAreas, MAX_AREA_TILES, planOfflineArea, recordSavedArea } from '../src/lib/offline';

const snapshot = {
  basemap: 'hm20c', zoom: 15.1,
  center: { lat: 22.3835, lon: 114.3225 },
  bounds: { south: 22.37, north: 22.39, west: 114.31, east: 114.33 },
  // Deliberately rotation-aware rather than derived only from bounds.
  tileRange: { zoom: 15, minX: 26789, maxX: 26790, minY: 14290, maxY: 14292 },
};

describe('offline viewport planning', () => {
  beforeEach(() => localStorage.clear());

  it('includes the rotated tile range and a bounded margin for both government layers', () => {
    const plan = planOfflineArea(snapshot);
    expect(plan.zoom).toBe(15);
    expect(plan.tiles).toHaveLength(40); // (2+2) × (3+2) × two layers
    expect(plan.tiles.filter((tile) => tile.includes('/basemap/'))).toHaveLength(20);
    expect(plan.tiles.filter((tile) => tile.includes('/label/hk/tc/'))).toHaveLength(20);
    expect(plan.tiles).toContain('https://mapapi.hkmapservice.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/15/26788/14289.png');
    expect(plan.coverageBounds.west).toBeLessThan(snapshot.bounds.east);
    expect(plan.coverageBounds.east).toBeGreaterThan(plan.coverageBounds.west);
  });

  it('drops the margin when needed and never exceeds the limit', () => {
    const range = { zoom: 15, minX: 26780, maxX: 26787, minY: 14290, maxY: 14294 };
    const plan = planOfflineArea({ ...snapshot, tileRange: range });
    expect(plan.tiles).toHaveLength(MAX_AREA_TILES);
    expect(() => planOfflineArea({ ...snapshot, tileRange: { ...range, maxY: range.maxY + 1 } })).toThrow(/最多/);
  });

  it('keeps the countryside source independent and uses Leaflet subdomains', () => {
    const plan = planOfflineArea({ ...snapshot, basemap: 'countryside' });
    expect(plan.tiles).toHaveLength(20);
    expect(plan.tiles.every((tile) => /^https:\/\/[abc]\.tile\.opentopomap\.org\//.test(tile))).toBe(true);
    expect(plan.tiles).toContain('https://b.tile.opentopomap.org/15/26788/14289.png'); // (26788+14289)%3=1
  });

  it('rejects invalid views and distinguishes fresh downloads from ordinary reloads', () => {
    expect(() => planOfflineArea({ ...snapshot, bounds: { ...snapshot.bounds, south: 23 } })).toThrow();
    expect(() => planOfflineArea({ ...snapshot, tileRange: { ...snapshot.tileRange, minX: 9, maxX: 3 } })).toThrow();
    const url = new URL(freshRequestUrl('https://example.com/map?x=1'));
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('__scout_fresh')).toBe('1');
  });

  it('saves only valid, deduplicated area records and clears all map caches', async () => {
    const plan = planOfflineArea(snapshot);
    expect(recordSavedArea(plan)).toHaveLength(1);
    expect(recordSavedArea(plan)).toHaveLength(1);
    expect(loadSavedAreas()[0].tileCount).toBe(40);
    localStorage.setItem('scout-trail-map.offline-areas.v1', JSON.stringify([{ ...loadSavedAreas()[0], center: { lat: 999, lon: 1 } }]));
    expect(loadSavedAreas()).toEqual([]);
    const removed = [];
    vi.stubGlobal('caches', {
      keys: async () => ['scout-offline-map-tiles-v1', 'scout-offline-contours-v1', 'scout-offline-contours-pending-old', 'scout-offline-app-123'],
      delete: async (name) => { removed.push(name); return true; },
    });
    await clearSavedAreas();
    expect(removed.sort()).toEqual(['scout-offline-contours-pending-old', 'scout-offline-contours-v1', 'scout-offline-map-tiles-v1'].sort());
    vi.unstubAllGlobals();
  });
});
