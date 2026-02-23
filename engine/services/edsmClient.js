/**
 * engine/services/edsmClient.js
 *
 * Listens on the eventBus for journal.location events (fired on every
 * FSDJump and Location event) and fetches system info + bodies from EDSM,
 * then pushes the results to the renderer via edsm-system and edsm-bodies.
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
 */

const eventBus    = require('../core/eventBus');
const CONFIG_PATH = require('path').join(__dirname, '../../config.json');
const fs          = require('fs');

const BASE_URL = 'https://www.edsm.net';

let mainWindow     = null;
let _lastLookupKey = null;   // "systemName|timestamp" — unique per system entry
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

// ── Main lookup — triggered on every system entry ─────────────────────────────

async function lookupSystem(systemName, timestamp) {
  if (!systemName) return;

  // Deduplicate by system+timestamp — collapses duplicate events from the same
  // jump (both FSDJump and Location fire journal.location), but allows a fresh
  // fetch every time the player genuinely enters a system.
  const key = systemName + '|' + (timestamp || '');
  if (key === _lastLookupKey) return;
  _lastLookupKey = key;

  const cfg    = readConfig();
  const edsmOn = !!cfg.edsmEnabled;

  try {
    // Bodies always fetch. System info only when EDSM integration is on.
    const tasks = [fetchSystemBodies(systemName)];
    if (edsmOn) tasks.push(fetchSystemInfo(systemName));

    const results  = await Promise.allSettled(tasks);
    const bodiesRaw = results[0];
    const infoRaw   = edsmOn ? results[1] : null;

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
      } else {
        const errMsg = infoRaw.reason?.message || 'lookup failed';
        const payload = {
          name:    systemName,
          edsmUrl: `https://www.edsm.net/en/system/id/-/name/${encodeURIComponent(systemName)}`,
          error:   errMsg,
        };
        _cachedSystem = payload;
        send('edsm-system', payload);
      }
    }

    // ── Bodies → edsm-bodies ───────────────────────────────────────────────
    if (bodiesRaw.status === 'fulfilled' && bodiesRaw.value && Array.isArray(bodiesRaw.value.bodies)) {
      const payload = { system: systemName, bodies: bodiesRaw.value.bodies };
      _cachedBodies = payload;
      send('edsm-bodies', payload);
    } else {
      console.warn('[edsmClient] bodies fetch failed for', systemName,
        bodiesRaw.reason?.message || 'empty response');
    }

  } catch (err) {
    console.warn('[edsmClient] lookup error for', systemName, err.message);
  }
}

// ── Replay cached data to any page that loads after the initial lookup ─────────

function replayToPage() {
  if (_cachedSystem) send('edsm-system', _cachedSystem);
  if (_cachedBodies) send('edsm-bodies', _cachedBodies);
}

// ── Start: subscribe to location events ──────────────────────────────────────

function start() {
  // journal.location fires on FSDJump and Location events.
  // Deduplication inside lookupSystem() handles the case where both events
  // fire for the same jump — only one HTTP request goes out.
  eventBus.on('journal.location', (data) => {
    if (data && data.system) lookupSystem(data.system, data.timestamp);
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
