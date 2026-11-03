// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.js';
import verifyHandler from '../api/leader-verify.js';
import { createD1ActivityStore } from '../server/d1-activity-store.js';
import { issueLeaderSession, leaderSigningSecret } from '../server/leader-session.js';

// D1 executes SQLite statements. This adapter runs the real schema and SQL in
// Node's SQLite rather than replacing the data store with canned responses.
function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      return { bind(...values) {
        return {
          async first() { return db.prepare(sql).get(...values) || null; },
          async run() { const result = db.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
        };
      } };
    },
  };
}
const set = { id: '0123456789abcdef', name: 'A 團練習', revision: 1, questions: [
  { id: '1111111111111111', type: 'free', prompt: '題目', reference: '', points: [], answer: '未公布答案' },
] };
const password = 'leader-test-only';
const sessionSecret = 'independent-random-test-secret-not-for-production';
const origin = 'https://app.example.test';
const verifyUrl = 'https://app.example.test/api/leader-verify';
// Deliberately omit the human password: the Worker must not need it.
function env(db) { return { ACTIVITY_DB: db, ALLOWED_ORIGINS: origin, LEADER_SESSION_SECRET: sessionSecret, LEADER_VERIFY_URL: verifyUrl }; }
function token(pass = password) { return issueLeaderSession(leaderSigningSecret(pass, { LEADER_SESSION_SECRET: sessionSecret })); }
function installVerifier(state = { password }) {
  const calls = [];
  vi.stubGlobal('fetch', async (url, options) => {
    calls.push({ url, options });
    const req = { method: options.method, headers: Object.fromEntries(new Headers(options.headers)) };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.data = value; } };
    await verifyHandler(req, res, { env: { LEADER_PASSWORD: state.password, LEADER_SESSION_SECRET: sessionSecret } });
    return new Response(res.data, { status: res.statusCode, headers: res.headers });
  });
  return calls;
}
async function call(environment, { method = 'GET', id, body, authorization = token(), requestOrigin = origin } = {}) {
  const url = new URL('https://activity.example.test/api/activity');
  if (id) url.searchParams.set('id', id);
  const headers = { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) };
  const response = await worker.fetch(new Request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), environment);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Cloudflare D1 practice backend', () => {
  it('uses conditional SQL writes and rejects expired records before cleanup', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const db = sqliteD1(); const store = createD1ActivityStore(db); const expiresAt = Date.now() + 60_000;
    const record = { version: 1, expiresAt, set };
    expect(await store.create('one', record)).toBe(true);
    expect(await store.create('one', record)).toBe(false);
    const results = await Promise.all([
      store.compareSet('one', 1, { ...record, version: 2 }),
      store.compareSet('one', 1, { ...record, version: 2 }),
    ]);
    expect(results.sort()).toEqual([-1, 1]);
    expect(await store.compareDelete('one', 1)).toBe(-1);
    vi.advanceTimersByTime(60_000);
    expect(await store.get('one')).toBeNull();
    expect(await store.compareSet('one', 2, { ...record, version: 3, expiresAt: Date.now() + 60_000 })).toBe(0);
    expect(db.raw.prepare('SELECT count(*) AS n FROM activities').get().n).toBe(1);
    db.raw.close();
  });

  it('keeps groups and owner keys separate without any Worker leader password', async () => {
    const calls = installVerifier(); const db = sqliteD1(); const settings = env(db); const expiry = Date.now() + 86400_000;
    const a = await call(settings, { method: 'POST', body: { set, expiresAt: expiry } });
    const b = await call({ ...settings, LEADER_PASSWORD: 'stale-ignored-password' }, { method: 'POST', body: { set: { ...set, name: 'B 團練習' }, expiresAt: expiry } });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id); expect(a.body.ownerKey).not.toBe(b.body.ownerKey);
    const wrongKey = await call(settings, { method: 'PUT', body: { id: b.body.id, ownerKey: a.body.ownerKey, expectedVersion: 1, action: 'extend', expiresAt: expiry + 86400_000 } });
    expect(wrongKey.status).toBe(403);
    const beforeReads = calls.length;
    const publicA = await call(settings, { id: a.body.id, authorization: null });
    const publicB = await call(settings, { id: b.body.id, authorization: null });
    expect(calls).toHaveLength(beforeReads); // Member reads never call Vercel.
    expect(publicA.body.set.name).toBe('A 團練習'); expect(publicB.body.set.name).toBe('B 團練習');
    expect(JSON.stringify(publicA.body)).not.toContain('未公布答案');
    expect(JSON.stringify(publicA.body)).not.toContain(a.body.ownerKey);
    const extended = await call(settings, { method: 'PUT', body: { id: a.body.id, ownerKey: a.body.ownerKey, expectedVersion: 1, action: 'extend', expiresAt: expiry + 86400_000 } });
    expect(extended.status).toBe(200); expect(extended.body.id).toBe(a.body.id);
    expect(extended.body.expiresAt).toBe(expiry + 86400_000);
    expect((await call(settings, { id: b.body.id })).body.expiresAt).toBe(expiry);
    expect(calls.every((c) => c.url === verifyUrl && c.options.redirect === 'manual' && c.options.body === undefined)).toBe(true);
    db.raw.close();
  });

  it('limits CORS and fails writes closed when Vercel verification cannot be trusted', async () => {
    const calls = installVerifier(); const db = sqliteD1(); const settings = env(db);
    const preflight = await call(settings, { method: 'OPTIONS', authorization: null });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const rejected = await call(settings, { requestOrigin: 'https://other.example.test', id: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(rejected.status).toBe(403); expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
    const noSecret = await call({ ...settings, LEADER_SESSION_SECRET: '' }, { method: 'POST', body: { set } });
    expect(noSecret.status).toBe(503); expect(noSecret.body.error).toBe('leader_not_configured');
    expect((await call({ ...settings, LEADER_VERIFY_URL: 'https://evil.example/?target=verifier' }, { method: 'POST', body: { set } })).status).toBe(503);
    expect(calls).toHaveLength(0);
    const wrongSecret = await call({ ...settings, LEADER_SESSION_SECRET: 'a-different-very-long-test-key-not-production' }, { method: 'POST', body: { set } });
    expect(wrongSecret.status).toBe(503); expect(wrongSecret.body.error).toBe('leader_not_configured');
    const forged = await call(settings, { method: 'POST', authorization: issueLeaderSession(password), body: { set } });
    expect(forged.status).toBe(401);
    let redirects = 0;
    vi.stubGlobal('fetch', async (_url, options) => {
      redirects += 1; expect(options.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { Location: 'https://untrusted.example/' } });
    });
    expect((await call(settings, { method: 'POST', body: { set } })).status).toBe(503);
    expect(redirects).toBe(1); // Never forward the Worker key to a redirect target.
    expect(db.raw.prepare('SELECT count(*) AS n FROM activities').get().n).toBe(0);
    db.raw.close();
  });

  it('rejects old sessions against the fixed current deployment even if a past deployment still signs them', async () => {
    const state = { password }; const calls = installVerifier(state); const db = sqliteD1(); const settings = env(db);
    const old = token();
    const created = await call(settings, { method: 'POST', body: { set }, authorization: old });
    expect(created.status).toBe(201);
    state.password = 'new-leader-password'; // Vercel Production redeployed; Worker settings untouched.
    const oldDeploymentStillSigns = token(password);
    const mutation = { id: created.body.id, ownerKey: created.body.ownerKey, expectedVersion: 1, action: 'extend', expiresAt: Date.now() + 8 * 86400_000 };
    expect((await call(settings, { method: 'PUT', body: mutation, authorization: old })).status).toBe(401);
    expect((await call(settings, { method: 'PUT', body: mutation, authorization: oldDeploymentStillSigns })).status).toBe(401);
    expect((await call(settings, { method: 'PUT', body: mutation, authorization: token(state.password) })).status).toBe(200);
    expect(calls.every((c) => c.url === verifyUrl)).toBe(true);
    expect((await call(settings, { id: created.body.id, authorization: null })).status).toBe(200);
    db.raw.close();
  });

  it('cleans expired rows on schedule while keeping active practices', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    installVerifier(); const db = sqliteD1(); const settings = env(db); const start = Date.now();
    const a = await call(settings, { method: 'POST', body: { set, expiresAt: start + 60_000 } });
    const b = await call(settings, { method: 'POST', body: { set, expiresAt: start + 120_000 } });
    vi.advanceTimersByTime(60_000);
    expect((await call(settings, { id: a.body.id, authorization: null })).status).toBe(404);
    let pending; worker.scheduled({}, settings, { waitUntil(promise) { pending = promise; } }); await pending;
    expect(db.raw.prepare('SELECT count(*) AS n FROM activities').get().n).toBe(1);
    expect((await call(settings, { id: b.body.id, authorization: null })).status).toBe(200);
    db.raw.close();
  });
});
