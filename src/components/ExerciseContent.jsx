import React, { useEffect, useRef, useState } from 'react';
import { Camera, Copy, ImagePlus, MapPin, QrCode, RotateCcw, ScanLine, Share2 } from 'lucide-react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { exerciseUrl, MAX_EXERCISE_POINTS, validateExercise } from '../lib/exercise';
import { decodeShared } from '../lib/questionSet';

const labels = { points: '地圖標記', bearing: '兩點方位', resection: '三角網測' };
export function requiredPoints(kind) { return kind === 'bearing' ? 2 : kind === 'resection' ? 3 : MAX_EXERCISE_POINTS; }
export function enoughPoints(draft) { return draft.kind === 'points' ? draft.points.length >= 1 : draft.points.length === requiredPoints(draft.kind); }

export function ExerciseHome({ leader, exercise, memberSet, onCreate, onBank, onMember, onScan, onRestore, onClear, onGoPoint }) {
  return <div className="exercise-content">
    <p className="modal-intro">領袖標記地點後產生 QR Code；成員可在這裏讀取，地標會顯示在地圖上。</p>
    <div className="modal-option-list">
      <button onClick={onScan}><span className="option-icon"><ScanLine size={20}/></span><span><strong>讀取題目 QR Code</strong><small>可讀取活動、題目、答案 QR 或 JSON</small></span></button>
      {memberSet && <button onClick={onMember}><span className="option-icon"><MapPin size={20}/></span><span><strong>查看多題套題</strong><small>{memberSet.name} · {memberSet.questions.length} 題</small></span></button>}
      {leader && <button onClick={onBank}><span className="option-icon"><QrCode size={20}/></span><span><strong>領袖題庫及同步活動</strong><small>多題、答案分享與線上更新</small></span></button>}
      {leader && <button onClick={onCreate}><span className="option-icon"><QrCode size={20}/></span><span><strong>領袖設題及分享</strong><small>選類型、在地圖標記，再產生 QR Code</small></span></button>}
    </div>
    {exercise && <div className="exercise-current"><div className="exercise-current-heading"><strong>{exercise.title}</strong><span>{labels[exercise.kind]}</span></div>
      {exercise.description && <p>{exercise.description}</p>}
      <ol>{exercise.points.map((point, index) => <li key={index}><button onClick={() => onGoPoint(point, index)}><b>{String.fromCharCode(65 + index)}</b> {point.name || '未命名地點'} <span>移至地點 →</span></button></li>)}</ol>
      <div className="exercise-current-actions"><button onClick={onRestore}><MapPin size={15}/>重新顯示題目</button><button onClick={onClear}>清除題目</button></div>
    </div>}
    <p className="modal-footnote">單題 QR 內容自包含；多題可用離線 QR，或在已設定資料庫後使用連網活動。讀取題目不會取代路線或 GPX。</p>
  </div>;
}

