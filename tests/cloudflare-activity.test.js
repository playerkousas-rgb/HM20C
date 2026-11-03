// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.js';
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
function env(db) { return { ACTIVITY_DB: db, ALLOWED_ORIGINS: origin, LEADER_PASSWORD: password, LEADER_SESSION_SECRET: sessionSecret }; }
function token() { return issueLeaderSession(leaderSigningSecret(password, { LEADER_SESSION_SECRET: sessionSecret })); }
async function call(environment, { method = 'GET', id, body, authorization = token(), requestOrigin = origin } = {}) {
  const url = new URL('https://activity.example.test/api/activity');
  if (id) url.searchParams.set('id', id);
  const headers = { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) };
  const response = await worker.fetch(new Request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), environment);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}
afterEach(() => { vi.useRealTimers(); });

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

  it('keeps different groups and owner keys separate with the same signing scheme as the Vercel login', async () => {
    const db = sqliteD1(); const settings = env(db); const expiry = Date.now() + 86400_000;
    const a = await call(settings, { method: 'POST', body: { set, expiresAt: expiry } });
    const b = await call(settings, { method: 'POST', body: { set: { ...set, name: 'B 團練習' }, expiresAt: expiry } });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id); expect(a.body.ownerKey).not.toBe(b.body.ownerKey);
    const wrongKey = await call(settings, { method: 'PUT', body: { id: b.body.id, ownerKey: a.body.ownerKey, expectedVersion: 1, action: 'extend', expiresAt: expiry + 86400_000 } });
    expect(wrongKey.status).toBe(403);
    const publicA = await call(settings, { id: a.body.id, authorization: null });
    const publicB = await call(settings, { id: b.body.id, authorization: null });
    expect(publicA.body.set.name).toBe('A 團練習'); expect(publicB.body.set.name).toBe('B 團練習');
    expect(JSON.stringify(publicA.body)).not.toContain('未公布答案');
    expect(JSON.stringify(publicA.body)).not.toContain(a.body.ownerKey);
    const extended = await call(settings, { method: 'PUT', body: { id: a.body.id, ownerKey: a.body.ownerKey, expectedVersion: 1, action: 'extend', expiresAt: expiry + 86400_000 } });
    expect(extended.status).toBe(200); expect(extended.body.id).toBe(a.body.id);
    expect(extended.body.expiresAt).toBe(expiry + 86400_000);
    expect((await call(settings, { id: b.body.id })).body.expiresAt).toBe(expiry);
    db.raw.close();
  });

  it('limits CORS to configured origins, handles preflight, and fails writes closed without a signing secret', async () => {
    const db = sqliteD1(); const settings = env(db);
    const preflight = await call(settings, { method: 'OPTIONS', authorization: null });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const rejected = await call(settings, { requestOrigin: 'https://other.example.test', id: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(rejected.status).toBe(403); expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
    const noSecret = await call({ ...settings, LEADER_SESSION_SECRET: '' }, { method: 'POST', body: { set } });
    expect(noSecret.status).toBe(503); expect(noSecret.body.error).toBe('leader_not_configured');
    const forged = await call(settings, { method: 'POST', authorization: issueLeaderSession(password), body: { set } });
    expect(forged.status).toBe(401);
    db.raw.close();
  });

  it('cleans expired rows on schedule while keeping active practices', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const db = sqliteD1(); const settings = env(db); const start = Date.now();
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
