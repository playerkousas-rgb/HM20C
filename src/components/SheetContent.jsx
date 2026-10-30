import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, FolderOpen, Map as MapIcon, Trash2 } from 'lucide-react';
import { formatBytes } from '../sheets/files';
import { sheetAtCenter, sheetUrl } from '../sheets/geometry';

export default function SheetContent({ center, basemap, sheets, activeId, listError, job, busy, onDownload, onImport, onStop, onSelect, onDelete, onOnline, installGuide }) {
  const [selected, setSelected] = useState(() => sheetAtCenter(center.lat, center.lon) || 'T8');
  const [deleting, setDeleting] = useState(null);
  const inputRef = useRef(null);
  const statusRef = useRef(null);
  const justSaved = job.phase === 'success' ? sheets.find((item) => item.id === job.id) : null;
  useEffect(() => {
    // When returning from the phone's file picker, the status may otherwise
    // be above the current scroll position and look as if nothing happened.
    if (['success', 'error', 'stopped'].includes(job.phase)) statusRef.current?.scrollIntoView({ block: 'nearest' });
  }, [job.phase, job.message, justSaved?.id]);
  return <div className="sheet-download">
    <p className="modal-intro sheet-intro">直接由政府下載 <strong>iB20000 數碼圖幅</strong>，只存於手機；不是紙圖掃描。</p>
    <div className="offline-limitation"><AlertTriangle size={17}/><div><strong>整幅功能試用中</strong><span>實際政府 TIFF、等高線及手機效能未核實。出發前須飛航模式重開並對照紙圖；勿依賴試用版導航。</span></div></div>
    {basemap === 'countryside' && <p className="sheet-countryside-note">你正使用獨立郊遊圖；整幅郊遊圖來源尚未提供。開啟以下圖幅時會切回地形圖，不會混合兩種地圖。</p>}
    <label className="sheet-picker" htmlFor="sheet-number"><span>選擇數碼圖幅</span><select id="sheet-number" value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
      {Array.from({ length: 18 }, (_, i) => <option key={i + 1} value={`T${i + 1}`}>iB20000 · T{i + 1}</option>)}
    </select></label>
    <div className="sheet-primary-action">
      {busy ? <button className="secondary-button" onClick={onStop}>停止圖幅處理</button>
        : <button className="primary-button" onClick={() => onDownload(selected)}><Download size={17}/> 嘗試直接下載 {selected}</button>}
    </div>
    {job.message && <div ref={statusRef} className={`offline-job ${job.phase === 'error' || job.phase === 'stopped' ? 'offline-job--warn' : ''}`} role="status"><strong>{job.message}</strong>{job.total > 0 && <progress value={Math.min(job.done, job.total)} max={job.total}/>} {justSaved && <button className="sheet-job-open" onClick={() => onSelect(justSaved)}>立即查看 {justSaved.id} ›</button>}</div>}
    <p className="sheet-picker-note">預選按圖心估算；數碼圖幅與紙本 HM20C 邊界未逐一核實。<a href="https://www.landsd.gov.hk/doc/en/mapping/digital-map/common/index/ib20_index.pdf" target="_blank" rel="noopener noreferrer">查看官方數碼圖幅索引 ↗</a></p>
    {installGuide}
    <div className="sheet-fallback"><strong>直連失敗？用手機本機匯入</strong><p>1. 在官方網頁下載 {selected} TIFF（或 ZIP）。<br/>2. 返回這個 App，從「檔案」選取下載的檔案。</p>
      <div className="sheet-fallback-actions"><a href={sheetUrl(selected)} target="_blank" rel="noopener noreferrer">官方下載 {selected} ↗</a><a href={sheetUrl(selected, true)} target="_blank" rel="noopener noreferrer">官方產品頁 ↗</a></div>
      <input ref={inputRef} id="sheet-file" className="visually-hidden-file" type="file" accept=".tif,.tiff,.zip,image/tiff,application/zip,application/x-zip-compressed" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onImport(selected, file); }}/>
      <button className="sheet-file-button" disabled={busy} onClick={() => inputRef.current?.click()}><FolderOpen size={16}/> 選取手機 TIFF／ZIP</button>
      <small>檔案只在手機處理，不上傳至 Arena、Vercel 或本 App；每次匯入一張，檔案上限 200 MB。</small>
    </div>
    <div className="offline-safety"><AlertTriangle size={16}/><span>只檢查座標、範圍抽樣及少量像素，不能保證全幅資料、地名或等高線正確。瀏覽器可能清除檔案；圖幅邊界外會留白，跨幅須手動切換。請帶紙圖及指南針。</span></div>
    <div className="offline-list-heading"><strong>此裝置的數碼圖幅</strong><small>{sheets.length} 張</small></div>
    {listError ? <p className="sheet-list-error" role="alert">{listError}</p> : sheets.length ? <div className="saved-sheets">{sheets.map((item) => <div className="saved-sheet" key={item.id}>
      <div className="saved-sheet-info"><MapIcon size={17}/><div><strong>{item.id} {activeId === item.id ? '· 地形圖已選用' : ''}</strong><small>{formatBytes(item.size)} · {item.source === 'official' ? '官方連結取得' : '本機選檔'} · {new Date(item.time).toLocaleDateString('zh-HK')}</small><small className={item.coverage < 0.98 ? 'sheet-partial-coverage' : ''}>{item.coverage < 0.98 ? `索引抽樣只覆蓋約 ${Math.round(item.coverage * 100)}%，並非整幅` : '索引範圍抽樣覆蓋；內容仍未驗證'}</small></div></div>
      {deleting === item.id ? <div className="sheet-delete-confirm"><span>刪除 {item.id}？路線及書籤不受影響。</span><button onClick={() => setDeleting(null)}>取消</button><button onClick={() => { setDeleting(null); onDelete(item.id); }}>確認刪除 {item.id}</button></div> : <div className="saved-sheet-actions"><button disabled={busy} onClick={() => onSelect(item)}>查看 {item.id}</button><button disabled={busy} onClick={() => setDeleting(item.id)} aria-label={`刪除 ${item.id}`}><Trash2 size={15}/> 刪除</button></div>}
    </div>)}</div> : <p className="offline-empty">尚未儲存圖幅。下載或匯入失敗不會覆蓋先前的圖幅。</p>}
    {activeId && <button className="sheet-online-button" disabled={busy} onClick={onOnline}>切回原有地形圖（線上／已存畫面）</button>}
  </div>;
}
