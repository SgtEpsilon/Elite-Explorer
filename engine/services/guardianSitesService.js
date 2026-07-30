/**
 * engine/services/guardianSitesService.js
 *
 * Caches Guardian site + POI data (fetched from Canonn — see canonnClient.js)
 * into our own schema (see docs/guardian-sites-schema.md), keyed by
 * (systemAddress, bodyId, siteType) so a revisit is a cache read, not a
 * re-fetch. Owns its own tables (created lazily, IF NOT EXISTS) rather than
 * editing engine/db/database.js's init() block, so this feature can be
 * dropped in without touching existing schema code.
 *
 * This file is an original design — see docs/guardian-sites-schema.md for
 * why the shape looks the way it does, and canonnClient.js for the caveat
 * about Canonn's exact field names still needing live verification before
 * mapCanonnResponseToSite() below is filled in for real.
 */

const db = require('../db/database');
const canonnClient = require('./canonnClient');
const siteTypes = require('../../data/guardianSiteTypes.json');

let _schemaReady = false;

function ensureSchema() {
  if (_schemaReady) return;
  db.run(`
    CREATE TABLE IF NOT EXISTS guardian_sites (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      system_address  TEXT NOT NULL,
      body_id         INTEGER,
      body_name       TEXT,
      site_type       TEXT NOT NULL,
      variant         TEXT,
      origin_lat      REAL,
      origin_lon      REAL,
      scale_width_m   REAL,
      scale_height_m  REAL,
      source          TEXT,
      canonn_site_id  TEXT,
      fetched_at      TEXT,
      schema_version  INTEGER,
      UNIQUE(system_address, body_id, site_type)
    );
    CREATE TABLE IF NOT EXISTS guardian_site_pois (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id         INTEGER NOT NULL,
      poi_key         TEXT,
      poi_type        TEXT NOT NULL,
      bearing_deg     REAL,
      distance_m      REAL,
      label           TEXT,
      notes           TEXT,
      FOREIGN KEY(site_id) REFERENCES guardian_sites(id)
    );
  `);
  _schemaReady = true;
}

/** Look up our siteType/variant/label for a stripped $Ancient_* prefix. */
function classifyAncientPrefix(strippedName) {
  // Longest match first so "Ancient_Tiny" beats the bare "Ancient" fallback.
  const sorted = [...siteTypes.prefixes].sort((a, b) => b.match.length - a.match.length);
  for (const entry of sorted) {
    if (strippedName === entry.match || strippedName.startsWith(entry.match + '_')) {
      return { siteType: entry.siteType, label: entry.label };
    }
  }
  return null;
}

/**
 * Parses an ApproachSettlement `Name` field, e.g. "$Ancient_Tiny_001:#index=1;"
 * Returns { siteType, variant, label } or null if it's not a Guardian site
 * (ApproachSettlement fires for plenty of non-Guardian settlements too).
 */
function parseApproachSettlementName(name) {
  if (!name || !name.startsWith('$Ancient')) return null;
  const stripped = name.replace(/^\$/, '').replace(/:#index=\d+;$/, '');
  const numMatch = stripped.match(/_(\d{3})$/);
  const prefix = numMatch ? stripped.slice(0, -(numMatch[0].length)) : stripped;
  const classified = classifyAncientPrefix(prefix);
  if (!classified) return null;
  return {
    siteType: classified.siteType,
    variant: numMatch ? `${prefix.split('_').pop().toLowerCase()}-${numMatch[1]}` : null,
    label: classified.label,
  };
}

function getCachedSite(systemAddress, bodyId, siteType) {
  ensureSchema();
  const row = db.get(
    `SELECT * FROM guardian_sites WHERE system_address = ? AND body_id = ? AND site_type = ?`,
    [String(systemAddress), bodyId, siteType]
  );
  if (!row) return null;
  const pois = db.all(`SELECT * FROM guardian_site_pois WHERE site_id = ?`, [row.id]);
  return rowsToSiteRecord(row, pois);
}

function rowsToSiteRecord(row, poiRows) {
  return {
    systemAddress: row.system_address,
    bodyId: row.body_id,
    bodyName: row.body_name,
    siteType: row.site_type,
    variant: row.variant,
    origin: { latitude: row.origin_lat, longitude: row.origin_lon },
    scale: { widthM: row.scale_width_m, heightM: row.scale_height_m },
    pois: poiRows.map(p => ({
      id: p.poi_key,
      type: p.poi_type,
      bearingDeg: p.bearing_deg,
      distanceM: p.distance_m,
      label: p.label,
      notes: p.notes,
    })),
    obeliskGroups: [], // populated once obelisk-group mapping is confirmed against real Canonn data
    source: row.source,
    canonnSiteId: row.canonn_site_id,
    fetchedAt: row.fetched_at,
    schemaVersion: row.schema_version,
  };
}

/**
 * PLACEHOLDER — intentionally not implemented yet.
 *
 * Once canonnClient.probeSystem() has been run against a real Guardian
 * system and we've confirmed the actual field names Canonn returns, this
 * function maps that raw shape into our schema (docs/guardian-sites-schema.md)
 * and calls saveSite() below. Left unimplemented rather than guessing so we
 * don't cache wrong data under our own schema version.
 */
function mapCanonnResponseToSite(/* raw, systemAddress, bodyId, siteType, variant */) {
  throw new Error('mapCanonnResponseToSite: pending live Canonn response shape — see canonnClient.js header');
}

function saveSite(site) {
  ensureSchema();
  db.run(
    `INSERT OR REPLACE INTO guardian_sites
      (system_address, body_id, body_name, site_type, variant, origin_lat, origin_lon,
       scale_width_m, scale_height_m, source, canonn_site_id, fetched_at, schema_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      String(site.systemAddress), site.bodyId, site.bodyName, site.siteType, site.variant,
      site.origin?.latitude ?? null, site.origin?.longitude ?? null,
      site.scale?.widthM ?? null, site.scale?.heightM ?? null,
      site.source, site.canonnSiteId, site.fetchedAt, site.schemaVersion ?? 1,
    ]
  );
  const row = db.get(
    `SELECT id FROM guardian_sites WHERE system_address = ? AND body_id = ? AND site_type = ?`,
    [String(site.systemAddress), site.bodyId, site.siteType]
  );
  if (row && Array.isArray(site.pois)) {
    db.run(`DELETE FROM guardian_site_pois WHERE site_id = ?`, [row.id]);
    for (const poi of site.pois) {
      db.run(
        `INSERT INTO guardian_site_pois (site_id, poi_key, poi_type, bearing_deg, distance_m, label, notes)
         VALUES (?,?,?,?,?,?,?)`,
        [row.id, poi.id, poi.type, poi.bearingDeg, poi.distanceM, poi.label ?? null, poi.notes ?? null]
      );
    }
  }
}

/**
 * Main entry point (Phase 2 will call this from the journal handler):
 * returns a cached site if we have one, otherwise fetches from Canonn,
 * maps it, caches it, and returns it. Returns null if Canonn has nothing
 * for this site (shows the "no data yet" placeholder in the UI).
 */
async function getOrFetchSite({ systemAddress, bodyId, siteType, systemName }) {
  const cached = getCachedSite(systemAddress, bodyId, siteType);
  if (cached) return cached;

  const result = await canonnClient.fetchGuardianSitesForSystem(systemName);
  if (!result) return null;

  // See mapCanonnResponseToSite() above — deliberately not wired up until
  // we've confirmed the real response shape together.
  return null;
}

module.exports = {
  ensureSchema,
  parseApproachSettlementName,
  getCachedSite,
  saveSite,
  getOrFetchSite,
};