export function ExerciseEditor({ draft, onChange, onMark, onCancel, onNew }) {
  const [qr, setQr] = useState(null);
  const [message, setMessage] = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);
  const maximum = requiredPoints(draft.kind);
  function update(key, value) { setQr(null); setMessage(''); onChange({ ...draft, [key]: value }); }
  function pointName(index, name) {
    update('points', draft.points.map((point, i) => i === index ? { ...point, name } : point));
  }
  async function generate() {
    try {
      if (!enoughPoints(draft)) throw new Error(draft.kind === 'points' ? '請先在地圖標記至少一個點。' : `請先標記 ${maximum} 個地標。`);
      if (!draft.title.trim()) throw new Error('請輸入題目名稱。');
      validateExercise(draft);
      const link = exerciseUrl(draft, `${window.location.origin}${window.location.pathname}`);
      const options = { errorCorrectionLevel: 'M', margin: 4, width: 320, color: { dark: '#183b2d', light: '#ffffff' } };
      if (QRCode.create(link, options).version > 17) throw new Error('QR Code 太密，請縮短題目或地點名稱。');
      const image = await QRCode.toDataURL(link, options);
      setQr({ image, link }); setMessage('');
    } catch (error) { setMessage(error?.message || '未能產生 QR Code。'); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(qr.link); setMessage('分享連結已複製。'); }
    catch { setMessage('無法自動複製，請長按下方連結複製。'); }
  }
  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: draft.title, url: qr.link });
      else await copy();
    } catch (error) { if (error?.name !== 'AbortError') setMessage('無法分享，請改用複製連結或下載 QR 圖片。'); }
  }
  return <div className="exercise-editor">
    <p className="modal-intro">選擇題型，然後到地圖點選地標。成員讀取後會自動看到相同的點。</p>
    <label>題型<select aria-label="題目類型" value={draft.kind} disabled={draft.points.length > 0} onChange={(event) => update('kind', event.target.value)}><option value="points">地圖標記（1–6 點）</option><option value="bearing">兩點方位（A、B）</option><option value="resection">三角網測（A、B、C）</option></select></label>
    {draft.points.length > 0 && <small className="exercise-subtle">更改題型須先重設地標。</small>}
    <label>題目名稱<input aria-label="題目名稱" maxLength={28} value={draft.title} placeholder="例如：西貢方位練習" onChange={(event) => update('title', event.target.value)}/></label>
    <label>題目說明 <small>（選填，最多 80 字）</small><textarea aria-label="題目說明" maxLength={80} rows={2} value={draft.description} placeholder="例如：量度 A 至 B 的前視方位" onChange={(event) => update('description', event.target.value)}/></label>
    <div className="exercise-editor-heading"><strong>地標 {draft.points.length} / {maximum}</strong><button onClick={onMark}><MapPin size={15}/> {draft.points.length ? '返回地圖選點' : '到地圖標記'}</button></div>
    {draft.points.map((point, index) => <label className="exercise-name" key={index}><b>{String.fromCharCode(65 + index)}</b><input aria-label={`地點 ${String.fromCharCode(65 + index)} 名稱`} maxLength={12} value={point.name} placeholder={`地點 ${String.fromCharCode(65 + index)} 名稱（選填）`} onChange={(event) => pointName(index, event.target.value)}/></label>)}
    {message && <p className="exercise-message" role="status">{message}</p>}
    <div className="modal-actions"><button className="secondary-button" onClick={onCancel}>返回</button><button className="primary-button" onClick={generate} disabled={!enoughPoints(draft)}><QrCode size={17}/>產生 QR Code</button></div>
    {!resetConfirm ? <button className="exercise-new" onClick={() => setResetConfirm(true)}>建立新題目</button> : <div className="exercise-reset-confirm"><span>清除目前草稿並重新開始？</span><button onClick={() => setResetConfirm(false)}>取消</button><button onClick={() => { setQr(null); setResetConfirm(false); onNew(); }}>確定</button></div>}
    <p className="exercise-subtle">草稿只暫存在目前頁面，重新整理會消失；請先儲存 QR 圖片或分享連結。</p>
    {qr && <div className="exercise-qr"><strong>題目 QR Code</strong><img src={qr.image} width="320" height="320" alt="題目 QR Code"/><span>讓成員在 App 按「題目 → 讀取」。亦可用一般相機開啟連結。</span><div className="exercise-share-actions"><button onClick={share}><Share2 size={15}/>分享連結</button><button onClick={copy}><Copy size={15}/>複製</button><a href={qr.image} download="山野地圖-題目.png">下載 QR</a></div><details><summary>顯示分享連結</summary><textarea aria-label="題目分享連結" readOnly value={qr.link} rows={3}/></details><p>QR 內含題目及所有地標位置，任何人都能讀取及修改；請勿放入密碼或敏感資料。</p></div>}
  </div>;
}

export function ExerciseMarkCard({ draft, limit, onUndo, onClear, onComplete, onCancel }) {
  const maximum = limit || requiredPoints(draft.kind);
  const complete = limit ? draft.points.length === limit : enoughPoints(draft);
  return <div className="bearing-card exercise-mark-card" aria-label="題目地標標記">
    <div className="bearing-card-heading"><span><MapPin size={15}/> 領袖標記地標</span></div>
    <p className="bearing-hint">{draft.points.length >= maximum ? '已選滿；可返回題目編輯名稱。' : `在地圖點選 ${String.fromCharCode(65 + draft.points.length)}；拖動地圖可平移。`}（{draft.points.length}/{maximum}）</p>
    <div className="bearing-card-actions"><button onClick={onUndo} disabled={!draft.points.length}>撤回一點</button><button onClick={onClear} disabled={!draft.points.length}><RotateCcw size={13}/>重選</button><button onClick={onComplete} disabled={!complete}>完成選點</button><button onClick={onCancel}>返回</button></div>
  </div>;
}

function readQrImage(image, maxDimension = 1400) {
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
            const text = readQrImage(video.current, 960);
            if (text) {
              try { accept(text); return; } catch { setError('這不是有效的山野地圖題目；請對準領袖的 QR Code。'); }
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
      try { accept(await file.text()); } catch (cause) { if (live.current) setError(cause?.message || '未能讀取 JSON。'); }
      finally { if (live.current) setBusy(false); }
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      const text = readQrImage(image);
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
