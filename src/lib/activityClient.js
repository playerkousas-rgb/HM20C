import { validateAnswerPacket, validateQuestionSet } from '../../shared/question-set.js';

const messages = {
  storage_not_configured: '線上資料庫尚未設定。請管理員按 README 設定；離線 QR 仍可使用。',
  storage_unavailable: '線上資料庫暫時無法使用；請稍後重試，或改用離線 QR。',
  leader_not_configured: '尚未設定領袖密碼；請管理員在 Vercel 設定後重新部署。',
  unauthorized: '領袖驗證已過期；請連網重新解鎖。', not_owner: '此手機沒有這個活動的管理權限；請匯入領袖私人備份。',
  not_found: '活動不存在或已過期；請領袖建立新活動或改用離線 QR。',
  conflict: '活動剛被其他裝置更新。請先重新整理活動狀態，再檢查題目。',
  revision_conflict: '同一題組版本有不同內容，請先核對另一裝置的題目，避免覆蓋。',
  set_conflict: '線上題組與本機版本不同，未覆蓋或公布；請先向更新活動的領袖核對及匯入私人備份。',
  invalid_set: '題組資料或版本無效，請檢查題目後重試。',
};
export class ActivityError extends Error {
  constructor(code, status, message) { super(message || messages[code] || '活動服務暫時不可用，請檢查網絡後重試。'); this.code = code; this.status = status; }
}
async function request(method, { id, body, token, simple = false } = {}) {
  let response;
  try {
    response = await fetch(`/api/activity${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
      method, cache: 'no-store', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
    });
  } catch { throw new ActivityError('network', 0, '未能連接活動；請檢查網絡，或改用離線 QR。'); }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ActivityError(value.error, response.status);
  if (simple && value.ok === true) return value;
  if (method !== 'GET' && !/^[A-Za-z0-9_-]{43}$/.test(value.setFingerprint || '')) throw new ActivityError('invalid_response', 0);
  const set = validateQuestionSet(value.set);
  const packet = value.answers?.length ? validateAnswerPacket({ kind: 'answers', v: 1, setId: set?.id, revision: set?.revision, answers: value.answers }) : null;
  if (!set || !Number.isSafeInteger(value.version) || value.version < 1 || !/^[A-Za-z0-9_-]{22,64}$/.test(value.id || '')
      || (id && value.id !== id) || !Array.isArray(value.answers) || (value.answers.length && !packet)
      || (packet && packet.answers.some((a) => !set.questions.some((q) => q.id === a.id)))) throw new ActivityError('invalid_response', 0);
  return { id: value.id, version: value.version, set, answers: packet?.answers || [], updatedAt: Number(value.updatedAt) || 0,
    expiresAt: Number(value.expiresAt) || 0, ...(/^[A-Za-z0-9_-]{43}$/.test(value.setFingerprint || '') ? { setFingerprint: value.setFingerprint } : {}), ...(value.ownerKey ? { ownerKey: value.ownerKey } : {}) };
}
export const getActivity = (id) => request('GET', { id });
export const createActivity = (set, token) => request('POST', { body: { set }, token });
export const updateActivity = (record, action, data, token) => request('PUT', { body: { id: record.id, ownerKey: record.ownerKey, expectedVersion: record.version, baseFingerprint: record.setFingerprint, action, ...data }, token });

export const stopActivity = (record, token) => request('DELETE', { body: { id: record.id, ownerKey: record.ownerKey, expectedVersion: record.version }, token, simple: true });
