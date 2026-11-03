import { createHash, timingSafeEqual } from 'node:crypto';

// This independent server-only key authenticates Cloudflare to Vercel and
// prevents a leaked leader session from being an offline password oracle.
export function validWorkerSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32;
}
export function sameWorkerSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || Buffer.byteLength(a, 'utf8') > 1024) return false;
  const first = createHash('sha256').update(a, 'utf8').digest();
  const second = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(first, second);
}
