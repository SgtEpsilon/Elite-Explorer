/**
 * engine/services/inaraService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Inara.cz API integration — read-only profile enrichment.
 *
 * Fetches commander data from inara.cz using the `getCommanderProfile` event.
 * This supplements local journal data with fields that journals don't contain:
 *   • Squadron name, member rank, member count, and Inara URL
 *   • Preferred allegiance (Federation / Empire / Alliance / Independent)
 *   • Preferred power (Powerplay pledge)
 *   • Preferred game role
 *   • Avatar image URL
 *   • Rank progress percentages (0–1 float) as a cross-check against journals
 *
 * AUTHENTICATION:
 *   getCommanderProfile can be called with the user's *personal* API key
 *   (found at https://inara.cz/elite/settings-api/) or with a generic
 *   application key registered on Inara's developer portal.
 *   We use the personal key approach — the user enters it in Options.
 *
 * API DOCS: https://inara.cz/elite/inara-api-docs/
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const logger = require('../core/logger');

// CONFIG_PATH mirrors the pattern used by capiService — reads from userData
const { app: electronApp } = (() => { try { return require('electron'); } catch { return {}; } })();
const userDataDir  = (electronApp && electronApp.getPath) ? electronApp.getPath('userData') : path.join(__dirname, '../..');
const CONFIG_PATH  = path.join(userDataDir, 'config.json');

const INARA_HOST   = 'inara.cz';
const INARA_PATH   = '/inara-api-input/';
const APP_NAME     = 'Elite Explorer';
const APP_VERSION  = '1.0';
const TIMEOUT_MS   = 15_000;

// ── Config reader ─────────────────────────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// ── HTTPS JSON POST helper ────────────────────────────────────────────────────
function httpsPostJson(hostname, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname,
      port:   443,
      path:   urlPath,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'Elite Explorer/1.0',
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: {}, _raw: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Inara request timed out after ' + (TIMEOUT_MS / 1000) + 's'));
    });
    req.write(body);
    req.end();
  });
}

// ── getCommanderProfile ───────────────────────────────────────────────────────
// Searches Inara for the commander by name.
//
// Name resolution order:
//   1. `inaraCommanderName` from config  — user-specified override
//   2. `searchName` argument             — in-game name from journals
//
// Returns:
//   { success: true,  data: <Inara eventData>, fetchedAt: <ms timestamp> }
//   { success: false, error: <string> }
// ─────────────────────────────────────────────────────────────────────────────
async function getCommanderProfile(searchName) {
  const cfg    = readConfig();
  const apiKey = (cfg.inaraApiKey || '').trim();
  if (!apiKey) {
    return { success: false, error: 'No Inara API key configured. Add your key in Options ⚙ → Inara.' };
  }

  // Prefer the manual override; fall back to the in-game name from journals
  const resolvedName = (cfg.inaraCommanderName || '').trim() || (searchName || '').trim();
  if (!resolvedName) {
    return { success: false, error: 'No commander name available. Set one in Options ⚙ → Inara.' };
  }

  const payload = {
    header: {
      appName:          APP_NAME,
      appVersion:       APP_VERSION,
      isBeingDeveloped: false,
      APIkey:           apiKey,
      commanderName:    resolvedName,
    },
    events: [
      {
        eventName:      'getCommanderProfile',
        eventTimestamp: new Date().toISOString().slice(0, 19) + 'Z',
        eventData:      { searchName: resolvedName },
      },
    ],
  };

  logger.info('INARA', 'Querying commander profile', { resolvedName });
  logger.debug('INARA', 'Outbound payload', {
    appName:      payload.header.appName,
    hasApiKey:    !!payload.header.APIkey,
    commanderName: payload.header.commanderName,
    searchName:   payload.events[0].eventData.searchName,
  });

  let response;
  try {
    response = await httpsPostJson(INARA_HOST, INARA_PATH, payload);
  } catch (err) {
    logger.error('INARA', 'Network error: ' + err.message);
    return { success: false, error: 'Network error: ' + err.message };
  }

  if (response.status !== 200) {
    const statusMessages = {
      503: 'Inara is temporarily unavailable (503) — try again in a few minutes.',
      502: 'Inara is temporarily unavailable (502) — try again in a few minutes.',
      504: 'Inara gateway timed out (504) — try again in a few minutes.',
      429: 'Inara rate limit hit (429) — please wait before retrying.',
      401: 'Inara rejected the API key (401) — check your key in Options ⚙ → Inara.',
      403: 'Inara access forbidden (403) — check your API key in Options ⚙ → Inara.',
    };
    const msg = statusMessages[response.status] || 'Inara returned HTTP ' + response.status;
    logger.warn('INARA', msg);
    return { success: false, error: msg };
  }

  const respBody = response.body;
  logger.debug('INARA', 'Raw response', {
    httpStatus:   response.status,
    headerStatus: respBody.header && respBody.header.eventStatus,
    headerText:   respBody.header && respBody.header.eventStatusText,
    eventsCount:  respBody.events ? respBody.events.length : 'missing',
    firstEvent:   respBody.events && respBody.events[0]
      ? { status: respBody.events[0].eventStatus, text: respBody.events[0].eventStatusText }
      : null,
  });

  // Check header-level auth status
  const headerStatus = respBody.header && respBody.header.eventStatus;
  if (headerStatus === 400) {
    const msg = (respBody.header && respBody.header.eventStatusText) || 'API key invalid or unauthorised.';
    logger.warn('INARA', 'Auth failure: ' + msg);
    return { success: false, error: 'Inara auth error: ' + msg };
  }

  // Check event-level status
  const events = respBody.events;
  if (!events || !events.length) {
    const headerText = (respBody.header && respBody.header.eventStatusText) || '';
    const detail     = headerText ? (' — ' + headerText) : ' — check the Debug Log in Preferences ⚙ for the full response.';
    return { success: false, error: 'Empty response from Inara' + detail };
  }

  const evt = events[0];
  if (evt.eventStatus === 204) {
    return { success: false, error: 'Commander "' + resolvedName + '" not found on Inara. Check the name in Options ⚙ → Inara.' };
  }
  if (evt.eventStatus === 400) {
    return { success: false, error: 'Inara event error: ' + (evt.eventStatusText || 'unknown') };
  }
  if (evt.eventStatus !== 200 && evt.eventStatus !== 202) {
    return { success: false, error: 'Inara returned event status ' + evt.eventStatus };
  }

  const data = evt.eventData;
  if (!data) {
    return { success: false, error: 'No data in Inara response.' };
  }

  logger.info('INARA', 'Profile fetched successfully', { inaraUser: data.userName });

  return {
    success:   true,
    data:      data,
    fetchedAt: Date.now(),
    // 202 means the name wasn't an exact match — Inara returned the closest result
    warning:   evt.eventStatus === 202 ? (evt.eventStatusText || 'Name was not an exact match — check your Inara display name in Options ⚙') : null,
  };
}

module.exports = { getCommanderProfile };
