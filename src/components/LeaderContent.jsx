import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, LockKeyhole, ShieldCheck } from 'lucide-react';

export default function LeaderContent({ active, onUnlock, onLock }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef(null);
  useEffect(() => () => { const pending = controller.current; controller.current = null; pending?.abort(); }, []);

  async function submit(event) {
    event.preventDefault();
    if (!password || busy) return;
    if (navigator.onLine === false) { setError('解鎖需要網絡；請連線後輸入密碼。'); return; }
    setError(''); setBusy(true);
    const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch('/api/leader', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }), cache: 'no-store', signal: abort.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true || !Number.isFinite(result.durationSeconds) || typeof result.token !== 'string') {
        if (response.status === 503 && result.error === 'not_configured') throw new Error('尚未在 Vercel 設定 LEADER_PASSWORD；設定後須重新部署。');
        if (response.status === 429) throw new Error('嘗試次數過多，請稍後再試。');
        if (response.status === 401) throw new Error('密碼不正確，請再試。');
        throw new Error('領袖驗證服務暫時不可用，請檢查部署及網絡。');
      }
      setPassword('');
      onUnlock(Math.min(Math.max(result.durationSeconds, 1), 8 * 60 * 60), result.token);
    } catch (cause) {
      if (controller.current === abort) setError(cause?.name === 'AbortError' ? '驗證逾時或已取消；請檢查網絡再試。' : cause.message || '未能連接驗證服務。');
    } finally {
      clearTimeout(timer);
      if (controller.current === abort) { controller.current = null; setBusy(false); }
    }
  }
  return <div className="leader-content">
    {active ? <>
      <div className="leader-unlocked"><ShieldCheck size={21}/><div><strong>領袖模式已開啟</strong><span>可看八位座標、方位答案及設題分享。</span></div></div>
      <p className="modal-intro">離線時保持本頁開啟可繼續看答案；關頁或重新整理後，須連線重新解鎖。最多維持 8 小時。</p>
      <button className="secondary-button leader-lock-button" onClick={onLock}><LockKeyhole size={16}/> 返回成員模式</button>
    </> : <>
      <p className="modal-intro">輸入領袖密碼，顯示圖心八位方格座標、方位答案及領袖設題。首次解鎖需要網絡。</p>
      <form onSubmit={submit} className="leader-form">
        <label htmlFor="leader-password">領袖密碼</label>
        <input id="leader-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={256} required placeholder="請輸入密碼" />
        {error && <p className="leader-error" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy || !password}><LockKeyhole size={16}/>{busy ? '正在驗證…' : '解鎖領袖模式'}</button>
      </form>
    </>}
    <div className="about-warning leader-warning"><AlertTriangle size={17}/><span>只作教學時隱藏答案；地圖及計算程式仍在手機，懂得使用開發工具的人可自行計算。這不是保密或防作弊系統。</span></div>
  </div>;
}
