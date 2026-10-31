import { deflate, Inflate } from 'pako';
import { answerPacket, publicQuestionSet, validateAnswerPacket, validateQuestionSet } from '../../shared/question-set.js';
import { decodeExercise } from './exercise';
import { parseGridReference } from './utm';

export const BANK_KEY = 'scout-trail-map.question-bank.v1';
export const MEMBER_KEY = 'scout-trail-map.question-member.v1';
export const ACTIVITY_KEY = 'scout-trail-map.question-activities.v1';
const MAX_RAW = 50000;

export function newId() {
  // Web Crypto works in the installed PWA and modern browsers, never Math.random.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}
export function newQuestion(type = 'grid') {
  return { id: newId(), type, prompt: { grid: '圖上標記的八位座標是甚麼？', identify: '以下座標的地點／圖例是甚麼？', bearing: '由 A 至 B 的方位是多少？', resection: '以地標 A、B、C 作後視線，找出位置。', free: '' }[type], reference: '', points: [], answer: '' };
}
export function newQuestionSet() { return { id: newId(), name: '', revision: 1, questions: [newQuestion()] }; }

export function readBank() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BANK_KEY) || '[]');
    if (!Array.isArray(parsed) || parsed.length > 50) return null;
    const sets = parsed.map((set) => validateQuestionSet(set, { privateAnswers: true }));
    if (sets.some((set) => !set) || new Set(sets.map((set) => set.id)).size !== sets.length) return null;
    return sets;
  } catch { return null; }
}
export function loadBank() { return readBank() || []; }
export function readActivities() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
export function loadActivities() { return readActivities() || {}; }

export function loadMember() {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMBER_KEY) || 'null');
    const set = validateQuestionSet(raw?.set);
    if (!set) return null;
    const answers = raw.answers?.length ? validateAnswerPacket({ kind: 'answers', v: 1, setId: set.id, revision: set.revision, answers: raw.answers })?.answers : [];
    const activityId = /^[A-Za-z0-9_-]{22,64}$/.test(raw.activityId || '') ? raw.activityId : null;
    return { set, answers: answers || [], activityId, version: Number.isSafeInteger(raw.version) ? raw.version : 0, syncedAt: Number(raw.syncedAt) || 0 };
  } catch { return null; }
}

function encode(value) {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  const bytes = deflate(raw, { level: 9 });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `z${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}
function decode(value) {
  if (!value || value.length > MAX_RAW || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('題目資料無效或過大。');
  try {
    const compressed = value.startsWith('z');
    const encoded = compressed ? value.slice(1) : value; // also accepts earlier uncompressed v1 links
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encoded.length % 4) % 4));
    let bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (compressed) {
      const chunks = []; let length = 0;
      const inflator = new Inflate({ chunkSize: 4096 });
      inflator.onData = (chunk) => {
        length += chunk.length;
        if (length > MAX_RAW) throw new Error('inflated data too large');
        chunks.push(chunk);
      };
      inflator.push(bytes, true);
      if (inflator.err) throw new Error('invalid compressed data');
      bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    }
    if (bytes.length > MAX_RAW) throw new Error('data too large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error('題目資料無法讀取。'); }
}
function packetFromObject(raw) {
  if (raw?.kind === 'questions' && raw.v === 1) {
    const set = validateQuestionSet(raw.set);
    if (set) return { kind: 'questions', set };
  }
  if (raw?.kind === 'answers') {
    const answers = validateAnswerPacket(raw);
    if (answers) return answers;
  }
  if (raw?.kind === 'activity' && raw.v === 1 && /^[A-Za-z0-9_-]{22,64}$/.test(raw.id || '')) return { kind: 'activity', id: raw.id };
  throw new Error('這不是有效的題組或答案資料。');
}
export function questionPacket(set) { return { kind: 'questions', v: 1, set: publicQuestionSet(set) }; }
export function questionShare(set, base = `${location.origin}${location.pathname}`) {
  const packet = questionPacket(set);
  if (!packet.set) throw new Error('題組資料無效。');
  return `${base}#questions=${encode(packet)}`;
}
export function answerShare(set, ids, base = `${location.origin}${location.pathname}`) {
  const packet = answerPacket(set, ids);
  if (!packet?.answers.length) throw new Error('沒有可分享的答案。');
  return `${base}#answers=${encode(packet)}`;
}
export function activityShare(id, base = `${location.origin}${location.pathname}`) {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(id || '')) throw new Error('活動連結無效。');
  return `${base}#activity=${id}`;
}
export function decodeShared(input) {
  const source = String(input || '').trim();
  if (!source || source.length > MAX_RAW) throw new Error('資料無效或過大。');
  if (source.startsWith('{')) {
    try { return packetFromObject(JSON.parse(source)); } catch { throw new Error('這不是有效的題組或答案 JSON。'); }
  }
  const hash = source.includes('#') ? source.slice(source.indexOf('#') + 1) : source.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  if (params.has('questions')) return packetFromObject(decode(params.get('questions')));
  if (params.has('answers')) return packetFromObject(decode(params.get('answers')));
  if (params.has('activity')) return packetFromObject({ kind: 'activity', v: 1, id: params.get('activity') });
  return { kind: 'exercise', exercise: decodeExercise(source) };
}
export function questionAsExercise(question) {
  if (question.type === 'free') return null;
  if (question.type === 'identify') {
    const point = parseGridReference(question.reference);
    return point ? { kind: 'points', title: '座標方格（中心點）', description: [...question.prompt].slice(0, 80).join(''), points: [{ lat: point.lat, lon: point.lon, name: '' }] } : null;
  }
  return { kind: question.type === 'grid' ? 'points' : question.type, title: '套題標記', description: [...question.prompt].slice(0, 80).join(''), points: question.points.map(({ lat, lon }) => ({ lat, lon, name: '' })) };
}
export function saveJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export { answerPacket, publicQuestionSet, validateQuestionSet };
