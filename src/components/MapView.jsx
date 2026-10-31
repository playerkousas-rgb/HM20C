import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// Rotation-aware coordinates, tiles, vector renderers and marker dragging.
import '@tomickigrzegorz/leaflet-rotate';
import { createContourOverlay } from '../map/contours';
import { QueuedTileLayer } from '../map/tileLayer';
import { createUtmLayer } from '../map/utmLayer';
import { createBearingLayer } from '../map/bearingLayer';
import { inspectTiff } from '../sheets/files';
import { createSheetLayer } from '../sheets/rasterLayer';
import { allRoutePoints, DEFAULT_PX_PER_MM, distanceMeters, metersPerPixel, routePointCount, zoomForScale } from '../lib/geo';

const LANDSD_API = 'https://mapapi.hkmapservice.gov.hk/gs/api/v1.0.0/xyz';
const START = [22.3835, 114.3225];
const MAP_CONFIG = {
  hm20c: {
    scale: 20000,
    url: `${LANDSD_API}/basemap/WGS84/{z}/{x}/{y}.png`,
  },
  countryside: {
    scale: 25000,
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  },
};

function statusTracker(layer, callback) {
  let loaded = 0;
  let failed = 0;
  layer.on('loading', () => { loaded = 0; failed = 0; callback('loading'); });
  layer.on('tileload', () => { loaded += 1; });
  layer.on('tileerror', () => { failed += 1; });
  layer.on('load', () => callback(failed ? (loaded ? 'partial' : 'error') : 'ready'));
}

function nodeIcon(type, label = '') {
  return L.divIcon({
    className: `route-marker route-marker--${type}`,
    html: `<span>${label}</span>`,
    iconSize: type === 'small' ? [16, 16] : [28, 28],
    iconAnchor: type === 'small' ? [8, 8] : [14, 14],
  });
}

