import { useEffect, useRef, useState } from 'react';
import { ACTIVITY_KEY, BANK_KEY, MEMBER_KEY, loadActivities, loadBank, loadMember, newQuestionSet, readActivities, readBank, saveJson, validateQuestionSet } from '../lib/questionSet';
import { createActivity, getActivity, stopActivity, updateActivity } from '../lib/activityClient';
import { createBankBackup, mergeBackupActivities, validateBankBackup } from '../lib/bankBackup';

const idPattern = /^[A-Za-z0-9_-]{22,64}$/;
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
function savedAt(time) { return time ? `上次更新 ${new Date(time).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' })}` : '尚未更新'; }
function safeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function metadata(previous, value, ownerKey) {
  return { id: value.id, ownerKey: ownerKey || previous?.ownerKey, version: value.version, revision: value.set.revision,
    released: value.answers.map((a) => a.id), expiresAt: value.expiresAt, setFingerprint: value.setFingerprint || previous?.setFingerprint };
}
export function mergeSnapshot(previous, value) {
  if (previous?.set.id === value.set.id && previous.set.revision > value.set.revision) return null;
  const same = previous?.set.id === value.set.id && previous.set.revision === value.set.revision;
  // A revision is an identity, not permission to attach answers to different questions.
  if (same && JSON.stringify(previous.set) !== JSON.stringify(value.set)) return null;
  const merged = new Map((same ? previous.answers : []).map((a) => [a.id, a]));
  for (const answer of value.answers) merged.set(answer.id, answer);
  return { set: value.set, answers: [...merged.values()], activityId: value.id, version: value.version, syncedAt: Date.now() };
}
export function useQuestionSets({ leaderActive, token, open, notify }) {
  const [bank, setBank] = useState(loadBank);
  const [activities, setActivities] = useState(loadActivities);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [shareMode, setShareMode] = useState(null);
  const [member, setMember] = useState(loadMember);
  const [status, setStatus] = useState({ message: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const memberRef = useRef(member); memberRef.current = member;
  const selected = bank.find((set) => set.id === selectedId) || null;
  const activity = selected ? activities[selected.id] : null;
  const memberActivityId = member?.activityId || null;

  useEffect(() => {
    if (!memberActivityId) return undefined;
    let alive = true; let timer; let running = false;
    async function refresh() {
      clearTimeout(timer);
      if (!alive || running) return;
      if (document.hidden || navigator.onLine === false) {
        if (alive && navigator.onLine === false) setStatus({ error: true, message: `目前離線；${savedAt(memberRef.current?.syncedAt)}。重連後自動同步。` });
        timer = setTimeout(refresh, 6000); return;
      }
      running = true;
      try {
        const value = await getActivity(memberActivityId);
        if (!alive) return;
        const previous = memberRef.current;
        if (previous?.activityId !== memberActivityId) return;
        const next = mergeSnapshot(previous, value);
        if (!next) {
          setStatus({ error: true, message: '本機與線上題組版本或內容不一致；請領袖先核對並同步活動。' });
        } else {
          if (previous.version && value.version > previous.version) notify(value.answers.length > previous.answers.length ? '領袖已公布答案；打開「題目」查看。' : '活動題目已更新；打開「題目」查看。');
          memberRef.current = next; setMember(next);
          if (!safeStore(MEMBER_KEY, next)) setStatus({ error: true, message: '已連網更新，但手機未能儲存離線副本。' });
          else setStatus({ message: `已連網同步 · ${savedAt(next.syncedAt)}` });
        }
      } catch (cause) {
        if (alive) setStatus({ error: true, message: `${cause.message} ${savedAt(memberRef.current?.syncedAt)}。` });
      } finally {
        running = false;
        if (alive) timer = setTimeout(refresh, 6000);
      }
    }
    const resume = () => { if (!document.hidden && navigator.onLine !== false) { clearTimeout(timer); if (!running) void refresh(); } };
    void refresh(); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [memberActivityId]);

  function saveActivities(next) {
    // Preserve other sets written by another tab while this one was open.
    const latest = readActivities();
    if (!latest) { setActivities(next); setError('本機活動管理資料損壞或不能讀取；未覆蓋，請立即備份。'); return false; }
    for (const id of new Set([...Object.keys(activities), ...Object.keys(next)])) {
      if (JSON.stringify(activities[id]) === JSON.stringify(next[id])) continue;
      if (next[id]) latest[id] = next[id]; else delete latest[id];
    }
    setActivities(latest);
    if (!safeStore(ACTIVITY_KEY, latest)) { setError('活動管理鑰匙未能儲存在手機；請立即下載私人備份。'); return false; }
    return true;
  }
  function saveMember(next) {
    memberRef.current = next; setMember(next);
    if (!safeStore(MEMBER_KEY, next)) notify('題組已讀取，但手機未能儲存離線副本。');
  }
  function create() { if (hasDraft && !window.confirm('目前有未儲存草稿，建立新題組會放棄草稿。繼續？')) return; setDraft(newQuestionSet()); setHasDraft(true); setError(''); open('question-edit'); }
  function edit() { if (!selected) return; if (hasDraft && draft?.id === selected.id) { open('question-edit'); return; } if (hasDraft && !window.confirm('目前有未儲存草稿，切換題組會放棄草稿。繼續？')) return; setDraft(structuredClone(selected)); setHasDraft(true); setError(''); open('question-edit'); }
  function select(id) { setSelectedId(id); setError(''); }
  async function save(set) {
    if (!leaderActive) { notify('請先解鎖領袖模式。'); return; }
    if (busy) { notify('活動更新中，請稍候再儲存。'); return; }
    const original = bank.find((item) => item.id === set.id);
    const latest = readBank();
    if (!latest) { setError('本機題庫損壞或不能讀取；未覆蓋原有資料。'); notify('本機題庫未能讀取，未覆蓋；草稿仍在本頁。'); return; }
    const storedOriginal = latest.find((item) => item.id === set.id);
    if (JSON.stringify(original || null) !== JSON.stringify(storedOriginal || null)) {
      setError('另一分頁已修改同一題組；未覆蓋，請先核對及備份。');
      notify('另一分頁已修改同一題組；草稿仍在本頁。'); return;
    }
    const nextSet = validateQuestionSet({ ...set, revision: original ? original.revision + 1 : 1 }, { privateAnswers: true });
    if (!nextSet) { setError('題組資料無效。'); return; }
    const nextBank = original ? latest.map((item) => item.id === set.id ? nextSet : item) : [...latest, nextSet];
    if (nextBank.length > 50 || !safeStore(BANK_KEY, nextBank)) { setError('未能儲存題庫；請檢查手機儲存空間。'); notify('未能儲存題庫；草稿仍在本頁。'); return; }
    setBank(nextBank); setSelectedId(nextSet.id); setHasDraft(false); setError(''); open('question-bank');
    const record = activities[nextSet.id];
    if (record && navigator.onLine !== false && token) {
      setBusy(true);
      try {
        const result = await updateActivity(record, 'sync', { set: nextSet }, token);
        const next = { ...activities, [nextSet.id]: metadata(record, result) };
        if (saveActivities(next)) notify('題組已儲存並同步；答案需重新公布。');
      } catch (cause) { setError(`本機已儲存，但未同步：${cause.message}`); notify('題組只儲存在本機；請稍後更新活動。'); }
      finally { setBusy(false); }
    } else notify(record ? '題組已存在本機；連網後請更新活動。' : '題組已儲存在本機。');
  }
  function remove() {
    if (!selected) return;
    const latest = readBank();
    if (!latest) { setError('本機題庫損壞或不能讀取；未刪除。'); return; }
    if (JSON.stringify(latest.find((set) => set.id === selected.id) || null) !== JSON.stringify(selected)) { setError('另一分頁已修改此題組；未刪除，請先核對。'); return; }
    const nextBank = latest.filter((set) => set.id !== selected.id);
    if (!safeStore(BANK_KEY, nextBank)) { setError('未能刪除本機題組。'); return; }
    setBank(nextBank);
    const nextActivities = { ...activities }; delete nextActivities[selected.id];
    const stored = saveActivities(nextActivities);
    setSelectedId(null); if (stored) setError('');
  }
  function share(mode) { setShareMode(mode); open('question-share'); }
  async function createOnline() {
    if (!selected || !leaderActive || !token || busy) return;
    const latest = readActivities();
    if (!latest) { setError('本機活動管理資料不能讀取；未建立活動。'); return; }
    if (!activity && latest[selected.id]) { setActivities(latest); setError('另一分頁已建立活動，請先檢查活動狀態。'); return; }
    setBusy(true); setError('');
    try {
      const result = await createActivity(selected, token);
      if (!keyPattern.test(result.ownerKey || '') || !keyPattern.test(result.setFingerprint || '')) throw new Error('活動回應未包含有效管理資料。');
      if (saveActivities({ ...activities, [selected.id]: metadata(null, result, result.ownerKey) })) notify('已建立活動；可分享活動 QR。');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function update(action, data = {}) {
    if (!selected || !activity || !leaderActive || !token || busy) return;
    setBusy(true); setError('');
    try {
      const result = await updateActivity(activity, action, data, token);
      if (saveActivities({ ...activities, [selected.id]: metadata(activity, result) })) notify(action === 'release' ? '答案已公布；連網成員會自動更新。' : '活動題目已更新。');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function refresh() {
    if (!selected || !activity || busy) return;
    setBusy(true); setError('');
    try {
      const result = await getActivity(activity.id);
      if (result.set.id !== selected.id) throw new Error('活動與此題組不相符，請檢查私人備份。');
      if (saveActivities({ ...activities, [selected.id]: metadata(activity, result) })) notify('已更新活動狀態。');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function stopOnline() {
    if (!selected || !activity || !leaderActive || !token || busy) return;
    setBusy(true); setError('');
    try {
      await stopActivity(activity, token);
      const next = { ...activities }; delete next[selected.id];
      if (saveActivities(next)) notify('活動已結束；曾公布的答案仍可能留在成員手機。');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  function unlinkOnline() {
    if (!selected || !activity || busy) return;
    const next = { ...activities }; delete next[selected.id];
    if (saveActivities(next)) { setError(''); notify('已解除本機活動連結；舊活動不會因此立即結束。'); }
  }
  async function backup() {
    try {
      const storedSets = readBank(); const storedActivities = readActivities();
      const sets = storedSets || bank;
      const currentActivities = mergeBackupActivities(storedActivities || {}, activities);
      saveJson('HM20C-私人題庫備份.json', await createBankBackup(sets, currentActivities));
      const warning = !storedSets || !storedActivities ? '本機資料讀取異常：備份只包括目前能讀到的內容，請仔細核對。' : '';
      setError(warning); notify(warning || '已準備私人備份；包含答案及管理鑰匙，請妥善保管。');
    } catch (cause) { setError(cause?.message || '未能產生私人備份。'); }
  }
  async function importBackup(file) {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('備份檔超過 2 MB。');
      const raw = await validateBankBackup(JSON.parse(await file.text()));
      if (raw.sets.length > 50) throw new Error('備份題組數量過多。');
      const sets = raw.sets.map((set) => validateQuestionSet(set, { privateAnswers: true }));
      if (sets.some((set) => !set) || new Set(sets.map((set) => set.id)).size !== sets.length) throw new Error('備份題目無效。');
      const latestBank = readBank();
      const latestActivities = readActivities();
      if (!latestActivities) throw new Error('本機活動管理資料不能讀取；未覆蓋。');
      if (!latestBank) throw new Error('本機題庫不能讀取；未覆蓋。');
      if (sets.some((set) => latestBank.some((existing) => existing.id === set.id && JSON.stringify(existing) !== JSON.stringify(set)))) throw new Error('備份與本機同一題組不同；請先備份及刪除本機版本，避免覆蓋。');
      const restoredActivities = {};
      for (const set of sets) {
        const a = raw.activities[set.id];
        if (!a) continue;
        if (!idPattern.test(a.id || '') || !keyPattern.test(a.ownerKey || '') || !Number.isSafeInteger(a.version) || a.version < 1
          || !Number.isSafeInteger(a.revision) || a.revision < 1 || !keyPattern.test(a.setFingerprint || '') || !Array.isArray(a.released) || a.released.length > 15 || !a.released.every((qid) => /^[A-Za-z0-9_-]{12,64}$/.test(qid))) throw new Error('備份的活動管理資料無效。');
        const existing = latestActivities[set.id];
        if (existing && (existing.id !== a.id || existing.ownerKey !== a.ownerKey)) throw new Error('本機已有不同的活動管理資料，未覆蓋；請先核對。');
        restoredActivities[set.id] = existing && existing.version > a.version ? existing : { id: a.id, ownerKey: a.ownerKey, version: a.version, revision: a.revision, setFingerprint: a.setFingerprint, released: a.released, expiresAt: Number(a.expiresAt) || 0 };
      }
      const nextBank = [...latestBank, ...sets.filter((set) => !latestBank.some((existing) => existing.id === set.id))];
      if (nextBank.length > 50 || !safeStore(BANK_KEY, nextBank)) throw new Error('題庫未能儲存。');
      setBank(nextBank);
      if (!saveActivities({ ...activities, ...restoredActivities })) { notify('題組已還原，但活動管理資料未能儲存，請檢查手機儲存。'); return; }
      setError(''); notify(raw.verified ? '已驗證並還原私人備份；更新活動前請先重新整理狀態。' : '已還原舊版備份（未含校驗碼）；請先核對題目及活動狀態。');
    } catch (cause) { setError(cause?.message || '無法讀取私人備份。'); }
  }
  async function join(id) {
    setStatus({ message: '正在連接活動…' });
    const cached = memberRef.current?.activityId === id ? memberRef.current : null;
    if (cached) open('question-member');
    try {
      const value = await getActivity(id);
      const next = mergeSnapshot(cached, value);
      if (!next) { setStatus({ error: true, message: '本機與線上題組版本或內容不一致；請領袖先核對並同步活動。' }); open('question-member'); return; }
      saveMember(next); setStatus({ message: `已連網同步 · ${savedAt(next.syncedAt)}` }); open('question-member');
    } catch (cause) {
      if (cached) { setStatus({ error: true, message: `${cause.message} ${savedAt(cached.syncedAt)}。` }); open('question-member'); }
      else { notify(cause.message); open('exercise'); }
    }
  }
  function receive(packet) {
    if (packet.kind === 'activity') { void join(packet.id); return; }
    if (packet.kind === 'questions' || (packet.kind === 'answers' && packet.v === 2)) {
      const previous = memberRef.current;
      const matchingId = previous?.set.id === packet.set.id;
      const same = matchingId && previous.set.revision === packet.set.revision;
      if (matchingId && previous.set.revision > packet.set.revision) throw new Error('版本不同：此 QR 比手機內的題目舊，請向領袖索取新版。');
      if (same && JSON.stringify(previous.set) !== JSON.stringify(packet.set)) throw new Error('相同版本的題目內容不同，請向領袖重新索取。');
      const answers = new Map((same ? previous.answers : []).map((answer) => [answer.id, answer]));
      if (packet.kind === 'answers') for (const answer of packet.answers) answers.set(answer.id, answer);
      const activityId = matchingId ? previous.activityId : null;
      saveMember({ set: packet.set, answers: [...answers.values()], activityId, version: same ? previous.version : 0, syncedAt: same ? previous.syncedAt : 0 });
      setStatus({ message: activityId ? '已讀取離線資料，連網後會繼續同步。' : '' }); open('question-member'); return;
    }
    if (packet.kind === 'answers') {
      // Compatibility with previously issued v1 answer-only QR/JSON.
      const previous = memberRef.current;
      if (!previous || previous.set.id !== packet.setId) throw new Error('舊版答案不屬於目前題組；請先讀取對應題目。');
      if (previous.set.revision !== packet.revision) throw new Error('答案與題目版本不同；請先讀取相同版本的題目。');
      if (packet.answers.some((answer) => !previous.set.questions.some((q) => q.id === answer.id))) throw new Error('答案與目前題目不相符。');
      const answers = new Map(previous.answers.map((answer) => [answer.id, answer]));
      for (const answer of packet.answers) answers.set(answer.id, answer);
      saveMember({ ...previous, answers: [...answers.values()] }); open('question-member');
    }
  }
  return { bank, activities, selected, activity, draft, setDraft, hasDraft, resumeDraft: () => open('question-edit'), shareMode, member, status, busy, error,
    create, edit, select, save, remove, share, createOnline, sync: () => update('sync', { set: selected }),
    release: (questionIds) => update('release', { questionIds, set: selected }), refresh, stopOnline, unlinkOnline, backup, importBackup, receive };
}
