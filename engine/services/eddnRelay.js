/**
 * eddnRelay.js
 * Submits live journal events to the Elite Dangerous Data Network.
 * https://eddn.edcd.io
 *
 * EDDN journal/1 schema rules applied here:
 *   - All *_Localised keys must be stripped (additionalProperties: false)
 *   - Personal/private fields must be stripped per-event (see below)
 *   - StarPos must be injected into Scan events (not present in journal Scan)
 *   - Docked at a Fleet Carrier has a different SystemAddress to the star system
 *     and must be handled separately — use the FC's own SystemAddress as-is
 *   - FSDJump Factions entries contain personal fields (MyReputation, HomeSystem)
 *     that must be removed from each faction object before submission
 */

const fs       = require('fs');
const path     = require('path');
const eventBus = require('../core/eventBus');

const EDDN_ENDPOINT    = 'https://eddn.edcd.io:4430/upload/';
const SOFTWARE_NAME    = 'EliteExplorer';
const SOFTWARE_VERSION = '1.0.0';
const CONFIG_PATH      = path.join(__dirname, '../../config.json');

let mainWindow = null;
function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function isEnabled() { return readConfig().eddnEnabled === true; }

// ── Location tracking ─────────────────────────────────────────────────────────
// Tracks the last known star-system location (StarPos + SystemAddress).
// Updated from FSDJump, Location, and CarrierJump — all carry StarPos.
// Registered unconditionally so _lastLocation is ready if EDDN is enabled later.
let _lastLocation = null; // { StarSystem, SystemAddress, StarPos }

function updateLocation(entry) {
  if (entry.StarSystem && entry.SystemAddress && entry.StarPos) {
    _lastLocation = {
      StarSystem:    entry.StarSystem,
      SystemAddress: entry.SystemAddress,
      StarPos:       entry.StarPos,
    };
  }
}

eventBus.on('journal.raw.FSDJump',     updateLocation);
eventBus.on('journal.raw.Location',    updateLocation);
eventBus.on('journal.raw.CarrierJump', updateLocation);

// ── Field stripping ───────────────────────────────────────────────────────────
// EDDN journal/1 schema uses additionalProperties:false, so any key not in the
// schema causes a "{'type': [...all types...]} is not allowed" validation error.
//
// STRIP_ALWAYS: forbidden in every event type
const STRIP_ALWAYS = new Set([
  // Personal flight data — forbidden by EDDN for privacy
  'ActiveFine', 'CockpitBreach', 'BoostUsed', 'FuelLevel', 'FuelUsed',
  'JumpDist', 'Wanted', 'Latitude', 'Longitude',
]);

// STRIP_SCAN: additional fields forbidden specifically in Scan events.
// These are either personal data (Materials — varies per commander) or
// fields the journal/1 schema explicitly marks as disallowed.
const STRIP_SCAN = new Set([
  'Parents',              // orbital parent chain — not in schema
  'Composition',          // body rock composition — not in schema
  'AtmosphereComposition',// personal/variable data
  'SolidComposition',     // personal/variable data
  'Materials',            // personal — quantity varies per cmdr
]);

// STRIP_FSDJUMP: personal fields inside the top-level FSDJump event.
// Faction sub-objects also need MyReputation and HomeSystem removed (see below).
const STRIP_FSDJUMP = new Set([
  'ActiveFine', 'CockpitBreach', 'BoostUsed', 'FuelLevel', 'FuelUsed',
  'JumpDist', 'Wanted',
]);

function sanitise(entry, extraStrip) {
  const strip = extraStrip || STRIP_ALWAYS;
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (strip.has(k))          continue; // forbidden field
    if (k.endsWith('_Localised')) continue; // localised strings never allowed
    out[k] = v;
  }
  return out;
}

// Strip personal fields from each Faction object inside FSDJump.
// MyReputation is commander-specific; HomeSystem is personal route data.
function sanitiseFactions(factions) {
  if (!Array.isArray(factions)) return factions;
  return factions.map(f => {
    const clean = Object.assign({}, f);
    delete clean.MyReputation;
    delete clean.HomeSystem;
    // Strip localised keys inside faction too
    for (const k of Object.keys(clean)) {
      if (k.endsWith('_Localised')) delete clean[k];
    }
    return clean;
  });
}

