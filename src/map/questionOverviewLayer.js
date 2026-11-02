import * as L from 'leaflet';

// Both leader and imported answer text are untrusted: use textContent, never HTML.
function overviewIcon(point) {
  const root = document.createElement('span');
  const badge = document.createElement('b'); badge.textContent = point.label; root.append(badge);
  if (point.detail) {
    const detail = document.createElement('small'); detail.textContent = point.detail; root.append(detail);
  }
  return L.divIcon({ className: 'question-overview-marker', html: root, iconSize: [28, 28], iconAnchor: [14, 14] });
}
export function createQuestionOverviewLayer(map) {
  const group = L.layerGroup().addTo(map);
  return {
    render(items) {
      group.clearLayers();
      for (const item of items || []) {
        if (item.line?.length === 2 && item.line.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))) {
          L.polyline(item.line.map((p) => [p.lat, p.lon]), { color: '#426e9b', weight: 2, dashArray: '5 5', interactive: false, className: 'question-overview-line' }).addTo(group);
        }
        for (const point of item.markers) L.marker([point.lat, point.lon], {
          icon: overviewIcon(point), interactive: false, keyboard: false, zIndexOffset: 850,
          title: `第 ${item.index + 1} 題 ${point.label}`,
        }).addTo(group);
      }
    },
    destroy() { group.remove(); },
  };
}
