import { describe, expect, it, vi } from 'vitest';
import { snapHikingStroke, strokeAnchors } from '../src/lib/hiking';

const line = [{ lat: 22.3835, lon: 114.3225 }, { lat: 22.384, lon: 114.3235 }, { lat: 22.3845, lon: 114.3232 }];
function response(geometry, status = 200, length = null) {
  return { ok: status === 200, status, headers: { get: () => length }, text: async () => JSON.stringify(geometry) };
}
function fromUrl(url) {
  return new URL(url).searchParams.get('lonlats').split('|').map((pair) => pair.split(',').map(Number));
}
function feature(coords) { return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }] }; }

describe('hiking magnet', () => {
  it('preserves bends and appends returned network geometry instead of raw straight points', async () => {
    const fetcher = vi.fn(async (url) => {
      const anchors = fromUrl(url); const middle = [(anchors[0][0] + anchors[1][0]) / 2 + 0.0002, (anchors[0][1] + anchors[1][1]) / 2];
      return response(feature([anchors[0], middle, ...anchors.slice(1)]));
    });
    const output = await snapHikingStroke(line, { fetcher });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('profile')).toBe('hiking-mountain');
    expect(output.length).toBeGreaterThan(2);
    expect(output[1].lon).not.toBe(line[1].lon);
    expect(strokeAnchors(line).length).toBeGreaterThan(2);
  });
  it('does not invent straight-chord via points between a previous endpoint and the next stroke', () => {
    const start = { lat: 22.36, lon: 114.30 };
    const anchors = strokeAnchors(line, start);
    expect(anchors[0]).toEqual(start);
    expect(anchors[1]).toEqual(line[0]);
  });
  it('never falls back to a straight line on network, service, or invalid geometry failure', async () => {
    await expect(snapHikingStroke(line, { fetcher: async () => { throw new TypeError('offline'); } })).rejects.toThrow('未能連接 BRouter');
    await expect(snapHikingStroke(line, { fetcher: async () => response({}, 503) })).rejects.toThrow('503');
    await expect(snapHikingStroke(line, { fetcher: async () => response({}) })).rejects.toThrow('有效山徑');
    await expect(snapHikingStroke(line, { fetcher: async () => response(feature([[114, 22.2], [114.01, 22.21]])) })).rejects.toThrow('150 米');
    await expect(snapHikingStroke(line, { fetcher: async () => response(feature([[114.3225, 22.3835], [114.3232, 22.3845]]), 200, '6000000') })).rejects.toThrow('過大');
  });
  it('rejects a prior endpoint too far from the snapped network rather than inventing a connector', async () => {
    const start = { lat: 22.3834, lon: 114.3224 };
    const fetcher = async (url) => {
      const coords = fromUrl(url); coords[0] = [coords[0][0] + 0.0002, coords[0][1]];
      return response(feature(coords));
    };
    await expect(snapHikingStroke(line, { start, fetcher })).rejects.toThrow('現有路線終點');
  });
  it('requests long strokes in chunks atomically and rejects if any chunk fails', async () => {
    const raw = Array.from({ length: 15 }, (_, i) => ({ lat: 22.38 + i * 0.0008, lon: 114.30 + (i % 2) * 0.001 }));
    expect(strokeAnchors(raw).length).toBeGreaterThan(9);
    const fetcher = vi.fn(async (url) => response(feature(fromUrl(url)), fetcher.mock.calls.length === 2 ? 500 : 200));
    await expect(snapHikingStroke(raw, { fetcher })).rejects.toThrow('500');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('aborts without committing and rejects tiny strokes', async () => {
    const controller = new AbortController();
    const fetcher = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = snapHikingStroke(line, { signal: controller.signal, fetcher }); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => strokeAnchors([line[0], { lat: line[0].lat + 0.00001, lon: line[0].lon }])).toThrow('太短');
  });
});
