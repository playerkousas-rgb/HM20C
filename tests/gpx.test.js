import { describe, expect, it } from 'vitest';
import { emptyRoute, makeGpx, MAX_GPX_POINTS, parseGpx } from '../src/lib/gpx';
import { routeDistance } from '../src/lib/geo';

const mixed = `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">
  <metadata><name>山徑 &amp; 海岸</name></metadata>
  <wpt lat="22.38" lon="114.32"><ele>28</ele><name>CP &amp; 1</name></wpt>
  <rte><name>路線一</name><rtept lat="22.38" lon="114.32"/><rtept lat="22.381" lon="114.321"/></rte>
  <trk><name>航跡一</name>
    <trkseg><trkpt lat="22.40" lon="114.10"><ele>250.5</ele><time>2026-01-01T09:00:00Z</time></trkpt><trkpt lat="22.401" lon="114.101"/></trkseg>
    <trkseg><trkpt lat="22.42" lon="114.13"/><trkpt lat="22.421" lon="114.131"/></trkseg>
  </trk>
</gpx>`;

describe('GPX import and export', () => {
  it('reads routes, independent track segments, waypoints and recorded metadata', () => {
    const route = parseGpx(mixed);
    expect(route.name).toBe('山徑 & 海岸');
    expect(route.waypoints).toEqual([{ lat: 22.38, lon: 114.32, ele: 28, name: 'CP & 1' }]);
    expect(route.segments.map((s) => s.kind)).toEqual(['route', 'track', 'track']);
    expect(route.segments[1].points[0]).toEqual({ lat: 22.4, lon: 114.1, ele: 250.5, time: '2026-01-01T09:00:00Z' });
    expect(routeDistance(route)).toBeLessThan(1000); // no line across the gap
  });

  it('round-trips segments and waypoints without inventing elevation or time', () => {
    const original = parseGpx(mixed);
    const xml = makeGpx(original);
    expect(xml).toContain('山徑 &amp; 海岸');
    expect(xml).toContain('CP &amp; 1');
    const again = parseGpx(xml);
    expect(again).toEqual(original);
    const drawn = emptyRoute();
    drawn.segments = [{ kind: 'draw', points: [{ lat: 22.3, lon: 114.1 }, { lat: 22.31, lon: 114.11 }] }];
    const out = makeGpx(drawn);
    expect(out).not.toContain('<ele>');
    expect(out).not.toContain('<time>');
    expect(parseGpx(out).segments[0].points).toEqual(drawn.segments[0].points);
  });

  it('accepts prefixed namespaces and zero coordinates', () => {
    const route = parseGpx('<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:wpt lat="0" lon="0"><g:name>原點</g:name></g:wpt></g:gpx>');
    expect(route.waypoints[0]).toEqual({ lat: 0, lon: 0, name: '原點' });
  });

  it('rejects malformed XML, missing or invalid coordinates, DTDs, and empty files', () => {
    for (const xml of [
      '', '<gpx><trk></gpx>', '<html/>', '<gpx/>',
      '<!DOCTYPE gpx [<!ENTITY x "bad">]><gpx/>',
      '<gpx><wpt lon="114"/></gpx>', '<gpx><wpt lat="" lon="114"/></gpx>',
      '<gpx><wpt lat="91" lon="114"/></gpx>', '<gpx><wpt lat="22" lon="181"/></gpx>',
      '<gpx><wpt lat="abc" lon="114"/></gpx>', '<gpx><wpt lat="22" lon="114"><ele>bad</ele></wpt></gpx>',
    ]) expect(() => parseGpx(xml)).toThrow();
  });

  it('limits very large files by point count', () => {
    const xml = `<gpx><trk><trkseg>${'<trkpt lat="22" lon="114"/>'.repeat(MAX_GPX_POINTS + 1)}</trkseg></trk></gpx>`;
    expect(() => parseGpx(xml)).toThrow(/超過/);
  });

  it('escapes user-supplied text in exported XML', () => {
    const route = { name: '<trip & "name">', segments: [], waypoints: [{ lat: 22, lon: 114, name: '<CP & 1>' }] };
    const xml = makeGpx(route);
    expect(xml).toContain('&lt;trip &amp; &quot;name&quot;&gt;');
    expect(parseGpx(xml).waypoints[0].name).toBe('<CP & 1>');
  });
});
