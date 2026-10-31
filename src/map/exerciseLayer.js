import * as L from 'leaflet';

// Use DOM textContent for names from a QR code: never interpret them as HTML.
function exerciseIcon(point, index) {
  const content = document.createElement('span');
  const badge = document.createElement('b'); badge.textContent = String.fromCharCode(65 + index);
  content.append(badge);
  if (point.name) {
    const name = document.createElement('small'); name.textContent = point.name;
    content.append(name);
  }
  return L.divIcon({ className: 'exercise-marker', html: content, iconSize: [28, 28], iconAnchor: [14, 14] });
}
export function createExerciseLayer(map) {
  const group = L.layerGroup().addTo(map);
  return {
    render(points) {
      group.clearLayers();
      points.forEach((point, index) => L.marker([point.lat, point.lon], {
        icon: exerciseIcon(point, index), interactive: false, keyboard: false, zIndexOffset: 700,
        title: `題目 ${String.fromCharCode(65 + index)}`,
      }).addTo(group));
    },
    destroy() { group.remove(); },
  };
}
