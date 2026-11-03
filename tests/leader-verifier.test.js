// @vitest-environment node
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import leaderHandler from '../api/leader.js';
import verifyHandler from '../api/leader-verify.js';

const secret = 'unique-random-test-secret-at-least-thirty-two-bytes';
const oldPassword = 'old-leader-password';
const env = { LEADER_PASSWORD: oldPassword, LEADER_SESSION_SECRET: secret, VITE_ACTIVITY_API_URL: 'https://worker.example.test/api/activity' };
function response() {
  const headers = {};
  return { headers, setHeader(name, value) { headers[name] = String(value); }, end(value) { this.body = JSON.parse(value); } };
}
async function login(settings, password) {
  const req = Readable.from([Buffer.from(JSON.stringify({ password }))]);
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' }; req.socket = { remoteAddress: Math.random().toString() };
  const res = response(); await leaderHandler(req, res, { env: settings }); return res;
}
async function verify(settings, token, key = secret, method = 'POST') {
  const req = { method, headers: { 'x-hm20c-worker-key': key, authorization: `Bearer ${token}` } };
  const res = response(); await verifyHandler(req, res, { env: settings }); return res;
}

describe('current Vercel leader-session verification', () => {
  it('changes password only in Vercel and rejects tokens from the former password', async () => {
    const first = await login(env, oldPassword); expect(first.statusCode).toBe(200);
    expect((await verify(env, first.body.token)).body.ok).toBe(true);
    const rotated = { ...env, LEADER_PASSWORD: 'new-leader-password' };
    expect((await login(rotated, oldPassword)).statusCode).toBe(401);
    expect((await verify(rotated, first.body.token)).statusCode).toBe(401);
    const oldDeployment = await login(env, oldPassword); // An accessible old deployment still knows the former environment.
    expect(oldDeployment.statusCode).toBe(200);
    expect((await verify(rotated, oldDeployment.body.token)).statusCode).toBe(401);
    const current = await login(rotated, rotated.LEADER_PASSWORD);
    expect(current.statusCode).toBe(200); expect((await verify(rotated, current.body.token)).statusCode).toBe(200);
    expect(JSON.stringify(current.body)).not.toContain(secret); expect(JSON.stringify(current.body)).not.toContain(rotated.LEADER_PASSWORD);
  });
  it('authenticates Cloudflare, rejects forged sessions, fails closed and never echoes the key', async () => {
    const token = (await login(env, oldPassword)).body.token;
    const forbidden = await verify(env, token, 'wrong-server-key');
    expect(forbidden.statusCode).toBe(403); expect(JSON.stringify(forbidden)).not.toContain(secret);
    expect((await verify(env, `${token}x`)).statusCode).toBe(401);
    expect((await verify(env, token, secret, 'GET')).statusCode).toBe(405);
    for (const bad of ['', 'short', oldPassword]) {
      const broken = { ...env, LEADER_SESSION_SECRET: bad };
      expect((await login(broken, oldPassword)).body.error).toBe('signing_not_configured');
      expect((await verify(broken, token)).statusCode).toBe(503);
    }
    const same = { ...env, LEADER_PASSWORD: secret, LEADER_SESSION_SECRET: secret };
    expect((await login(same, secret)).statusCode).toBe(503);
    expect((await verify(same, token)).statusCode).toBe(503);
  });
});
