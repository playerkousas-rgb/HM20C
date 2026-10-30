import { isSheetId } from './geometry.js';

const DB_NAME = 'scout-trail-map.offline-sheets.v1';
const META = 'sheet-metadata';
const FILES = 'sheet-files';
const ACTIVE_KEY = 'scout-trail-map.active-sheet.v1';
export const SHEETS_CHANGED_KEY = 'scout-trail-map.sheets-changed.v1';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('此瀏覽器未提供本機圖幅儲存。')); return; }
    let settled = false;
    const request = indexedDB.open(DB_NAME, 1);
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('本機圖幅儲存未能開啟；請關閉其他分頁後重試。')); }
    }, 12000);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    request.onerror = () => { clearTimeout(timer); if (!settled) { settled = true; reject(request.error || new Error('本機儲存未能開啟。')); } };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transact(mode, work, signal) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let result;
    let failure;
    let transaction;
    const cancel = () => {
      failure = new DOMException('已停止', 'AbortError');
      try { transaction?.abort(); } catch { /* already committed */ }
    };
    const finish = () => { signal?.removeEventListener('abort', cancel); db.close(); };
    try {
      if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
      transaction = db.transaction([META, FILES], mode);
      signal?.addEventListener('abort', cancel, { once: true });
      transaction.oncomplete = () => { finish(); resolve(result); };
      transaction.onabort = transaction.onerror = () => {
        finish();
        reject(failure || transaction.error || new Error('本機儲存交易失敗。'));
      };
      work(transaction, (value) => { result = value; });
    } catch (error) {
      failure = error;
      if (transaction) {
        try { transaction.abort(); } catch { finish(); reject(error); }
      } else { finish(); reject(error); }
    }
  });
}

export async function listStoredSheets() {
  return transact('readonly', (tx, setResult) => {
    const request = tx.objectStore(META).getAll();
    request.onsuccess = () => setResult((request.result || []).filter((item) => isSheetId(item.id)).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))));
  });
}

export async function readStoredSheet(id) {
  if (!isSheetId(id)) return null;
  return transact('readonly', (tx, setResult) => {
    let meta, blob;
    const metadata = tx.objectStore(META).get(id);
    const file = tx.objectStore(FILES).get(id);
    const finish = () => { if (metadata.readyState === 'done' && file.readyState === 'done') setResult(meta && blob instanceof Blob ? { meta, blob } : null); };
    metadata.onsuccess = () => { meta = metadata.result; finish(); };
    file.onsuccess = () => { blob = file.result; finish(); };
  });
}

export async function saveStoredSheet(meta, blob, { signal } = {}) {
  if (!isSheetId(meta?.id) || !(blob instanceof Blob) || blob.size !== meta.size) throw new Error('圖幅資料無效，未有儲存。');
  // Both stores commit atomically. A failed replacement must never destroy the
  // previous saved file or leave a success entry for a missing/truncated file.
  await transact('readwrite', (tx) => {
    tx.objectStore(META).put(meta);
    tx.objectStore(FILES).put(blob, meta.id);
  }, signal);
  announceChange();
}

export async function deleteStoredSheet(id) {
  if (!isSheetId(id)) throw new Error('圖幅編號無效。');
  await transact('readwrite', (tx) => {
    tx.objectStore(META).delete(id);
    tx.objectStore(FILES).delete(id);
  });
  announceChange();
}

function announceChange() {
  try { localStorage.setItem(SHEETS_CHANGED_KEY, `${Date.now()}-${Math.random()}`); } catch { /* cross-tab sync is optional */ }
}

export function loadActiveSheet() {
  try { const id = localStorage.getItem(ACTIVE_KEY); return isSheetId(id) ? id : null; }
  catch { return null; }
}

export function saveActiveSheet(id) {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else if (isSheetId(id)) localStorage.setItem(ACTIVE_KEY, id);
    else return false;
    return true;
  } catch { return false; }
}
