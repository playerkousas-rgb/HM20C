import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Copy, Download, MapPin, Plus, QrCode, RefreshCw, Share2, Upload } from 'lucide-react';
import { MAX_QUESTIONS } from '../../shared/question-set.js';
import { standaloneAnswerPacket, answerShare, activityShare, newQuestion, questionPacket, questionShare, saveJson, validateQuestionSet } from '../lib/questionSet';
import { bearingAnswerMode, calculatedBearingAnswer, leaderAnswer } from '../lib/questionOverview';
import { loadQrEncoder } from '../lib/qrCodec';
import { gridReference, parseGridReference } from '../lib/utm';

const types = { grid: '看地點量八位座標', identify: '座標找地點／圖例', bearing: '兩點方位', resection: '三角網測', free: '文字題' };
const pointCount = { grid: 1, identify: 0, bearing: 2, resection: 3, free: 0 };

export function QuestionSetEditor({ draft, busy, onChange, onMark, onOverview, onSave, onCancel }) {
  const [error, setError] = useState('');
  function questionChange(index, changes) {
    onChange({ ...draft, questions: draft.questions.map((q, i) => i === index ? { ...q, ...changes } : q) });
    setError('');
  }
  function selectType(index, type) {
    const q = newQuestion(type);
    questionChange(index, { ...q, id: draft.questions[index].id });
  }
  function addReferencePoint(index, value) {
    const point = parseGridReference(value);
    if (!point) { setError('請輸入有效的香港 WGS84 UTM 八位座標，例如 50Q KK 2430 7773。'); return; }
    questionChange(index, { points: [{ lat: point.lat, lon: point.lon }], pointText: point.text });
  }
  function finish() {
    const questions = draft.questions.map((q) => {
      const reference = q.type === 'identify' ? parseGridReference(q.reference) : null;
      return { ...q, reference: q.type === 'identify' ? (reference?.text || q.reference) : '',
        ...(q.type === 'bearing' ? { answerMode: bearingAnswerMode(q) } : {}), answer: leaderAnswer(q) };
    });
    if (questions.some((q) => q.type === 'identify' && !parseGridReference(q.reference))) { setError('請檢查座標題：需要完整的 49Q／50Q 方格及八位數字。'); return; }
    const set = validateQuestionSet({ ...draft, questions }, { privateAnswers: true });
    if (!set) { setError('請填好題組名稱、每條題目及答案，並完成指定的地圖標記。'); return; }
    onSave(set);
  }
  return <div className="question-editor">
    <p className="modal-intro">題組儲存在這部手機。每題可用不同題型；答案不會放進題目 QR。</p>
    <label>題組名稱<input aria-label="題組名稱" value={draft.name} maxLength={48} placeholder="例如：西貢讀圖練習" onChange={(e) => onChange({ ...draft, name: e.target.value })}/></label>
    {draft.questions.map((q, index) => <section className="question-editor-card" key={q.id}>
      <div className="question-card-heading"><strong>第 {index + 1} 題</strong>{draft.questions.length > 1 && <button onClick={() => onChange({ ...draft, questions: draft.questions.filter((_, i) => i !== index) })}>刪除此題</button>}</div>
      <label>題型<select aria-label={`第 ${index + 1} 題題型`} value={q.type} onChange={(e) => selectType(index, e.target.value)}>{Object.entries(types).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label>題目<textarea aria-label={`第 ${index + 1} 題題目`} rows={2} maxLength={160} value={q.prompt} onChange={(e) => questionChange(index, { prompt: e.target.value })}/></label>
      {q.type === 'identify' && <><label>八位座標<input aria-label={`第 ${index + 1} 題八位座標`} maxLength={32} value={q.reference} placeholder="50Q KK 2430 7773" onChange={(e) => questionChange(index, { reference: e.target.value.toUpperCase() })}/></label><small>WGS84 UTM；須寫明區號與方格。這是 10 米方格，不是精確點。</small></>}
      {pointCount[q.type] > 0 && <div className="question-point-picker">
        <div><strong>地圖標記 {q.points.length} / {pointCount[q.type]}</strong><button onClick={() => onMark(q.id)}><MapPin size={15}/>在地圖選點</button></div>
        {q.points.map((p, i) => <small key={i}>{String.fromCharCode(65 + i)} · {gridReference(p)?.text || '超出範圍'}</small>)}
        {q.type === 'grid' && <><label>或輸入完整八位座標作題點<input aria-label={`第 ${index + 1} 題題點座標`} value={q.pointText ?? (q.points[0] ? gridReference(q.points[0])?.text : '')} placeholder="50Q KK 2430 7773" maxLength={32} onChange={(e) => questionChange(index, { pointText: e.target.value.toUpperCase(), points: [] })}/></label><button onClick={() => addReferencePoint(index, q.pointText || '')}>使用這個座標</button><small>輸入方格時，以 10 米格中心標記。</small></>}
      </div>}
      {q.type === 'grid' && <p className="question-answer-preview">領袖答案：{leaderAnswer(q) || '先選點'}</p>}
      {q.type === 'bearing' && <><p className="question-answer-preview">方格北參考：{calculatedBearingAnswer(q) || '先選相距至少 10 米的 A、B'}</p>
        <label>答案方式<select aria-label={`第 ${index + 1} 題答案方式`} value={bearingAnswerMode(q)} onChange={(e) => questionChange(index, { answerMode: e.target.value })}><option value="auto">自動使用方格北前後視</option><option value="manual">領袖自填答案</option></select></label></>}
      {q.type !== 'grid' && (q.type !== 'bearing' || bearingAnswerMode(q) === 'manual') && <label>領袖答案 <small>（成員要等公布才看見）</small><textarea aria-label={`第 ${index + 1} 題答案`} rows={2} maxLength={160} value={q.answer} placeholder={q.type === 'identify' ? '自行填寫地名或圖例，例如涼亭' : q.type === 'resection' ? '自行填寫交會位置或完整八位座標' : '填寫答案或核對方法'} onChange={(e) => questionChange(index, { answer: e.target.value })}/></label>}
      {q.type === 'resection' && <small>只有三個地標不能算出交會位置；請按觀測結果核對並填寫。答案若是完整八位座標，總覽會標出該格中心。</small>}
    </section>)}
    <button className="secondary-button question-overview-open" onClick={onOverview}><MapPin size={16}/>在地圖總覽所有答案</button>
    {draft.questions.length < MAX_QUESTIONS && <button className="secondary-button question-add" onClick={() => onChange({ ...draft, questions: [...draft.questions, newQuestion()] })}><Plus size={16}/>新增一題</button>}
    {error && <p className="leader-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="secondary-button" onClick={onCancel}>返回題庫</button><button className="primary-button" onClick={finish} disabled={busy}>儲存題組</button></div>
    <p className="modal-footnote">未儲存草稿暫留本頁；關頁或重整會消失。手動答案請領袖對照實際紙圖核實；地圖不會自動辨識圖例。題目座標可被自行計算，不能防作弊。</p>
  </div>;
}

export function QuestionBank({ sets, selected, activity, busy, error, hasDraft, onResumeDraft, onSelect, onCreate, onEdit, onDelete, onBack, onOverview, onShare, onCreateActivity, onSync, onRefresh, onRelease, onStopActivity, onUnlinkActivity, onBackup, onImport }) {
  const input = useRef(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  useEffect(() => { setConfirm(false); setConfirmStop(false); setConfirmUnlink(false); }, [selected?.id]);
  return <div className="question-bank">
    {hasDraft && <button className="secondary-button question-add" onClick={onResumeDraft}>繼續未儲存草稿</button>}
    {selected ? <>
      <p className="modal-intro"><strong>{selected.name}</strong> · {selected.questions.length} 題 · 題組版本 {selected.revision}</p>
      <ol className="question-summary">{selected.questions.map((q, i) => <li key={q.id}><strong>{i + 1}. {q.prompt}</strong><small>{types[q.type]}{q.reference ? ` · ${q.reference}` : ''}</small><span>領袖答案：{q.answer}</span></li>)}</ol>
      <div className="question-actions"><button onClick={onEdit} disabled={busy}>修改題目</button><button onClick={onOverview}><MapPin size={15}/>在地圖總覽所有答案</button><button onClick={() => onShare('questions')}><QrCode size={15}/>題目 QR／JSON</button><button onClick={() => onShare('answers')}><QrCode size={15}/>答案 QR／JSON</button></div>
      <div className="question-online"><strong>連網同步活動</strong>
        {!activity ? <><p>先建立活動，再讓成員掃活動 QR；之後可更新題目及公布答案。</p><button className="secondary-button" disabled={busy} onClick={onCreateActivity}>建立連網活動</button></> : <>
          <p>活動版本 {activity.version} · 線上題組版本 {activity.revision}{activity.expiresAt ? ` · 預計 ${new Date(activity.expiresAt).toLocaleDateString('zh-HK')} 到期` : ''}</p>
          {activity.revision !== selected.revision && <p className="question-unsynced">本機題組有未同步修改；更新後需重新公布答案。</p>}
          <div className="question-actions"><button onClick={() => onShare('activity')}><QrCode size={15}/>活動 QR</button><button onClick={onSync} disabled={busy}><RefreshCw size={15}/>更新活動題目</button><button onClick={onRefresh} disabled={busy}>重新整理狀態</button></div>
          {!confirmStop ? <button className="text-button" onClick={() => setConfirmStop(true)} disabled={busy}>結束連網活動</button> : <div className="question-release"><span>結束後舊活動 QR 失效；已公布的答案仍可能留在手機。</span><button disabled={busy} onClick={() => { setConfirmStop(false); onStopActivity(); }}>確認結束活動</button><button onClick={() => setConfirmStop(false)}>取消結束</button></div>}
          {!confirmUnlink ? <button className="text-button" onClick={() => setConfirmUnlink(true)} disabled={busy}>解除本機活動連結</button> : <div className="question-release"><span>會移除本機管理鑰匙；舊活動仍可用至到期，先備份或先結束活動。</span><button disabled={busy} onClick={() => { setConfirmUnlink(false); onUnlinkActivity(); }}>確認解除連結</button><button onClick={() => setConfirmUnlink(false)}>取消解除</button></div>}
          <div className="question-release"><span>線上公布答案：</span><button disabled={busy || activity.revision !== selected.revision} onClick={() => onRelease(selected.questions.map((q) => q.id))}>公布全部答案</button>{selected.questions.map((q, i) => <button key={q.id} disabled={busy || activity.revision !== selected.revision || activity.released?.includes(q.id)} onClick={() => onRelease([q.id])}>{activity.released?.includes(q.id) ? `第 ${i + 1} 題已公布` : `公布第 ${i + 1} 題`}</button>)}</div>
        </>}
        <small>成員前台約每 6 秒檢查更新；無網時請改掃離線題目／答案 QR。公布後持有人可以保留答案。</small>
      </div>
      {error && <p className="leader-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="secondary-button" onClick={onBack}>返回題庫</button>{!confirm ? <button className="danger-button" disabled={busy} onClick={() => setConfirm(true)}>刪除本機題組</button> : <button className="danger-button" disabled={busy} onClick={() => { setConfirm(false); onDelete(); }}>確認刪除</button>}</div>
      {confirm && <p className="question-unsynced">刪除本機題組和管理鑰匙；線上活動仍會在到期後自動刪除，請先備份。</p>}
    </> : <>
      <p className="modal-intro">每部領袖手機有自己的題庫。可一次分享多題，答案分開公布。</p>
      <div className="question-actions"><button className="primary-button" onClick={onCreate} disabled={busy}><Plus size={16}/>建立題組</button><button onClick={onBackup}><Download size={15}/>私人備份</button><button disabled={busy} onClick={() => input.current?.click()}><Upload size={15}/>還原備份</button></div>
      <input ref={input} type="file" accept=".json,application/json" aria-label="匯入私人題庫備份" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onImport(file); }}/>
      {sets.length ? <div className="question-library">{sets.map((set) => <button key={set.id} onClick={() => onSelect(set.id)}><BookOpen size={18}/><span><strong>{set.name}</strong><small>{set.questions.length} 題 · 版本 {set.revision}</small></span><span>開啟 →</span></button>)}</div> : <p className="question-empty">題庫尚未有題組，先建立第一組。</p>}
      {error && <p className="leader-error" role="alert">{error}</p>}
      <p className="modal-footnote">私人備份包含未公布答案及活動管理鑰匙，只限領袖保管，不要發給成員。清除瀏覽器資料會刪除本機題庫。</p>
    </>}
  </div>;
}

export function QuestionShare({ mode, set, activity, onBack }) {
  const [selected, setSelected] = useState('all');
  const [qr, setQr] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    async function generate() {
      try {
        const QRCode = await loadQrEncoder();
        const ids = selected === 'all' ? null : [selected];
        const link = mode === 'questions' ? questionShare(set) : mode === 'answers' ? answerShare(set, ids) : activityShare(activity?.id);
        const options = { errorCorrectionLevel: 'M', margin: 4, width: 512, color: { dark: '#183b2d', light: '#fff' } };
        let version;
        try { version = QRCode.create(link, options).version; }
        catch { throw new Error('QR 太密或資料過長，請減少題數、縮短題目／答案，或下載 JSON 分享。'); }
        if (version > 17) throw new Error('QR 太密或資料過長，請減少題數、縮短題目／答案，或下載 JSON 分享。');
        const image = await QRCode.toDataURL(link, options);
        if (active) { setQr({ link, image }); setMessage(''); }
      } catch (error) { if (active) { setQr(null); setMessage(error?.message || '未能產生 QR。'); } }
    }
    void generate(); return () => { active = false; };
  }, [mode, set, activity?.id, selected]);
  const title = mode === 'questions' ? '離線題目' : mode === 'answers' ? '離線答案' : '連網活動';
  const ids = selected === 'all' ? null : [selected];
  function downloadJson() { saveJson(mode === 'questions' ? '題目.json' : '答案.json', mode === 'questions' ? questionPacket(set) : standaloneAnswerPacket(set, ids)); }
  async function copy() { try { await navigator.clipboard.writeText(qr.link); setMessage('連結已複製。'); } catch { setMessage('請長按下方連結複製。'); } }
  async function share() { try { if (navigator.share) await navigator.share({ title, url: qr.link }); else await copy(); } catch (error) { if (error?.name !== 'AbortError') setMessage('請改用複製或下載 QR。'); } }
  return <div className="question-share">
    <p className="modal-intro">{mode === 'questions' ? '一個 QR 可放多題，不包含答案；修改後需重新掃。' : mode === 'answers' ? '這個 QR 包含題目和所選答案；成員可直接掃描，無須先掃題目。只有準備公布時才分享。' : '成員掃一次活動 QR；有網絡時自動檢查更新。'}</p>
    {mode === 'answers' && <label>分享範圍<select aria-label="答案分享範圍" value={selected} onChange={(e) => { setQr(null); setSelected(e.target.value); }}><option value="all">全部答案</option>{set.questions.map((q, i) => <option key={q.id} value={q.id}>第 {i + 1} 題</option>)}</select></label>}
    {message && <p className="exercise-message" role="status">{message}</p>}
    {qr && <div className="exercise-qr"><strong>{title} QR Code</strong><img src={qr.image} width="320" height="320" alt={`${title} QR Code`}/><div className="exercise-share-actions"><button onClick={share}><Share2 size={15}/>分享連結</button><button onClick={copy}><Copy size={15}/>複製</button><a href={qr.image} download={`${title}.png`}>下載 QR</a></div><details><summary>顯示分享連結</summary><textarea aria-label={`${title}分享連結`} readOnly rows={3} value={qr.link}/></details></div>}
    {mode !== 'activity' && <button className="secondary-button question-json" onClick={downloadJson}><Download size={15}/>下載{title} JSON</button>}
    <p className="modal-footnote">請先儲存 QR 圖片；山野離線時需已安裝及快取 App 和相關地圖。不要把答案 QR 傳給未準備對答案的人。</p>
    <div className="modal-actions"><button className="secondary-button" onClick={onBack}>返回題組</button></div>
  </div>;
}

