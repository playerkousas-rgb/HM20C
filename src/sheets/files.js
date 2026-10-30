import { fromBlob } from 'geotiff';
import { BlobReader, ZipReader } from '@zip.js/zip.js';
import { isSheetId, rasterGeometry, sheetCoverage, sheetUrl } from './geometry.js';

// These caps are deliberately conservative for phones. Never bundle or proxy
// a map file: the only network request here is directly to LandsD.
export const MAX_SHEET_BYTES = 200 * 1024 * 1024;
const MAX_DECODED_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_SIDE = 100000;
const IDLE_TIMEOUT_MS = 90000;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小不明';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function abortError() { return new DOMException('已停止', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

async function magic(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (bytes.length < 4) return 'unknown';
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 42 || bytes[2] === 43) && bytes[3] === 0) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && (bytes[3] === 42 || bytes[3] === 43))) return 'tiff';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) return 'zip';
  return 'unknown';
}

/** Download only from the hardcoded official host; no third-party proxy. */
export async function fetchOfficialSheet(id, { signal, onProgress = () => {} } = {}) {
  if (!isSheetId(id)) throw new Error('請選擇有效的數碼圖幅。');
  checkAbort(signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer, timedOut = false, reader;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, IDLE_TIMEOUT_MS);
  };
  resetTimer();
  try {
    const response = await fetch(sheetUrl(id), { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (!response.ok || response.type === 'opaque') throw new Error(`官方下載未成功（HTTP ${response.status || '不明'}）。請改用官方網頁下載後選取手機檔案。`);
    const advertised = Number(response.headers.get('content-length')) || 0;
    if (advertised > MAX_SHEET_BYTES) throw new Error('官方檔案超過 200 MB，這個手機試用版未支援。');
    let size = 0;
    const parts = [];
    if (response.body?.getReader) {
      reader = response.body.getReader();
      while (true) {
        resetTimer();
        const { value, done } = await reader.read();
        if (done) break;
        checkAbort(signal);
        size += value.byteLength;
        if (size > MAX_SHEET_BYTES) throw new Error('官方檔案超過 200 MB，這個手機試用版未支援。');
        parts.push(value);
        onProgress({ done: size, total: advertised });
      }
    } else {
      // Without a streaming body there is no safe way to enforce the size cap
      // before allocating the response; the local file picker is the fallback.
      throw new Error('瀏覽器未支援分段讀取，請用官方網頁下載後選取手機檔案。');
    }
    checkAbort(signal);
    // Content-Length describes encoded HTTP bytes, not decoded data. It is
    // unsafe to compare here when a server chooses content encoding. ZIP CRC
    // and TIFF decoding are checked separately before saving.
    if (!size) throw new Error('官方下載沒有資料；請改用官方網頁下載後選取手機檔案。');
    return new Blob(parts, { type: response.headers.get('content-type') || '' });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error('官方下載逾時；請檢查網絡或改用官方網頁下載後選取手機檔案。');
    if (error?.name === 'TypeError' || error?.name === 'AbortError') {
      throw new Error('App 未能讀取官方下載（可能是網絡或瀏覽器跨網站限制）；請用官方網頁下載，再選取手機檔案。');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (reader) { try { await reader.cancel(); } catch { /* already closed */ } }
  }
}

/** Unpack exactly one TIFF. Zip entries are never sent to a server or filesystem. */
export async function extractTiff(blob, { signal, onProgress = () => {} } = {}) {
  checkAbort(signal);
  if (!(blob instanceof Blob) || !blob.size) throw new Error('未選取有效檔案。');
  if (blob.size > MAX_SHEET_BYTES) throw new Error('檔案超過 200 MB，這個手機試用版未支援。');
  const kind = await magic(blob);
  if (kind === 'tiff') return blob;
  if (kind !== 'zip') throw new Error('檔案不是 TIFF 或 ZIP；官方下載可能回傳了網頁或錯誤訊息。');
  const zip = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  try {
    const entries = await zip.getEntries();
    checkAbort(signal);
    const candidates = entries.filter((entry) => !entry.directory && /\.tiff?$/i.test(entry.filename) &&
      !entry.filename.startsWith('__MACOSX/') && !/(^|\/)\._[^/]*$/.test(entry.filename));
    if (candidates.length !== 1) throw new Error(`ZIP 內有 ${candidates.length} 個 TIFF；請先在手機解壓，並只選擇一張圖幅。`);
    const entry = candidates[0];
    if (entry.encrypted) throw new Error('暫不支援加密 ZIP，請先在手機解壓。');
    if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize <= 0 || entry.uncompressedSize > MAX_SHEET_BYTES) {
      throw new Error('ZIP 內的 TIFF 超過 200 MB 或大小無效，試用版未支援。');
    }
    const chunks = [];
    let size = 0;
    // Enforce the limit while streaming as well as checking ZIP metadata: a
    // malformed archive must not be able to inflate beyond the mobile cap.
    const sink = new WritableStream({
      write(chunk) {
        checkAbort(signal);
        size += chunk.byteLength;
        if (size > MAX_SHEET_BYTES || size > entry.uncompressedSize) throw new Error('ZIP 解壓大小異常，已停止。');
        chunks.push(chunk);
      },
    });
    await entry.getData(sink, { useWebWorkers: false, checkCrc32: true, signal, onprogress: (done, total) => onProgress({ done, total }) });
    checkAbort(signal);
    if (size !== entry.uncompressedSize) throw new Error('ZIP 解壓不完整，請重新下載。');
    const tiff = new Blob(chunks, { type: 'image/tiff' });
    if (await magic(tiff) !== 'tiff') throw new Error('ZIP 內的 TIFF 格式無效。');
    return tiff;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    // Preserve our actionable messages; add context for corrupt ZIP codecs/CRC.
    if (error?.message && /[\u3400-\u9fff]/.test(error.message)) throw error;
    throw new Error('ZIP 解壓或完整性檢查失敗，請重新下載或先在手機解壓。');
  } finally {
    try { await zip.close(); } catch { /* preserve original error */ }
  }
}

/** Open and sample a local GeoTIFF. Full cartographic content is NOT verified. */
export async function inspectTiff(blob, id, { signal } = {}) {
  if (!isSheetId(id)) throw new Error('請選擇有效的數碼圖幅。');
  checkAbort(signal);
  if (!(blob instanceof Blob) || blob.size > MAX_SHEET_BYTES || await magic(blob) !== 'tiff') throw new Error('請選擇有效的 TIFF 檔案。');
  let tiff, image;
  try {
    tiff = await fromBlob(blob, signal);
    image = await tiff.getImage();
  } catch {
    checkAbort(signal);
    throw new Error('無法讀取 TIFF；檔案可能損壞或格式不受支援。');
  }
  const width = image.getWidth(), height = image.getHeight();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw new Error('TIFF 影像尺寸異常或過大，試用版未支援。');
  }
  const directory = image.getFileDirectory();
  if (directory.Orientation && directory.Orientation !== 1) throw new Error('此 TIFF 的影像方向格式暫未支援。');
  const bits = [...(directory.BitsPerSample || [])];
  const samples = image.getSamplesPerPixel();
  const format = directory.SampleFormat ? [...directory.SampleFormat] : [1];
  if (!bits.length || bits.some((n) => !Number.isInteger(n) || n < 1 || n > 16) || samples < 1 || samples > 4 || format.some((n) => n !== 1)) {
    throw new Error('此 TIFF 的像素格式暫未支援；請使用 8／16 位彩色或調色盤圖幅。');
  }
  if (directory.PhotometricInterpretation === 2 && (samples < 3 || (samples === 4 && ![1, 2].includes(Number(directory.ExtraSamples?.[0]))))) {
    throw new Error('此 TIFF 的色彩或透明度格式暫未支援。');
  }
  const blockWidth = image.getTileWidth(), blockHeight = image.getTileHeight();
  const blockBytes = blockWidth * Math.min(blockHeight, height) * samples * Math.ceil(Math.max(...bits) / 8);
  if (!Number.isFinite(blockBytes) || blockBytes <= 0 || blockBytes > MAX_DECODED_BLOCK_BYTES) {
    throw new Error('此 TIFF 單個解碼區塊過大，手機試用版不能安全讀取。');
  }
  // Detect a truncated TIFF without decoding the enormous full-resolution
  // sheet: every advertised strip/tile must have bytes within the local file.
  // This does not validate the content of each compressed block.
  const offsets = directory.TileOffsets || directory.StripOffsets;
  const lengths = directory.TileByteCounts || directory.StripByteCounts;
  const blockCount = Math.ceil(width / blockWidth) * Math.ceil(height / blockHeight) * (directory.PlanarConfiguration === 2 ? samples : 1);
  if (!Number.isSafeInteger(blockCount) || blockCount < 1 || blockCount > 200000 || !offsets || !lengths || offsets.length < blockCount || lengths.length < blockCount) {
    throw new Error('TIFF 圖像區塊索引不完整或過多，請重新下載。');
  }
  for (let index = 0; index < blockCount; index += 1) {
    const offset = offsets[index], length = lengths[index];
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > blob.size) {
      throw new Error('TIFF 圖像區塊不完整，請重新下載。');
    }
  }
  const geometry = rasterGeometry({ width, height, directory, keys: image.getGeoKeys() });
  const coverage = sheetCoverage(geometry, id);
  try {
    const x = Math.floor(width / 2), y = Math.floor(height / 2);
    const sample = await image.readRGB({ window: [x, y, x + 1, y + 1], enableAlpha: true, signal });
    if (!sample || sample.length < 3 || sample.length > 4) throw new Error('Invalid sample');
  } catch {
    checkAbort(signal);
    throw new Error('TIFF 影像未能解碼；可能損壞或使用未支援的壓縮格式。');
  }
  checkAbort(signal);
  return {
    tiff, image, geometry,
    meta: { id, size: blob.size, width, height, crs: geometry.crs, bounds: geometry.bounds, center: coverage.center, coverage: coverage.fraction },
  };
}
