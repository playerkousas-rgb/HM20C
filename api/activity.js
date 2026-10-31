import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { publicQuestionSet, validId, validateQuestionSet } from '../shared/question-set.js';
import { leaderSigningSecret, verifyLeaderSession } from '../server/leader-session.js';
import { ACTIVITY_TTL_SECONDS, redisFromEnv } from '../server/activity-store.js';

const MAX_BODY = 32768;
const ID = /^[A-Za-z0-9_-]{22,64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
function reply(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function matchesKey(key, stored) {
  if (!KEY.test(key || '') || !/^[a-f0-9]{64}$/.test(stored || '')) return false;
  const actual = Buffer.from(hash(key), 'hex'); const expected = Buffer.from(stored, 'hex');
  return timingSafeEqual(actual, expected);
}
function setFingerprint(key, set) {
  return createHmac('sha256', key).update(JSON.stringify(set)).digest('base64url');
}
function ownerView(id, record, key) { return { ...publicView(id, record), setFingerprint: setFingerprint(key, record.set) }; }
function sameFingerprint(value, expected) {
  if (!KEY.test(value || '')) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function authorized(req, secret) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') && verifyLeaderSession(header.slice(7), secret);
}
async function readBody(req) {
  if (req.body != null) {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error('large');
    return JSON.parse(body);
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function publicView(id, record) {
  const set = publicQuestionSet(record.set);
  if (!set) throw new Error('invalid data');
  const released = new Set(record.released || []);
  return { id, version: record.version, set, answers: record.set.questions.filter((q) => released.has(q.id)).map(({ id: questionId, answer }) => ({ id: questionId, answer })), updatedAt: record.updatedAt, expiresAt: record.expiresAt };
}

export default async function handler(req, res, options = {}) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return reply(res, 405, { error: 'method' });
  const store = options.store || redisFromEnv(options.env || process.env);
  if (!store) return reply(res, 503, { error: 'storage_not_configured' });
  const secret = options.password ?? process.env.LEADER_PASSWORD ?? '';
  const url = new URL(req.url || '/api/activity', 'http://local');
  if (req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!ID.test(id)) return reply(res, 400, { error: 'invalid_id' });
    try {
      const record = await store.get(id);
      if (!record) return reply(res, 404, { error: 'not_found' });
      return reply(res, 200, publicView(id, record));
    } catch { return reply(res, 503, { error: 'storage_unavailable' }); }
  }
  if (!secret) return reply(res, 503, { error: 'leader_not_configured' });
  if (!authorized(req, leaderSigningSecret(secret, options.env || process.env))) return reply(res, 401, { error: 'unauthorized' });
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return reply(res, 415, { error: 'content_type' });
  let data;
  try { data = await readBody(req); } catch { return reply(res, 400, { error: 'invalid_body' }); }
  try {
    const now = Date.now();
    const expiresAt = now + ACTIVITY_TTL_SECONDS * 1000;
    if (req.method === 'POST') {
      const set = validateQuestionSet(data?.set, { privateAnswers: true });
      if (!set) return reply(res, 400, { error: 'invalid_set' });
      const id = randomBytes(16).toString('base64url');
      const ownerKey = randomBytes(32).toString('base64url');
      const record = { version: 1, set, released: [], ownerHash: hash(ownerKey), updatedAt: now, expiresAt };
      if (!(await store.create(id, record))) return reply(res, 503, { error: 'storage_unavailable' });
      return reply(res, 201, { ...ownerView(id, record, ownerKey), ownerKey });
    }
    const { id, ownerKey, expectedVersion, action } = data || {};
    if (!ID.test(id || '') || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return reply(res, 400, { error: 'invalid_request' });
    const record = await store.get(id);
    if (!record) return reply(res, 404, { error: 'not_found' });
    if (!matchesKey(ownerKey, record.ownerHash)) return reply(res, 403, { error: 'not_owner' });
    if (record.version !== expectedVersion) return reply(res, 409, { error: 'conflict', version: record.version });
    if (req.method === 'DELETE') {
      const result = await store.compareDelete(id, expectedVersion);
      if (result !== 1) return reply(res, result === 0 ? 404 : 409, { error: result === 0 ? 'not_found' : 'conflict' });
      return reply(res, 200, { ok: true });
    }
    if (action === 'sync') {
      // Refreshing only a public version must never authorize overwriting
      // another leader's private changes, even if revision numbers collide.
      if (!sameFingerprint(data.baseFingerprint, setFingerprint(ownerKey, record.set))) return reply(res, 409, { error: 'set_conflict', version: record.version });
      const set = validateQuestionSet(data.set, { privateAnswers: true });
      if (!set || set.id !== record.set.id || set.revision < record.set.revision) return reply(res, 400, { error: 'invalid_set' });
      if (set.revision === record.set.revision) {
        // A revision is immutable. It may be retried without changing visibility.
        if (JSON.stringify(set) !== JSON.stringify(record.set)) return reply(res, 409, { error: 'revision_conflict', version: record.version });
        return reply(res, 200, ownerView(id, record, ownerKey));
      }
      record.set = set; record.released = [];
    } else if (action === 'release') {
      // The leader must preview exactly the private answers being published.
      const selected = validateQuestionSet(data.set, { privateAnswers: true });
      if (!selected || JSON.stringify(selected) !== JSON.stringify(record.set)) return reply(res, 409, { error: 'set_conflict', version: record.version });
      if (!Array.isArray(data.questionIds) || !data.questionIds.length || data.questionIds.length > record.set.questions.length
          || !data.questionIds.every((qid) => validId(qid) && record.set.questions.some((q) => q.id === qid))) return reply(res, 400, { error: 'invalid_questions' });
      record.released = [...new Set([...(record.released || []), ...data.questionIds])];
    } else return reply(res, 400, { error: 'invalid_action' });
    record.version += 1; record.updatedAt = now; record.expiresAt = expiresAt;
    const result = await store.compareSet(id, expectedVersion, record);
    if (result !== 1) return reply(res, result === 0 ? 404 : 409, { error: result === 0 ? 'not_found' : 'conflict' });
    return reply(res, 200, ownerView(id, record, ownerKey));
  } catch { return reply(res, 503, { error: 'storage_unavailable' }); }
}