// ── Envelope + submit ─────────────────────────────────────────────────────────
function makeEnvelope(schemaRef, message) {
  const cfg = readConfig();
  return {
    '$schemaRef': schemaRef,
    'header': {
      'uploaderID':      cfg.commanderName || 'Unknown',
      'softwareName':    SOFTWARE_NAME,
      'softwareVersion': SOFTWARE_VERSION,
    },
    'message': message,
  };
}

async function submit(envelope) {
  try {
    const res = await fetch(EDDN_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(envelope),
      signal:  AbortSignal.timeout(8000),
    });
    const schema = envelope['$schemaRef'].split('/').slice(-2).join('/');
    if (res.ok) {
      console.log('[EDDN] Submitted:', schema);
      send('eddn-status', { ok: true, schema });
    } else {
      const body = await res.text().catch(() => '');
      console.warn('[EDDN] Upload failed', res.status, body.slice(0, 120));
      send('eddn-status', { ok: false, status: res.status, message: body.slice(0, 120) });
    }
  } catch (err) {
    console.warn('[EDDN] Network error:', err.message);
    send('eddn-status', { ok: false, message: err.message });
  }
}

// ── FSDJump → journal/1 ───────────────────────────────────────────────────────
// StarPos IS present in FSDJump. Strip personal fields and sanitise Factions.
eventBus.on('journal.raw.FSDJump', (entry) => {
  if (!isEnabled()) return;
  const msg = sanitise(entry, STRIP_FSDJUMP);
  if (msg.Factions) msg.Factions = sanitiseFactions(msg.Factions);
  submit(makeEnvelope('https://eddn.edcd.io/schemas/journal/1', msg));
});

// ── Scan → journal/1 ─────────────────────────────────────────────────────────
// StarPos is NOT in journal Scan events — inject from _lastLocation.
// Cross-check SystemAddress first; if mismatch this is a stale/replayed scan.
eventBus.on('journal.raw.Scan', (entry) => {
  if (!isEnabled()) return;

  // Combine global strip set with Scan-specific forbidden fields
  const stripSet = new Set([...STRIP_ALWAYS, ...STRIP_SCAN]);
  const msg = sanitise(entry, stripSet);

  if (!_lastLocation) {
    console.warn('[EDDN] Scan dropped — no location context for', msg.BodyName || '?');
    return;
  }
  if (msg.SystemAddress && msg.SystemAddress !== _lastLocation.SystemAddress) {
    console.warn('[EDDN] Scan dropped — SystemAddress mismatch (stale scan?):', msg.BodyName);
    return;
  }

  msg.StarPos       = _lastLocation.StarPos;
  msg.StarSystem    = msg.StarSystem    || _lastLocation.StarSystem;
  msg.SystemAddress = msg.SystemAddress || _lastLocation.SystemAddress;

  submit(makeEnvelope('https://eddn.edcd.io/schemas/journal/1', msg));
});

// ── Docked → journal/1 ───────────────────────────────────────────────────────
// StarPos is NOT in journal Docked events — inject from _lastLocation.
//
// Fleet Carrier special case: when docked at an FC the Docked event carries
// the FC's own SystemAddress, which differs from the star system's SystemAddress
// stored in _lastLocation. This is NOT an error — the FC is a valid docking
// location. We use _lastLocation.StarPos (the star system coordinates) and
// trust the Docked event's own StarSystem/SystemAddress for routing, because
// the FC may have moved since _lastLocation was set.
//
// EDDN's cross-check rule applies to Scan events (delayed/replayed body scans)
// not to Docked — a Docked event is always current by definition.
eventBus.on('journal.raw.Docked', (entry) => {
  if (!isEnabled()) return;
  const msg = sanitise(entry);

  if (!_lastLocation) {
    console.warn('[EDDN] Docked dropped — no location context yet');
    return;
  }

  // Use the star system's StarPos — the FC is in the same system even if its
  // SystemAddress differs. StarSystem in the Docked event is the star system name.
  msg.StarPos = _lastLocation.StarPos;

  // If the Docked event doesn't already carry StarSystem/SystemAddress
  // (some older game versions), fall back to last known location.
  if (!msg.StarSystem)    msg.StarSystem    = _lastLocation.StarSystem;
  if (!msg.SystemAddress) msg.SystemAddress = _lastLocation.SystemAddress;

  submit(makeEnvelope('https://eddn.edcd.io/schemas/journal/1', msg));
});

function start() {
  console.log('[EDDN] Relay initialised, enabled:', isEnabled());
}

module.exports = { start, setMainWindow };
