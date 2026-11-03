// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { issueLeaderSession, leaderSigningSecret } from '../server/leader-session.js';

it('runs the bundled Worker, CORS, shared leader session and D1 in local workerd', async () => {
  const built = await build({ entryPoints: ['cloudflare/worker.js'], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'] });
  const origin = 'https://app.example.test';
  const password = 'local-test-password';
  const secret = 'local-testing-secret-never-for-production';
  const mf = new Miniflare({ workers: [{ config: {
    name: 'hm20c-local-test', compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: built.outputFiles[0].text } } },
    env: {
      ACTIVITY_DB: { type: 'd1', id: 'local-test-database' },
      ALLOWED_ORIGINS: { type: 'text', value: origin },
      LEADER_PASSWORD: { type: 'text', value: password },
      LEADER_SESSION_SECRET: { type: 'text', value: secret },
    },
  } }] });
  try {
    const db = await mf.getD1Database('ACTIVITY_DB');
    const schema = (await readFile('cloudflare/schema.sql', 'utf8')).replace(/^--.*$/gm, '');
    for (const sql of schema.split(';').map((value) => value.trim()).filter(Boolean)) await db.prepare(sql).run();
    const set = { id: '0123456789abcdef', name: 'A 團練習', revision: 1, questions: [
      { id: '1111111111111111', type: 'free', prompt: '題目', reference: '', points: [], answer: '未公布答案' },
    ] };
    const token = issueLeaderSession(leaderSigningSecret(password, { LEADER_SESSION_SECRET: secret }));
    const create = await mf.dispatchFetch('https://worker.example.test/api/activity', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ set, expiresAt: Date.now() + 86400_000 }),
    });
    expect(create.status).toBe(201);
    const created = await create.json();
    const read = await mf.dispatchFetch(`https://worker.example.test/api/activity?id=${created.id}`, { headers: { origin } });
    expect(read.status).toBe(200);
    const publicBody = await read.text();
    expect(publicBody).not.toContain('未公布答案'); expect(publicBody).not.toContain(created.ownerKey);
    const preflight = await mf.dispatchFetch('https://worker.example.test/api/activity', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    const denied = await mf.dispatchFetch('https://worker.example.test/api/activity', { method: 'OPTIONS', headers: { origin: 'https://untrusted.example' } });
    expect(denied.status).toBe(403);

    const createB = await mf.dispatchFetch('https://worker.example.test/api/activity', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ set: { ...set, name: 'B 團練習' }, expiresAt: Date.now() + 86400_000 }),
    });
    const b = await createB.json(); expect(createB.status).toBe(201); expect(b.id).not.toBe(created.id);
    const write = (body) => mf.dispatchFetch('https://worker.example.test/api/activity', {
      method: 'PUT', headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    const wrongOwner = await write({ id: b.id, ownerKey: created.ownerKey, expectedVersion: 1, action: 'extend', expiresAt: Date.now() + 2 * 86400_000 });
    expect(wrongOwner.status).toBe(403);
    const release = await write({ id: created.id, ownerKey: created.ownerKey, expectedVersion: 1, action: 'release', set, questionIds: [set.questions[0].id] });
    expect(release.status).toBe(200);
    const aAfter = await (await mf.dispatchFetch(`https://worker.example.test/api/activity?id=${created.id}`, { headers: { origin } })).json();
    const bAfter = await (await mf.dispatchFetch(`https://worker.example.test/api/activity?id=${b.id}`, { headers: { origin } })).json();
    expect(aAfter.answers[0].answer).toBe('未公布答案'); expect(bAfter.answers).toEqual([]);
    const later = Date.now() + 2 * 86400_000;
    const extended = await write({ id: created.id, ownerKey: created.ownerKey, expectedVersion: 2, action: 'extend', expiresAt: later });
    expect(extended.status).toBe(200);
    expect((await extended.json()).id).toBe(created.id);
  } finally { await mf.dispose(); }
}, 30_000);
