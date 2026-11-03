import activityHandler from '../api/activity.js';
import { createD1ActivityStore, deleteExpiredActivities } from '../server/d1-activity-store.js';
import { validWorkerSecret } from '../server/leader-auth.js';

const PATH = '/api/activity';
const METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const MAX_BODY = 32768;

function allowedOrigin(origin, env) {
  if (!origin) return false;
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return allowed.some((value) => {
    try {
      const parsed = new URL(value);
      // HTTP is only for an explicitly configured local development origin.
      const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
      return (parsed.protocol === 'https:' || local) && parsed.origin === value && value === origin;
    } catch { return false; }
  });
}
function corsHeaders(origin) {
  const headers = new Headers({ 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', METHODS);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Max-Age', '3600');
  }
  return headers;
}
function error(status, code, origin = '') {
  const headers = corsHeaders(origin); headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ error: code }), { status, headers });
}
async function readBoundedBody(request) {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}
function verificationUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/leader-verify') return null;
    return url.href;
  } catch { return null; }
}
async function verifyCurrentLeader(request, env) {
  const target = verificationUrl(env.LEADER_VERIFY_URL);
  const secret = env.LEADER_SESSION_SECRET;
  if (!target || !validWorkerSecret(secret)) return 'leader_not_configured';
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization) || authorization.length > 520) return 'unauthorized';
  try {
    // The target is a fixed Production domain, never a request parameter or an
    // old deployment URL. TLS and manual redirects keep both credentials there;
    // only a direct 200 response can authorize the mutation.
    const response = await fetch(target, {
      method: 'POST', headers: { Authorization: authorization, 'X-HM20C-Worker-Key': secret, Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) return 'unauthorized';
    if (response.status === 403) return 'leader_not_configured';
    if (response.status !== 200) return 'storage_unavailable';
    const body = await response.json();
    return body?.ok === true ? null : 'storage_unavailable';
  } catch { return 'storage_unavailable'; }
}

async function fetchActivity(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return error(404, 'not_found');
  const requestedOrigin = request.headers.get('Origin') || '';
  if (requestedOrigin && !allowedOrigin(requestedOrigin, env)) return error(403, 'origin_not_allowed');
  const origin = requestedOrigin || '';
  if (request.method === 'OPTIONS') {
    if (!origin) return error(403, 'origin_not_allowed');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return error(405, 'method', origin);
  if (!env.ACTIVITY_DB) return error(503, 'storage_not_configured', origin);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return error(400, 'invalid_body', origin);

  let body;
  if (request.method !== 'GET') {
    if (!String(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return error(415, 'content_type', origin);
    let bytes;
    try { bytes = await readBoundedBody(request); body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return error(400, 'invalid_body', origin); }
    // The Worker never stores the human password. Every leader mutation must
    // be checked against the current Vercel Production password, even when an
    // old deployment could still issue sessions with an obsolete password.
    const failure = await verifyCurrentLeader(request, env);
    if (failure) return error(failure === 'unauthorized' ? 401 : 503, failure, origin);
  }

  const req = { method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body };
  const headers = corsHeaders(origin);
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers.set(name, String(value)); },
    end(value) { this.body = value; },
  };
  try {
    await activityHandler(req, res, {
      store: createD1ActivityStore(env.ACTIVITY_DB),
      trustedServerMutation: request.method !== 'GET',
    });
    return new Response(res.body || '', { status: res.statusCode, headers });
  } catch {
    return error(503, 'storage_unavailable', origin);
  }
}

export default {
  fetch(request, env) { return fetchActivity(request, env); },
  scheduled(_event, env, ctx) {
    if (!env.ACTIVITY_DB) return;
    ctx.waitUntil((async () => {
      for (let i = 0; i < 5; i += 1) {
        if (await deleteExpiredActivities(env.ACTIVITY_DB) < 200) break;
      }
    })());
  },
};
