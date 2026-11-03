import { sameWorkerSecret, validWorkerSecret } from '../server/leader-auth.js';
import { leaderSigningSecret, verifyLeaderSession } from '../server/leader-session.js';

function reply(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

// Cloudflare calls this *fixed production URL* for each intentional leader
// write. Old Vercel deployments may still know the former password: they do
// not authorize writes because the Worker only calls the current deployment.
export default async function leaderVerifyHandler(req, res, options = {}) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(res, 405, { error: 'method' }); }
  const env = options.env || process.env;
  const password = options.password ?? env.LEADER_PASSWORD;
  const secret = env.LEADER_SESSION_SECRET;
  if (typeof password !== 'string' || !password || !validWorkerSecret(secret) || secret === password) {
    return reply(res, 503, { error: 'not_configured' });
  }
  if (!sameWorkerSecret(req.headers['x-hm20c-worker-key'], secret)) return reply(res, 403, { error: 'forbidden' });
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ') || !verifyLeaderSession(authorization.slice(7), leaderSigningSecret(password, env))) {
    return reply(res, 401, { error: 'unauthorized' });
  }
  return reply(res, 200, { ok: true });
}
