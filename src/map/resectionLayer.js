import * as L from 'leaflet';
import { extendToViewport } from './bearingLayer';
import { gridAngleBetween, pointAlongGrid } from '../lib/resection';

const COLORS = ['#276c51', '#bd753b', '#795b9a'];
const LABELS = ['A', 'B', 'C'];

// Only the landmark → back-bearing direction is valid. Clip that ray to the
// viewport, including when the landmark lies outside the screen after a pan.
export function extendRayToViewport(anchor, target, width, height) {
  const ends = extendToViewport(anchor, target, width, height);
  if (!ends) return null;
  const dx = target.x - anchor.x; const dy = target.y - anchor.y;
  const length2 = dx * dx + dy * dy;
  const along = (p) => ((p.x - anchor.x) * dx + (p.y - anchor.y) * dy) / length2;
  const low = Math.max(0, along(ends[0])); const high = along(ends[1]);
  if (high < low || high < 0) return null;
  return [L.point(anchor.x + dx * low, anchor.y + dy * low), L.point(anchor.x + dx * high, anchor.y + dy * high)];
}

function landmarkIcon(index) {
  return L.divIcon({ className: `resection-landmark resection-landmark-${LABELS[index].toLowerCase()}`,
    html: `<span style="--landmark-color:${COLORS[index]}"><i></i><b>${LABELS[index]}</b></span>`, iconSize: [32, 32], iconAnchor: [16, 16] });
}
function handleIcon(index) {
  return L.divIcon({ className: `resection-handle resection-handle-${LABELS[index].toLowerCase()}`,
    html: `<span style="--landmark-color:${COLORS[index]}" aria-hidden="true">↻</span>`, iconSize: [36, 36], iconAnchor: [18, 18] });
}

/** Three independent fixed landmarks and one draggable direction handle per line. */
export function createResectionLayer(map, getCurrent) {
  const group = L.layerGroup().addTo(map);
  let entries = []; let dragging = -1;
  function updateEntry(entry, useDraggedHandle = false) {
    const anchor = map.latLngToContainerPoint([entry.point.lat, entry.point.lon]);
    let target;
    if (useDraggedHandle) target = map.latLngToContainerPoint(entry.handle.getLatLng());
    else {
      const projected = pointAlongGrid(entry.point, entry.point.angle);
      if (!projected) return;
      const p = map.latLngToContainerPoint([projected.lat, projected.lon]);
      const dx = p.x - anchor.x; const dy = p.y - anchor.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.001) return;
      target = L.point(anchor.x + 78 * dx / length, anchor.y + 78 * dy / length);
      entry.handle.setLatLng(map.containerPointToLatLng(target));
    }
    const size = map.getSize();
    const ends = extendRayToViewport(anchor, target, size.x, size.y);
    const latlngs = ends ? ends.map((p) => map.containerPointToLatLng(p)) : [];
    entry.halo.setLatLngs(latlngs); entry.line.setLatLngs(latlngs);
  }
  function updateAll() { entries.forEach((entry, index) => updateEntry(entry, dragging === index)); }
  function render(points, editable) {
    if (dragging >= 0) return;
    group.clearLayers();
    entries = points.map((point, index) => {
      const halo = L.polyline([], { color: '#fffdf8', weight: 7, opacity: 0.9, interactive: false }).addTo(group);
      const line = L.polyline([], { color: COLORS[index], weight: 2.5, opacity: 0.95, dashArray: point.set ? null : '7 7', interactive: false, className: `resection-line resection-line-${LABELS[index].toLowerCase()}` }).addTo(group);
      const marker = L.marker([point.lat, point.lon], { icon: landmarkIcon(index), draggable: false, keyboard: false,
        title: `地標 ${LABELS[index]}（固定）`, bubblingMouseEvents: false, zIndexOffset: 900 }).addTo(group);
      L.DomEvent.disableClickPropagation(marker.getElement());
      if (point.name) {
        const name = document.createElement('span'); name.textContent = point.name;
        marker.bindTooltip(name, { permanent: true, direction: 'bottom', offset: [0, 12], className: 'exercise-name-label' }).openTooltip();
      }
      const handle = L.marker([point.lat, point.lon], { icon: handleIcon(index), draggable: editable, keyboard: false,
        title: editable ? `拖動 ${LABELS[index]} 線旋轉` : `${LABELS[index]} 線方向`, bubblingMouseEvents: false, zIndexOffset: 950 }).addTo(group);
      const entry = { point, marker, handle, halo, line };
      if (editable) {
        handle.on('dragstart', () => { dragging = index; });
        handle.on('drag', () => {
          const latlng = handle.getLatLng();
          const angle = gridAngleBetween(point, { lat: latlng.lat, lon: latlng.lng });
          if (angle !== null) {
            entry.point = { ...entry.point, angle, set: true };
            entry.line.setStyle({ dashArray: null });
            getCurrent().onResectionAngle(index, angle);
          }
          updateEntry(entry, true);
        });
        handle.on('dragend', () => { dragging = -1; updateEntry(entry); });
      } else L.DomEvent.disableClickPropagation(handle.getElement());
      return entry;
    });
    updateAll();
  }
  map.on('move resize rotate', updateAll);
  return { render, destroy() { map.off('move resize rotate', updateAll); group.remove(); } };
}
