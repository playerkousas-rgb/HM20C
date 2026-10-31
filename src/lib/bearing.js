import { magvar } from 'magvar';
import { distanceMeters } from './geo';
import { gridReference, inHongKongGrid, toUtm, zoneForLongitude } from './utm';

export function normalizeAngle(value) { return ((value % 360) + 360) % 360; }
export function formatBearing(value) {
  if (!Number.isFinite(value)) return '—';
  return `${(Math.round(normalizeAngle(value) * 10) / 10 % 360).toFixed(1)}°`;
}
// Geodesic initial true bearing on a sphere; adequate as an approximate
// teaching aid for the short distances of an HK map, not survey-grade data.
export function trueBearing(a, b) {
  const rad = Math.PI / 180;
  const p1 = a.lat * rad; const p2 = b.lat * rad; const dLon = (b.lon - a.lon) * rad;
  return normalizeAngle(Math.atan2(Math.sin(dLon) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon)) / rad);
}
export function magneticDeclination(point, date = new Date()) {
  const year = date instanceof Date ? date.getUTCFullYear() : NaN;
  // WMM2025 is only valid in [2025, 2030). Never quietly extrapolate.
  if (!inHongKongGrid(point) || year < 2025 || year >= 2030 || !Number.isFinite(year)) return null;
  try {
    const value = magvar(point.lat, point.lon, 0, date);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}
export function bearingAnswers(a, b, date = new Date()) {
  if (!inHongKongGrid(a) || !inHongKongGrid(b) || distanceMeters(a, b) < 10) return null;
  const zone = zoneForLongitude(a.lon);
  // Use A's zone for both endpoints. Mixing the false eastings of the two
  // zones at 114°E would yield a completely fictitious bearing.
  const p = toUtm(a, zone); const q = toUtm(b, zone);
  const forwardGrid = normalizeAngle(Math.atan2(q.easting - p.easting, q.northing - p.northing) * 180 / Math.PI);
  const forwardTrue = trueBearing(a, b); const backTrue = trueBearing(b, a);
  const declinationA = magneticDeclination(a, date); const declinationB = magneticDeclination(b, date);
  return {
    zone, crossesZone: zoneForLongitude(b.lon) !== zone,
    forwardGrid, backGrid: normalizeAngle(forwardGrid + 180), forwardTrue, backTrue,
    forwardMagnetic: declinationA === null ? null : normalizeAngle(forwardTrue - declinationA),
    backMagnetic: declinationB === null ? null : normalizeAngle(backTrue - declinationB),
    declinationA, declinationB, pointA: gridReference(a), pointB: gridReference(b),
  };
}
