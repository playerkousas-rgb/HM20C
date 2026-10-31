// @vitest-environment node
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import leaderHandler from '../api/leader.js';

async function request({ method = 'POST', body = '{"password":"correct secret"}', secret = 'correct secret', ip = Math.random().toString(), type = 'application/json' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method; req.headers = { 'content-type': type }; req.socket = { remoteAddress: ip };
  const headers = {}; const res = { setHeader(key, value) { headers[key] = value; }, end(data) { this.data = data; } };
  await leaderHandler(req, res, { password: secret });
  return { status: res.statusCode, headers, body: JSON.parse(res.data) };
}

describe('server-side leader password', () => {
  it('fails closed without a configured secret and never echoes it', async () => {
    expect(await request({ secret: '' })).toMatchObject({ status: 503, body: { error: 'not_configured' } });
    const wrong = await request({ body: '{"password":"wrong"}' });
    expect(wrong.status).toBe(401);
    const correct = await request();
    expect(correct.status).toBe(200);
    expect(correct.body).toEqual({ ok: true, durationSeconds: 28800 });
    expect(JSON.stringify(correct)).not.toContain('correct secret');
    expect(correct.headers['Cache-Control']).toContain('no-store');
  });
  it('handles unicode, limits body size and only accepts JSON POST', async () => {
    expect((await request({ secret: '密碼 🏕️', body: JSON.stringify({ password: '密碼 🏕️' }) })).status).toBe(200);
    expect((await request({ body: JSON.stringify({ password: 'x'.repeat(5000) }) })).status).toBe(400);
    expect((await request({ method: 'GET' })).status).toBe(405);
    expect((await request({ type: 'text/plain' })).status).toBe(415);
  });
  it('applies best-effort per-instance throttling', async () => {
    for (let i = 0; i < 8; i += 1) expect((await request({ ip: 'throttle-test', body: '{"password":"wrong"}' })).status).toBe(401);
    expect((await request({ ip: 'throttle-test' })).status).toBe(429);
  });
});
