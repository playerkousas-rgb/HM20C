// @vitest-environment node
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/activity.js';
import { createMemoryActivityStore, redisFromEnv } from '../server/activity-store.js';
import { issueLeaderSession, leaderSigningSecret, verifyLeaderSession } from '../server/leader-session.js';

const password = 'leader test secret';
const token = issueLeaderSession(password);
const set = { id: '0123456789abcdef', name: '課程', revision: 1, questions: [
  { id: '1111111111111111', type: 'identify', prompt: '哪個地點？', reference: '50Q KK 2430 7773', points: [], answer: '保密答案' },
  { id: '2222222222222222', type: 'free', prompt: '哪個圖例？', reference: '', points: [], answer: '另一秘密' },
] };
async function request(store, { method = 'GET', id = '', body, auth = token } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.url = `/?id=${id}`; req.method = method;
  req.headers = { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) };
  const headers = {};
  const res = { setHeader(k, v) { headers[k] = v; }, end(value) { this.data = value; } };
  await handler(req, res, { store, password });
  return { status: res.statusCode, body: JSON.parse(res.data), headers };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('authorized question activity', () => {
  it('requires signed, expiring leader sessions; a changed password revokes them', () => {
    expect(verifyLeaderSession(token, password)).toBe(true);
    expect(verifyLeaderSession(`${token}x`, password)).toBe(false);
    expect(verifyLeaderSession(token, 'different')).toBe(false);
    expect(verifyLeaderSession(issueLeaderSession(password, 0), password)).toBe(false);
    const highEntropy = leaderSigningSecret(password, { KV_REST_API_TOKEN: 'random-database-secret' });
    const signed = issueLeaderSession(highEntropy);
    expect(verifyLeaderSession(signed, password)).toBe(false);
    expect(verifyLeaderSession(signed, highEntropy)).toBe(true);
    expect(verifyLeaderSession(signed, leaderSigningSecret('new password', { KV_REST_API_TOKEN: 'random-database-secret' }))).toBe(false);
  });
  it('requires both leader authentication and room owner key, never leaks unpublished answers', async () => {
    const store = createMemoryActivityStore();
    expect((await request(store, { method: 'POST', auth: null, body: { set } })).status).toBe(401);
    const created = await request(store, { method: 'POST', body: { set } });
    expect(created.status).toBe(201);
    const { id, ownerKey, setFingerprint } = created.body;
    const shown = await request(store, { id });
    expect(shown.status).toBe(200); expect(shown.headers['Cache-Control']).toContain('no-store');
    expect(JSON.stringify(shown.body)).not.toContain('保密答案');
    expect(JSON.stringify(shown.body)).not.toContain('另一秘密');
    expect(JSON.stringify(shown.body)).not.toContain(ownerKey);
    expect(JSON.stringify(shown.body)).not.toContain(setFingerprint);
    expect((await request(store, { method: 'PUT', body: { id, expectedVersion: 1, ownerKey: 'x'.repeat(43), action: 'release', questionIds: [set.questions[0].id] } })).status).toBe(403);
    expect((await request(store, { method: 'PUT', auth: null, body: { id, expectedVersion: 1, ownerKey, set, action: 'release', questionIds: [set.questions[0].id] } })).status).toBe(401);
    const release = await request(store, { method: 'PUT', body: { id, ownerKey, expectedVersion: 1, set, action: 'release', questionIds: [set.questions[0].id] } });
    expect(release.body.answers).toEqual([{ id: set.questions[0].id, answer: '保密答案' }]);
    expect(JSON.stringify(await request(store, { id }))).not.toContain('另一秘密');
    expect((await request(store, { method: 'PUT', body: { id, ownerKey, expectedVersion: 1, action: 'release', questionIds: [set.questions[1].id] } })).status).toBe(409);
    const updated = { ...set, revision: 2, questions: set.questions.map((q) => ({ ...q, answer: '新答案' })) };
    const sync = await request(store, { method: 'PUT', body: { id, ownerKey, expectedVersion: 2, baseFingerprint: setFingerprint, action: 'sync', set: updated } });
    expect(sync.body.set.revision).toBe(2); expect(sync.body.answers).toEqual([]);
    expect(JSON.stringify(await request(store, { id }))).not.toContain('新答案');
    // A stale device may refresh the public version, but must not overwrite
    // private changes or publish answers different from its own preview.
    const divergent = { ...updated, questions: updated.questions.map((q) => ({ ...q, answer: '另一裝置答案' })) };
    expect((await request(store, { method: 'PUT', body: { id, ownerKey, expectedVersion: 3, baseFingerprint: setFingerprint, action: 'sync', set: { ...divergent, revision: 3 } } })).body.error).toBe('set_conflict');
    expect((await request(store, { method: 'PUT', body: { id, ownerKey, expectedVersion: 3, action: 'release', set: divergent, questionIds: [divergent.questions[0].id] } })).body.error).toBe('set_conflict');
    expect((await request(store, { method: 'DELETE', body: { id, ownerKey, expectedVersion: 2 } })).status).toBe(409);
    expect((await request(store, { method: 'DELETE', body: { id, ownerKey, expectedVersion: 3 } })).body).toEqual({ ok: true });
    expect((await request(store, { id })).status).toBe(404);
  });
  it('atomically rejects competing updates and expires after seven days', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const store = createMemoryActivityStore();
    const timedToken = issueLeaderSession(password);
    const created = await request(store, { method: 'POST', auth: timedToken, body: { set } });
    expect(created.status).toBe(201);
    const { id, ownerKey, setFingerprint } = created.body;
    const a = { ...set, revision: 2, questions: set.questions.map((q) => ({ ...q, answer: '甲' })) };
    const b = { ...set, revision: 2, questions: set.questions.map((q) => ({ ...q, answer: '乙' })) };
    const body = { id, ownerKey, expectedVersion: 1, baseFingerprint: setFingerprint, action: 'sync' };
    const results = await Promise.all([request(store, { method: 'PUT', auth: timedToken, body: { ...body, set: a } }), request(store, { method: 'PUT', auth: timedToken, body: { ...body, set: b } })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect((await request(store, { id })).status).toBe(404);
  });
  it('returns a clear error instead of silently storing activities in memory', async () => {
    const req = Readable.from([]); req.url = '/?id=AAAAAAAAAAAAAAAAAAAAAA'; req.method = 'GET'; req.headers = {};
    const res = { setHeader() {}, end(value) { this.data = value; } };
    await handler(req, res, { env: {}, password });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.data)).toEqual({ error: 'storage_not_configured' });
  });
  it('uses the Upstash REST command format, atomic Lua and expiry without exposing credentials', async () => {
    const record = { version: 1, set, released: [], ownerHash: 'private', updatedAt: 123, expiresAt: 456 };
    const results = ['OK', JSON.stringify(record), 1, 1];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ result: results.shift() }) }));
    vi.stubGlobal('fetch', fetchMock);
    const store = redisFromEnv({ UPSTASH_REDIS_REST_URL: 'https://sample.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'server-only-token' });
    expect(await store.create('roomId', record)).toBe(true);
    expect(await store.get('roomId')).toEqual(record);
    expect(await store.compareSet('roomId', 1, { ...record, version: 2 })).toBe(1);
    expect(await store.compareDelete('roomId', 2)).toBe(1);
    const [firstUrl, firstOptions] = fetchMock.mock.calls[0];
    expect(firstUrl).toBe('https://sample.upstash.io/');
    expect(firstOptions.headers.Authorization).toBe('Bearer server-only-token');
    expect(JSON.parse(firstOptions.body)).toEqual(['SET', 'hm20c:activity:v1:roomId', JSON.stringify(record), 'EX', 604800, 'NX']);
    const cas = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(cas[0]).toBe('EVAL'); expect(cas[1]).toContain("current.version");
    expect(cas.slice(2, 5)).toEqual([1, 'hm20c:activity:v1:roomId', 1]);
    const deleted = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(deleted[1]).toContain("redis.call('DEL'");
  });
  it('fails closed for writes if the leader password is missing', async () => {
    const req = Readable.from([Buffer.from(JSON.stringify({ set }))]);
    req.url = '/'; req.method = 'POST'; req.headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const res = { setHeader() {}, end(value) { this.data = value; } };
    await handler(req, res, { store: createMemoryActivityStore(), password: '', env: { KV_REST_API_TOKEN: 'secret' } });
    expect(res.statusCode).toBe(503); expect(JSON.parse(res.data).error).toBe('leader_not_configured');
  });
  it('does not silently use partial or insecure Redis configuration', () => {
    expect(redisFromEnv({})).toBeNull();
    expect(redisFromEnv({ UPSTASH_REDIS_REST_URL: 'https://example.com', KV_REST_API_URL: 'https://example.com', KV_REST_API_TOKEN: 'x' })).toBeNull();
    expect(redisFromEnv({ UPSTASH_REDIS_REST_URL: 'http://example.com', UPSTASH_REDIS_REST_TOKEN: 'x' })).toBeNull();
    expect(redisFromEnv({ KV_REST_API_URL: 'https://example.com', KV_REST_API_TOKEN: 'x' })).toBeTruthy();
  });
});
