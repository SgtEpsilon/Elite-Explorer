/**
 * engine/services/edsmSystemCache.js
 *
 * Thin wrapper around the edsm_system_cache table (engine/db/database.js).
 * Lets historyProvider.js check "have we already resolved this system's
 * star class / body count from EDSM before" without hitting the network —
 * and remember the answer across app restarts, not just for the lifetime
 * of a single History-page session.
 *
 * Systems don't change star class, and body count is stable enough for
 * this purpose (new bodies are occasionally added to EDSM's catalogue as
 * more commanders visit, but that's rare enough not to justify re-fetching
 * on every launch) — so entries are treated as durable, no TTL/expiry.
 */

const db = require('../db/database');

function getCached(systemName) {
  if (!systemName) return null;
  const row = db.get(
    'SELECT system_name, star_class, body_count, fetched_at FROM edsm_system_cache WHERE system_name_lower = ?',
    [systemName.toLowerCase()]
  );
  if (!row) return null;
  return {
    systemName: row.system_name,
    starClass:  row.star_class || null,
    bodyCount:  row.body_count != null ? row.body_count : null,
    fetchedAt:  row.fetched_at || null,
  };
}

function setCached(systemName, starClass, bodyCount) {
  if (!systemName) return;
  db.run(
    `INSERT INTO edsm_system_cache (system_name_lower, system_name, star_class, body_count, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(system_name_lower) DO UPDATE SET
       system_name = excluded.system_name,
       star_class  = COALESCE(excluded.star_class, edsm_system_cache.star_class),
       body_count  = COALESCE(excluded.body_count, edsm_system_cache.body_count),
       fetched_at  = excluded.fetched_at`,
    [systemName.toLowerCase(), systemName, starClass || null, bodyCount != null ? bodyCount : null, new Date().toISOString()]
  );
}

module.exports = { getCached, setCached };
