/**
 * engine/services/edsmClient.js
 *
 * Listens on the eventBus for journal.location events (fired on every
 * FSDJump and Location event) and fetches system info + bodies from EDSM,
 * cross-references bodies/stations against Spansh (see spanshClient.js),
 * then pushes the merged results to the renderer via edsm-system and
 * edsm-bodies.
 *
 * Bodies are ALWAYS fetched regardless of edsmEnabled — they populate the
 * System Bodies panel immediately on system entry without waiting for the
 * Discovery Scanner (FSSDiscoveryScan) to fire.
 *
 * System info (security, allegiance, economy, population) only fetches when
 * edsmEnabled is true in config.
 *
 * Deduplication is by system+timestamp key so rapid duplicate events for the
 * same jump are collapsed, but re-entering the same system always re-fetches.
 *
 * ── Cross-referencing stations/bodies against Spansh ──────────────────────
 * EDSM's station list is crowd-submitted and known to go stale — stations
 * that have been removed, renamed, or never existed can linger. Spansh
 * rebuilds its galaxy data from EDDN on a rolling basis and tends to reflect
 * reality faster, so we treat Spansh as the primary source for stations
 * (and use it to backfill/verify bodies) whenever we can resolve the
 * system's id64, and only fall back to EDSM-only data if Spansh is
 * unavailable or doesn't recognise the system yet. Every station/body we
 * send to the renderer carries a `source` field ('spansh' or 'edsm') so any
 * still-EDSM-only entry can be visually flagged as unverified.
 */

const eventBus     = require('../core/eventBus');
const logger       = require('../core/logger');
const spanshClient = require('./spanshClient');
const CONFIG_PATH  = require('path').join(__dirname, '../../config.json');
const fs           = require('fs');

const BASE_URL = 'https://www.edsm.net';

let mainWindow     = null;
let _lastLookupKey = null;   // last system name looked up — prevents re-fetching same system
let _cachedSystem  = null;   // last edsm-system payload
let _cachedBodies  = null;   // last edsm-bodies payload


function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// ── EDSM API helpers ──────────────────────────────────────────────────────────

