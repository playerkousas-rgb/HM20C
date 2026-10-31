import { distanceMeters } from './geo';
import { inHongKongGrid } from './utm';

export const EXERCISE_KEY = 'scout-trail-map.exercise.v1';
export const MAX_EXERCISE_POINTS = 6;
const codes = { points: 'p', bearing: 'b', resection: 'r' };
const kinds = { p: 'points', b: 'bearing', r: 'resection' };
const invalid = () => new Error('這不是有效的山野地圖題目，請向領袖重新索取。');
const cleanText = (value, max, required = false) => {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw invalid();
  const result = value.trim();
  if ((required && !result) || [...result].length > max) throw invalid();
  return result;
};

/** Fail closed for malformed, unknown-version, oversized or out-of-area QR data. */
export function validateExercise(input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(codes, input.kind) || !Array.isArray(input.points)) throw invalid();
  const { kind } = input;
  const count = input.points.length;
  if ((kind === 'bearing' && count !== 2) || (kind === 'resection' && count !== 3) ||
      (kind === 'points' && (count < 1 || count > MAX_EXERCISE_POINTS))) throw invalid();
  const title = cleanText(input.title, 28, true);
  const description = cleanText(input.description ?? '', 80);
  const points = input.points.map((point) => {
    if (!point || typeof point.lat !== 'number' || typeof point.lon !== 'number' || !inHongKongGrid(point)) throw invalid();
    return { lat: point.lat, lon: point.lon, name: cleanText(point.name ?? '', 12) };
  });
  if (kind !== 'points') {
    for (let i = 0; i < points.length; i += 1) for (let j = 0; j < i; j += 1) {
      if (distanceMeters(points[i], points[j]) < 10) throw new Error('方位及三角網的地標須相距至少 10 米，請重選地點。');
    }
  }
  return { kind, title, description, points };
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBase64(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 1200) throw invalid();
  try {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
    const binary = atob(base64);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch { throw invalid(); }
}

// All information lives in the fragment: no location is uploaded to a server.
// Six decimal degrees are roughly decimetres here; labels are untrusted text.
export function exerciseUrl(exercise, baseUrl) {
  const task = validateExercise(exercise);
  const payload = {
    v: 1, k: codes[task.kind], t: task.title, d: task.description,
    p: task.points.map((p) => [Math.round(p.lat * 1e6), Math.round(p.lon * 1e6), p.name]),
  };
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid();
  url.search = '';
  url.hash = `exercise=${encodeBase64(JSON.stringify(payload))}`;
  return url.toString();
}

export function decodeExercise(text) {
  if (typeof text !== 'string' || text.length > 1600) throw invalid();
  let url;
  try { url = new URL(text.trim()); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid();
  const params = new URLSearchParams(url.hash.slice(1));
  const token = params.get('exercise');
  if (!token || [...params.keys()].length !== 1) throw invalid();
  let data;
  try { data = JSON.parse(decodeBase64(token)); } catch { throw invalid(); }
  if (!data || data.v !== 1 || !Object.hasOwn(kinds, data.k) || !Array.isArray(data.p)) throw invalid();
  const points = data.p.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 3 || !Number.isInteger(entry[0]) || !Number.isInteger(entry[1])) throw invalid();
    return { lat: entry[0] / 1e6, lon: entry[1] / 1e6, name: entry[2] };
  });
  return validateExercise({ kind: kinds[data.k], title: data.t, description: data.d, points });
}

export function loadExercise() {
  try {
    const stored = localStorage.getItem(EXERCISE_KEY);
    return stored ? validateExercise(JSON.parse(stored)) : null;
  } catch { return null; }
}
export function saveExercise(exercise) {
  try {
    if (exercise) localStorage.setItem(EXERCISE_KEY, JSON.stringify(validateExercise(exercise)));
    else localStorage.removeItem(EXERCISE_KEY);
    return true;
  } catch { return false; }
}
