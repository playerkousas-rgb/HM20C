import React, { useState } from 'react';
import { AlertTriangle, Download, Map as MapIcon, Smartphone, Trash2 } from 'lucide-react';
import SheetContent from './SheetContent';

function InstallGuide({ install }) {
  const [message, setMessage] = useState('');
  async function startInstall() {
    const outcome = await install.install();
    if (outcome === 'accepted') setMessage('已接受安裝提示；請確認安裝完成後，從主畫面圖示重新開啟。');
    else if (outcome === 'dismissed') setMessage('已取消安裝提示；仍可按以下步驟手動加入。');
    else setMessage('如未顯示安裝提示，請按以下步驟手動加入。');
  }
  return <details className="install-guide">
    <summary><Smartphone size={18}/><span><strong>加入手機主畫面</strong><small>{install.standalone ? '正以主畫面 App 開啟' : '查看 iPhone／Android 安裝方法'}</small></span></summary>
    <div className="install-guide-content">
      {install.standalone ? <p className="install-state">現正以主畫面 App 開啟；請在這裏下載及檢查地圖。</p>
        : install.installed ? <p className="install-state">已加入主畫面；請由圖示重新開啟，再下載及檢查地圖。</p>
          : <p>請先在手機瀏覽器的新分頁開啟 App；如果是在聊天或其他 App 的內嵌預覽，先選擇「在瀏覽器開啟」。</p>}
      {!install.standalone && !install.installed && install.canPrompt && <button className="install-button" onClick={startInstall}><Download size={15}/> 加入主畫面</button>}
      {message && !install.standalone && !install.installed && <p className="install-state" role="status">{message}</p>}
      {!install.standalone && <ul><li><strong>iPhone／iPad：</strong>以 Safari 開啟，按「分享」再選「加入主畫面」。</li><li><strong>Android：</strong>以 Chrome 開啟，按右上角選單，再選「安裝應用程式」或「加到主畫面」。</li></ul>}
      <p>加入後請由主畫面圖示開啟，並在同一個 App 內下載；不同瀏覽器或主畫面 App 的儲存可能分開。正式使用需要穩定的 HTTPS 網址，臨時預覽網址可能失效。</p>
    </div>
  </details>;
}