async function fetchSystemInfo(systemName) {
  const params = new URLSearchParams({
    systemName,
    showInformation: 1,
    showPermit: 1,
    showPrimaryStar: 1,
  });
  const res = await fetch(`${BASE_URL}/api-v1/system?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

async function fetchSystemBodies(systemName) {
  const res = await fetch(
    `${BASE_URL}/api-system-v1/bodies?systemName=${encodeURIComponent(systemName)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

async function fetchSystemStations(systemName) {
  const res = await fetch(
    `${BASE_URL}/api-system-v1/stations?systemName=${encodeURIComponent(systemName)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

// ── Cross-referencing helpers ──────────────────────────────────────────────

function normalizeName(n) { return String(n || '').trim().toLowerCase(); }

// Spansh's dump schema doesn't match EDSM's station shape 1:1 — reshape it
// to the same fields the renderer already reads off EDSM stations
// (type, distanceToArrival, haveMarket/haveShipyard/haveOutfitting,
// otherServices, controllingFaction.name, body.name) so the UI needs no
// changes to consume whichever source a given station came from.
function spanshStationToEdsmShape(s, bodiesById) {
  const services = Array.isArray(s.services) ? s.services : [];
  // Keep the numeric body id alongside the name (not just the name) —
  // Spansh correlates a station to a body by id internally (bodiesById is
  // keyed by that same id), and carrying it through lets the renderer match
  // stations to bodies by id instead of by name string. Name strings can go
  // stale relative to each other (a body or station renamed independently)
  // in a way a stable internal id doesn't.
  const bodyId = (s.body && s.body.id != null) ? s.body.id : (s.bodyId != null ? s.bodyId : null);
  const body = (s.body && s.body.name)
    ? { name: s.body.name, id: bodyId }
    : (bodyId != null && bodiesById && bodiesById[bodyId])
      ? { name: bodiesById[bodyId], id: bodyId }
      : null;
  return {
    name:              s.name || '?',
    type:              s.type || s.stationType || 'Station',
    distanceToArrival: s.distanceToArrival != null ? s.distanceToArrival : null,
    haveMarket:        !!s.market || services.indexOf('Market') !== -1,
    haveShipyard:      !!s.shipyard || services.indexOf('Shipyard') !== -1,
    haveOutfitting:    !!s.outfitting || services.indexOf('Outfitting') !== -1,
    otherServices:     services,
    controllingFaction: s.controllingFaction && s.controllingFaction.name
      ? { name: s.controllingFaction.name }
      : (s.faction && s.faction.name ? { name: s.faction.name } : null),
    updateTime: s.updateTime || null,
    body,
    source: 'spansh',
  };
}

function spanshBodyToEdsmShape(b) {
  return {
    id:                b.id != null ? b.id : null,
    name:              b.name || '?',
    type:              b.type || null,
    subType:           b.subType || null,
    distanceToArrival: b.distanceToArrival != null ? b.distanceToArrival : null,
    radius:            b.radius != null ? b.radius : null,
    gravity:           b.gravity != null ? b.gravity : null,
    surfaceTemp:       b.surfaceTemperature != null ? b.surfaceTemperature : null,
    isLandable:        !!b.isLandable,
    rings:             Array.isArray(b.rings) && b.rings.length ? b.rings : null,
    solarRadius:       b.solarRadius != null ? b.solarRadius : null,
    // Spansh's dump format is based on EDSM's own schema, so materials come
    // through as the same {elementname: percent} object shape when present —
    // pass it straight through unchanged.
    materials:         b.materials && typeof b.materials === 'object' ? b.materials : null,
    source:            'spansh',
  };
}

// Spansh is treated as primary (fresher, pruned against EDDN) — any EDSM
// entry with the same name is dropped in favour of it. EDSM-only entries
// (systems/stations Spansh hasn't indexed yet) are kept and tagged so the UI
// can flag them as unverified.
function mergeStations(edsmStations, spanshRaw) {
  const bodiesById = {};
  if (spanshRaw && Array.isArray(spanshRaw.bodies)) {
    spanshRaw.bodies.forEach((b) => { if (b.id != null) bodiesById[b.id] = b.name; });
  }

  const merged  = new Map();
  const spanshStations = (spanshRaw && Array.isArray(spanshRaw.stations)) ? spanshRaw.stations : [];

  spanshStations.forEach((s) => {
    merged.set(normalizeName(s.name), spanshStationToEdsmShape(s, bodiesById));
  });

  (edsmStations || []).forEach((s) => {
    const key = normalizeName(s.name);
    if (merged.has(key)) return; // Spansh already covers this one — trust it
    merged.set(key, Object.assign({}, s, { source: 'edsm' }));
  });

  return Array.from(merged.values());
}

function mergeBodies(edsmBodies, spanshRaw) {
  const merged = new Map();

  (edsmBodies || []).forEach((b) => {
    merged.set(normalizeName(b.name), Object.assign({}, b, { source: b.source || 'edsm' }));
  });

  const spanshBodies = (spanshRaw && Array.isArray(spanshRaw.bodies)) ? spanshRaw.bodies : [];
  spanshBodies.forEach((b) => {
    const key = normalizeName(b.name);
    if (merged.has(key)) return; // already have it from EDSM/journal — don't override
    merged.set(key, spanshBodyToEdsmShape(b));
  });

  return Array.from(merged.values());
}

// ── Main lookup — triggered on every system entry ─────────────────────────────

async function lookupSystem(systemName, timestamp) {
  if (!systemName) return;

  // Deduplicate by system name — only fetch when the player enters a new system.
  // The old system|timestamp key caused a fresh EDSM hit on every Location event
  // (FSS entry, supercruise exit, approach body, etc.) because each carries a
  // different timestamp even though the system hasn't changed.
  if (systemName === _lastLookupKey) return;
  _lastLookupKey = systemName;

  const cfg    = readConfig();
  const edsmOn = !!cfg.edsmEnabled;

  try {
    // Bodies always fetch. System info only when EDSM integration is on.
    const tasks = [fetchSystemBodies(systemName), fetchSystemStations(systemName)];
    if (edsmOn) tasks.push(fetchSystemInfo(systemName));

    const results      = await Promise.allSettled(tasks);
    const bodiesRaw    = results[0];
    const stationsRaw  = results[1];
    const infoRaw      = edsmOn ? results[2] : null;

    // ── System info → edsm-system ──────────────────────────────────────────
    if (edsmOn) {
      if (infoRaw.status === 'fulfilled' && infoRaw.value) {
        const d    = infoRaw.value;
        const info = d.information || {};
        const payload = {
          name:       d.name      || systemName,
          edsmUrl:    d.url       || `https://www.edsm.net/en/system/id/-/name/${encodeURIComponent(systemName)}`,
          allegiance: info.allegiance || null,
          government: info.government || null,
          security:   info.security   || null,
          economy:    info.economy    || null,
          population: info.population ?? null,
          error:      null,
        };
        _cachedSystem = payload;
        send('edsm-system', payload);
        logger.info('EDSM', `System info fetched for ${systemName}`, { allegiance: info.allegiance, security: info.security });
      } else {
        const errMsg = infoRaw.reason?.message || 'lookup failed';
        const payload = {
          name:    systemName,
          edsmUrl: `https://www.edsm.net/en/system/id/-/name/${encodeURIComponent(systemName)}`,
          error:   errMsg,
        };
        _cachedSystem = payload;
        send('edsm-system', payload);
        logger.warn('EDSM', `System info lookup failed for ${systemName}`, errMsg);
      }
    }

    // ── Bodies → edsm-bodies ───────────────────────────────────────────────
    if (bodiesRaw.status === 'fulfilled' && bodiesRaw.value && Array.isArray(bodiesRaw.value.bodies)) {
      const edsmBodies   = bodiesRaw.value.bodies;
      const edsmStations = (stationsRaw.status === 'fulfilled' && stationsRaw.value && Array.isArray(stationsRaw.value.stations))
        ? stationsRaw.value.stations
        : [];

      // Cross-reference against Spansh using the system's id64 (EDSM's
      // bodies response includes it). Spansh is a second, independently
      // maintained source — merging it in is what catches stations EDSM has
      // wrong or stale. Any failure here (network, unrecognised system,
      // Spansh API shape drift) is non-fatal — we just fall back to EDSM
      // alone for this lookup. We also sanity-check the response actually
      // is the system we asked for (by id64 and name) before trusting any
      // of its stations — belt-and-braces against ever attributing another
      // system's stations to this one if Spansh's id64 lookup ever mismatches.
      //
      // FIX: the fallback (no id64 / lookup failed / mismatch) used to hand
      // back edsmBodies/edsmStations completely untagged. mergeStations()
      // tags every non-Spansh-matched entry `source: 'edsm'`, which is what
      // the renderer's "Unverified" badge keys off — so a *partial* Spansh
      // success correctly flagged the EDSM-only leftovers, but a *total*
      // Spansh failure (arguably the case where the data is least trustworthy)
      // rendered with no warning at all, looking identical to verified data.
      // Tag the fallback the same way so "Unverified" is consistent regardless
      // of which path produced the result.
      let bodies   = edsmBodies.map(b => Object.assign({}, b, { source: b.source || 'edsm' }));
      let stations = edsmStations.map(s => Object.assign({}, s, { source: s.source || 'edsm' }));
      let spanshOk = false;
      const id64 = bodiesRaw.value.id64;
      if (id64) {
        try {
          const spanshRaw = await spanshClient.fetchSpanshSystem(id64);
          const spanshId64Matches = spanshRaw && (spanshRaw.id64 == null || String(spanshRaw.id64) === String(id64));
          const spanshNameMatches = spanshRaw && (!spanshRaw.name || normalizeName(spanshRaw.name) === normalizeName(systemName));
          if (spanshRaw && spanshId64Matches && spanshNameMatches) {
            bodies   = mergeBodies(edsmBodies, spanshRaw);
            stations = mergeStations(edsmStations, spanshRaw);
            spanshOk = true;
          } else if (spanshRaw) {
            logger.warn('Spansh', `Response for id64 ${id64} didn't match requested system ${systemName} (got "${spanshRaw.name}") — ignoring, using EDSM only`);
          }
        } catch (err) {
          logger.warn('Spansh', `Cross-reference lookup failed for ${systemName}`, err.message || err);
        }
      } else {
        logger.warn('Spansh', `No id64 for ${systemName} — skipping cross-reference, using EDSM only`);
      }

      const payload = { system: systemName, bodies, stations, spanshVerified: spanshOk };
      _cachedBodies = payload;
      send('edsm-bodies', payload);
      logger.info('EDSM', `Bodies fetched for ${systemName}`, {
        count: bodies.length, stations: stations.length, spanshCrossRef: spanshOk,
      });
    } else {
      logger.warn('EDSM', `Bodies fetch failed for ${systemName}`, bodiesRaw.reason?.message || 'empty response');
    }

  } catch (err) {
    logger.error('EDSM', `Lookup error for ${systemName}`, err);
  }
}


