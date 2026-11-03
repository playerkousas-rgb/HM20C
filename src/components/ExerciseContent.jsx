import React, { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, MapPin, QrCode, RefreshCw, RotateCcw, ScanLine } from 'lucide-react';
import { decodeShared } from '../lib/questionSet';
import { loadQrDecoder } from '../lib/qrCodec';

const labels = { points: '地圖標記', bearing: '兩點方位', resection: '三角網測' };

export function ExerciseHome({ leader, exercise, memberSet, onBank, onMember, onScan, onRestore, onClear, onGoPoint }) {
  return <div className="exercise-content">
    <p className="modal-intro">成員在這裏讀取題庫 QR；領袖登入後可建立多套題組，每套均可包含多題。</p>
    <div className="modal-option-list">
      <button onClick={onScan}><span className="option-icon"><ScanLine size={20}/></span><span><strong>讀取題目 QR Code</strong><small>可讀取活動、題目、答案 QR 或 JSON</small></span></button>
      {memberSet && <button onClick={onMember}><span className="option-icon"><MapPin size={20}/></span><span><strong>查看多題套題</strong><small>{memberSet.name} · {memberSet.questions.length} 題</small></span></button>}
      {leader && <button onClick={() => onBank('activity')}><span className="option-icon"><RefreshCw size={20}/></span><span><strong>活動題庫</strong><small>連網改題、公布答案；成員手動更新</small></span></button>}
      {leader && <button onClick={() => onBank('fixed')}><span className="option-icon"><QrCode size={20}/></span><span><strong>固定題庫</strong><small>每套多題，題目及答案各有離線 QR</small></span></button>}
    </div>
    {exercise && <div className="exercise-current"><div className="exercise-current-heading"><strong>{exercise.title}</strong><span>{labels[exercise.kind]}</span></div>
      {exercise.description && <p>{exercise.description}</p>}
      <ol>{exercise.points.map((point, index) => <li key={index}><button onClick={() => onGoPoint(point, index)}><b>{String.fromCharCode(65 + index)}</b> {point.name || '未命名地點'} <span>移至地點 →</span></button></li>)}</ol>
      <div className="exercise-current-actions"><button onClick={onRestore}><MapPin size={15}/>重新顯示題目</button><button onClick={onClear}>清除題目</button></div>
    </div>}
    <p className="modal-footnote">固定題庫改題後要重新分享 QR；活動題庫更新時 QR 不變。讀取題目不會取代路線或 GPX。</p>
  </div>;
}

export function ExerciseMarkCard({ draft, limit, answer, onUndo, onClear, onComplete, onCancel }) {
  const maximum = limit;
  const complete = Boolean(limit) && draft.points.length === limit;
  return <div className="bearing-card exercise-mark-card" aria-label="題目地標標記">
    <div className="bearing-card-heading"><span><MapPin size={15}/> 領袖標記地標</span></div>
    <p className="bearing-hint">{draft.points.length >= maximum ? '已選滿；可返回題目編輯名稱。' : `在地圖點選 ${String.fromCharCode(65 + draft.points.length)}；拖動地圖可平移。`}（{draft.points.length}/{maximum}）</p>
    {answer && <p className="marking-answer">領袖答案：{answer}</p>}
    <div className="bearing-card-actions"><button onClick={onUndo} disabled={!draft.points.length}>撤回一點</button><button onClick={onClear} disabled={!draft.points.length}><RotateCcw size={13}/>重選</button><button onClick={onComplete} disabled={!complete}>完成選點</button><button onClick={onCancel}>返回</button></div>
  </div>;
}

function readQrImage(image, jsQR, maxDimension = 1400) {
  const width = image.videoWidth || image.naturalWidth || image.width;
  const height = image.videoHeight || image.naturalHeight || image.height;
  if (!width || !height || width * height > 80_000_000) throw new Error('圖片尺寸無效或過大。');
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' })?.data || null;
}

