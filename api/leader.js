import { createHash, timingSafeEqual } from 'node:crypto';
import { issueLeaderSession, leaderSigningSecret } from '../server/leader-session.js';

// This function verifies the password but does not claim to protect map data:
// the map and the calculations are shipped to every browser for offline use.
// A best-effort per-instance throttle reduces casual guessing; serverless
// instances do not share counters, so this is not a global rate limiter.
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_BODY = 4096;
const SESSION_SECONDS = 8 * 60 * 60;

function reply(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
function clientKey(req) {
  const value = req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  return String(value).split(',')[0].trim().slice(0, 128);
}
function bucket(key, now) {
  // Avoid an unbounded map on long-lived local development processes.
  if (attempts.size > 1000) for (const [entry, value] of attempts) {
    if (now - value.start >= WINDOW_MS) attempts.delete(entry);
  }
  if (attempts.size > 2000 && !attempts.has(key)) return { start: now, failures: MAX_FAILURES };
  const existing = attempts.get(key);
  if (existing && now - existing.start < WINDOW_MS) return existing;
  const created = { start: now, failures: 0 }; attempts.set(key, created); return created;
}
async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) throw new Error('too large');
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null) {
      if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY) throw new Error('too large');
      return req.body;
    }
    const body = String(req.body);
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error('too large');
    return JSON.parse(body);
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function sameSecret(a, b) {
  // Equal-sized digests avoid leaking the password length through the comparison.
  const first = createHash('sha256').update(a, 'utf8').digest();
  const second = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(first, second);
}
export default async function leaderHandler(req, res, options = {}) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(res, 405, { error: 'method' }); return; }
  const password = options.password ?? process.env.LEADER_PASSWORD;
  if (!password) { reply(res, 503, { error: 'not_configured' }); return; }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    reply(res, 415, { error: 'content_type' }); return;
  }
  const key = clientKey(req); const entry = bucket(key, Date.now());
  if (entry.failures >= MAX_FAILURES) {
    res.setHeader('Retry-After', String(Math.ceil((entry.start + WINDOW_MS - Date.now()) / 1000)));
    reply(res, 429, { error: 'rate_limited' }); return;
  }
  let body;
  try { body = await readBody(req); } catch { reply(res, 400, { error: 'invalid_request' }); return; }
  if (typeof body?.password !== 'string' || Buffer.byteLength(body.password) > 1024 || !sameSecret(body.password, password)) {
    entry.failures += 1; reply(res, 401, { error: 'incorrect' }); return;
  }
  attempts.delete(key);
  // The short-lived, signed token authorizes activity writes; the browser
  // keeps it only in memory and never receives the password back.
  reply(res, 200, { ok: true, durationSeconds: SESSION_SECONDS, token: issueLeaderSession(leaderSigningSecret(password, options.env || process.env)) });
}
