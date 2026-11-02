// Checksums detect accidental file corruption, not malicious tampering. The
// backup still contains private answers and activity owner keys in plaintext.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function checksum(value) {
  if (!globalThis.crypto?.subtle) throw new Error('此瀏覽器不能計算備份校驗碼，請使用 HTTPS。');
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function createBankBackup(sets, activities) {
  const payload = { kind: 'hm20c-private-bank', v: 2, sets, activities };
  return { ...payload, sha256: await checksum(payload) };
}
export async function validateBankBackup(raw) {
  if (raw?.kind !== 'hm20c-private-bank' || ![1, 2].includes(raw.v) || !Array.isArray(raw.sets)
    || !raw.activities || typeof raw.activities !== 'object' || Array.isArray(raw.activities)) throw new Error('不是有效的私人題庫備份。');
  if (raw.v === 2) {
    const payload = { kind: raw.kind, v: raw.v, sets: raw.sets, activities: raw.activities };
    if (!/^[0-9a-f]{64}$/.test(raw.sha256 || '') || await checksum(payload) !== raw.sha256) throw new Error('備份校驗碼不符；檔案可能損壞，未匯入。');
  }
  return { sets: raw.sets, activities: raw.activities, verified: raw.v === 2 };
}

// A failed localStorage write can leave a newly created owner key only in
// React memory. Include it in emergency backups instead of silently losing it.
export function mergeBackupActivities(stored, memory) {
  const merged = { ...stored };
  for (const [setId, current] of Object.entries(memory || {})) {
    const saved = merged[setId];
    if (saved && (saved.id !== current.id || saved.ownerKey !== current.ownerKey)) throw new Error('同一題組有不同的活動管理資料；未合併備份，請先檢查其他分頁。');
    if (!saved || (Number(current.version) || 0) >= (Number(saved.version) || 0)) merged[setId] = current;
  }
  return merged;
}