export function ExerciseScanner({ onRead, onBack }) {
  const video = useRef(null); const stream = useRef(null); const timer = useRef(null); const live = useRef(true); const fileInput = useRef(null);
  const [scanning, setScanning] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function stop() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    if (live.current) { setScanning(false); setBusy(false); }
  }
  useEffect(() => {
    const hide = () => { if (document.hidden && stream.current) { stop(); setError('相機已暫停；返回後可重新開啟。'); } };
    document.addEventListener('visibilitychange', hide);
    return () => { live.current = false; stop(); document.removeEventListener('visibilitychange', hide); };
  }, []);
  function accept(text) {
    const packet = decodeShared(text);
    onRead(packet); stop();
  }
  async function startCamera() {
    if (busy || scanning) return;
    setError(''); setBusy(true);
    if (!navigator.mediaDevices?.getUserMedia) { setError('此瀏覽器不能開啟相機；請用 HTTPS 或選擇 QR 圖片。'); setBusy(false); return; }
    let decoder;
    try { decoder = await loadQrDecoder(); }
    catch (cause) { if (live.current) { setError(cause.message); setBusy(false); } return; }
    if (!live.current || document.hidden) { if (live.current) { setBusy(false); setError('相機已暫停；返回後可重新開啟。'); } return; }
    try {
      const result = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (!live.current || document.hidden) { result.getTracks().forEach((track) => track.stop()); if (live.current) { setBusy(false); setError('相機已暫停；返回後可重新開啟。'); } return; }
      stream.current = result; video.current.srcObject = result;
      await video.current.play();
      if (!live.current) { stop(); return; }
      setScanning(true); setBusy(false);
      const scan = () => {
        if (!live.current || !stream.current) return;
        try {
          if (video.current?.readyState >= 2) {
            const text = readQrImage(video.current, decoder, 960);
            if (text) {
              try { accept(text); return; } catch (cause) { setError(cause?.message || '這不是有效的山野地圖題目；請對準領袖的 QR Code。'); }
            }
          }
        } catch { /* Wait for the next camera frame. */ }
        timer.current = setTimeout(scan, 180);
      };
      scan();
    } catch {
      stop();
      if (live.current) setError('相機未獲授權或無法開啟；請檢查手機權限，或選擇 QR 圖片。');
    }
  }
  async function selectImage(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { setError('圖片超過 12 MB，請選較小的 QR 圖片。'); return; }
    setError(''); setBusy(true);
    if (file.name.toLowerCase().endsWith('.json') || file.type === 'application/json') {
      try { const text = await file.text(); if (live.current) accept(text); } catch (cause) { if (live.current) setError(cause?.message || '未能讀取 JSON。'); }
      finally { if (live.current) setBusy(false); }
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      const decoder = await loadQrDecoder();
      if (!live.current) return;
      const text = readQrImage(image, decoder);
      if (!text) throw new Error('圖片內找不到 QR Code，請試用清晰圖片。');
      accept(text);
    } catch (cause) { if (live.current) setError(cause?.message || '未能讀取圖片，請重試。'); }
    finally { URL.revokeObjectURL(url); if (live.current) setBusy(false); }
  }
  return <div className="exercise-scanner">
    <p className="modal-intro">對準領袖的活動、題目或答案 QR；亦可選擇 QR 圖片或 JSON。圖片及相機畫面只在此手機處理。</p>
    <video ref={video} className={scanning ? 'is-scanning' : ''} muted playsInline aria-label="QR 掃描相機" />
    {error && <p className="leader-error" role="alert">{error}</p>}
    <div className="exercise-scan-actions">{scanning ? <button className="secondary-button" onClick={stop}>停止相機</button> : <button className="primary-button" onClick={startCamera} disabled={busy}><Camera size={17}/>開啟相機</button>}<button className="secondary-button" onClick={() => fileInput.current?.click()} disabled={busy}><ImagePlus size={17}/>選擇 QR 圖片／JSON</button></div>
    <input ref={fileInput} type="file" accept="image/*,.json,application/json" aria-label="選擇題目 QR 圖片" hidden onChange={selectImage}/>
    <div className="modal-actions"><button className="secondary-button" onClick={() => { stop(); onBack(); }}>返回</button></div>
    <p className="modal-footnote">相機需要 HTTPS 及你的授權；關閉或離開掃描頁會停止相機。不會要求 GPS 定位。</p>
  </div>;
}
