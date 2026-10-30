// Web Mercator ground resolution at the centre of the map. A screen scale is
// only physically meaningful after the user has measured their own display.
export const DEFAULT_PX_PER_MM = 96 / 25.4;
export const EARTH_RADIUS_M = 6371008.8;

// Use hemisphere letters rather than pairing negative numbers with N/E.
export function formatLatitude(value, digits = 4) {
  return `${Math.abs(value).toFixed(digits)}° ${value < 0 ? 'S' : 'N'}`;
}
export function formatLongitude(value, digits = 4) {
  return `${Math.abs(value).toFixed(digits)}° ${value < 0 ? 'W' : 'E'}`;
}

export function zoomForScale(latitude, denominator, pixelsPerMm = DEFAULT_PX_PER_MM) {
  const latitudeRadians = Math.max(-85, Math.min(85, latitude)) * Math.PI / 180;
  const targetMetersPerPixel = denominator / (1000 * pixelsPerMm);
  return Math.log2(156543.03392804097 * Math.cos(latitudeRadians) / targetMetersPerPixel);
}

export function metersPerPixel(latitude, zoom) {
  return 156543.03392804097 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom;
}

// Pick a readable ground distance rather than clamping the pixel width of a
// fixed 500 m bar: clamping would silently make the labelled scale inaccurate.
export function scaleBarForMetersPerPixel(metersPerPixelValue, maxPixels = 110) {
  const candidates = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
  const meters = candidates.find((distance) => distance / metersPerPixelValue <= maxPixels) || 1;
  return { meters, pixels: meters / metersPerPixelValue };
}

export function distanceMeters(a, b) {
  const toRadians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRadians;
  const dLon = (b.lon - a.lon) * toRadians;
  const p1 = a.lat * toRadians;
  const p2 = b.lat * toRadians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Separate GPX segments are deliberately not connected across their gaps.
export function routeDistance(route) {
  return route.segments.reduce((total, segment) => {
    for (let i = 1; i < segment.points.length; i += 1) {
      total += distanceMeters(segment.points[i - 1], segment.points[i]);
    }
    return total;
  }, 0);
}

export function routePointCount(route) {
  return route.segments.reduce((sum, segment) => sum + segment.points.length, 0);
}

export function allRoutePoints(route) {
  return [...route.segments.flatMap((segment) => segment.points), ...route.waypoints];
}

export function formatDistance(meters) {
  return (meters / 1000).toFixed(2);
}
