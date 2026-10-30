import React, { useState } from 'react';
import { Bookmark, ChevronRight, MapPin, Trash2 } from 'lucide-react';
import { MAX_BOOKMARK_NAME, MAX_BOOKMARKS } from '../lib/bookmarks';
import { formatLatitude, formatLongitude } from '../lib/geo';

/** Only the manually chosen map centre is saved; this never reads GPS. */
export default function PlacesContent({ center, bookmarks, regions, onAdd, onRemove, onGo }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  function add(event) {
    event.preventDefault();
    const result = onAdd(name.trim());
    setMessage(result);
    if (result.ok) setName('');
  }

  function remove(id) {
    const result = onRemove(id);
    setMessage(result);
    if (result.ok) setConfirmId(null);
  }

  return <>
    <p className="modal-intro">移動地圖，用畫面中央的十字選擇地點；圖心不是你的實際位置。</p>
    <div className="place-center"><span className="place-center-icon"><MapPin size={18}/></span><div><strong>目前圖心</strong><span>{formatLatitude(center.lat, 5)}　{formatLongitude(center.lon, 5)}</span></div></div>
    <form className="bookmark-form" onSubmit={add}>
      <label htmlFor="bookmark-name">書籤名稱 <small>（選填）</small></label>
      <div><input id="bookmark-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={MAX_BOOKMARK_NAME} placeholder="例如：集合處、檢查點"/><button type="submit" className="primary-button" disabled={bookmarks.length >= MAX_BOOKMARKS}><Bookmark size={16}/> 儲存圖心</button></div>
      {message && <p className={`bookmark-message ${message.ok ? '' : 'bookmark-message--error'}`} role="status">{message.message}</p>}
    </form>
    <p className="place-note">書籤只保存手選座標，不會下載地圖或取得定位。離線使用前，仍需預載並檢查該處畫面。</p>
    <div className="places-heading"><strong>我的地點</strong><small>{bookmarks.length} / {MAX_BOOKMARKS}</small></div>
    {bookmarks.length ? <div className="bookmark-list">{bookmarks.map((bookmark) => <div className="bookmark-row" key={bookmark.id}>
      {confirmId === bookmark.id ? <div className="bookmark-confirm"><span>刪除「{bookmark.name}」？</span><div><button type="button" onClick={() => setConfirmId(null)}>取消</button><button type="button" onClick={() => remove(bookmark.id)}>確認刪除</button></div></div> : <>
        <button type="button" className="bookmark-open" onClick={() => onGo(bookmark.lat, bookmark.lon, bookmark.name)}><span className="region-icon"><Bookmark size={16}/></span><span><strong>{bookmark.name}</strong><small>{formatLatitude(bookmark.lat, 5)} · {formatLongitude(bookmark.lon, 5)}</small></span><ChevronRight size={16}/></button>
        <button type="button" className="bookmark-delete" onClick={() => setConfirmId(bookmark.id)} aria-label={`刪除書籤 ${bookmark.name}`} title="刪除書籤"><Trash2 size={16}/></button>
      </>}
    </div>)}</div> : <p className="bookmark-empty">尚未儲存地點；書籤只留在這部裝置。</p>}
    <div className="places-heading places-heading--regions"><strong>快速前往</strong><small>手動移動地圖</small></div>
    <div className="region-list">{regions.map((region) => <button type="button" key={region.name} onClick={() => onGo(region.lat, region.lon, region.name)}><span className="region-icon"><MapPin size={17}/></span><span><strong>{region.name}</strong><small>{region.sub}</small></span><ChevronRight size={17}/></button>)}</div>
    <p className="modal-footnote">前往地點不會切換底圖或解除比例鎖定；地形圖的自動方向可能隨圖心改變。</p>
  </>;
}
