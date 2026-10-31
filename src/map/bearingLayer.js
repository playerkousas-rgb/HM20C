import * as L from 'leaflet';

// The straight line is extended in the *current rotated screen* and clipped
// to the viewport, so its line and A/B cross centres are physically aligned.
export function extendToViewport(a, b, width, height) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 0.01) return null;
  let low = -Infinity; let high = Infinity;
  for (const [origin, delta, limit] of [[a.x, dx, width], [a.y, dy, height]]) {
    if (Math.abs(delta) < 1e-12) { if (origin < 0 || origin > limit) return null; continue; }
    const first = (0 - origin) / delta; const second = (limit - origin) / delta;
    low = Math.max(low, Math.min(first, second)); high = Math.min(high, Math.max(first, second));
  }
  if (low > high) return null;
  return [L.point(a.x + low * dx, a.y + low * dy), L.point(a.x + high * dx, a.y + high * dy)];
}
export function bearingIcon(label) {
  return L.divIcon({
    className: `bearing-marker bearing-marker-${label.toLowerCase()}`,
    html: `<span class="bearing-cross"><i></i><b>${label}</b></span>`,
    iconSize: [38, 38], iconAnchor: [19, 19],
  });
}
export function createBearingLayer(map, getCurrent) {
  const group = L.layerGroup().addTo(map);
  const halo = L.polyline([], { color: '#fffcf2', weight: 7, opacity: 0.95, interactive: false, className: 'bearing-halo' }).addTo(group);
  const line = L.polyline([], { color: '#315e4d', weight: 2.5, opacity: 1, interactive: false, className: 'bearing-extension' }).addTo(group);
  let markers = []; let dragging = false;
  function updateLine() {
    if (markers.length !== 2) { halo.setLatLngs([]); line.setLatLngs([]); return; }
    const a = map.latLngToContainerPoint(markers[0].getLatLng());
    const b = map.latLngToContainerPoint(markers[1].getLatLng());
    const size = map.getSize(); const endpoints = extendToViewport(a, b, size.x, size.y);
    const latlngs = endpoints ? endpoints.map((point) => map.containerPointToLatLng(point)) : [];
    halo.setLatLngs(latlngs); line.setLatLngs(latlngs);
  }
  function render(points, editable) {
    if (dragging) return;
    for (const marker of markers) group.removeLayer(marker);
    markers = points.map((point, index) => {
      const label = index === 0 ? 'A' : 'B';
      const marker = L.marker([point.lat, point.lon], {
        icon: bearingIcon(label), draggable: editable, keyboard: editable,
        title: editable ? `拖動方位點 ${label}` : `方位點 ${label}`,
        bubblingMouseEvents: false, zIndexOffset: 1000,
      }).addTo(group);
      if (editable) {
        marker.on('dragstart', () => { dragging = true; });
        marker.on('drag', () => {
          updateLine(); const value = marker.getLatLng();
          getCurrent().onMoveBearingPoint(index, value.lat, value.lng, false);
        });
        marker.on('dragend', () => {
          dragging = false; const value = marker.getLatLng();
          if (!getCurrent().isAvailableBearingPoint(value)) {
            marker.setLatLng([point.lat, point.lon]);
            getCurrent().onMoveBearingPoint(index, point.lat, point.lon, true);
            getCurrent().onMapWarning('方位點不可移到本機圖幅以外。');
          } else getCurrent().onMoveBearingPoint(index, value.lat, value.lng, true);
          updateLine();
        });
      }
      return marker;
    });
    updateLine();
  }
  map.on('move resize rotate', updateLine);
  return { render, destroy() { map.off('move resize rotate', updateLine); group.remove(); } };
}
