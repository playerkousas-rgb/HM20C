import React, { useEffect, useRef, useState } from 'react';
import { Crosshair, Minimize2, RotateCcw, X } from 'lucide-react';
import { bearingAnswers, formatBearing } from '../lib/bearing';

export default function BearingCard({ points, active, leader, onReset, onFinish, onResume }) {
  const [minimized, setMinimized] = useState(false);
  const previousCount = useRef(points.length);
  useEffect(() => {
    if (!points.length) setMinimized(false);
    else if (active && !leader && previousCount.current < 2 && points.length === 2) setMinimized(true);
    previousCount.current = points.length;
  }, [active, leader, points.length]);
  useEffect(() => { if (leader && active && points.length === 2) setMinimized(false); }, [leader, active, points.length]);
  if (!active && !points.length) return null;
  const date = new Date();
  const answers = leader && points.length === 2 ? bearingAnswers(points[0], points[1], date) : null;
  if (active && minimized) return <div className="bearing-card bearing-card--compact" aria-label="兩點方位工具">
    <div className="bearing-card-heading"><span><Crosshair size={15}/> A / B 方位線</span></div>
    <div className="bearing-card-actions"><button onClick={() => setMinimized(false)}>{leader ? '展開答案' : '展開工具'}</button><button onClick={onFinish}>完成</button></div>
  </div>;
  return <div className={`bearing-card ${!active ? 'bearing-card--compact' : ''}`} aria-label="兩點方位工具">
    <div className="bearing-card-heading"><span><Crosshair size={15}/> {active ? '兩點方位直線' : '方位線已保留'}</span>
      {active && <div className="bearing-heading-actions"><button onClick={() => setMinimized(true)} aria-label="縮小方位工具" title="縮小方位工具"><Minimize2 size={15}/></button><button onClick={onFinish} aria-label="完成方位量度" title="完成方位量度"><X size={16}/></button></div>}</div>
    {active && <p className="bearing-hint">{points.length === 0 ? '先在地圖點選 A，再點選 B。' : points.length === 1 ? '再點選 B；完成後可拖動十字。' : '拖動 A / B 十字；沿方格北量度。'}</p>}
    {active && leader && points.length === 2 && (answers ? <div className="bearing-answers">
      <div className="bearing-answer-title">領袖答案（約） · {answers.zone}Q 方格北</div>
      <div className="bearing-answer-head"><span>基準</span><span>前視 A→B</span><span>後視 B→A</span></div>
      <div><span>方格</span><strong>{formatBearing(answers.forwardGrid)}</strong><strong>{formatBearing(answers.backGrid)}</strong></div>
      <div><span>真北</span><strong>{formatBearing(answers.forwardTrue)}</strong><strong>{formatBearing(answers.backTrue)}</strong></div>
      <div><span>磁北*</span><strong>{formatBearing(answers.forwardMagnetic)}</strong><strong>{formatBearing(answers.backMagnetic)}</strong></div>
      {answers.crossesZone && <small>跨區：以 A 點 {answers.zone}Q 方格北計算。</small>}
      {answers.forwardMagnetic === null && <small>磁北不可用：請核對手機日期（2025–2029）。</small>}
      <details className="bearing-details"><summary>兩點座標及磁差說明</summary><small>A {answers.pointA?.text}<br/>B {answers.pointB?.text}<br/>*WMM2025 按手機日期 {Number.isFinite(date.valueOf()) ? date.toLocaleDateString('zh-HK') : '無效'} 及海平面估算；請核對紙圖磁差，留意附近金屬及磁場。</small></details>
    </div> : <p className="bearing-warning">兩點須相距至少 10 米，並在香港 UTM 範圍內。</p>)}
    <div className="bearing-card-actions">
      {!active && <button onClick={onResume}>調整方位線</button>}
      <button onClick={onReset} disabled={!points.length}><RotateCcw size={13}/>{active ? '重設兩點' : '清除方位線'}</button>
      {active && <button onClick={onFinish}>完成</button>}
    </div>
  </div>;
}
