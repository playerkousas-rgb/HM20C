import * as L from 'leaflet';
import { gridReference, utmGridLines } from '../lib/utm';

/** Geographic 1 km grid: the pane rotates and pans with the basemap. */
export function createUtmLayer(map) {
  const pane = map.createPane('utmGrid', map.getPane('tilePane').parentElement);
  pane.style.zIndex = '390'; pane.style.pointerEvents = 'none';
  const lines = L.layerGroup(); const labels = L.layerGroup();
  let enabled = false;
  function refresh() {
    if (!enabled) return;
    lines.clearLayers(); labels.clearLayers();
    const bounds = map.getBounds();
    const grid = utmGridLines({ south: bounds.getSouth(), north: bounds.getNorth(), west: bounds.getWest(), east: bounds.getEast() });
    const size = map.getSize();
    for (const line of grid) {
      L.polyline(line.points.map((point) => [point.lat, point.lon]), {
        pane: 'utmGrid', color: '#456f5b', weight: 1.15, opacity: 0.64,
        interactive: false, className: `utm-grid-line utm-grid-${line.axis} utm-zone-${line.zone}`,
      }).addTo(lines);
      // Choose the visible point nearest the bottom (eastings) or left (northings).
      const candidates = line.points.map((point) => ({ point, screen: map.latLngToContainerPoint([point.lat, point.lon]) }))
        .filter(({ screen }) => screen.x >= 5 && screen.x <= size.x - 5 && screen.y >= 5 && screen.y <= size.y - 5);
      const target = candidates.sort((a, b) => line.axis === 'easting' ? b.screen.y - a.screen.y : a.screen.x - b.screen.x)[0];
      if (target) {
        const reference = gridReference(target.point);
        const title = `${line.zone}Q${reference?.zone === line.zone ? ` ${reference.square}` : ''} · ${line.label}`;
        L.marker([target.point.lat, target.point.lon], {
          icon: L.divIcon({ className: 'utm-grid-label', html: title, iconSize: [58, 15], iconAnchor: [line.axis === 'easting' ? 29 : 0, line.axis === 'easting' ? 17 : 7] }),
          interactive: false, keyboard: false, zIndexOffset: -500,
        }).addTo(labels);
      }
    }
    // The UTM zone switch is meaningful; never draw a 49Q grid past 114°E.
    if (bounds.getWest() < 114 && bounds.getEast() > 114) {
      const south = Math.max(22, bounds.getSouth()); const north = Math.min(22.65, bounds.getNorth());
      if (south < north) L.polyline([[south, 114], [north, 114]], {
        pane: 'utmGrid', color: '#31543e', weight: 1.5, opacity: 0.8, dashArray: '5 5', interactive: false,
        className: 'utm-zone-boundary',
      }).addTo(lines);
    }
  }
  const update = () => refresh();
  map.on('moveend resize rotate', update);
  return {
    setEnabled(value) {
      enabled = value;
      if (enabled) { lines.addTo(map); labels.addTo(map); refresh(); }
      else { lines.remove(); labels.remove(); }
    },
    destroy() { map.off('moveend resize rotate', update); lines.remove(); labels.remove(); },
  };
}
