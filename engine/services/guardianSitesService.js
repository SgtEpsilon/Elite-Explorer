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
const { bearingDistance } = require('../core/geo');
const guardianLiveState = require('./guardianLiveState');
const guardianTemplateService = require('./guardianTemplateService');

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
  // Added after the initial CREATE TABLE above shipped, so a DB created by
  // an earlier build won't have this column yet — guarded ALTER rather than
  // baking it into the CREATE TABLE, which only runs once per fresh DB.
  try { db.run(`ALTER TABLE guardian_sites ADD COLUMN obelisk_groups_json TEXT`); } catch { /* already exists */ }
  try { db.run(`ALTER TABLE guardian_sites ADD COLUMN planet_radius_m REAL`); } catch { /* already exists */ }
  // Real-world rotation of this site instance vs. our template's local
  // frame — see guardianTemplateService.js's local->world convention.
  // Null until known (bootstrap dataset match, or future in-app calibration).
  try { db.run(`ALTER TABLE guardian_sites ADD COLUMN site_heading_deg REAL`); } catch { /* already exists */ }
  // Human-readable system name, for the site picker — the table was
  // originally keyed by system_address alone (fine for lookups, useless
  // for a 700+ entry dropdown label), so this is filled in lazily by
  // healGeometry() for any pre-existing row that predates this column.
  try { db.run(`ALTER TABLE guardian_sites ADD COLUMN system_name TEXT`); } catch { /* already exists */ }
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

/**
 * Looks up a cached site row by (systemAddress, bodyId) only — ignoring
 * siteType — for the CodexEntry fallback path below, which can confirm/fill
 * an origin fix but has no way to independently classify siteType itself.
 * Returns the raw row (not the reshaped record getCachedSite() returns).
 */
function getSiteRowByLocation(systemAddress, bodyId) {
  ensureSchema();
  return db.get(
    `SELECT * FROM guardian_sites WHERE system_address = ? AND body_id = ? LIMIT 1`,
    [String(systemAddress), bodyId]
  );
}

/**
 * Upserts a site record from a live journal sighting (ApproachSettlement),
 * independent of whether Canonn POI data has been fetched yet — this is what
 * lets a site "exist" in our cache (with at least an origin fix) the moment
 * it's approached, rather than only once mapCanonnResponseToSite() is wired
 * up. Deliberately NOT an INSERT OR REPLACE: that would drop any POIs already
 * cached against this site's id (saveSite()'s INSERT OR REPLACE reassigns the
 * AUTOINCREMENT id on conflict, orphaning guardian_site_pois rows that still
 * point at the old id). This does a targeted UPDATE instead, and never
 * downgrades a field that's already populated.
 */
