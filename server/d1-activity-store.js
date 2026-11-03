// Cloudflare D1 implementation of the same activity-store interface used by
// the local and Redis adapters. A single conditional statement guards each
// update/delete so different leader devices cannot silently overwrite data.
function changed(result) {
  if (!result?.success || !Number.isSafeInteger(result.meta?.changes)) throw new Error('D1 unavailable');
  return result.meta.changes;
}
function validRecord(value, now = Date.now()) {
  return Number.isSafeInteger(value?.version) && value.version > 0
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now;
}

export function createD1ActivityStore(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('D1 not configured');
  async function current(id, now = Date.now()) {
    return db.prepare('SELECT version, expires_at, data FROM activities WHERE id = ? AND expires_at > ?')
      .bind(id, now).first();
  }
  async function conflictOrMissing(id, now = Date.now()) {
    return await current(id, now) ? -1 : 0;
  }
  return {
    async get(id) {
      const row = await current(id);
      if (!row) return null;
      const value = JSON.parse(row.data);
      if (value.version !== row.version || value.expiresAt !== row.expires_at) throw new Error('invalid D1 record');
      return value;
    },
    async create(id, value) {
      if (!validRecord(value)) return false;
      const result = await db.prepare('INSERT INTO activities (id, version, expires_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .bind(id, value.version, value.expiresAt, JSON.stringify(value)).run();
      return changed(result) === 1;
    },
    async compareSet(id, expected, value) {
      const now = Date.now();
      if (!validRecord(value, now)) return 0;
      const result = await db.prepare('UPDATE activities SET version = ?, expires_at = ?, data = ? WHERE id = ? AND version = ? AND expires_at > ?')
        .bind(value.version, value.expiresAt, JSON.stringify(value), id, expected, now).run();
      return changed(result) === 1 ? 1 : conflictOrMissing(id);
    },
    async compareDelete(id, expected) {
      const result = await db.prepare('DELETE FROM activities WHERE id = ? AND version = ? AND expires_at > ?')
        .bind(id, expected, Date.now()).run();
      return changed(result) === 1 ? 1 : conflictOrMissing(id);
    },
  };
}

// Expiry is enforced at read/write time; cleanup is best-effort and may be
// delayed by quota or outages. Batches cap the work done by a scheduled run.
export async function deleteExpiredActivities(db, now = Date.now(), batchSize = 200) {
  if (!Number.isSafeInteger(now) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) throw new Error('invalid cleanup arguments');
  const result = await db.prepare('DELETE FROM activities WHERE id IN (SELECT id FROM activities WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)')
    .bind(now, batchSize).run();
  return changed(result);
}
