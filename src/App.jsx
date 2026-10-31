import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronRight, ChevronUp,
  Crosshair, Download, FileDown, FolderOpen, Grid3X3, Info, Layers2, LocateFixed,
  LockKeyhole, Map as MapIcon, MapPin, Mountain, Navigation, Pencil, QrCode, RotateCcw,
  Ruler, ShieldCheck, Trash2, Triangle, Undo2, X,
} from 'lucide-react';
import MapView from './components/MapView';
import OfflineContent from './components/OfflineContent';
import PlacesContent from './components/PlacesContent';
import LeaderContent from './components/LeaderContent';
import BearingCard from './components/BearingCard';
import ResectionCard from './components/ResectionCard';
import { ExerciseEditor, ExerciseHome, ExerciseMarkCard, ExerciseScanner, requiredPoints } from './components/ExerciseContent';
import { BOOKMARKS_KEY, loadBookmarks, makeBookmark, MAX_BOOKMARKS, saveBookmarks } from './lib/bookmarks';
import { allRoutePoints, distanceMeters, formatDistance, formatLatitude, formatLongitude, routeDistance, routePointCount, scaleBarForMetersPerPixel } from './lib/geo';
import { emptyRoute, makeGpx, MAX_GPX_BYTES, MAX_GPX_POINTS, parseGpx } from './lib/gpx';
import { orientationForView, SHEET_ROTATIONS, signedAngle } from './lib/orientation';
import { gridReference, inHongKongGrid } from './lib/utm';
import { RESECTION_INITIAL_ANGLES } from './lib/resection';
import { decodeExercise, loadExercise, saveExercise } from './lib/exercise';
import { snapHikingStroke } from './lib/hiking';
import { loadMapCenter, loadPreferences, loadResection, loadRoute, saveMapCenter, savePreferences, saveResection, saveRoute } from './lib/storage';
import { clearSavedAreas, downloadAreaTiles, loadSavedAreas, planOfflineArea, prepareOfflineEngine, recordSavedArea } from './lib/offline';
import { useInstallPrompt } from './lib/install';
import { extractTiff, fetchOfficialSheet, formatBytes, inspectTiff } from './sheets/files';
import { deleteStoredSheet, listStoredSheets, loadActiveSheet, readStoredSheet, saveActiveSheet, saveStoredSheet, SHEETS_CHANGED_KEY } from './sheets/storage';

const REGIONS = [
  { name: '西貢・萬宜水庫', sub: '麥理浩徑一帶', lat: 22.3835, lon: 114.3225 },
  { name: '大帽山', sub: '新界中部', lat: 22.4108, lon: 114.1174 },
  { name: '城門水塘', sub: '城門郊野公園', lat: 22.3778, lon: 114.1441 },
  { name: '獅子山', sub: '九龍與新界之間', lat: 22.3518, lon: 114.1852 },
  { name: '鳳凰山', sub: '大嶼山南部', lat: 22.2559, lon: 113.9341 },
  { name: '龍脊', sub: '香港島東南部', lat: 22.2413, lon: 114.2374 },
];

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 42 42" fill="none"><path d="M6.5 28.5 14.5 16l5.6 7.5 5.6-10L36 28.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M6.5 33h29" stroke="#e9c37c" strokeWidth="2.1" strokeLinecap="round"/><circle cx="32.4" cy="10.6" r="2.1" fill="#e9c37c"/></svg></span>;
}

function Modal({ title, eyebrow, children, onClose, className = '' }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-handle" />
      <div className="modal-heading"><div><div className="eyebrow">{eyebrow}</div><h2 id="modal-title">{title}</h2></div><button className="icon-button modal-close" onClick={onClose} aria-label="關閉"><X size={19}/></button></div>
      {children}
    </section>
  </div>;
}

function ContourStatus({ basemap, phase, onRetry, sheetId, sheetCoverage, tileStatus }) {
  if (basemap === 'hm20c' && sheetId) {
    const sheetState = tileStatus === 'loading' ? '載入中' : tileStatus === 'error' || tileStatus === 'partial' ? '圖幅未載妥' : tileStatus === 'outside' ? '已離開範圍' : Number.isFinite(sheetCoverage) && sheetCoverage < 0.98 ? '範圍不完整' : '等高線待核對';
    return <span className="source-pill source-pill--warn"><span className="status-dot"/>{sheetId} 本機試用 · {sheetState}</span>;
  }
  if (basemap === 'countryside') return <span className="source-pill"><span className="status-dot" />OpenTopoMap 自帶地形</span>;
  const labels = {
    ready: 'iB20000 等高距 20 米 · 2021',
    loading: '20 米等高線載入中',
    partial: '等高線未完整載入',
    error: '等高線未能載入',
    zoom: '等高線無法在此比例顯示',
    outside: '已離開等高線資料範圍',
    off: '等高線準備中',
  };
  const warning = phase === 'error' || phase === 'partial' || phase === 'zoom' || phase === 'outside';
  if (phase === 'error' || phase === 'partial') {
    return <button className="source-pill source-pill--warn" onClick={onRetry} title="重試等高線"><span className="status-dot" />{labels[phase]}<span className="retry-inline">重試</span></button>;
  }
  return <span className={`source-pill ${warning ? 'source-pill--warn' : ''}`}><span className="status-dot" />{labels[phase] || labels.loading}</span>;
}

