/**
 * eddnRelay.js
 * Submits live journal events to the Elite Dangerous Data Network.
 * https://eddn.edcd.io
 *
 * Hooks into the eventBus for raw journal events, wraps them in the EDDN
 * schema envelope, and POSTs to the upload endpoint.
 *
 * Requires config.json to have:
 *   "eddnEnabled": true
 *   "commanderName": "YourCmdrName"
 *
 * Uses Node 18 built-in fetch (available in Electron 26+).
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

function makeEnvelope(schemaRef, message) {
  const cfg = readConfig();
  return {
    '$schemaRef': schemaRef,
    'header': {
      'uploaderID':       cfg.commanderName || 'Unknown',
      'softwareName':     SOFTWARE_NAME,
      'softwareVersion':  SOFTWARE_VERSION,
      'gatewayTimestamp': new Date().toISOString(),
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
      console.warn('[EDDN] Upload failed', res.status, body.slice(0, 100));
      send('eddn-status', { ok: false, status: res.status, message: body.slice(0, 100) });
    }
  } catch (err) {
    console.warn('[EDDN] Network error:', err.message);
    send('eddn-status', { ok: false, message: err.message });
  }
}

function isEnabled() { return readConfig().eddnEnabled === true; }

// ── FSDJump → journal/1 ───────────────────────────────────────────────────────
eventBus.on('journal.raw.FSDJump', (entry) => {
  if (!isEnabled()) return;
  // Strip personal fields EDDN forbids
  const msg = Object.assign({}, entry);
  ['ActiveFine','CockpitBreach','BoostUsed','FuelLevel','FuelUsed','JumpDist','Wanted'].forEach(k => delete msg[k]);
  submit(makeEnvelope('https://eddn.edcd.io/schemas/journal/1', msg));
});

// ── Scan → journal/1 ─────────────────────────────────────────────────────────
eventBus.on('journal.raw.Scan', (entry) => {
  if (!isEnabled()) return;
  submit(makeEnvelope('https://eddn.edcd.io/schemas/journal/1', Object.assign({}, entry)));
});

// ── Docked → journal/1 ───────────────────────────────────────────────────────
eventBus.on('journal.raw.Docked', (entry) => {
  if (!isEnabled()) return;
  const msg = Object.assign({}, entry);
  delete msg.Wanted;
  submit(makeEnvelope('https://eddn.edcd.io/schemas/journal/1', msg));
});

function start() {
  console.log('[EDDN] Relay initialised, enabled:', isEnabled());
}

module.exports = { start, setMainWindow };
