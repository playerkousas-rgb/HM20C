import React, { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';

// SG18（docs/50 §1）：子 App 內置「讚好／收藏」一鍵回跳主站詳情卡。
// 硬規則：
//   · 網址只可以由 ScoutStoreGate.getAppStoreUrl(slug) 組出，唔准寫死；
//   · 零 Supabase 直連、零 anon key、零 bump_hearts／bump_stars；
//   · ScoutStoreGate 未載入時保持 hidden，唔准出死連；
//   · 零彈窗、零倒數、零遮擋、零新增 localStorage key。
const APP_SLUG = 'hm20c';
const LABEL = '讚好／收藏';
const HINT = '前往主站讚好或收藏此程式（開新分頁）';

export default function StoreSupportLink() {
  const [href, setHref] = useState('');

  useEffect(() => {
    const gate = typeof window === 'undefined' ? null : window.ScoutStoreGate;
    if (!gate || typeof gate.getAppStoreUrl !== 'function') return;
    try {
      const url = gate.getAppStoreUrl(APP_SLUG);
      if (typeof url === 'string' && /^https:\/\//.test(url)) setHref(url);
    } catch {
      /* 保持 hidden，唔會出死連 */
    }
  }, []);

  return <a
    id="storeSupportTop"
    className="support-btn"
    href={href || undefined}
    target="_blank"
    rel="noopener"
    hidden={!href}
    aria-label={HINT}
    title={HINT}
  ><Heart size={14} aria-hidden="true"/><span>{LABEL}</span></a>;
}