function recordSighting({ systemAddress, systemName, bodyId, bodyName, siteType, variant, origin, source, timestamp }) {
  ensureSchema();
  const existing = db.get(
    `SELECT * FROM guardian_sites WHERE system_address = ? AND body_id = ? AND site_type = ?`,
    [String(systemAddress), bodyId, siteType]
  );

  if (existing) {
    const nextBodyName   = existing.body_name   || bodyName   || null;
    const nextVariant    = existing.variant     || variant    || null;
    const nextSystemName = existing.system_name || systemName || null;
    const nextLat      = existing.origin_lat != null ? existing.origin_lat : (origin ? origin.latitude  : null);
    const nextLon      = existing.origin_lon != null ? existing.origin_lon : (origin ? origin.longitude : null);
    db.run(
      `UPDATE guardian_sites SET body_name = ?, variant = ?, origin_lat = ?, origin_lon = ?, system_name = ? WHERE id = ?`,
      [nextBodyName, nextVariant, nextLat, nextLon, nextSystemName, existing.id]
    );
  } else {
    db.run(
      `INSERT INTO guardian_sites
        (system_address, system_name, body_id, body_name, site_type, variant, origin_lat, origin_lon,
         scale_width_m, scale_height_m, source, canonn_site_id, fetched_at, schema_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(systemAddress), systemName || null, bodyId, bodyName || null, siteType, variant || null,
        origin ? origin.latitude : null, origin ? origin.longitude : null,
        null, null, source || 'journal', null, timestamp || null, 1,
      ]
    );
  }

  // Try filling real geometry straight from our own template dataset —
  // no network round-trip needed, so a brand-new sighting can render a
  // full site plot immediately instead of showing "no data yet" until
  // Canonn enrichment (getOrFetchSite) resolves later.
  const site = getCachedSite(systemAddress, bodyId, siteType);
  if (site && !(site.pois && site.pois.length)) {
    applyTemplate(site); // resolves variant itself for ruins (see applyTemplate)
    if (site.pois && site.pois.length) {
      saveSite(site);
      return getCachedSite(systemAddress, bodyId, siteType);
    }
  }
  return site;
}

/**
 * Main-thread handler for the worker's 'journal.approachSettlement' event.
 * Classifies the Name via parseApproachSettlementName() (the one place that
 * decision is made), records/updates the sighting, and — fire-and-forget —
 * kicks off Canonn enrichment for it. Returns null (not a Guardian site, or
 * missing the systemAddress we key on) without touching the cache.
 */
function handleApproachSettlementEvent({ name, systemName, systemAddress, bodyId, bodyName, latitude, longitude, timestamp } = {}) {
  if (!systemAddress) return null;
  const classified = parseApproachSettlementName(name);
  if (!classified) return null;

  const origin = (latitude != null && longitude != null) ? { latitude, longitude } : null;
  const site = recordSighting({
    systemAddress, systemName, bodyId, bodyName,
    siteType: classified.siteType,
    variant:  classified.variant,
    origin,
    source: 'journal',
    timestamp,
  });

  // Mark this as the commander's current site immediately (even before any
  // Canonn POI data has loaded) so the live map has something to draw —
  // the origin/heading marker doesn't need POI data to be useful.
  guardianLiveState.setActive(site);

  if (systemName) {
    // Errors here (network down, Canonn unreachable, or a bad response
    // shape from mapCanonnResponseToSite) must never break journal
    // processing — this is a background enrichment, not the source of
    // truth. getOrFetchSite() re-pushes guardianLiveState itself once (if)
    // it resolves with real POI data.
    getOrFetchSite({
      systemAddress, bodyId, siteType: classified.siteType, systemName,
      bodyName, variant: classified.variant,
    }).catch(() => {});
  }

  return site;
}

/**
 * Main-thread handler for the worker's 'journal.codexGuardian' event — only
 * ever fills/confirms an origin fix on a site record that already exists
 * (created via handleApproachSettlementEvent above). Never creates a new
 * record and never guesses siteType, since a Codex entry's Name doesn't
 * carry the $Ancient_* size/layout info ApproachSettlement does.
 */
function handleCodexEntryEvent({ subCategory, systemAddress, bodyId, latitude, longitude } = {}) {
  if (subCategory !== '$Codex_SubCategory_Guardian;') return null;
  if (!systemAddress || latitude == null || longitude == null) return null;

  const row = getSiteRowByLocation(systemAddress, bodyId);
  if (!row) return null; // nothing to confirm yet — wait for ApproachSettlement

  if (row.origin_lat == null || row.origin_lon == null) {
    db.run(`UPDATE guardian_sites SET origin_lat = ?, origin_lon = ? WHERE id = ?`, [latitude, longitude, row.id]);
  }
  return getCachedSite(systemAddress, bodyId, row.site_type);
}

function getCachedSite(systemAddress, bodyId, siteType) {
  ensureSchema();
  const row = db.get(
    `SELECT * FROM guardian_sites WHERE system_address = ? AND body_id = ? AND site_type = ?`,
    [String(systemAddress), bodyId, siteType]
  );
  if (!row) return null;
  const pois = db.all(`SELECT * FROM guardian_site_pois WHERE site_id = ?`, [row.id]);
  return healGeometry(rowsToSiteRecord(row, pois));
}

/**
 * Self-heals a site record read from the DB that predates (or otherwise
 * missed) template-filling — e.g. a row created by an old build, or by
 * recordSighting() before the known-sites bootstrap existed. Any read path
 * (getCachedSite, getAllSites) runs records through this rather than only
 * relying on write-time paths (recordSighting/getOrFetchSite) to have
 * applied the template, so a stale empty-POI row fixes itself the next
 * time it's looked at instead of staying stuck showing "no POI data yet".
 * Persists the fix via saveSite() so future reads don't redo the work.
 */
function healGeometry(site) {
  if (!site) return site;
  try {
    let dirty = false;

    // Lazily fill systemName for rows written before that column existed —
    // check the known-sites dataset by systemAddress rather than leaving it
    // blank forever.
    if (!site.systemName) {
      const known = guardianTemplateService.findKnownSite({ systemAddress: site.systemAddress });
      if (known && known.systemName) { site.systemName = known.systemName; dirty = true; }
    }

    if (!(site.pois && site.pois.length)) {
      const before = site.pois ? site.pois.length : 0;
      applyTemplate(site);
      if (site.pois && site.pois.length && site.pois.length !== before) dirty = true;
    }

    if (dirty) saveSite(site);
  } catch (err) {
    // A single malformed/unhealable row must never take down the entire
    // list it's part of — getAllSites()/getSitesForSystem() map every row
    // through this function, and an uncaught throw here used to propagate
    // all the way up through the IPC handler's catch-all, silently
    // emptying the whole site picker instead of just this one row.
    console.error('[guardianSitesService] healGeometry failed for site', site && site.systemAddress, site && site.bodyId, ':', err.message);
  }
  return site;
}

function rowsToSiteRecord(row, poiRows) {
  let obeliskGroups = [];
  if (row.obelisk_groups_json) {
    try { obeliskGroups = JSON.parse(row.obelisk_groups_json); } catch { obeliskGroups = []; }
  }
  return {
    systemAddress: row.system_address,
    systemName: row.system_name || null,
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
    obeliskGroups,
    source: row.source,
    canonnSiteId: row.canonn_site_id,
    fetchedAt: row.fetched_at,
    schemaVersion: row.schema_version,
    planetRadiusM: row.planet_radius_m ?? null,
    siteHeadingDeg: row.site_heading_deg ?? null,
  };
}

/**
 * Fills pois/obeliskGroups/scale (and siteHeadingDeg, if we can find one)
 * from our own template dataset — see guardianTemplateService.js. This is
 * now the PRIMARY way a site gets real geometry: deterministic, offline,
 * and not dependent on Canonn's unconfirmed activeObelisks/activeGroups
 * shape. Mutates and returns `site`; leaves it untouched if we have no
 * template for its (siteType, variant), or it already has POIs.
 */
function applyTemplate(site) {
  if (!site || (site.pois && site.pois.length)) return site;

  // Ruins carry no size/layout suffix in the journal (see
  // docs/guardian-sites-schema.md) — `variant` (alpha/beta/gamma) is
  // genuinely unknown until matched against a known-site record by
  // location. Structures already know their variant from the journal Name.
  let variant = site.variant;
  let siteHeadingDeg = site.siteHeadingDeg;
  if (variant == null || siteHeadingDeg == null) {
    const known = guardianTemplateService.findKnownSite({
      systemAddress: site.systemAddress,
      bodyName: site.bodyName,
    });
    if (known) {
      if (variant == null && known.variant) variant = known.variant;
      if (siteHeadingDeg == null && known.siteHeadingDeg != null) siteHeadingDeg = known.siteHeadingDeg;
    }
  }
  if (!variant) return site;

  const built = guardianTemplateService.buildSitePois({
    siteType: site.siteType,
    variant,
    siteHeadingDeg,
  });
  if (!built) return site;

  site.pois = built.pois;
  site.obeliskGroups = built.obeliskGroups;
  if (!site.scale || site.scale.widthM == null) site.scale = built.scale;
  if (siteHeadingDeg != null) site.siteHeadingDeg = siteHeadingDeg;
  if (!site.variant) site.variant = variant;
  site.source = site.source === 'journal' ? 'template' : site.source;
  return site;
}

/**
 * Returns every cached site (across all systems), most-recently-fetched
 * first, for the site picker's "previously discovered sites" list. Each
 * entry is the same shape getCachedSite() returns.
 */
function getAllSites() {
  ensureSchema();
  const rows = db.all(`SELECT * FROM guardian_sites ORDER BY fetched_at DESC, id DESC`);
  return rows.map((row) => safeSiteRecord(row)).filter(Boolean);
}

/**
 * Every known Guardian site in a given system (by systemAddress), for
 * auto-loading a browsable view the moment the commander jumps in — before
 * they've physically approached anything. Sorted by bodyName so a system
 * with multiple sites shows them in a stable, sensible order.
 */
function getSitesForSystem(systemAddress) {
  if (!systemAddress) return [];
  ensureSchema();
  const rows = db.all(
    `SELECT * FROM guardian_sites WHERE system_address = ? ORDER BY body_name ASC`,
    [String(systemAddress)]
  );
  return rows.map((row) => safeSiteRecord(row)).filter(Boolean);
}

/**
 * Builds one site record from a DB row, isolated so a single bad row
 * (corrupt JSON column, unexpected data, etc.) can only drop that one
 * entry instead of throwing and wiping out the whole list it's part of —
 * see healGeometry()'s own try/catch for why that guarantee matters here.
 */
function safeSiteRecord(row) {
  try {
    const pois = db.all(`SELECT * FROM guardian_site_pois WHERE site_id = ?`, [row.id]);
    return healGeometry(rowsToSiteRecord(row, pois));
  } catch (err) {
    console.error('[guardianSitesService] Skipping unreadable guardian_sites row', row && row.id, ':', err.message);
    return null;
  }
}

/**
 * Picks the single best-matching Canonn record out of the array returned
 * for a system (a system can have several sites of the same siteType —
 * e.g. multiple ruins). Preference order:
 *   1. nearest to an origin we already have (from our own journal sighting)
 *   2. exact body-name match
 *   3. first record, as a last resort
 */
function pickBestMatch(records, { existingOrigin, bodyName }) {
  if (!records.length) return null;
  if (existingOrigin && existingOrigin.latitude != null && existingOrigin.longitude != null) {
    let best = null, bestDist = Infinity;
    for (const rec of records) {
      if (rec.latitude == null || rec.longitude == null) continue;
      const dLat = rec.latitude - existingOrigin.latitude;
      const dLon = rec.longitude - existingOrigin.longitude;
      const d = dLat * dLat + dLon * dLon; // squared, comparison only — no need to unscale
      if (d < bestDist) { bestDist = d; best = rec; }
    }
    if (best) return best;
  }
  if (bodyName) {
    const norm = (s) => (s || '').trim().toUpperCase();
    const exact = records.find((rec) => norm(rec.body && rec.body.bodyName) === norm(bodyName));
    if (exact) return exact;
  }
  return records[0];
}

/**
 * Best-effort extraction of per-POI data from a GS record's activeObelisks/
 * activeGroups relations. Their exact internal shape is unconfirmed (see
 * canonnClient.js header) — this tries a few plausible field names for
 * each item and silently skips anything it can't place, rather than
 * throwing. Never blocks the site-level record (origin/type/etc.) from
 * being cached even if this comes back empty.
 */
function extractPois(rec, origin, planetRadiusM) {
  const pois = [];
  const items = Array.isArray(rec.activeObelisks) ? rec.activeObelisks : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    let bearingDeg = item.bearingDeg ?? item.bearing ?? null;
    let distanceM  = item.distanceM  ?? item.distance ?? null;
    if ((bearingDeg == null || distanceM == null) && item.latitude != null && item.longitude != null
        && origin && origin.latitude != null && planetRadiusM) {
      const bd = bearingDistance(origin.latitude, origin.longitude, item.latitude, item.longitude, planetRadiusM);
      if (bd) { bearingDeg = bd.bearingDeg; distanceM = bd.distanceM; }
    }
    if (bearingDeg == null || distanceM == null) continue; // can't place it — skip rather than guess
    pois.push({
      id: item.id != null ? `poi-${item.id}` : `poi-${pois.length + 1}`,
      type: 'obelisk',
      bearingDeg, distanceM,
      label: item.label || item.name || null,
      notes: null,
    });
  }
  return pois;
}

/**
 * Best-effort extraction of obeliskGroups from a GS record's activeGroups
 * relation. Same caveats as extractPois() above.
 */
function extractObeliskGroups(rec, origin, planetRadiusM) {
  const groups = [];
  const items = Array.isArray(rec.activeGroups) ? rec.activeGroups : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    let bearingDeg = item.bearingDeg ?? item.bearing ?? null;
    let distanceM  = item.distanceM  ?? item.distance ?? null;
    if ((bearingDeg == null || distanceM == null) && item.latitude != null && item.longitude != null
        && origin && origin.latitude != null && planetRadiusM) {
      const bd = bearingDistance(origin.latitude, origin.longitude, item.latitude, item.longitude, planetRadiusM);
      if (bd) { bearingDeg = bd.bearingDeg; distanceM = bd.distanceM; }
    }
    if (bearingDeg == null || distanceM == null) continue;
    groups.push({
      id: item.id != null ? `group-${item.id}` : `group-${groups.length + 1}`,
      label: item.label || item.name || `Group ${groups.length + 1}`,
      bearingDeg, distanceM,
      obeliskCount: Array.isArray(item.obelisks) ? item.obelisks.length : (item.obeliskCount ?? null),
    });
  }
  return groups;
}

/**
 * Maps a raw Canonn API response (see canonnClient.js header for the
 * confirmed shape) into our own schema (docs/guardian-sites-schema.md) and
 * returns a record ready for saveSite(). Never throws on unexpected/missing
 * nested fields — a site with just an origin + type is still useful; a
 * site with zero matching records returns null.
 */
function mapCanonnResponseToSite(canonnResult, { systemAddress, bodyId, bodyName, siteType, variant, existingOrigin }) {
  if (!canonnResult || !Array.isArray(canonnResult.raw) || !canonnResult.raw.length) return null;

  const rec = pickBestMatch(canonnResult.raw, { existingOrigin, bodyName });
  if (!rec) return null;

  // Prefer our own journal-observed origin (we were physically there) over
  // Canonn's site-center coordinate — but fall back to Canonn's if we
  // don't have one yet (e.g. Codex-only sighting with no lat/long).
  const origin = (existingOrigin && existingOrigin.latitude != null)
    ? existingOrigin
    : (rec.latitude != null ? { latitude: rec.latitude, longitude: rec.longitude } : null);

  const planetRadiusM = guardianLiveState.getPlanetRadius();

  return {
    systemAddress, bodyId, bodyName,
    siteType,
    variant: variant || null,
    origin: origin || { latitude: null, longitude: null },
    scale: { widthM: null, heightM: null }, // unknown until we have real POI spread to derive it from
    pois: extractPois(rec, origin, planetRadiusM),
    obeliskGroups: extractObeliskGroups(rec, origin, planetRadiusM),
    source: 'canonn',
    canonnSiteId: rec.siteID != null ? String(rec.siteID) : (rec.id != null ? String(rec.id) : null),
    fetchedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

function saveSite(site) {
  ensureSchema();
  db.run(
    `INSERT OR REPLACE INTO guardian_sites
      (system_address, system_name, body_id, body_name, site_type, variant, origin_lat, origin_lon,
       scale_width_m, scale_height_m, source, canonn_site_id, fetched_at, schema_version,
       obelisk_groups_json, planet_radius_m, site_heading_deg)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      String(site.systemAddress), site.systemName || null, site.bodyId, site.bodyName, site.siteType, site.variant,
      site.origin?.latitude ?? null, site.origin?.longitude ?? null,
      site.scale?.widthM ?? null, site.scale?.heightM ?? null,
      site.source, site.canonnSiteId, site.fetchedAt, site.schemaVersion ?? 1,
      JSON.stringify(site.obeliskGroups || []), site.planetRadiusM ?? null,
      site.siteHeadingDeg ?? null,
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
 * Main entry point, called from handleApproachSettlementEvent below (and
 * safe to call again later to re-sync): returns a cached site if we
 * already have POI data for it, otherwise fetches from Canonn, maps it,
 * caches it, and returns the result. Returns null if Canonn has nothing
 * for this site (the UI shows the "no data yet" placeholder) — the bare
 * journal-sighting record (origin only, no POIs) from recordSighting()
 * still exists in that case and is what getCachedSite() will keep
 * returning until a future fetch succeeds.
 */
async function getOrFetchSite({ systemAddress, bodyId, siteType, systemName, bodyName, variant }) {
  const cached = getCachedSite(systemAddress, bodyId, siteType);
  if (cached && cached.pois.length) return cached; // already have real POI data — don't re-fetch

  // Template dataset is primary and needs no network call — try it before
  // ever bothering Canonn. Canonn (below) only ever runs now as a fallback
  // for site types our template dataset doesn't cover yet.
  if (cached) {
    const withTemplate = applyTemplate({ ...cached, variant: variant || cached.variant });
    if (withTemplate.pois && withTemplate.pois.length) {
      saveSite(withTemplate);
      return getCachedSite(systemAddress, bodyId, siteType);
    }
  }

  const result = await canonnClient.fetchGuardianSitesForSystem(systemName, siteType);
  if (!result) return cached; // Canonn has nothing (yet) — keep whatever journal-only record we have

  const mapped = mapCanonnResponseToSite(result, {
    systemAddress, bodyId, bodyName,
    siteType, variant: variant || (cached && cached.variant),
    existingOrigin: cached ? cached.origin : null,
  });
  if (!mapped) return cached;

  mapped.planetRadiusM = guardianLiveState.getPlanetRadius();
  saveSite(mapped);
  const saved = getCachedSite(systemAddress, bodyId, siteType);
  // If the commander is still at this site, refresh the live-active push
  // with the now-populated POI data (the first push, from
  // handleApproachSettlementEvent, only had the bare origin).
  const active = guardianLiveState.getActive();
  if (active && String(active.systemAddress) === String(systemAddress) && active.bodyId === bodyId && active.siteType === siteType) {
    guardianLiveState.setActive(saved);
  }
  return saved;
}

/**
 * One-time (idempotent) import of data/guardianKnownSites.json into
 * guardian_sites, so the site picker/map has entries for known sites the
 * commander hasn't personally visited yet. Never overwrites a row that
 * already exists (a journal sighting or Canonn fetch always wins over the
 * bootstrap dataset), and always fills in geometry via applyTemplate() so
 * imported sites are immediately fully rendered.
 */
function bootstrapKnownSites() {
  ensureSchema();
  const known = guardianTemplateService.loadKnownSites();
  let inserted = 0;
  for (const k of known) {
    if (!k.systemAddress || !k.variant) continue;
    const existing = db.get(
      `SELECT id FROM guardian_sites WHERE system_address = ? AND body_id = ? AND site_type = ?`,
      [String(k.systemAddress), k.bodyId ?? null, k.siteType]
    );
    if (existing) continue;

    const site = {
      systemAddress: k.systemAddress, systemName: k.systemName || null,
      bodyId: k.bodyId ?? null, bodyName: k.bodyName || null,
      siteType: k.siteType, variant: k.variant,
      origin: k.origin || { latitude: null, longitude: null },
      scale: { widthM: null, heightM: null },
      pois: [], obeliskGroups: [],
      source: 'community-dataset', canonnSiteId: null,
      fetchedAt: new Date().toISOString(), schemaVersion: 1,
      siteHeadingDeg: k.siteHeadingDeg ?? null,
    };
    applyTemplate(site);
    saveSite(site);
    inserted++;
  }
  return inserted;
}

module.exports = {
  ensureSchema,
  parseApproachSettlementName,
  getCachedSite,
  getAllSites,
  getSitesForSystem,
  getSiteRowByLocation,
  recordSighting,
  saveSite,
  applyTemplate,
  getOrFetchSite,
  bootstrapKnownSites,
  handleApproachSettlementEvent,
  handleCodexEntryEvent,
};