export default function OfflineContent({ plan, areas, job, busy, install, onDownload, onStop, onSelect, onClear, sheet }) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [tab, setTab] = useState(() => sheet.basemap === 'countryside' ? 'screen' : 'sheet');
  const name = plan?.basemap === 'hm20c' ? '地形圖' : '郊遊圖';
  return <>
    <div className="offline-tabs" role="tablist" aria-label="離線下載方式">
      <button type="button" role="tab" aria-selected={tab === 'sheet'} disabled={busy || sheet.busy} onClick={() => setTab('sheet')}>整幅地形圖 <small>試用</small></button>
      <button type="button" role="tab" aria-selected={tab === 'screen'} disabled={busy || sheet.busy} onClick={() => setTab('screen')}>目前畫面</button>
    </div>
    {tab === 'sheet' ? <SheetContent {...sheet} installGuide={<InstallGuide install={install}/>}/> : <>
      <p className="modal-intro">先移到需要的地方，下載<strong>目前畫面</strong>。沒有定位或自動導航。</p>
      <div className="offline-limitation"><AlertTriangle size={17}/><div><strong>這裏只預載單一畫面</strong><span>郊遊圖整區來源尚未提供；此處不代表整幅完整。地形圖整幅試用請切換上方分頁。</span></div></div>
      {plan ? <div className="offline-plan">
        <MapIcon size={20}/><div><strong>目前畫面 · {name}</strong><span>{plan.tiles.length} 張圖磚 · 單一鎖定比例的詳細度</span><small>{plan.basemap === 'hm20c' ? '包含底圖、中文地名及 20 米等高線' : '包含 OpenTopoMap 原有路徑、地形及等高線'}</small></div>
      </div> : <div className="about-warning"><AlertTriangle size={17}/><span>{sheet.activeId && sheet.basemap === 'hm20c' ? '目前正使用本機圖幅；如要預載線上地形圖畫面，請先在「整幅地形圖」切回原有地形圖。' : '未能取得目前畫面範圍；請關閉視窗、移動地圖後重試。'}</span></div>}
      {job.message && <div className={`offline-job ${job.phase === 'error' || job.phase === 'stopped' ? 'offline-job--warn' : ''}`} role="status"><strong>{job.message}</strong>{job.total > 0 && <progress value={job.done} max={job.total}/>}</div>}
      <div className="modal-actions">{busy ? <button className="secondary-button" onClick={onStop}>停止下載</button>
        : <button className="primary-button" disabled={!plan} onClick={onDownload}><Download size={17}/> 下載目前畫面</button>}</div>
      <InstallGuide install={install}/>
      <p className="modal-footnote">每次只下載目前畫面的一個級別，不是全港。改變螢幕校準、方向、面板大小或走到範圍外可能需要其他圖磚。圖磚順序下載，以免大量佔用公共地圖服務。部分服務不允許直接讀取圖磚，手機可能按每張數 MB 計算儲存空間。</p>
      <div className="offline-safety"><AlertTriangle size={16}/><span>下載後請先開啟飛航模式，重新開啟並檢查沿途範圍、地名和等高線。瀏覽器或手機可能清除儲存資料；勿以下載清單代替實測，出發仍須帶紙圖及指南針。</span></div>
      <div className="offline-list-heading"><strong>已下載的畫面</strong><small>{areas.length} 個</small></div>
      {areas.length ? <div className="offline-areas">{areas.map((area, index) => <button key={`${area.time}-${index}`} onClick={() => onSelect(area)} disabled={busy}>
        <span><strong>{area.basemap === 'hm20c' ? '地形圖' : '郊遊圖'} · 圖心 {area.center.lat.toFixed(4)}, {area.center.lon.toFixed(4)}</strong><small>{new Date(area.time).toLocaleString('zh-HK')} · z{area.zoom} · {area.tileCount} 張圖磚</small></span><span>查看 ›</span>
      </button>)}</div> : <p className="offline-empty">未有完整下載的畫面；下載中途失敗不會列為完成。</p>}
      {confirmClear ? <div className="offline-clear-confirm"><span>刪除這部機所有已存畫面底圖及等高線？整幅圖幅、路線及書籤不受影響。</span><div><button onClick={() => setConfirmClear(false)}>取消</button><button onClick={() => { setConfirmClear(false); onClear(); }}>確認刪除</button></div></div>
        : <button className="offline-clear" disabled={busy} onClick={() => setConfirmClear(true)}><Trash2 size={14}/> 刪除所有已存畫面</button>}
    </>}
    <details className="official-options"><summary>官方地圖資料及其他選項</summary><div>
      <p><a href="https://data.gov.hk/tc-data/dataset/hk-landsd-openmap-development-hkms-digital-b20k" target="_blank" rel="noopener noreferrer">查看地政總署 iB20000 官方資料 ↗</a><br/>GeoTIFF 匯入為試用功能，須自行核對實際內容及條款。</p>
      <p><a href="https://www.landsd.gov.hk/tc/spatial-data/geospatial-infomation-services/geospatial-portals.html" target="_blank" rel="noopener noreferrer">MyMapHK 官方介紹 ↗</a><br/>官方 MyMapHK 有 iB20000 離線功能，須另行使用；其離線資料不會出現在本 App。<br/><a href="https://apps.apple.com/hk/app/mymaphk/id793615275" target="_blank" rel="noopener noreferrer">iPhone／iPad 下載 ↗</a>　<a href="https://play.google.com/store/apps/details?id=gis.android.map" target="_blank" rel="noopener noreferrer">Android 下載 ↗</a></p>
    </div></details>
  </>;
}
