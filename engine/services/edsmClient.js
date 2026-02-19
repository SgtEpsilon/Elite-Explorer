/**
 * edsmClient.js
 * Fetches system data from the Elite Dangerous Star Map API.
 * https://www.edsm.net/en/api-v1
 *
 * On each FSDJump / Location event, fetches:
 *   - System info  (id, coords, allegiance, government, security, population, state)
 *   - System bodies (star/planet list)
 *
 * Sends results to the renderer via `edsm-system` and `edsm-bodies` IPC channels.
 * Also exposes `getEdsmUrl(systemName)` for building the EDSM link in the UI.
 *
 * Requires config.json:
 *   "edsmEnabled": true
 *   "edsmCommanderName": "YourCmdrName"   (optional, for log submissions)
 *   "edsmApiKey": "..."                   (optional, for log submissions)
 */

const fs       = require('fs');
const path     = require('path');
const eventBus = require('../core/eventBus');

const CONFIG_PATH    = path.join(__dirname, '../../config.json');
const BASE_URL       = 'https://www.edsm.net';
const SYSTEM_URL     = BASE_URL + '/api-v1/system';
const BODIES_URL     = BASE_URL + '/api-system-v1/bodies';

let mainWindow    = null;
let _lastSystem   = null;   // debounce — don't re-fetch the same system twice
let _inflight     = false;  // one request at a time

function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function isEnabled() { return readConfig().edsmEnabled === true; }

// ── URL builders ──────────────────────────────────────────────────────────────
function getEdsmUrl(systemName) {
  return BASE_URL + '/en/system/id/-/name/' + encodeURIComponent(systemName || '');
}

// ── Fetch system info + bodies ────────────────────────────────────────────────
async function fetchSystem(systemName) {
  if (_inflight || systemName === _lastSystem) return;
  _inflight = true;
  _lastSystem = systemName;

  try {
    const infoUrl = SYSTEM_URL + '?systemName=' + encodeURIComponent(systemName) +
      '&showId=1&showCoordinates=1&showPermit=1&showInformation=1&showPrimaryStar=1';

    const [infoRes, bodiesRes] = await Promise.all([
      fetch(infoUrl,                                                  { signal: AbortSignal.timeout(8000) }),
      fetch(BODIES_URL + '?systemName=' + encodeURIComponent(systemName), { signal: AbortSignal.timeout(8000) }),
    ]);

    if (infoRes.ok) {
      const info = await infoRes.json();
      console.log('[EDSM] System info:', systemName, '→', info.id ? 'found' : 'unknown');
      const payload = {
        name:         info.name         || systemName,
        id:           info.id           || null,
        id64:         info.id64         || null,
        coords:       info.coords       || null,
        permit:       info.requirePermit || false,
        allegiance:   info.information?.allegiance   || null,
        government:   info.information?.government   || null,
        faction:      info.information?.faction      || null,
        security:     info.information?.security     || null,
        population:   info.information?.population   || null,
        state:        info.information?.state        || null,
        economy:      info.information?.economy      || null,
        primaryStar:  info.primaryStar?.type         || null,
        edsmUrl:      getEdsmUrl(systemName),
      };
      send('edsm-system', payload);
      eventBus.emit('edsm.system', payload);
    }

    if (bodiesRes.ok) {
      const bodiesData = await bodiesRes.json();
      const bodies = (bodiesData.bodies || []).map(b => ({
        id:          b.id,
        name:        b.name,
        type:        b.type,
        subType:     b.subType,
        distanceToArrival: b.distanceToArrival,
        isLandable:  b.isLandable,
        gravity:     b.gravity,
        earthMasses: b.earthMasses,
        radius:      b.radius,
        surfaceTemp: b.surfaceTemperature,
        volcanism:   b.volcanismType,
        materials:   b.materials,
        rings:       b.rings?.length > 0,
        isScoopable: b.isScoopable,
        spectralClass: b.spectralClass,
        luminosity:  b.luminosity,
        absoluteMagnitude: b.absoluteMagnitude,
        solarMasses: b.solarMasses,
        solarRadius: b.solarRadius,
        reserveLevel: b.reserveLevel,
      }));
      console.log('[EDSM] Bodies for', systemName + ':', bodies.length);
      send('edsm-bodies', { system: systemName, bodies });
      eventBus.emit('edsm.bodies', { system: systemName, bodies });
    }

  } catch (err) {
    console.warn('[EDSM] Fetch error for', systemName + ':', err.message);
    send('edsm-system', { name: systemName, edsmUrl: getEdsmUrl(systemName), error: err.message });
  } finally {
    _inflight = false;
  }
}

// ── Listen to location changes ────────────────────────────────────────────────
eventBus.on('journal.location', (data) => {
  if (!isEnabled() || !data.system) return;
  fetchSystem(data.system);
});

// Reset debounce on new session so first system after launch always fetches
eventBus.on('journal.live', (data) => {
  if (data.currentSystem && data.currentSystem !== _lastSystem) {
    _lastSystem = null; // allow re-fetch
    if (isEnabled()) fetchSystem(data.currentSystem);
  }
});

function start() {
  console.log('[EDSM] Client initialised, enabled:', isEnabled());
}

module.exports = { start, setMainWindow, getEdsmUrl };
