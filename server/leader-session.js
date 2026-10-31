import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_SECONDS = 8 * 60 * 60;
// When a database is configured, derive the HMAC key from its high-entropy
// server-only REST token plus the password. A leaked signed session must not
// become an offline oracle for guessing a human-chosen leader password.
export function leaderSigningSecret(password, env = process.env) {
  const direct = !!(env.UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_REST_TOKEN);
  const backing = env.LEADER_SESSION_SECRET || (direct ? env.UPSTASH_REDIS_REST_TOKEN : env.KV_REST_API_TOKEN);
  if (!backing) return password;
  return createHmac('sha256', backing).update('hm20c-signing-key-v1:').update(password).digest('hex');
}
function signature(payload, secret) {
  return createHmac('sha256', secret).update('hm20c-leader-session-v1:').update(payload).digest();
}
export function issueLeaderSession(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + SESSION_SECONDS, nonce: randomBytes(16).toString('base64url') })).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}
export function verifyLeaderSession(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 512) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  try {
    const actual = Buffer.from(parts[1], 'base64url');
    const expected = signature(parts[0], secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const current = Math.floor(now / 1000);
    return Number.isSafeInteger(data.exp) && data.exp > current && data.exp <= current + SESSION_SECONDS
      && typeof data.nonce === 'string' && data.nonce.length >= 20;
  } catch { return false; }
}
