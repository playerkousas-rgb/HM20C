import React, { useEffect, useRef, useState } from 'react';
import { Minimize2, RotateCcw, Triangle, X } from 'lucide-react';
import { normalizeAngle } from '../lib/bearing';
import { gridToMagnetic, magneticToGrid } from '../lib/resection';
import { zoneForLongitude } from '../lib/utm';

function AngleField({ point, index, reference, onChange }) {
  const [error, setError] = useState('');
  const displayed = reference === 'magnetic' ? gridToMagnetic(point, point.angle) : point.angle;
  const value = point.set && displayed !== null ? (Math.round(normalizeAngle(displayed) * 10) / 10 % 360).toFixed(1) : '';
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  function commit() {
    if (!draft.trim()) { setDraft(value); setError(''); return; }
    const number = Number(draft);
    if (!Number.isFinite(number) || number < 0 || number > 360) { setError('請輸入 0 至 360 度'); return; }
    const grid = reference === 'magnetic' ? magneticToGrid(point, number) : normalizeAngle(number);
    if (grid === null) { setError('磁北估算不可用，請改用方格北。'); return; }
    setError(''); onChange(index, grid);
  }
  const letter = String.fromCharCode(65 + index);
  return <div className={`resection-angle resection-angle-${letter.toLowerCase()}`}>
    <label htmlFor={`resection-angle-${index}`}><b>{letter}</b><span>{point.name || `地標 ${letter}`}<small>{zoneForLongitude(point.lon)}Q · {point.set ? '已設定' : '示意線'}</small></span></label>
    <span><input id={`resection-angle-${index}`} type="number" inputMode="decimal" min="0" max="360" step="0.1" placeholder="—" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} aria-label={`${letter} 後視方位`}/>°</span>
    {error && <small className="resection-input-error" role="alert">{error}</small>}
  </div>;
}

export default function ResectionCard({ points, active, onAngle, onReset, onFinish, onResume }) {
  const [minimized, setMinimized] = useState(true);
  const [reference, setReference] = useState('grid');
  const previousCount = useRef(points.length);
  useEffect(() => {
    if (!points.length) setMinimized(true);
    else if (active && previousCount.current < 3 && points.length === 3) setMinimized(true);
    previousCount.current = points.length;
  }, [active, points.length]);
  if (!active && !points.length) return null;
  if (active && minimized) return <div className="bearing-card bearing-card--compact resection-card" aria-label="三角網測工具">
    <div className="bearing-card-heading"><span><Triangle size={15}/> 三角網測</span></div>
    <p className="bearing-hint">{points.length < 3 ? `點選地標 A、B、C（${points.length}/3），可平移。` : '拖圓柄轉線，線由地標指向圓柄。'}</p>
    <div className="bearing-card-actions"><button onClick={() => setMinimized(false)}>展開工具</button><button onClick={onFinish}>完成</button></div>
  </div>;
  const magneticUnavailable = reference === 'magnetic' && points.some((point) => gridToMagnetic(point, point.angle) === null);
  return <div className={`bearing-card resection-card ${!active ? 'bearing-card--compact' : ''}`} aria-label="三角網測工具">
    <div className="bearing-card-heading"><span><Triangle size={15}/> {active ? '三角網測法' : '三角線已保留'}</span>
      {active && <div className="bearing-heading-actions"><button onClick={() => setMinimized(true)} aria-label="縮小三角網測工具"><Minimize2 size={15}/></button><button onClick={onFinish} aria-label="完成三角網測"><X size={16}/></button></div>}</div>
    {active && <>
      <p className="bearing-hint">{points.length < 3 ? `先點選已知地標 A、B、C（已選 ${points.length}/3）；可平移地圖。` : '地標固定；拖圓柄或輸入後視角，線由地標向圓柄方向延伸。'}</p>
      {points.length > 0 && <>
        <label className="resection-reference">輸入／顯示基準 <select value={reference} onChange={(event) => setReference(event.target.value)} aria-label="三角線方位基準"><option value="grid">方格北</option><option value="magnetic">磁北（估算）</option></select></label>
        {points.map((point, index) => <AngleField key={index} point={point} index={index} reference={reference} onChange={onAngle}/>)}
        {magneticUnavailable && <p className="bearing-warning">手機日期不在 WMM2025 有效期（2025–2029）；請用方格北。</p>}
        <p className="resection-note">輸入的是「地標指回你」的後視角；數字是你設定的方向，不是答案。虛線是未設定的示意線；圓柄方向是地標指回自己。</p>
      </>}
      <details className="resection-details"><summary>如何量度及判讀？</summary><p>在同一位置向三個可辨認的地標量度磁方位，各加或減 180° 得後視；由地標向自己方向畫線。三線未相交於一點時形成誤差三角形，須再核對，不等於 GPS 定位。</p><p>若以方格北輸入，先按紙圖的磁差及方格收斂角轉換；不能把磁北直接當方格北。磁北選項用 WMM2025 按地標位置及手機日期估算，並非現場磁差；跨區時各用地標的 UTM 區。</p></details>
    </>}
    <div className="bearing-card-actions">{!active && <button onClick={onResume}>查看三角線</button>}<button onClick={onReset} disabled={!points.length}><RotateCcw size={13}/>重設地標</button>{active && <button onClick={onFinish}>完成</button>}</div>
  </div>;
}
