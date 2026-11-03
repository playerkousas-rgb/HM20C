import activityHandler from '../api/activity.js';
import { createD1ActivityStore, deleteExpiredActivities } from '../server/d1-activity-store.js';

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
  // Both servers use the same independent, high-entropy signing secret. Never
  // fall back to a guessable password on the publicly accessible Worker.
  if (request.method !== 'GET' && (typeof env.LEADER_PASSWORD !== 'string' || !env.LEADER_PASSWORD
      || typeof env.LEADER_SESSION_SECRET !== 'string' || env.LEADER_SESSION_SECRET.length < 32)) {
    return error(503, 'leader_not_configured', origin);
  }
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return error(400, 'invalid_body', origin);
  const req = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    async *[Symbol.asyncIterator]() {
      if (!request.body) return;
      const reader = request.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          yield part.value;
        }
      } finally { reader.releaseLock(); }
    },
  };
  const headers = corsHeaders(origin);
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers.set(name, String(value)); },
    end(value) { this.body = value; },
  };
  try {
    await activityHandler(req, res, {
      store: createD1ActivityStore(env.ACTIVITY_DB),
      password: typeof env.LEADER_PASSWORD === 'string' ? env.LEADER_PASSWORD : '',
      env: { LEADER_SESSION_SECRET: env.LEADER_SESSION_SECRET },
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
