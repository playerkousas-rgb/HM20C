import { normalizeAngle, trueBearing, magneticDeclination } from './bearing';
import { fromUtm, toUtm, zoneForLongitude } from './utm';

export const RESECTION_INITIAL_ANGLES = [90, 160, 230];

// A line's direction is kept in its landmark's UTM zone, independent of the
// map's visual rotation. One zone is used for both points of each calculation.
export function gridAngleBetween(origin, point) {
  const zone = zoneForLongitude(origin.lon);
  const a = toUtm(origin, zone); const b = toUtm(point, zone);
  if (!a || !b || Math.hypot(b.easting - a.easting, b.northing - a.northing) < 1) return null;
  return normalizeAngle(Math.atan2(b.easting - a.easting, b.northing - a.northing) * 180 / Math.PI);
}

export function pointAlongGrid(origin, angle, distance = 1000) {
  if (!Number.isFinite(angle) || !Number.isFinite(distance)) return null;
  const zone = zoneForLongitude(origin.lon); const a = toUtm(origin, zone);
  if (!a) return null;
  const radians = angle * Math.PI / 180;
  return fromUtm(a.easting + Math.sin(radians) * distance, a.northing + Math.cos(radians) * distance, zone);
}

// Optional magnetic input is a teaching estimate: the actual observation
// station is unknown, so the WMM declination is approximated at the landmark.
// Compute convergence from this landmark's UTM projection, not screen rotation.
export function gridToMagnetic(origin, gridAngle, date = new Date()) {
  const declination = magneticDeclination(origin, date);
  const target = pointAlongGrid(origin, gridAngle);
  if (declination === null || !target) return null;
  return normalizeAngle(trueBearing(origin, target) - declination);
}
export function magneticToGrid(origin, magneticAngle, date = new Date()) {
  if (!Number.isFinite(magneticAngle)) return null;
  const reference = gridToMagnetic(origin, 0, date);
  if (reference === null) return null;
  // UTM is ellipsoidal but the app's teaching true bearing is spherical; the
  // offset varies slightly with direction. Invert the actual forward formula
  // rather than assuming a constant screen or grid convergence offset.
  let guess = normalizeAngle(magneticAngle - reference);
  for (let i = 0; i < 6; i += 1) {
    const actual = gridToMagnetic(origin, guess, date);
    const error = ((actual - magneticAngle + 540) % 360) - 180;
    guess = normalizeAngle(guess - error);
    if (Math.abs(error) < 1e-8) break;
  }
  return guess;
}