// ── Replay cached data to any page that loads after the initial lookup ─────────

function replayToPage() {
  if (_cachedSystem) send('edsm-system', _cachedSystem);
  if (_cachedBodies) send('edsm-bodies', _cachedBodies);
}

// ── Start: subscribe to location events ──────────────────────────────────────

function start() {
  const cfg    = readConfig();
  const edsmOn = !!cfg.edsmEnabled;

  if (edsmOn) {
    if (!cfg.edsmCommanderName && !cfg.edsmApiKey) {
      logger.warn('EDSM', 'EDSM integration is enabled but no Commander Name or API Key is set — system info lookups will fail. Set them in Options > EDSM.');
    } else if (!cfg.edsmCommanderName) {
      logger.warn('EDSM', 'EDSM enabled but Commander Name is not set — flight log sync will not work');
    } else if (!cfg.edsmApiKey) {
      logger.warn('EDSM', 'EDSM enabled but API Key is not set — flight log sync will not work. Anonymous system lookups will still function.');
    } else {
      logger.info('EDSM', 'EDSM integration active', { commander: cfg.edsmCommanderName });
    }
  } else {
    logger.info('EDSM', 'EDSM integration is disabled — system info will not be fetched (bodies still fetched regardless)');
  }

  eventBus.on('journal.location', (data) => {
    if (data && data.system) {
      lookupSystem(data.system, data.timestamp);
    }
  });
}

// ── Exported helpers ──────────────────────────────────────────────────────────

async function getSystemBodies(systemName) {
  try { return await fetchSystemBodies(systemName); } catch { return null; }
}

async function getSystemInfo(systemName) {
  try { return await fetchSystemInfo(systemName); } catch { return null; }
}

module.exports = {
  setMainWindow,
  start,
  replayToPage,
  getSystemBodies,
  getSystemInfo,
  lookupSystem,
  getCache: () => ({ system: _cachedSystem, bodies: _cachedBodies }),
};
