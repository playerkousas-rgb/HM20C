import { emptyRoute, MAX_GPX_POINTS } from './gpx';
import { DEFAULT_ORIENTATION, isOrientationPreference } from './orientation';

const ROUTE_KEY = 'scout-trail-map.route.v1';
const PREFS_KEY = 'scout-trail-map.prefs.v1';
const VIEW_KEY = 'scout-trail-map.map-centre.v1';
export const DEFAULT_MAP_CENTER = { lat: 22.3835, lon: 114.3225 };

function validPoint(point) {
  return point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
}

// This is the manually chosen map centre, not the device's location.
export function loadMapCenter() {
  try {
    const value = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (validPoint(value) && Math.abs(value.lat) <= 85) return { lat: value.lat, lon: value.lon };
  } catch { /* invalid or unavailable storage */ }
  return { ...DEFAULT_MAP_CENTER };
}

export function saveMapCenter(value) {
  if (!validPoint(value) || Math.abs(value.lat) > 85) return false;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: Number(value.lat.toFixed(7)), lon: Number(value.lon.toFixed(7)) }));
    return true;
  } catch { return false; }
}

export function loadRoute() {
  try {
    const value = JSON.parse(localStorage.getItem(ROUTE_KEY));
    if (!value || typeof value.name !== 'string' || !Array.isArray(value.segments) || !Array.isArray(value.waypoints)) return emptyRoute();
    if (!value.waypoints.every(validPoint) || !value.segments.every((segment) => Array.isArray(segment.points) && segment.points.every(validPoint))) return emptyRoute();
    if (value.waypoints.length + value.segments.reduce((n, segment) => n + segment.points.length, 0) > MAX_GPX_POINTS) return emptyRoute();
    return value;
  } catch {
    return emptyRoute();
  }
}

export function saveRoute(route) {
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify(route)); return true; }
  catch { return false; }
}

export function loadPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    return {
      basemap: value.basemap === 'countryside' ? 'countryside' : 'hm20c',
      pixelsPerMm: Number.isFinite(value.pixelsPerMm) && value.pixelsPerMm >= 2.5 && value.pixelsPerMm <= 12 ? value.pixelsPerMm : null,
      orientation: isOrientationPreference(value.orientation) ? value.orientation : DEFAULT_ORIENTATION,
    };
  } catch { return { basemap: 'hm20c', pixelsPerMm: null, orientation: DEFAULT_ORIENTATION }; }
}

export function savePreferences(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); return true; }
  catch { return false; }
}