const MapView = forwardRef(function MapView(props, ref) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const contourRef = useRef(null);
  const baseRef = useRef(null);
  const labelsRef = useRef(null);
  const sheetGeometryRef = useRef(null);
  const routeLayerRef = useRef(null);
  const gridLayerRef = useRef(null);
  const bearingLayerRef = useRef(null);
  const current = useRef(props);
  current.current = props;

  function isAvailablePosition(position) {
    if (current.current.basemap !== 'hm20c' || !current.current.activeSheetId) return true;
    return Boolean(sheetGeometryRef.current?.contains(position.lng, position.lat));
  }

  useImperativeHandle(ref, () => ({
    goTo(lat, lon) {
      mapRef.current?.panTo([lat, lon], { animate: false });
    },
    centerRoute() {
      const map = mapRef.current;
      const points = allRoutePoints(current.current.route);
      if (!map || !points.length) return;
      const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lon]));
      // Do not fitBounds: changing zoom would silently unlock the scale.
      map.panTo(bounds.getCenter(), { animate: false });
    },
    retry() {
      baseRef.current?.redraw();
      labelsRef.current?.redraw();
      contourRef.current?.retry?.();
    },
    offlineSnapshot() {
      const map = mapRef.current;
      if (!map) return null;
      const bounds = map.getBounds(), center = map.getCenter();
      const layer = baseRef.current;
      // Use the same rotation-aware tile range as Leaflet; rotated layers
      // request a little beyond the geographic viewport to avoid blank edges.
      const range = layer?._tileZoom !== undefined && layer?._getTiledPixelBounds && layer?._pxBoundsToTileRange
        ? layer._pxBoundsToTileRange(layer._getTiledPixelBounds(center)) : null;
      return {
        bounds: { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() },
        center: { lat: center.lat, lon: center.lng },
        tileRange: range ? { minX: range.min.x, maxX: range.max.x, minY: range.min.y, maxY: range.max.y, zoom: layer._tileZoom } : null,
        zoom: map.getZoom(),
        basemap: current.current.basemap,
      };
    },
    canUsePoints(points) {
      return points.every((point) => isAvailablePosition({ lat: point.lat, lng: point.lon }));
    },
    downloadContours(plan, options) {
      return contourRef.current.downloadOffline(plan.coverageBounds, plan.mapZoom, options);
    },
  }), []);

  useEffect(() => {
    const initial = current.current.initialCenter || { lat: START[0], lon: START[1] };
    const map = L.map(container.current, {
      center: [initial.lat, initial.lon],
      zoom: zoomForScale(initial.lat, MAP_CONFIG[current.current.basemap].scale, current.current.pixelsPerMm || DEFAULT_PX_PER_MM),
      // Angles are set by the selected sheet, never by an accidental gesture.
      rotate: true,
      bearing: current.current.rotation,
      dragRotate: false,
      shiftKeyRotate: false,
      touchRotate: false,
      rotateControl: false,
      preventPageGestures: false,
      minZoom: 10,
      maxZoom: 20,
      zoomSnap: 0,
      zoomDelta: 0.25,
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      fadeAnimation: false,
    });
    mapRef.current = map;
    // Custom raster labels must rotate with the tile/overlay pane. Leaflet's
    // default createPane parent is the unrotated map pane.
    const labelPane = map.createPane('placeLabels', map.getPane('tilePane').parentElement);
    labelPane.style.zIndex = '370';
    labelPane.style.pointerEvents = 'none';
    const contour = createContourOverlay(map, { onStatus: (status) => current.current.onContourStatus(status.phase) });
    contourRef.current = contour;
    gridLayerRef.current = createUtmLayer(map);
    gridLayerRef.current.setEnabled(current.current.gridVisible);
    routeLayerRef.current = L.layerGroup().addTo(map);
    bearingLayerRef.current = createBearingLayer(map, () => ({ ...current.current, isAvailableBearingPoint: isAvailablePosition }));

    function updateView() {
      const centre = map.getCenter();
      const scale = MAP_CONFIG[current.current.basemap].scale;
      const zoom = zoomForScale(centre.lat, scale, current.current.pixelsPerMm || DEFAULT_PX_PER_MM);
      if (Math.abs(zoom - map.getZoom()) > 0.00001) {
        map.setZoom(zoom, { animate: false });
        return;
      }
      current.current.onViewChange({
        lat: centre.lat, lon: centre.lng, zoom: map.getZoom(),
        scaleWidth: 500 / metersPerPixel(centre.lat, map.getZoom()),
      });
    }
    map.on('moveend', updateView);
    let centreFrame = null;
    map.on('move', () => {
      if (!current.current.leaderActive || centreFrame !== null) return;
      centreFrame = requestAnimationFrame(() => {
        centreFrame = null;
        const centre = map.getCenter();
        current.current.onLeaderCenter({ lat: centre.lat, lon: centre.lng });
      });
    });
    map.on('click', (event) => {
      if (current.current.bearingActive || (current.current.editing && current.current.drawMode === 'straight')) {
        if (!isAvailablePosition(event.latlng)) { current.current.onMapWarning('所選位置不在本機圖幅內；請先切換圖幅。'); return; }
        const point = { lat: event.latlng.lat, lon: event.latlng.lng };
        if (current.current.bearingActive) current.current.onAddBearingPoint(point);
        else current.current.onAddPoint(point);
      }
    });
    updateView();
    // Preserve the geographic center when the mobile layout changes size.
    // The rotation plugin handles the resize around the rotated viewport pivot.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize({ pan: true, animate: false })) : null;
    observer?.observe(container.current);
    return () => {
      observer?.disconnect();
      if (centreFrame !== null) cancelAnimationFrame(centreFrame);
      gridLayerRef.current?.destroy();
      bearingLayerRef.current?.destroy();
      contour.setEnabled(false);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    let active = true, base = null, labels = null, coverageCheck = null;
    contourRef.current.setEnabled(false);
    if (baseRef.current) map.removeLayer(baseRef.current);
    if (labelsRef.current) map.removeLayer(labelsRef.current);
    baseRef.current = null;
    labelsRef.current = null;
    sheetGeometryRef.current = null;
    props.onTileStatus('loading');
    props.onLabelStatus('loading');
    props.onSheetError('');
    const config = MAP_CONFIG[props.basemap];
    const zoom = zoomForScale(map.getCenter().lat, config.scale, props.pixelsPerMm || DEFAULT_PX_PER_MM);
    map.setZoom(zoom, { animate: false });
    const centre = map.getCenter();
    current.current.onViewChange({ lat: centre.lat, lon: centre.lng, zoom: map.getZoom(), scaleWidth: 500 / metersPerPixel(centre.lat, map.getZoom()) });

    if (props.basemap === 'hm20c' && props.activeSheetId) {
      // A missing or unreadable local sheet must fail closed: never silently
      // substitute online tiles/labels/contours underneath a sheet indicator.
      props.onLabelStatus('not-applicable');
      props.onContourStatus('not-applicable');
      if (props.sheetRecord?.id === props.activeSheetId && props.sheetRecord.phase === 'error') {
        props.onSheetError(props.sheetRecord.message);
        props.onTileStatus('error');
      } else if (props.sheetRecord?.id === props.activeSheetId && props.sheetRecord.phase === 'ready') {
        inspectTiff(props.sheetRecord.blob, props.activeSheetId).then(({ image, geometry }) => {
          if (!active) return;
          sheetGeometryRef.current = geometry;
          base = createSheetLayer(image, geometry);
          let latest = 'loading';
          coverageCheck = () => {
            if (!active) return;
            const center = map.getCenter();
            current.current.onTileStatus(geometry.contains(center.lng, center.lat) ? latest : 'outside');
          };
          statusTracker(base, (status) => { latest = status; coverageCheck(); });
          base.on('tileerror', (event) => { if (active) current.current.onSheetError(event.error?.message || '部分 TIFF 圖像未能解碼。'); });
          map.on('moveend', coverageCheck);
          baseRef.current = base;
          base.addTo(map);
          coverageCheck();
        }).catch((error) => {
          if (!active) return;
          current.current.onSheetError(error?.message || '本機圖幅未能讀取。');
          current.current.onTileStatus('error');
        });
      }
    } else {
      base = new QueuedTileLayer(config.url, {
        maxZoom: 20,
        maxNativeZoom: props.basemap === 'countryside' ? 17 : 20,
        minZoom: 10,
        subdomains: 'abc',
        keepBuffer: 1,
        updateWhenIdle: true,
      });
      statusTracker(base, (status) => { if (active) current.current.onTileStatus(status); });
      baseRef.current = base;
      base.addTo(map);
      if (props.basemap === 'hm20c') {
        labels = new QueuedTileLayer(`${LANDSD_API}/label/hk/tc/WGS84/{z}/{x}/{y}.png`, {
          pane: 'placeLabels', maxZoom: 20, minZoom: 10, keepBuffer: 1, updateWhenIdle: true,
        });
        statusTracker(labels, (status) => { if (active) current.current.onLabelStatus(status); });
        labelsRef.current = labels;
        labels.addTo(map);
        contourRef.current.setBasemap('hm20c');
        contourRef.current.setLabels(true);
        contourRef.current.setEnabled(true);
      } else {
        // Countryside is a separate map, never mixed with government layers.
        props.onLabelStatus('not-applicable');
        props.onContourStatus('not-applicable');
      }
    }
    return () => {
      active = false;
      if (coverageCheck) map.off('moveend', coverageCheck);
      if (base && map.hasLayer(base)) map.removeLayer(base);
      if (labels && map.hasLayer(labels)) map.removeLayer(labels);
      if (baseRef.current === base) baseRef.current = null;
      if (labelsRef.current === labels) labelsRef.current = null;
      sheetGeometryRef.current = null;
    };
  }, [props.basemap, props.activeSheetId, props.sheetRecord]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const zoom = zoomForScale(map.getCenter().lat, MAP_CONFIG[props.basemap].scale, props.pixelsPerMm || DEFAULT_PX_PER_MM);
    map.setZoom(zoom, { animate: false });
  }, [props.pixelsPerMm]);

  useEffect(() => {
    mapRef.current?.setBearing(props.rotation);
  }, [props.rotation]);

  useEffect(() => {
    gridLayerRef.current?.setEnabled(props.gridVisible);
  }, [props.gridVisible]);

  useEffect(() => {
    bearingLayerRef.current?.render(props.bearingPoints, props.bearingActive);
  }, [props.bearingPoints, props.bearingActive]);

  useEffect(() => {
    if (!props.leaderActive || !mapRef.current) return;
    const centre = mapRef.current.getCenter();
    current.current.onLeaderCenter({ lat: centre.lat, lon: centre.lng });
  }, [props.leaderActive]);

  // A freehand pointer stroke is only a preview. It is committed to the
  // route after BRouter returns valid network geometry, never as a fallback.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.editing || props.drawMode !== 'magnet') return undefined;
    const element = map.getContainer();
    let active = null; let preview = null; let exceeded = false;
    map.dragging.disable();
    function position(event) {
      const latlng = map.mouseEventToLatLng(event);
      return { lat: latlng.lat, lon: latlng.lng };
    }
    function stop(event) { event.preventDefault(); event.stopPropagation(); }
    function down(event) {
      if (active || current.current.routingBusy || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      stop(event);
      const point = position(event);
      if (!isAvailablePosition({ lat: point.lat, lng: point.lon })) {
        current.current.onMapWarning('所選位置不在本機圖幅內；請先切換圖幅。'); return;
      }
      active = { id: event.pointerId, points: [point] }; exceeded = false;
      preview = L.polyline([[point.lat, point.lon]], { color: '#7f3b58', weight: 3, opacity: 0.8, dashArray: '6 5', interactive: false, className: 'stroke-preview' }).addTo(map);
      try { element.setPointerCapture(event.pointerId); } catch { /* old touch browsers */ }
    }
    function move(event) {
      if (!active || event.pointerId !== active.id) return;
      stop(event);
      const point = position(event);
      if (distanceMeters(active.points.at(-1), point) < 2) return;
      if (active.points.length >= 1000) { exceeded = true; return; }
      active.points.push(point);
      preview?.addLatLng([point.lat, point.lon]);
    }
    function end(event) {
      if (!active || event.pointerId !== active.id) return;
      stop(event);
      const stroke = active.points;
      active = null;
      try { element.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      preview?.remove(); preview = null;
      if (event.type === 'pointercancel') return;
      if (exceeded) { current.current.onMapWarning('這一筆太長，請分成較短的筆畫。'); return; }
      if (!stroke.every((point) => isAvailablePosition({ lat: point.lat, lng: point.lon }))) {
        current.current.onMapWarning('筆畫離開本機圖幅，請切換圖幅或分段重畫。'); return;
      }
      current.current.onDrawStroke(stroke);
    }
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', end, true);
    element.addEventListener('pointercancel', end, true);
    return () => {
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', end, true);
      element.removeEventListener('pointercancel', end, true);
      preview?.remove();
      map.dragging.enable();
    };
  }, [props.editing, props.drawMode]);

  useEffect(() => {
    const layer = routeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const count = routePointCount(props.route);
    const canEditAll = props.editing && props.drawMode === 'straight' && count <= 150;
    let number = 0;
    for (let segmentIndex = 0; segmentIndex < props.route.segments.length; segmentIndex += 1) {
      const segment = props.route.segments[segmentIndex];
      const positions = segment.points.map((point) => [point.lat, point.lon]);
      if (positions.length > 1) {
        L.polyline(positions, { color: '#fffdf5', weight: 8, opacity: 0.95, interactive: false, lineJoin: 'round' }).addTo(layer);
        L.polyline(positions, { color: '#a33555', weight: 4, opacity: 1, interactive: false, lineJoin: 'round' }).addTo(layer);
      }
      const canEditSegment = canEditAll && segment.kind !== 'snap';
      segment.points.forEach((point, pointIndex) => {
        number += 1;
        const start = pointIndex === 0;
        const end = pointIndex === segment.points.length - 1 && !start;
        if (!canEditSegment && !start && !end) return;
        const type = start ? 'start' : end ? 'end' : 'small';
        const marker = L.marker([point.lat, point.lon], {
          icon: nodeIcon(type, start ? '起' : end ? '終' : ''),
          draggable: canEditSegment,
          keyboard: canEditSegment,
          title: canEditSegment ? `拖動調整第 ${number} 個路點` : (start ? '路段起點' : '路段終點'),
          bubblingMouseEvents: false,
        }).addTo(layer);
        if (canEditSegment) marker.on('dragend', () => {
          const position = marker.getLatLng();
          if (!isAvailablePosition(position)) { marker.setLatLng([point.lat, point.lon]); current.current.onMapWarning('路點不可移到本機圖幅以外。'); return; }
          current.current.onMovePoint('segment', segmentIndex, pointIndex, position.lat, position.lng);
        });
      });
    }
    props.route.waypoints.forEach((point, index) => {
      const marker = L.marker([point.lat, point.lon], {
        icon: nodeIcon('waypoint', '◆'),
        draggable: props.editing && props.drawMode === 'straight' && props.route.waypoints.length <= 150,
        title: point.name || `航點 ${index + 1}`,
        bubblingMouseEvents: false,
      }).addTo(layer);
      marker.on('dragend', () => {
        const position = marker.getLatLng();
        if (!isAvailablePosition(position)) { marker.setLatLng([point.lat, point.lon]); current.current.onMapWarning('航點不可移到本機圖幅以外。'); return; }
        current.current.onMovePoint('waypoint', index, 0, position.lat, position.lng);
      });
    });
    contourRef.current?.setAvoidProvider(() => allRoutePoints(props.route).slice(0, 150).map((point) => ({ lat: point.lat, lng: point.lon, r: 12 })));
    contourRef.current?.refreshLabels();
  }, [props.route, props.editing, props.drawMode]);


  return <div className={`map-canvas ${props.editing ? 'is-drawing' : ''} ${props.editing && props.drawMode === 'magnet' ? 'is-magnet-drawing' : ''} ${props.bearingActive ? 'is-bearing' : ''}`} ref={container} aria-label="遠足地圖" data-rotation={props.rotation} />;
});

export default MapView;