function App() {
  const install = useInstallPrompt();
  const [route, setRoute] = useState(loadRoute);
  const routeRef = useRef(route);
  routeRef.current = route;
  const [prefs, setPrefs] = useState(loadPreferences);
  const [initialCenter] = useState(loadMapCenter);
  const [editing, setEditing] = useState(false);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [routingMessage, setRoutingMessage] = useState('');
  const [bearingActive, setBearingActive] = useState(false);
  const [bearingPoints, setBearingPoints] = useState([]);
  const [bearingNames, setBearingNames] = useState([]);
  const [resectionActive, setResectionActive] = useState(false);
  const [resectionPoints, setResectionPoints] = useState(loadResection);
  const [visibleTool, setVisibleTool] = useState(null);
  const [exerciseMarking, setExerciseMarking] = useState(false);
  const [exerciseDraft, setExerciseDraft] = useState(null);
  const [exercise, setExercise] = useState(loadExercise);
  const [pendingExercise, setPendingExercise] = useState(null);
  const [leaderUntil, setLeaderUntil] = useState(0);
  const [leaderCenter, setLeaderCenter] = useState(initialCenter);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [bookmarks, setBookmarks] = useState(loadBookmarks);
  const [tileStatus, setTileStatus] = useState('loading');
  const [labelStatus, setLabelStatus] = useState('loading');
  const [contourStatus, setContourStatus] = useState('loading');
  const [view, setView] = useState({ ...initialCenter, scaleWidth: 95 });
  const [offlineAreas, setOfflineAreas] = useState(loadSavedAreas);
  const [offlinePlan, setOfflinePlan] = useState(null);
  const [offlineJob, setOfflineJob] = useState({ phase: 'idle', message: '', done: 0, total: 0 });
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [activeSheetId, setActiveSheetId] = useState(loadActiveSheet);
  const [sheetRecord, setSheetRecord] = useState(null);
  const [sheetRevision, setSheetRevision] = useState(0);
  const [sheets, setSheets] = useState([]);
  const [sheetListError, setSheetListError] = useState('');
  const [sheetJob, setSheetJob] = useState({ phase: 'idle', message: '', done: 0, total: 0 });
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [modal, setModal] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [measurement, setMeasurement] = useState('');
  const [toast, setToast] = useState('');
  const [saved, setSaved] = useState(true);
  const [undoCount, setUndoCount] = useState(0);
  const mapRef = useRef(null);
  const fileRef = useRef(null);
  const history = useRef([]);
  const toastTimer = useRef(null);
  const offlineAbort = useRef(null);
  const sheetAbort = useRef(null);
  const routingAbort = useRef(null);
  const receiveExerciseRef = useRef(null);
  const sourceVersion = useRef('');
  sourceVersion.current = `${prefs.basemap}:${activeSheetId || ''}:${sheetRevision}`;

  useEffect(() => { setSaved(saveRoute(route)); }, [route]);
  useEffect(() => { savePreferences(prefs); }, [prefs]);
  useEffect(() => { saveResection(resectionPoints); }, [resectionPoints]);
  useEffect(() => {
    const onStorage = (event) => { if (event.key === BOOKMARKS_KEY || event.key === null) setBookmarks(loadBookmarks()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    refreshStoredSheets();
    const onStorage = (event) => {
      if (event.key === SHEETS_CHANGED_KEY || event.key === null) {
        refreshStoredSheets();
        setSheetRevision((value) => value + 1);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    if (!activeSheetId) { setSheetRecord(null); return undefined; }
    let alive = true;
    setSheetRecord({ id: activeSheetId, phase: 'loading' });
    readStoredSheet(activeSheetId).then((record) => {
      if (!alive) return;
      setSheetRecord(record ? { ...record, id: activeSheetId, phase: 'ready' } : { id: activeSheetId, phase: 'error', message: '本機圖幅已遺失或被系統清除；請重新下載或選檔。' });
    }).catch(() => { if (alive) setSheetRecord({ id: activeSheetId, phase: 'error', message: '未能開啟本機圖幅儲存；請檢查手機設定。' }); });
    return () => { alive = false; };
  }, [activeSheetId, sheetRevision]);
  useEffect(() => () => { clearTimeout(toastTimer.current); offlineAbort.current?.abort(); sheetAbort.current?.abort(); routingAbort.current?.abort(); }, []);
  useEffect(() => {
    const timer = setTimeout(() => saveMapCenter(view), 350);
    return () => clearTimeout(timer);
  }, [view.lat, view.lon]);
  useEffect(() => {
    const onNetwork = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', onNetwork);
    window.addEventListener('offline', onNetwork);
    return () => { window.removeEventListener('online', onNetwork); window.removeEventListener('offline', onNetwork); };
  }, []);

  useEffect(() => {
    if (!leaderUntil) return undefined;
    const expire = () => { if (Date.now() >= leaderUntil) setLeaderUntil(0); };
    const timer = setTimeout(expire, Math.max(0, leaderUntil - Date.now()));
    document.addEventListener('visibilitychange', expire);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', expire); };
  }, [leaderUntil]);

  const leaderActive = leaderUntil > Date.now();
  const centerReference = leaderActive ? gridReference(leaderCenter) : null;
  const exercisePoints = useMemo(() => exerciseMarking ? (exerciseDraft?.points || []) : (exercise?.kind === 'points' ? exercise.points : []), [exerciseMarking, exerciseDraft?.points, exercise]);
  const usingSheet = prefs.basemap === 'hm20c' && Boolean(activeSheetId);
  const pointCount = routePointCount(route);
  const hasPoints = pointCount + route.waypoints.length > 0;
  const distance = formatDistance(routeDistance(route));
  const scaleBar = scaleBarForMetersPerPixel(500 / view.scaleWidth);
  const scaleLabel = scaleBar.meters >= 1000 ? `${scaleBar.meters / 1000} km` : `${scaleBar.meters} m`;
  const orientation = orientationForView(prefs.basemap, prefs.orientation, view.lat, view.lon);
  const orientationLabel = orientation.sheet
    ? `${orientation.mode === 'auto' ? '自動' : '手選'}圖幅 ${orientation.sheet.number} · ${signedAngle(orientation.angle)}（估算）`
    : orientation.mode === 'auto' ? '圖幅範圍外 · 未旋轉' : '真北向上 · 0°';

  function notify(message) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3600);
  }

  function cancelRouting(message = '') {
    if (routingAbort.current) {
      routingAbort.current.abort();
      routingAbort.current = null;
      setRoutingBusy(false);
      if (message) setRoutingMessage(message);
    }
  }

  function changeRoute(next, record = true) {
    cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
    if (record) {
      history.current = [...history.current.slice(-19), routeRef.current];
      setUndoCount(history.current.length);
    }
    routeRef.current = next;
    setRoute(next);
  }

  function undo() {
    cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
    if (!history.current.length) return;
    const previous = history.current[history.current.length - 1];
    history.current = history.current.slice(0, -1);
    setUndoCount(history.current.length);
    routeRef.current = previous;
    setRoute(previous);
    notify('已撤回上一步');
  }

  async function drawStroke(stroke) {
    if (routingAbort.current) return;
    if (tileStatus !== 'ready') { notify('底圖未完整載入，請先檢查地圖。'); return; }
    if (navigator.onLine === false) { setRoutingMessage('沿徑磁石需要網絡；未有新增直線。'); return; }
    const previous = routeRef.current;
    const oldPoints = previous.segments.flatMap((segment) => segment.points);
    const start = oldPoints.at(-1) || null;
    const source = sourceVersion.current;
    const abort = new AbortController(); routingAbort.current = abort;
    setRoutingBusy(true); setRoutingMessage('正在送交 BRouter 計算山徑…');
    try {
      const points = await snapHikingStroke(stroke, { start, signal: abort.signal });
      if (abort.signal.aborted || routingAbort.current !== abort) return;
      if (routeRef.current !== previous || sourceVersion.current !== source) throw new Error('地圖或路線已更改；請重新畫這一筆。');
      if (!mapRef.current?.canUsePoints(points)) throw new Error('計算出的山徑離開本機圖幅；請切換圖幅或重畫。');
      if (routePointCount(previous) + previous.waypoints.length + points.length > MAX_GPX_POINTS) throw new Error('路線點數超過上限；請先精簡 GPX。');
      routingAbort.current = null;
      changeRoute({ ...previous, segments: [...previous.segments, { kind: 'snap', name: '', points }] });
      setRoutingMessage('已貼上路網；請核對路徑是否安全及開放。');
      notify('已加入沿徑筆畫；可撤回整筆。');
    } catch (error) {
      if (!abort.signal.aborted) {
        setRoutingMessage(error?.message || '沿徑計算失敗；路線未有更改。');
        notify(error?.message || '沿徑計算失敗；路線未有更改。');
      }
    } finally {
      if (routingAbort.current === abort) routingAbort.current = null;
      // A later job must not have its busy state cleared by an older response.
      if (!routingAbort.current) setRoutingBusy(false);
    }
  }

  function toggleDrawing() {
    if (editing) cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
    setEditing(!editing);
    if (!editing) {
      setBearingActive(false); setResectionActive(false); setExerciseMarking(false); setVisibleTool(null);
      setMapExpanded(false); setRoutingMessage('');
      notify('沿可見山徑拖畫；放手後連網貼路。');
    }
  }

  function openBearing() {
    cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
    setEditing(false); setResectionActive(false); setExerciseMarking(false);
    setBearingActive(true); setVisibleTool('bearing'); setMapExpanded(true);
  }
  function addBearingPoint(point) {
    if (tileStatus !== 'ready') { notify('底圖未完整載入，請先檢查地圖。'); return; }
    if (!inHongKongGrid(point)) { notify('請在香港 UTM 範圍內選點。'); return; }
    setBearingPoints((old) => old.length < 2 ? [...old, point] : old);
  }
  function openResection() {
    cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
    setEditing(false); setBearingActive(false); setExerciseMarking(false);
    setResectionActive(true); setVisibleTool('resection'); setMapExpanded(true);
  }
  function addResectionPoint(point) {
    if (tileStatus !== 'ready') { notify('底圖未完整載入，請先檢查地圖。'); return; }
    if (!inHongKongGrid(point)) { notify('請在香港 UTM 範圍內選地標。'); return; }
    if (resectionPoints.some((other) => distanceMeters(other, point) < 10)) { notify('地標須相距至少 10 米。'); return; }
    setResectionPoints((old) => old.length < 3 ? [...old, { ...point, name: '', angle: RESECTION_INITIAL_ANGLES[old.length], set: false }] : old);
  }
  function updateResectionAngle(index, angle) {
    setResectionPoints((old) => old.map((point, i) => i === index ? { ...point, angle, set: true } : point));
  }

  function newExerciseDraft() { return { kind: 'points', title: '', description: '', points: [] }; }
  function editExercise() {
    if (!leaderActive) { notify('請先登入領袖模式。'); return; }
    if (!exerciseDraft) setExerciseDraft(newExerciseDraft());
    setModal('exercise-edit');
  }
  function markExercise() {
    if (!leaderActive || !exerciseDraft) return;
    cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
    setEditing(false); setBearingActive(false); setResectionActive(false); setVisibleTool('exercise');
    setExerciseMarking(true); setMapExpanded(true); setModal(null);
  }
  function addExercisePoint(point) {
    if (!leaderActive || !exerciseDraft) return;
    if (tileStatus !== 'ready') { notify('底圖未完整載入，請先檢查地圖。'); return; }
    if (!inHongKongGrid(point)) { notify('請在香港 UTM 範圍內標記地點。'); return; }
    setExerciseDraft((old) => old.points.length < requiredPoints(old.kind) ? { ...old, points: [...old.points, { ...point, name: '' }] } : old);
  }
  function showExercise(task, { preserveLines = false } = {}) {
    cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
    setEditing(false); setExerciseMarking(false); setBearingActive(false); setResectionActive(false);
    setExercise(task); const persisted = saveExercise(task);
    setMapExpanded(true);
    if (task.kind === 'bearing') {
      setBearingPoints(task.points.map(({ lat, lon, name }) => ({ lat, lon, name })));
      setBearingNames(task.points.map(({ name }) => name));
      setVisibleTool('bearing'); setBearingActive(true);
    } else if (task.kind === 'resection') {
      const matching = preserveLines && resectionPoints.length === task.points.length && resectionPoints.every((point, index) => Math.abs(point.lat - task.points[index].lat) < 1e-7 && Math.abs(point.lon - task.points[index].lon) < 1e-7);
      setResectionPoints(task.points.map((point, index) => ({ ...point, angle: matching ? resectionPoints[index].angle : RESECTION_INITIAL_ANGLES[index], set: matching ? resectionPoints[index].set : false })));
      setVisibleTool('resection'); setResectionActive(true);
    } else setVisibleTool(null);
    setModal(null);
    const first = task.points[0];
    mapRef.current?.goTo(first.lat, first.lon);
    notify(persisted ? '題目已顯示；其他地標可在「題目」清單移動查看。' : '題目已顯示，但未能儲存，重新開啟後需再讀取。');
  }
  function receiveExercise(task) {
    if (exercise || (task.kind === 'bearing' && bearingPoints.length) || (task.kind === 'resection' && resectionPoints.length)) {
      setPendingExercise(task); setModal('exercise-replace');
    } else showExercise(task);
  }
  receiveExerciseRef.current = receiveExercise;
  useEffect(() => {
    function readLink() {
      if (!window.location.hash.startsWith('#exercise=')) return false;
      try {
        const task = decodeExercise(window.location.href);
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        receiveExerciseRef.current(task);
      } catch {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        notify('題目連結無效或版本不支援，請重新索取。');
      }
      return true;
    }
    const linked = readLink();
    if (!linked && exercise) showExercise(exercise, { preserveLines: true });
    window.addEventListener('hashchange', readLink);
    return () => window.removeEventListener('hashchange', readLink);
  }, []);
  useEffect(() => {
    if (!leaderActive && exerciseMarking) {
      setExerciseMarking(false); setVisibleTool(null);
      notify('領袖模式已結束；題目草稿仍保留在本頁。');
    }
  }, [leaderActive, exerciseMarking]);

  function clearExercise() {
    const matchesTask = (points) => points.length === exercise?.points.length && points.every((point, index) => Math.abs(point.lat - exercise.points[index].lat) < 1e-7 && Math.abs(point.lon - exercise.points[index].lon) < 1e-7);
    const clearBearing = exercise?.kind === 'bearing' && matchesTask(bearingPoints);
    const clearResection = exercise?.kind === 'resection' && matchesTask(resectionPoints);
    if (clearBearing) { setBearingPoints([]); setBearingNames([]); setBearingActive(false); }
    if (clearResection) { setResectionPoints([]); setResectionActive(false); }
    if (clearBearing || clearResection) setVisibleTool(null);
    setExercise(null); const removed = saveExercise(null); setModal(null);
    notify(removed ? '已清除題目；路線及 GPX 不受影響。' : '未能從裝置儲存清除題目，重新開啟後可能仍會顯示。');
  }

  function toggleRoutePanel() {
    const collapse = !mapExpanded;
    setMapExpanded(collapse);
    if (collapse && editing) {
      cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。');
      setEditing(false);
      notify('已結束繪畫，路線仍然保留。');
    }
  }

  function setBasemap(basemap) {
    if (basemap === prefs.basemap) return;
    cancelRouting('底圖已更改；沿徑計算已取消。');
    setPrefs((previous) => ({ ...previous, basemap }));
    setTileStatus('loading');
    setContourStatus(basemap === 'hm20c' ? 'loading' : 'not-applicable');
  }

  function addBookmark(name) {
    if (bookmarks.length >= MAX_BOOKMARKS) return { ok: false, message: '書籤數量已達上限，請先刪除舊地點。' };
    const bookmark = makeBookmark(view, name || `地點 ${bookmarks.length + 1}`);
    if (!bookmark) return { ok: false, message: '圖心座標無效，請移動地圖後重試。' };
    const next = [bookmark, ...bookmarks];
    if (!saveBookmarks(next)) return { ok: false, message: '未能儲存書籤，請檢查瀏覽器儲存空間。' };
    setBookmarks(next);
    return { ok: true, message: '已儲存手選圖心；書籤不包含地圖資料。' };
  }

  function removeBookmark(id) {
    const next = bookmarks.filter((bookmark) => bookmark.id !== id);
    if (!saveBookmarks(next)) return { ok: false, message: '未能刪除書籤，請檢查瀏覽器儲存空間。' };
    setBookmarks(next);
    return { ok: true, message: '已刪除書籤；路線及離線地圖不受影響。' };
  }

  function goToPlace(lat, lon, name) {
    cancelRouting('圖心已更改；沿徑計算已取消。');
    mapRef.current?.goTo(lat, lon);
    saveMapCenter({ lat, lon });
    setModal(null);
    notify(`已移至${name}；圖心不代表你的位置。`);
  }

  function openOffline() {
    try {
      setOfflinePlan(usingSheet ? null : planOfflineArea(mapRef.current?.offlineSnapshot()));
      setOfflineJob({ phase: 'idle', message: '', done: 0, total: 0 });
    } catch (error) {
      setOfflinePlan(null);
      setOfflineJob({ phase: 'error', message: error.message || '未能取得地圖範圍。', done: 0, total: 0 });
    }
    setOfflineAreas(loadSavedAreas());
    if (!sheetAbort.current) setSheetJob({ phase: 'idle', message: '', done: 0, total: 0 });
    refreshStoredSheets();
    setModal('offline');
  }

  async function downloadOffline() {
    if (!offlinePlan || offlineAbort.current) return;
    if (navigator.onLine === false) {
      setOfflineJob({ phase: 'error', message: '請先連接網絡，才能下載新畫面。', done: 0, total: 0 });
      return;
    }
    const abort = new AbortController();
    offlineAbort.current = abort;
    setOfflineBusy(true);
    setOfflineJob({ phase: 'preparing', message: '正在準備離線程式及 App 檔案…', done: 0, total: 0 });
    try {
      await prepareOfflineEngine(abort.signal);
      if (abort.signal.aborted) throw new DOMException('已停止', 'AbortError');
      // A request for persistent storage is advisory; mobile OSs can still evict it.
      try { await navigator.storage?.persist?.(); } catch { /* storage persistence is optional */ }
      const tileResult = await downloadAreaTiles(offlinePlan, {
        signal: abort.signal,
        onProgress: ({ done, total, failed, opaqueCount }) => setOfflineJob({ phase: 'tiles', message: `地圖圖磚 ${done} / ${total}${failed ? `（失敗 ${failed}）` : ''}${opaqueCount ? `；${opaqueCount} 張可能佔用較多空間` : ''}`, done, total }),
      });
      if (tileResult.failed) throw new Error(`下載未完整（圖磚失敗 ${tileResult.failed}）；不能視作離線可用，請重試。`);
      let contourResult = { failed: 0 };
      if (offlinePlan.basemap === 'hm20c') {
        setOfflineJob({ phase: 'contours', message: '正在下載 20 米等高線…', done: 0, total: 0 });
        contourResult = await mapRef.current.downloadContours(offlinePlan, {
          signal: abort.signal,
          onProgress: ({ done, total, failed }) => setOfflineJob({ phase: 'contours', message: `等高線區塊 ${done} / ${total}${failed ? `（失敗 ${failed}）` : ''}`, done, total }),
        });
      }
      if (abort.signal.aborted) throw new DOMException('已停止', 'AbortError');
      if (tileResult.failed || contourResult.failed) throw new Error(`下載未完整（圖磚失敗 ${tileResult.failed}，等高線區塊失敗 ${contourResult.failed}）；不能視作離線可用，請重試。`);
      setOfflineAreas(recordSavedArea(offlinePlan));
      setOfflineJob({ phase: 'success', message: '目前畫面已下載；請用飛航模式重新開啟並檢查。', done: 0, total: 0 });
    } catch (error) {
      const stopped = error?.name === 'AbortError' || abort.signal.aborted;
      setOfflineJob({ phase: stopped ? 'stopped' : 'error', message: stopped ? '已停止；尚未完整的畫面不會列為完成。' : (error?.message || '下載未完成，請檢查網絡及儲存空間。'), done: 0, total: 0 });
    } finally {
      offlineAbort.current = null;
      setOfflineBusy(false);
    }
  }

  function openSavedArea(area) {
    cancelRouting('地圖範圍已更改；沿徑計算已取消。');
    if (area.basemap === 'hm20c' && activeSheetId) { saveActiveSheet(null); setActiveSheetId(null); }
    if (area.basemap !== prefs.basemap) setBasemap(area.basemap);
    mapRef.current?.goTo(area.center.lat, area.center.lon);
    saveMapCenter(area.center);
    setModal(null);
    notify('已移到儲存的圖心；請檢查畫面是否完整。');
  }

  async function clearOffline() {
    try {
      await clearSavedAreas();
      setOfflineAreas([]);
      setOfflineJob({ phase: 'idle', message: '已刪除儲存的畫面；路線不受影響，整幅圖幅及書籤亦會保留。', done: 0, total: 0 });
    } catch {
      setOfflineJob({ phase: 'error', message: '未能清除地圖，請檢查瀏覽器儲存設定。', done: 0, total: 0 });
    }
  }

  async function refreshStoredSheets() {
    try { setSheets(await listStoredSheets()); setSheetListError(''); }
    catch { setSheetListError('未能開啟本機圖幅清單；請檢查瀏覽器儲存設定。'); }
  }

  async function processSheet(id, file = null) {
    if (sheetAbort.current || offlineAbort.current) return;
    const abort = new AbortController();
    sheetAbort.current = abort;
    setSheetBusy(true);
    setSheetJob({ phase: 'preparing', message: '正在準備離線程式及 App 檔案…', done: 0, total: 0 });
    try {
      await prepareOfflineEngine(abort.signal);
      if (abort.signal.aborted) throw new DOMException('已停止', 'AbortError');
      try { await navigator.storage?.persist?.(); } catch { /* advisory only */ }
      const input = file || await fetchOfficialSheet(id, {
        signal: abort.signal,
        onProgress: ({ done, total }) => setSheetJob({ phase: 'download', message: `正在由政府直接下載 ${id}：${formatBytes(done)}${total ? ` / ${formatBytes(total)}` : ''}`, done, total }),
      });
      if (abort.signal.aborted) throw new DOMException('已停止', 'AbortError');
      setSheetJob({ phase: 'extract', message: '正在手機本機檢查及解壓檔案…', done: 0, total: 0 });
      const blob = await extractTiff(input, {
        signal: abort.signal,
        onProgress: ({ done, total }) => setSheetJob({ phase: 'extract', message: `正在手機本機解壓：${formatBytes(done)}${total ? ` / ${formatBytes(total)}` : ''}`, done, total }),
      });
      setSheetJob({ phase: 'validate', message: '正在檢查地理座標、圖幅範圍及抽樣解碼…', done: 0, total: 0 });
      const { meta } = await inspectTiff(blob, id, { signal: abort.signal });
      if (abort.signal.aborted) throw new DOMException('已停止', 'AbortError');
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.quota - estimate.usage < blob.size + 1024 * 1024) {
          throw new Error('手機可用離線儲存空間不足；請先刪除不需要的資料再試。');
        }
      } catch (error) {
        if (error?.message?.includes('空間不足')) throw error;
        // Estimation is optional; the atomic IndexedDB write remains decisive.
      }
      if (abort.signal.aborted) throw new DOMException('已停止', 'AbortError');
      setSheetJob({ phase: 'save', message: '正在儲存到這部裝置…', done: 0, total: 0 });
      await saveStoredSheet({ ...meta, source: file ? 'local' : 'official', time: Date.now() }, blob, { signal: abort.signal });
      setSheetJob({ phase: 'success', id, message: `${id} 已儲存在此裝置；範圍及內容仍須核對，請查看並用飛航模式測試。`, done: 0, total: 0 });
      if (activeSheetId === id) setSheetRevision((value) => value + 1);
      await refreshStoredSheets();
    } catch (error) {
      const stopped = error?.name === 'AbortError' || abort.signal.aborted;
      const quota = error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED';
      setSheetJob({ phase: stopped ? 'stopped' : 'error', message: stopped ? '已停止；先前儲存的圖幅不受影響。' : quota ? '手機離線儲存空間不足；先前儲存的圖幅不受影響。' : (error?.message || '圖幅處理未完成；先前儲存的圖幅不受影響。'), done: 0, total: 0 });
    } finally {
      sheetAbort.current = null;
      setSheetBusy(false);
    }
  }

  function showStoredSheet(meta) {
    cancelRouting('圖幅已更改；沿徑計算已取消。');
    const persisted = saveActiveSheet(meta.id);
    setActiveSheetId(meta.id);
    setSheetRevision((value) => value + 1);
    setPrefs((previous) => ({ ...previous, basemap: 'hm20c' }));
    setTileStatus('loading');
    mapRef.current?.goTo(meta.center.lat, meta.center.lon);
    saveMapCenter(meta.center);
    setModal(null);
    notify(persisted ? `已選用 ${meta.id} 試用圖幅；請核對內容及邊界。` : '已選用圖幅，但來源選擇未能保存，重開後需再選。');
  }

  function useOnlineMap() {
    cancelRouting('圖幅已更改；沿徑計算已取消。');
    const persisted = saveActiveSheet(null);
    setActiveSheetId(null);
    setSheetJob({ phase: 'idle', message: persisted ? '已切回原有地形圖；圖幅仍保存在裝置。' : '已切回原有地形圖，但來源選擇未能保存。', done: 0, total: 0 });
    setModal(null);
    notify('已切回原有地形圖；離線時只顯示先前預載畫面。');
  }

  async function removeStoredSheet(id) {
    if (activeSheetId === id) cancelRouting('圖幅已更改；沿徑計算已取消。');
    try {
      await deleteStoredSheet(id);
      if (activeSheetId === id) { saveActiveSheet(null); setActiveSheetId(null); }
      await refreshStoredSheets();
      setSheetJob({ phase: 'idle', message: `已刪除 ${id}；路線及書籤不受影響。${activeSheetId === id ? '已切回原有地形圖。' : ''}`, done: 0, total: 0 });
    } catch { setSheetJob({ phase: 'error', message: '未能刪除圖幅，請檢查手機儲存設定。', done: 0, total: 0 }); }
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_GPX_BYTES) throw new Error('GPX 檔案超過 5 MB，請先精簡。');
      const incoming = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, '') || '匯入的路線');
      if (allRoutePoints(routeRef.current).length) {
        setPendingImport(incoming);
        setModal('replace');
      } else applyImport(incoming);
    } catch (error) { notify(error.message || '未能讀取 GPX 檔案。'); }
  }

  function applyImport(incoming) {
    changeRoute(incoming);
    setEditing(false);
    setPendingImport(null);
    setModal(null);
    const first = allRoutePoints(incoming)[0];
    if (first) mapRef.current?.goTo(first.lat, first.lon);
    notify('GPX 已匯入；比例保持鎖定。');
  }

  function exportFile() {
    if (routingAbort.current) { notify('請先等沿徑計算完成或取消，再下載 GPX。'); return; }
    if (!allRoutePoints(routeRef.current).length) { notify('先繪製或匯入路線，再下載 GPX。'); return; }
    const blob = new Blob([makeGpx(routeRef.current)], { type: 'application/gpx+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(routeRef.current.name.trim() || '山野路線').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')}.gpx`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setModal(null);
    notify('GPX 已準備下載。');
  }

  function openCalibration() {
    setMeasurement(prefs.pixelsPerMm ? (200 / prefs.pixelsPerMm).toFixed(1) : '');
    setModal('scale');
  }

  function saveCalibration() {
    const mm = Number(measurement);
    const pixelsPerMm = 200 / mm;
    if (!Number.isFinite(mm) || mm <= 0 || pixelsPerMm < 2.5 || pixelsPerMm > 12) {
      notify('請輸入 16.7 至 80 毫米之間的量度結果。');
      return;
    }
    setPrefs((previous) => ({ ...previous, pixelsPerMm }));
    setModal(null);
    notify('螢幕比例已校準，地圖保持鎖定。');
  }

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><BrandMark/><div><div className="brand-name">山野地圖<span className="brand-separator"> / </span><span className="brand-en">SCOUT TRAIL MAP</span></div><div className="brand-sub">為每一次山野探索而設</div></div></div>
      <div className="header-right"><span className="header-local"><span className="header-dot"/>路線儲存在此裝置 · 磁石需連網</span><button className={`header-leader ${leaderActive ? 'is-active' : ''}`} onClick={() => setModal('leader')} aria-label={leaderActive ? '領袖模式已開啟' : '開啟領袖模式'}><LockKeyhole size={16}/><span>{leaderActive ? '領袖模式' : '領袖登入'}</span></button><button className="header-about header-exercise" onClick={() => setModal('exercise')}><QrCode size={16}/><span>題目 QR</span></button><button className="header-about" onClick={() => setModal('about')}><Info size={16}/><span>使用說明</span></button></div>
    </header>

    <main className="workspace">
      <aside className={`planner ${mapExpanded ? 'planner--collapsed' : ''}`} aria-label="路線規劃">
        <div className="sheet-handle" />
        <div className="planner-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> YOUR TRAIL PLAN</div><h1>我的路線<span className="heading-period">.</span></h1><p>把想走的路，留在地圖上。</p></div><div className="planner-heading-actions"><span className={`saved-badge ${!saved ? 'saved-badge--error' : ''}`}><span/>{saved ? '自動儲存' : '儲存失敗'}</span><button type="button" className="planner-toggle" aria-controls="route-tools" aria-expanded={!mapExpanded} onClick={toggleRoutePanel}>{mapExpanded ? <>顯示路線<ChevronUp size={15}/></> : <>收起路線<ChevronDown size={15}/></>}</button></div></div>

        <div className="planner-body" id="route-tools">
        <div className="route-card">
          <div className="route-name-label"><span>路線名稱</span><Pencil size={13}/></div>
          <input aria-label="路線名稱" value={route.name} maxLength={100} onChange={(event) => changeRoute({ ...routeRef.current, name: event.target.value }, false)} placeholder="為路線命名" />
          <div className="route-stats"><div className="stat"><span>路線距離</span><strong>{distance}<small> km</small></strong></div><div className="stat"><span>總點數</span><strong>{pointCount + route.waypoints.length}<small> 點</small></strong></div><button className="view-route" aria-label="將路線置中" disabled={!hasPoints} onClick={() => { mapRef.current?.centerRoute(); notify('已將路線置中；鎖定比例下未必能同時顯示全線。'); }}><LocateFixed size={17}/></button></div>
          <div className="distance-note">按路線點計算水平距離；非自動導航</div>
        </div>

        <div className="draw-guide"><div className="guide-icon"><Pencil size={17}/></div><div><strong>{editing ? '沿徑磁石已開啟' : '開始規劃你的旅程'}</strong><p>沿山徑拖畫，放手後貼路。</p></div></div>
        {editing && <p className="draw-mode-hint">每筆接上次終點；手選位置及 IP 送往 BRouter。平移請先完成，失敗不會改畫直線。</p>}
        <div className="draw-actions"><button className={`primary-button ${editing ? 'primary-button--active' : ''}`} onClick={toggleDrawing}>{editing ? <Check size={18}/> : <Pencil size={18}/>}<span>{editing ? '完成繪畫' : '開始繪畫路線'}</span></button><button className="square-action" onClick={undo} disabled={!undoCount} aria-label="撤回上一步" title="撤回上一步"><Undo2 size={19}/></button><button className="square-action" onClick={() => setModal('clear')} disabled={!hasPoints} aria-label="清除路線" title="清除路線"><Trash2 size={18}/></button></div>
        {editing && routingMessage && <p className={`routing-status ${routingBusy ? 'is-busy' : ''}`} role="status">{routingMessage} {routingBusy && <button onClick={() => cancelRouting('已取消沿徑計算；路線未有更改。')}>取消</button>}</p>}

        <div className="desktop-gpx"><div className="section-title"><div><span className="eyebrow">TAKE IT WITH YOU</span><h2>GPX 路線檔案</h2></div><FolderOpen size={19}/></div><p>匯入已有路線，或下載帶走你的計劃。</p><div className="gpx-buttons"><button onClick={() => fileRef.current?.click()}><ArrowUpFromLine size={17}/>匯入 GPX</button><button onClick={exportFile} disabled={!hasPoints}><ArrowDownToLine size={17}/>下載 GPX</button></div></div>
        <div className="planner-safety"><ShieldCheck size={17}/><p><strong>出發前小提醒</strong><br/>帶備紙本地圖及指南針，切勿單靠手機導航。</p></div>
        <div className="planner-foot"><span>MADE FOR THE TRAIL</span><Mountain size={17}/></div>
        </div>
      </aside>

      <section className="map-panel" aria-label="地圖檢視">
        <MapView ref={mapRef} basemap={prefs.basemap} activeSheetId={activeSheetId} sheetRecord={sheetRecord} onSheetError={setSheetError} onMapWarning={notify} pixelsPerMm={prefs.pixelsPerMm} rotation={orientation.angle} route={route} editing={editing} routingBusy={routingBusy} gridVisible={prefs.gridVisible} visibleTool={visibleTool} bearingActive={bearingActive} bearingPoints={bearingPoints} resectionActive={resectionActive} resectionPoints={resectionPoints} exerciseMarking={exerciseMarking} exercisePoints={exercisePoints} leaderActive={leaderActive} onLeaderCenter={setLeaderCenter} onAddBearingPoint={addBearingPoint} onAddResectionPoint={addResectionPoint} onResectionAngle={updateResectionAngle} onAddExercisePoint={addExercisePoint} onDrawStroke={drawStroke} initialCenter={initialCenter} onTileStatus={setTileStatus} onLabelStatus={setLabelStatus} onContourStatus={setContourStatus} onViewChange={setView}/>
        {((!editing && !bearingActive && !resectionActive && !exerciseMarking) || leaderActive) && <div className="map-center-marker" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2v7m0 6v7M2 12h7m6 0h7" className="crosshair-halo"/><path d="M12 2v7m0 6v7M2 12h7m6 0h7" className="crosshair-lines"/><circle cx="12" cy="12" r="1.5"/></svg><span>圖心</span></div>}
        <div className="map-top-left"><div className="map-switch" role="group" aria-label="選擇地圖底圖"><button className={prefs.basemap === 'hm20c' ? 'selected' : ''} aria-pressed={prefs.basemap === 'hm20c'} onClick={() => setBasemap('hm20c')}><Layers2 size={15}/><span>地形圖</span></button><button className={prefs.basemap === 'countryside' ? 'selected' : ''} aria-pressed={prefs.basemap === 'countryside'} onClick={() => setBasemap('countryside')}><Mountain size={15}/><span>郊遊圖</span></button></div><ContourStatus basemap={prefs.basemap} sheetId={activeSheetId} sheetCoverage={sheetRecord?.id === activeSheetId ? sheetRecord.meta?.coverage : undefined} tileStatus={tileStatus} phase={contourStatus} onRetry={() => mapRef.current?.retry()}/><button className="orientation-pill" onClick={() => setModal('orientation')} title="設定地圖方向">{orientationLabel}<ChevronRight size={12}/></button>{!online && <span className="offline-indicator">離線 · 只顯示已存範圍</span>}</div>
        <button className="scale-lock" onClick={openCalibration} aria-label="比例已鎖定，設定螢幕校準"><LockKeyhole size={15}/><span><small>{prefs.pixelsPerMm ? '鎖定 · 已校準' : '鎖定 · 未校準'}</small><strong>1 : {prefs.basemap === 'hm20c' ? '20,000' : '25,000'}<sup>{prefs.pixelsPerMm ? '' : '*'}</sup></strong></span><ChevronRight size={13}/></button>
        <div className="map-controls"><button className="north-indicator" onClick={() => setModal('orientation')} aria-label="設定地圖方向" title="箭頭指示真北；按此設定方向"><span>N</span><Navigation size={17} fill="currentColor" style={{ transform: `rotate(${orientation.angle - 45}deg)` }}/></button><button onClick={() => setModal('regions')} aria-label="選擇地區與書籤" title="選擇地區與書籤"><MapPin size={19}/></button><button className={prefs.gridVisible ? 'is-selected' : ''} aria-pressed={prefs.gridVisible} onClick={() => setPrefs((previous) => ({ ...previous, gridVisible: !previous.gridVisible }))} aria-label="顯示 UTM 網格線" title="顯示或隱藏 1 公里 UTM 網格線"><Grid3X3 size={17}/><span className="map-control-label">格網</span></button><button className={visibleTool === 'bearing' ? 'is-selected' : ''} aria-pressed={bearingActive} onClick={openBearing} aria-label="兩點方位直線" title="兩點方位直線"><Crosshair size={17}/><span className="map-control-label">方位</span></button><button className={visibleTool === 'resection' ? 'is-selected' : ''} aria-pressed={resectionActive} onClick={openResection} aria-label="三角網測法" title="三角網測法"><Triangle size={17}/><span className="map-control-label">三角</span></button><button onClick={openOffline} aria-label="離線預載地圖" title="離線預載地圖"><Download size={17}/><span className="map-control-label">離線</span></button></div>
        {editing && <div className="drawing-indicator"><span/><Pencil size={14}/> {routingBusy ? '正在貼合山徑…' : '沿山徑拖畫 · 放手貼路'}</div>}
        {visibleTool === 'bearing' && <BearingCard points={bearingPoints} names={bearingNames} active={bearingActive} leader={leaderActive} onReset={() => { setBearingPoints([]); setBearingNames([]); }} onFinish={() => setBearingActive(false)} onResume={openBearing}/>}
        {visibleTool === 'resection' && <ResectionCard points={resectionPoints} active={resectionActive} onAngle={updateResectionAngle} onReset={() => setResectionPoints([])} onFinish={() => setResectionActive(false)} onResume={openResection}/>}
        {exerciseMarking && exerciseDraft && <ExerciseMarkCard draft={exerciseDraft} onUndo={() => setExerciseDraft((old) => ({ ...old, points: old.points.slice(0, -1) }))} onClear={() => setExerciseDraft((old) => ({ ...old, points: [] }))} onComplete={() => { setExerciseMarking(false); setModal('exercise-edit'); }} onCancel={() => { setExerciseMarking(false); setModal('exercise-edit'); }}/>}

        {leaderActive && <div className="leader-coordinate" aria-label="領袖圖心八位座標"><small>領袖 · 圖心八位座標（不是 GPS）</small><strong>{centerReference?.text || '圖心超出香港 UTM 範圍'}</strong><span>WGS84 UTM · 10 米方格</span></div>}
        {(tileStatus === 'error' || tileStatus === 'outside') && <div className="map-error" role="alert"><div className="map-error-icon"><AlertTriangle size={21}/></div><strong>{usingSheet ? (tileStatus === 'outside' ? `圖心已離開 ${activeSheetId} 圖幅` : '本機圖幅未能載入') : '地圖暫時未能載入'}</strong><p>{usingSheet ? (tileStatus === 'outside' ? '邊界外沒有此圖幅資料，請移回圖幅內或手動切換圖幅。' : `${sheetError || '請重新讀取或重新匯入檔案。'} 未載入的地圖不能作導航。`) : '請檢查網絡連線，未載入的地圖不能作導航。'}</p><button onClick={() => { if (usingSheet) setSheetRevision((value) => value + 1); mapRef.current?.retry(); }}><RotateCcw size={14}/> 重新載入</button>{usingSheet && <button onClick={openOffline}>管理圖幅</button>}</div>}
        {(tileStatus === 'partial' || (tileStatus !== 'error' && tileStatus !== 'outside' && !usingSheet && prefs.basemap === 'hm20c' && (labelStatus === 'error' || labelStatus === 'partial'))) && <div className="map-partial" role="alert"><AlertTriangle size={15}/> {tileStatus === 'partial' ? (usingSheet ? `部分本機圖幅未能解碼，請勿依賴此畫面導航。${sheetError ? ` ${sheetError}` : ''}` : '部分底圖未載入，請勿依賴此畫面導航。') : '部分地名未載入，請勿依賴此畫面導航。'}<button onClick={() => mapRef.current?.retry()}>重試</button></div>}
        <div className="map-footer"><div className="map-scale"><span>0</span><span style={{ width: `${scaleBar.pixels}px` }} className="scale-line"/><span>{scaleLabel}</span></div><div className="map-credit">{usingSheet ? <><img src="/landsd-logo.svg" alt="地政總署標誌"/><span>香港地政總署／CSDI<br/><a href="https://data.gov.hk/tc-data/dataset/hk-landsd-openmap-development-hkms-digital-b20k" target="_blank" rel="noreferrer">iB20000 試用檔案 · 來源須核對</a></span></> : prefs.basemap === 'hm20c' ? <><img src="/landsd-logo.svg" alt="地政總署標誌"/><span>Map from Lands Department<br/><a href="https://www.arcgis.com/home/item.html?id=566289c35c214178b572a7e934a1cd9a" target="_blank" rel="noreferrer">等高線 iB20000 · Esri China (HK)</a></span></> : <span>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>, SRTM<br/>Map style © <a href="https://opentopomap.org/" target="_blank" rel="noreferrer">OpenTopoMap</a> (CC BY-SA)</span>}</div></div>
        {!leaderActive && <div className="map-coordinates" aria-label="地圖中心座標，並非使用者位置" title="地圖中心座標，並非使用者位置"><span>圖心</span> {formatLatitude(view.lat)} &nbsp; {formatLongitude(view.lon)}</div>}
      </section>
    </main>

    <nav className="mobile-nav" aria-label="主要功能"><button className={!editing && !modal ? 'active' : ''} onClick={() => { cancelRouting('沿徑計算已取消；現有路線沒有被覆蓋。'); setEditing(false); setBearingActive(false); setResectionActive(false); setExerciseMarking(false); setVisibleTool(null); setModal(null); setMapExpanded(true); }}><MapIcon size={20}/><span>地圖</span></button><button className={editing ? 'active' : ''} onClick={toggleDrawing}><Pencil size={19}/><span>繪路</span></button><button className={modal === 'gpx' ? 'active' : ''} onClick={() => setModal('gpx')}><FolderOpen size={20}/><span>GPX</span></button><button className={modal?.startsWith('exercise') ? 'active' : ''} onClick={() => setModal('exercise')}><QrCode size={20}/><span>題目</span></button><button className={modal === 'about' ? 'active' : ''} onClick={() => setModal('about')}><Info size={20}/><span>說明</span></button></nav>
    <input type="file" ref={fileRef} accept=".gpx,application/gpx+xml,application/xml,text/xml" hidden onChange={importFile}/>
    {toast && <div className="toast" role="status">{toast}</div>}

    {modal === 'leader' && <Modal eyebrow="LEADER MODE" title="領袖模式" onClose={() => setModal(null)}><LeaderContent active={leaderActive} onUnlock={(seconds) => { setLeaderUntil(Date.now() + seconds * 1000); setModal(null); notify('領袖模式已開啟；圖心不是你的位置。'); }} onLock={() => { setLeaderUntil(0); setModal(null); notify('已返回成員模式。'); }}/></Modal>}
    {modal === 'exercise' && <Modal eyebrow="MAP EXERCISES" title="題目與 QR Code" onClose={() => setModal(null)}><ExerciseHome leader={leaderActive} exercise={exercise} onCreate={editExercise} onScan={() => setModal('exercise-scan')} onRestore={() => exercise && showExercise(exercise, { preserveLines: true })} onClear={() => setModal('exercise-clear')} onGoPoint={(point, index) => { mapRef.current?.goTo(point.lat, point.lon); setModal(null); setMapExpanded(true); notify(`已移至題目地點 ${String.fromCharCode(65 + index)}；比例保持鎖定。`); }}/></Modal>}
    {modal === 'exercise-edit' && <Modal eyebrow="LEADER EXERCISE" title="領袖設題" onClose={() => setModal(null)}>{leaderActive && exerciseDraft ? <ExerciseEditor draft={exerciseDraft} onChange={setExerciseDraft} onMark={markExercise} onNew={() => setExerciseDraft(newExerciseDraft())} onCancel={() => setModal('exercise')}/> : <p className="modal-intro">領袖模式已結束，請重新登入後繼續設題。</p>}</Modal>}
    {modal === 'exercise-scan' && <Modal eyebrow="SCAN EXERCISE" title="讀取題目" onClose={() => setModal(null)}><ExerciseScanner onRead={receiveExercise} onBack={() => setModal('exercise')}/></Modal>}
    {modal === 'exercise-clear' && <Modal eyebrow="CLEAR EXERCISE" title="清除這題？" onClose={() => setModal('exercise')}><p className="modal-intro">這會移除題目標記，以及屬於此題的方位或三角地標及方向；路線與 GPX 不受影響。</p><div className="modal-actions"><button className="secondary-button" onClick={() => setModal('exercise')}>取消</button><button className="primary-button" onClick={clearExercise}>清除題目</button></div></Modal>}
    {modal === 'exercise-replace' && <Modal eyebrow="READ EXERCISE" title="讀取新題目？" onClose={() => { setPendingExercise(null); setModal(null); }}><p className="modal-intro">讀取會取代目前的題目或方位／三角線；路線與 GPX 不受影響。</p><div className="modal-actions"><button className="secondary-button" onClick={() => { setPendingExercise(null); setModal(null); }}>取消</button><button className="primary-button" onClick={() => { if (pendingExercise) showExercise(pendingExercise); setPendingExercise(null); }}>讀取題目</button></div></Modal>}
    {modal === 'offline' && <Modal eyebrow="OFFLINE MAPS" title="預載離線地圖" onClose={() => { if (sheetAbort.current) sheetAbort.current.abort(); else if (offlineAbort.current) offlineAbort.current.abort(); else setModal(null); }}><OfflineContent plan={offlinePlan} areas={offlineAreas} job={offlineJob} busy={offlineBusy} install={install} onDownload={downloadOffline} onStop={() => offlineAbort.current?.abort()} onSelect={openSavedArea} onClear={clearOffline} sheet={{ center: view, basemap: prefs.basemap, sheets, activeId: activeSheetId, listError: sheetListError, job: sheetJob, busy: sheetBusy, onDownload: (id) => processSheet(id), onImport: processSheet, onStop: () => sheetAbort.current?.abort(), onSelect: showStoredSheet, onDelete: removeStoredSheet, onOnline: useOnlineMap }}/></Modal>}
    {modal === 'gpx' && <Modal eyebrow="ROUTE FILES" title="GPX 路線檔案" onClose={() => setModal(null)}><p className="modal-intro">匯入別人的路線，或將你的計劃下載到其他裝置。</p><div className="modal-option-list"><button onClick={() => fileRef.current?.click()}><span className="option-icon"><ArrowUpFromLine size={20}/></span><span><strong>匯入 GPX</strong><small>支援航跡、路線和獨立航點</small></span><ChevronRight size={18}/></button><button onClick={exportFile} disabled={!hasPoints}><span className="option-icon"><FileDown size={20}/></span><span><strong>下載 GPX</strong><small>儲存目前路線到手機</small></span><ChevronRight size={18}/></button></div><p className="modal-footnote">GPX 檔案只在此裝置處理；使用沿徑磁石時，手畫的錨點會送到 BRouter。未支援的擴充資料不會保留。</p></Modal>}
    {modal === 'replace' && <Modal eyebrow="IMPORT GPX" title="取代現有路線？" onClose={() => { setPendingImport(null); setModal(null); }}><p className="modal-intro">匯入會取代目前的路線。建議先下載現有 GPX 備份；匯入後亦可使用撤回。</p><div className="modal-actions"><button className="secondary-button" onClick={() => { setPendingImport(null); setModal(null); }}>取消</button><button className="primary-button" onClick={() => pendingImport && applyImport(pendingImport)}>確認匯入</button></div></Modal>}
    {modal === 'clear' && <Modal eyebrow="CLEAR ROUTE" title="清除目前路線？" onClose={() => setModal(null)}><p className="modal-intro">路線及航點將從地圖移除。你可以在此瀏覽器內用「撤回」復原。</p><div className="modal-actions"><button className="secondary-button" onClick={() => setModal(null)}>取消</button><button className="danger-button" onClick={() => { changeRoute(emptyRoute()); setEditing(false); setModal(null); notify('路線已清除，可按撤回復原。'); }}>清除路線</button></div></Modal>}
    {modal === 'regions' && <Modal eyebrow="PLACES & BOOKMARKS" title="地點與書籤" onClose={() => setModal(null)}><PlacesContent center={view} bookmarks={bookmarks} regions={REGIONS} onAdd={addBookmark} onRemove={removeBookmark} onGo={goToPlace}/><p className="modal-footnote">地點只作瀏覽中心，並非建議行山路線。</p></Modal>}
    {modal === 'orientation' && <Modal eyebrow="MAP ORIENTATION" title="地圖方向" onClose={() => setModal(null)}>
      <p className="modal-intro">地形圖可按你提供的圖幅角度輕微旋轉；比例不會因此改變。試用圖幅的等高線內容仍須核對。</p>
      <label className="orientation-field" htmlFor="orientation-select">地形圖旋轉方式
        <select id="orientation-select" value={prefs.orientation} onChange={(event) => setPrefs((previous) => ({ ...previous, orientation: event.target.value }))}>
          <option value="auto">自動：按地圖中心選圖幅（估算）</option>
          <option value="true">真北向上：不旋轉</option>
          <optgroup label="手動選擇圖幅（估算）">{SHEET_ROTATIONS.map((sheet) => <option key={sheet.number} value={`sheet:${sheet.number}`}>{sheet.number} · {sheet.name}　{signedAngle(sheet.angle)}</option>)}</optgroup>
        </select>
      </label>
      <div className="orientation-current"><Navigation size={17}/><div><strong>{orientationLabel}</strong><span>{orientation.sheet ? `${orientation.sheet.name} · 參考 UTM ${orientation.sheet.zone}Q` : prefs.basemap === 'countryside' ? '郊遊圖維持真北向上；設定會在地形圖套用。' : '箭頭 N 表示真北，不是磁北。'}</span></div></div>
      <div className="about-warning orientation-warning"><AlertTriangle size={17}/><span>角度為提供的估算，尚未與各版紙圖核實；「＋」為底圖順時針旋轉。HM20C 也標示香港 1980 方格網，不能只憑 UTM 區號確認紙圖方向。這不是磁差校正，請參考實際紙圖的偏角圖及指南針。</span></div>
      <p className="modal-footnote">自動模式按畫面中心及近似數碼圖幅選角度，跨圖幅可能跳變；圖幅外回到真北。手選模式不會隨位置改變。紙圖邊緣與數碼索引可能不同。</p>
      <div className="modal-actions"><button className="primary-button" onClick={() => setModal(null)}>完成</button></div>
    </Modal>}
    {modal === 'scale' && <Modal eyebrow="SCALE CALIBRATION" title="校準螢幕比例" onClose={() => setModal(null)}><p className="modal-intro">不同手機的實際像素大小不同。用尺量度以下線段，輸入實際長度，才能較準確顯示鎖定比例。</p><div className="calibration-ruler"><div className="calibration-line"/><span>請量度這條線的實際長度</span></div><label className="calibration-input">量得長度 <span><input type="number" inputMode="decimal" min="16.7" max="80" value={measurement} onChange={(event) => setMeasurement(event.target.value)} placeholder="例如 50"/> mm</span></label><p className="modal-footnote">未校準時按 96 dpi 估算。校準後比例以畫面中央為準；更改瀏覽器縮放或螢幕方向後請重新量度。地面距離請以比例尺為準。</p><div className="modal-actions"><button className="secondary-button" onClick={() => { setPrefs((previous) => ({ ...previous, pixelsPerMm: null })); setModal(null); notify('已還原預設螢幕估算。'); }}>還原預設</button><button className="primary-button" onClick={saveCalibration}><Ruler size={17}/> 儲存校準</button></div></Modal>}
    {modal === 'about' && <Modal eyebrow="MAP NOTES" title="關於這張地圖" onClose={() => setModal(null)} className="about-modal"><p className="modal-intro">為童軍遠足規劃而設。先了解資料來源，再安心出發。</p><div className="about-block"><span className="about-block-icon"><Layers2 size={18}/></span><div><strong>地形圖 · HM20C 參考</strong><p>地政總署 Topographic Map API 及中文地名，配合 HKMAP 使用的 iB20000 等高線（每 20 米，經 Esri China (HK) 的公開副本，最後修改於 2021 年；原始資料可能更舊或過時）。這不是紙本 HM20C 掃描；等高線載入狀態會顯示在地圖上。另可試用本機匯入的 iB20000 數碼圖幅，不會疊加上述即時底圖、地名或等高線；實際圖幅內容須核對。</p></div></div><div className="about-block"><span className="about-block-icon"><Mountain size={18}/></span><div><strong>郊遊圖 · OpenTopoMap</strong><p>獨立的 OpenStreetMap／SRTM 地形圖，不是地政總署紙本郊區地圖。切換時不會疊加地政總署地名或 iB20000 等高線。</p></div></div><div className="about-block"><span className="about-block-icon"><MapIcon size={18}/></span><div><strong>人手讀圖</strong><p>以地形、地名、等高線、方向及比例尺配合紙圖和指南針辨認位置。本工具不會要求定位權限或自動跟隨位置。</p></div></div><div className="about-block"><span className="about-block-icon"><Crosshair size={18}/></span><div><strong>方格與方位</strong><p>「格網」是 WGS84 UTM 1 公里格，不是香港 1980 格網；「方位」的 A／B 十字選定後固定；「三角」可固定三個地標並拖圓柄轉線。這些線不是山徑，也不加入 GPX。領袖模式以密碼顯示十字圖心八位座標及前後視答案；磁北按 WMM2025 估算，須核對紙圖磁差與手機日期。</p></div></div><div className="about-block"><span className="about-block-icon"><LockKeyhole size={18}/></span><div><strong>比例與離線</strong><p>比例分別鎖定在螢幕估算的 1:20,000 / 1:25,000；須量度螢幕才可校準。可預載目前畫面，或試用 iB20000 圖幅下載／本機匯入；試用圖幅內容及郊遊圖整區尚未驗證，請先以飛航模式實測。</p></div></div><div className="about-block"><span className="about-block-icon"><Info size={18}/></span><div><strong>其他等高線資料</strong><p>地政總署 iB1000 在適用地區有 2 米等高線；<a href="https://www.arcgis.com/home/item.html?id=86815de825f74309aa580033dbbff44e" target="_blank" rel="noreferrer">Esri 公開副本</a>於 2022 年更新，部分原始資料可能更舊，亦非政府即時 API。線距較密不等於精度較高；為保留 20 米 HM20C 參考，暫不取代現有圖層。</p></div></div><div className="about-warning"><AlertTriangle size={17}/><span>沿徑磁石依賴 BRouter／OpenStreetMap 路網及網絡，並不保證山徑可通行或安全；方位線及三角線不是山徑。地圖資料可能有誤或過時，出發前請核對官方資訊，帶備紙本地圖及指南針。</span></div><p className="modal-footnote">使用地政總署地圖須遵守 <a href="https://portal.csdi.gov.hk/csdi-webpage/doc/TNC" target="_blank" rel="noreferrer">LandsD Map API 使用條款</a>。<br/><a href="/third-party-licenses.txt" target="_blank" rel="noreferrer">第三方軟件授權</a>。</p></Modal>}
  </div>;
}

export default App;