export function QuestionMember({ member, status, onView, onOverview, onScan, onBack }) {
  const { set, answers } = member;
  const byId = new Map(answers.map((a) => [a.id, a.answer]));
  return <div className="question-member">
    <p className="modal-intro"><strong>{set.name}</strong> · {set.questions.length} 題 · 版本 {set.revision}</p>
    <p className={`question-sync-status ${status?.error ? 'question-unsynced' : ''}`}>{member.activityId ? (status?.message || '準備同步活動…') : '離線題組：修改或公布答案時，請再掃新的 QR／JSON。'}</p>
    {set.questions.map((q, i) => <section className="question-member-card" key={q.id}>
      <div className="question-card-heading"><strong>第 {i + 1} 題</strong><small>{types[q.type]}</small></div><p>{q.prompt}</p>
      {q.reference && <strong className="question-grid-ref">{q.reference}</strong>}
      {q.type !== 'free' && <button onClick={() => onView(q)}><MapPin size={15}/>在地圖顯示本題</button>}
      {byId.has(q.id) ? <div className="question-revealed"><strong>已公布答案</strong><p>{byId.get(q.id)}</p></div> : <p className="question-awaiting">答案尚未公布</p>}
    </section>)}
    {answers.length > 0 && <button className="secondary-button question-overview-open" onClick={onOverview}><MapPin size={16}/>在地圖總覽已公布答案</button>}
    <p className="modal-footnote">顯示方位或三角題會取代目前的題目線，但不會修改繪製路線／GPX。座標題的標記是 10 米格中心；請自行對照紙圖。</p>
    <div className="modal-actions"><button className="secondary-button" onClick={onBack}>返回</button><button className="primary-button" onClick={onScan}><QrCode size={16}/>讀取題目／答案</button></div>
  </div>;
}

// A separate, temporary map layer; it never modifies route/GPX or tool points.
export function QuestionOverviewCard({ items, audience, onGo, onReturn, onClose }) {
  return <section className="question-overview-card" aria-label={audience === 'leader' ? '領袖答案地圖總覽' : '已公布答案地圖總覽'}>
    <div className="question-overview-heading"><div><strong>{audience === 'leader' ? '領袖 · 答案地圖總覽' : '已公布答案地圖總覽'}</strong><small>比例鎖定；列表可上下滑動，點選可移動地圖</small></div><button onClick={onClose} aria-label="關閉答案地圖總覽">×</button></div>
    <details><summary>查看 {items.length} 題及答案</summary><ol>{items.map((item) => <li key={item.id}><strong>{item.index + 1}. {item.prompt}</strong><span>{item.answer || (audience === 'leader' ? '答案尚未填寫' : '答案尚未公布')}</span>{item.target && <button onClick={() => onGo(item.target)}>移至地點</button>}</li>)}</ol></details>
    <button className="question-overview-return" onClick={onReturn}>返回題組</button>
  </section>;
}
