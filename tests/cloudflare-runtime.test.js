// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import verifyHandler from '../api/leader-verify.js';
import { issueLeaderSession, leaderSigningSecret } from '../server/leader-session.js';

it('runs the bundled Worker, current Vercel verification, CORS and D1 in local workerd', async () => {
  const built = await build({ entryPoints: ['cloudflare/worker.js'], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'] });
  const origin = 'https://app.example.test'; const verifyUrl = `${origin}/api/leader-verify`;
  const password = 'local-test-password'; const secret = 'local-testing-secret-never-for-production';
  const state = { password }; const verifyCalls = [];
  const mf = new Miniflare({ workers: [{ config: {
    name: 'hm20c-local-test', compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: built.outputFiles[0].text } } },
    env: {
      ACTIVITY_DB: { type: 'd1', id: 'local-test-database' },
      ALLOWED_ORIGINS: { type: 'text', value: origin },
      LEADER_VERIFY_URL: { type: 'text', value: verifyUrl },
      LEADER_SESSION_SECRET: { type: 'text', value: secret },
    },
  }, dev: { outboundService: { type: 'fetcher', handler: async (request) => {
    verifyCalls.push(request.url);
    const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.data = value; } };
    await verifyHandler({ method: request.method, headers: Object.fromEntries(request.headers) }, res,
      { env: { LEADER_PASSWORD: state.password, LEADER_SESSION_SECRET: secret } });
    return new Response(res.data, { status: res.statusCode, headers: res.headers });
  } } } }] });
  try {
    const db = await mf.getD1Database('ACTIVITY_DB');
    const schema = (await readFile('cloudflare/schema.sql', 'utf8')).replace(/^--.*$/gm, '');
    for (const sql of schema.split(';').map((value) => value.trim()).filter(Boolean)) await db.prepare(sql).run();
    const set = { id: '0123456789abcdef', name: 'A 團練習', revision: 1, questions: [
      { id: '1111111111111111', type: 'free', prompt: '題目', reference: '', points: [], answer: '未公布答案' },
    ] };
    const token = (pass) => issueLeaderSession(leaderSigningSecret(pass, { LEADER_SESSION_SECRET: secret }));
    const oldToken = token(password);
    const write = (method, data, session = oldToken) => mf.dispatchFetch('https://worker.example.test/api/activity', {
      method, headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify(data),
    });
    const create = await write('POST', { set, expiresAt: Date.now() + 86400_000 });
    expect(create.status).toBe(201);
    const created = await create.json();
    const callsBeforeRead = verifyCalls.length;
    const read = await mf.dispatchFetch(`https://worker.example.test/api/activity?id=${created.id}`, { headers: { origin } });
    expect(read.status).toBe(200); expect(verifyCalls).toHaveLength(callsBeforeRead);
    const publicBody = await read.text();
    expect(publicBody).not.toContain('未公布答案'); expect(publicBody).not.toContain(created.ownerKey);
    const preflight = await mf.dispatchFetch('https://worker.example.test/api/activity', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    const denied = await mf.dispatchFetch('https://worker.example.test/api/activity', { method: 'OPTIONS', headers: { origin: 'https://untrusted.example' } });
    expect(denied.status).toBe(403);
    const createB = await write('POST', { set: { ...set, name: 'B 團練習' }, expiresAt: Date.now() + 86400_000 });
    const b = await createB.json(); expect(createB.status).toBe(201); expect(b.id).not.toBe(created.id);
    const wrongOwner = await write('PUT', { id: b.id, ownerKey: created.ownerKey, expectedVersion: 1, action: 'extend', expiresAt: Date.now() + 2 * 86400_000 });
    expect(wrongOwner.status).toBe(403);
    const release = await write('PUT', { id: created.id, ownerKey: created.ownerKey, expectedVersion: 1, action: 'release', set, questionIds: [set.questions[0].id] });
    expect(release.status).toBe(200);
    const aAfter = await (await mf.dispatchFetch(`https://worker.example.test/api/activity?id=${created.id}`, { headers: { origin } })).json();
    const bAfter = await (await mf.dispatchFetch(`https://worker.example.test/api/activity?id=${b.id}`, { headers: { origin } })).json();
    expect(aAfter.answers[0].answer).toBe('未公布答案'); expect(bAfter.answers).toEqual([]);
    state.password = 'new-password'; // Only the production Vercel verifier changes.
    const extend = { id: created.id, ownerKey: created.ownerKey, expectedVersion: 2, action: 'extend', expiresAt: Date.now() + 2 * 86400_000 };
    expect((await write('PUT', extend, oldToken)).status).toBe(401);
    expect((await write('PUT', extend, token(password))).status).toBe(401); // newly issued by an old deployment
    const extended = await write('PUT', extend, token(state.password));
    expect(extended.status).toBe(200); expect((await extended.json()).id).toBe(created.id);
    expect(verifyCalls.every((url) => url === verifyUrl)).toBe(true);
  } finally { await mf.dispose(); }
}, 30_000);
