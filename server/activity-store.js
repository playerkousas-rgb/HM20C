const PREFIX = 'hm20c:activity:v1:';
export const ACTIVITY_TTL_SECONDS = 7 * 24 * 60 * 60;
const CAS = `local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local current = cjson.decode(value)
if tonumber(current.version) ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;
const CAS_DELETE = `local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local current = cjson.decode(value)
if tonumber(current.version) ~= tonumber(ARGV[1]) then return -1 end
redis.call('DEL', KEYS[1])
return 1`;

export function redisFromEnv(env = process.env) {
  // A half-configured pair must fail closed rather than combining databases.
  const direct = !!(env.UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_REST_TOKEN);
  const url = direct ? env.UPSTASH_REDIS_REST_URL : env.KV_REST_API_URL;
  const token = direct ? env.UPSTASH_REDIS_REST_TOKEN : env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  let endpoint;
  try {
    endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  } catch { return null; }
  async function command(args) {
    const response = await fetch(endpoint.href, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(6000), cache: 'no-store',
    });
    if (!response.ok) throw new Error('storage unavailable');
    const data = await response.json();
    if (data.error) throw new Error('storage unavailable');
    return data.result;
  }
  return {
    async get(id) { const value = await command(['GET', PREFIX + id]); return value ? JSON.parse(value) : null; },
    async create(id, value) { return (await command(['SET', PREFIX + id, JSON.stringify(value), 'EX', ACTIVITY_TTL_SECONDS, 'NX'])) === 'OK'; },
    async compareSet(id, expected, value) { return Number(await command(['EVAL', CAS, 1, PREFIX + id, expected, JSON.stringify(value), ACTIVITY_TTL_SECONDS])); },
    async compareDelete(id, expected) { return Number(await command(['EVAL', CAS_DELETE, 1, PREFIX + id, expected])); },
  };
}

// Explicitly opt-in test/dev store; never a silent production fallback.
export function createMemoryActivityStore() {
  const records = new Map();
  return {
    async get(id) {
      const entry = records.get(id);
      if (!entry || entry.expires <= Date.now()) { records.delete(id); return null; }
      return structuredClone(entry.value);
    },
    async create(id, value) {
      const previous = records.get(id);
      if (previous && previous.expires > Date.now()) return false;
      records.set(id, { value: structuredClone(value), expires: Date.now() + ACTIVITY_TTL_SECONDS * 1000 }); return true;
    },
    async compareSet(id, expected, value) {
      const previous = records.get(id);
      if (!previous || previous.expires <= Date.now()) { records.delete(id); return 0; }
      if (previous.value.version !== expected) return -1;
      records.set(id, { value: structuredClone(value), expires: Date.now() + ACTIVITY_TTL_SECONDS * 1000 }); return 1;
    },
    async compareDelete(id, expected) {
      const previous = records.get(id);
      if (!previous || previous.expires <= Date.now()) { records.delete(id); return 0; }
      if (previous.value.version !== expected) return -1;
      records.delete(id); return 1;
    },
  };
}
