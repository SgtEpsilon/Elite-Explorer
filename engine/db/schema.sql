CREATE TABLE IF NOT EXISTS personal_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_name TEXT,
  body_name TEXT,
  body_type TEXT,
  estimated_value INTEGER,
  timestamp TEXT
);

CREATE TABLE IF NOT EXISTS commander_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_system TEXT,
  updated_at TEXT
);

-- Persistent local cache of EDSM's star class + body count per system, so
-- the History page's enrichment never has to re-hit EDSM for a system it's
-- already resolved on a previous launch. Keyed lowercase since EDSM system
-- names are case-insensitive. See engine/services/edsmSystemCache.js.
CREATE TABLE IF NOT EXISTS edsm_system_cache (
  system_name_lower TEXT PRIMARY KEY,
  system_name TEXT,
  star_class TEXT,
  body_count INTEGER,
  fetched_at TEXT
);
