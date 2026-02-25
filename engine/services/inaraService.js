/**
 * engine/services/inaraService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Inara.cz API integration — batched profile sync.
 *
 * Each sync sends a SINGLE request containing:
 *   1. getCommanderProfile  (read)  — returns squadron, avatar, preferred role, etc.
 *   2. setCommanderRankPilot        — pushes current ranks + progress from journals
 *   3. setCommanderReputationMajorFaction — pushes empire/fed/alliance rep
 *   4. setCommanderCredits          — pushes current credits (session start value)
 *
 * Inara's rate limit is 2 req/min. Batching everything into one call means we
 * stay well within that limit regardless of how often the user opens the app.
 *
 * API DOCS: https://inara.cz/elite/inara-api-docs/
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const logger = require('../core/logger');

const { app: electronApp } = (() => { try { return require('electron'); } catch { return {}; } })();
const userDataDir  = (electronApp && electronApp.getPath) ? electronApp.getPath('userData') : path.join(__dirname, '../..');
const CONFIG_PATH  = path.join(userDataDir, 'config.json');

const INARA_HOST   = 'inara.cz';
const INARA_PATH   = '/inapi/v1/';
const APP_NAME     = 'Elite Explorer';
const APP_VERSION  = '1.0';
const TIMEOUT_MS   = 15_000;

// Journal rank names → Inara rankName values
// Inara expects: combat, trade, explore, cqc, soldier, exobiologist, federation, empire
const RANK_MAP = {
  combat:     'combat',
  trade:      'trade',
  explore:    'explore',
  cqc:        'cqc',
  exobiology: 'exobiologist',
  empire:     'empire',
  federation: 'federation',
};

// Major faction names → Inara majorfactionName values
const FACTION_MAP = {
  empire:      'empire',
  federation:  'federation',
  alliance:    'alliance',
  independent: 'independent',
};

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

// ── buildWriteEvents ──────────────────────────────────────────────────────────
// Converts the journalProvider cache (ranks, progress, reputation, identity)
// into Inara write events to piggyback on the same request as getCommanderProfile.
//
// All write events are idempotent on Inara's side — if the stored value is
// already equal or newer, Inara silently ignores the update.
// ─────────────────────────────────────────────────────────────────────────────
function buildWriteEvents(journalCache, ts) {
  const events = [];
  if (!journalCache) return events;

  const { ranks, progress, reputation, identity } = journalCache;

  // setCommanderRankPilot — array form sends all ranks in one event
  if (ranks && progress) {
    const rankData = [];
    for (const [key, inaraName] of Object.entries(RANK_MAP)) {
      const rankEntry = ranks[key];
      const prog      = progress[key];
      if (rankEntry == null && prog == null) continue;
      const item = { rankName: inaraName };
      if (rankEntry != null) item.rankValue    = rankEntry.level;
      if (prog      != null) item.rankProgress = Math.round(prog) / 100; // journals store 0-100, Inara wants 0-1
      rankData.push(item);
    }
    if (rankData.length > 0) {
      events.push({
        eventName:      'setCommanderRankPilot',
        eventTimestamp: ts,
        eventData:      rankData,
      });
    }
  }

  // setCommanderReputationMajorFaction — array form
  if (reputation) {
    const repData = [];
    for (const [key, inaraName] of Object.entries(FACTION_MAP)) {
      const val = reputation[key];
      if (val == null) continue;
      repData.push({ majorfactionName: inaraName, majorfactionReputation: val / 100 }); // journals: -100..100 → Inara: -1..1
    }
    if (repData.length > 0) {
      events.push({
        eventName:      'setCommanderReputationMajorFaction',
        eventTimestamp: ts,
        eventData:      repData,
      });
    }
  }

  // setCommanderCredits — only send if we have a non-zero value
  if (identity && identity.credits != null && identity.credits > 0) {
    events.push({
      eventName:      'setCommanderCredits',
      eventTimestamp: ts,
      eventData:      { commanderCredits: identity.credits },
    });
  }

  return events;
}

// ── syncCommanderProfile ──────────────────────────────────────────────────────
// Sends a batched request: getCommanderProfile + journal write events.
//
// journalCache — optional { ranks, progress, reputation, identity } from
//                journalProvider.getCache().profileData — used to build write
//                events. If absent only the read event is sent.
//
// Returns:
//   { success: true,  data: <Inara eventData>, fetchedAt, batchedEvents }
//   { success: false, error: <string>, retryable?: true }
// ─────────────────────────────────────────────────────────────────────────────
async function syncCommanderProfile(searchName, journalCache) {
  const cfg    = readConfig();
  const apiKey = (cfg.inaraApiKey || '').trim();
  if (!apiKey) {
    return { success: false, error: 'No Inara API key configured. Add your key in Options ⚙ → Inara.' };
  }

  const resolvedName = (cfg.inaraCommanderName || '').trim() || (searchName || '').trim();
  if (!resolvedName) {
    return { success: false, error: 'No commander name available. Set one in Options ⚙ → Inara.' };
  }

  const ts = new Date().toISOString().slice(0, 19) + 'Z';

  // Build the write events from journal data (may be empty if no cache yet)
  const writeEvents = buildWriteEvents(journalCache, ts);

  // getCommanderProfile is always index 0 — the response parser relies on this
  const events = [
    {
      eventName:      'getCommanderProfile',
      eventTimestamp: ts,
      eventData:      { searchName: resolvedName },
    },
    ...writeEvents,
  ];

  const payload = {
    header: {
      appName:          APP_NAME,
      appVersion:       APP_VERSION,
      isBeingDeveloped: false,
      APIkey:           apiKey,
      commanderName:    resolvedName,
    },
    events,
  };

  logger.info('INARA', 'Batched sync', {
    resolvedName,
    totalEvents:   events.length,
    writeEvents:   writeEvents.map(e => e.eventName),
  });

  let response;
  try {
    response = await httpsPostJson(INARA_HOST, INARA_PATH, payload);
  } catch (err) {
    logger.error('INARA', 'Network error: ' + err.message);
    return { success: false, error: 'Network error: ' + err.message, retryable: true };
  }

  if (response.status !== 200) {
    const TRANSIENT_CODES = new Set([429, 500, 502, 503, 504]);
    const statusMessages  = {
      429: 'Inara rate limit hit (429) — will retry shortly.',
      500: 'Inara internal server error (500) — will retry shortly.',
      502: 'Inara gateway error (502) — will retry shortly.',
      503: 'Inara temporarily unavailable (503) — will retry shortly.',
      504: 'Inara gateway timed out (504) — will retry shortly.',
      401: 'Inara rejected the API key (401) — check your key in Options ⚙ → Inara.',
      403: 'Inara access forbidden (403) — check your API key in Options ⚙ → Inara.',
    };
    const msg       = statusMessages[response.status] || 'Inara returned HTTP ' + response.status;
    const retryable = TRANSIENT_CODES.has(response.status);
    logger.warn('INARA', msg, { httpStatus: response.status, retryable });
    return { success: false, error: msg, retryable };
  }

  const respBody     = response.body;
  const headerStatus = (respBody.header && respBody.header.eventStatus) ?? null;
  const headerText   = (respBody.header && respBody.header.eventStatusText) || '';

  logger.debug('INARA', 'Raw response', {
    httpStatus:   response.status,
    headerStatus,
    headerText,
    eventsCount:  Array.isArray(respBody.events) ? respBody.events.length : 'missing',
    eventStatuses: Array.isArray(respBody.events)
      ? respBody.events.map((e, i) => ({ i, name: events[i]?.eventName, status: e.eventStatus }))
      : [],
  });

  // ── Header-level auth check ───────────────────────────────────────────────
  if (headerStatus !== null && headerStatus !== 200 && headerStatus !== 202) {
    const knownHeaderMsgs = {
      400: 'API key rejected or app not recognised by Inara.',
      401: 'Inara API key is unauthorised.',
      403: 'Inara API access forbidden — check your key.',
      429: 'Inara rate limit hit at the header level — wait a few minutes.',
    };
    const base = knownHeaderMsgs[headerStatus] || ('Inara header error ' + headerStatus);
    const msg  = headerText ? (base + ' — ' + headerText) : base;
    logger.warn('INARA', 'Header-level error: ' + msg);
    return { success: false, error: msg };
  }

  // ── Missing events array ──────────────────────────────────────────────────
  const respEvents = respBody.events;
  if (!Array.isArray(respEvents) || respEvents.length === 0) {
    const hint = headerText
      ? ' — ' + headerText
      : ' — verify your API key and commander name in Options ⚙ → Inara.';
    const msg = 'No events in Inara response' + hint;
    logger.warn('INARA', msg, { rawBody: JSON.stringify(respBody).slice(0, 400) });
    return { success: false, error: msg };
  }

  // ── Parse getCommanderProfile response (always index 0) ──────────────────
  const profileEvt = respEvents[0];
  if (profileEvt.eventStatus === 204) {
    return { success: false, error: 'Commander "' + resolvedName + '" not found on Inara. Check the name in Options ⚙ → Inara.' };
  }
  if (profileEvt.eventStatus === 400) {
    return { success: false, error: 'Inara event error: ' + (profileEvt.eventStatusText || 'unknown') };
  }
  if (profileEvt.eventStatus !== 200 && profileEvt.eventStatus !== 202) {
    return { success: false, error: 'Inara returned event status ' + profileEvt.eventStatus };
  }

  const data = profileEvt.eventData;
  if (!data) {
    return { success: false, error: 'No data in Inara response.' };
  }

  // ── Log write event results (non-fatal — profile read already succeeded) ──
  for (let i = 1; i < respEvents.length; i++) {
    const we = respEvents[i];
    const weName = events[i]?.eventName || ('event[' + i + ']');
    if (we.eventStatus === 200 || we.eventStatus === 202) {
      logger.debug('INARA', weName + ' accepted', { status: we.eventStatus });
    } else {
      logger.warn('INARA', weName + ' rejected', { status: we.eventStatus, text: we.eventStatusText });
    }
  }

  logger.info('INARA', 'Batched sync succeeded', {
    inaraUser:     data.userName,
    batchedWrites: writeEvents.map(e => e.eventName),
  });

  return {
    success:       true,
    data,
    fetchedAt:     Date.now(),
    batchedEvents: writeEvents.map(e => e.eventName),
    warning:       profileEvt.eventStatus === 202
      ? (profileEvt.eventStatusText || 'Name was not an exact match — check your Inara display name in Options ⚙')
      : null,
  };
}

// ── syncProfile — rate-limited wrapper with retry back-off ────────────────────
const SYNC_INTERVAL_MS  = 5 * 60 * 1000;
const RETRY_DELAYS_MS   = [30_000, 60_000, 120_000];

let _lastSyncAt     = 0;
let _nextAllowedAt  = 0;
let _cachedResult   = null;
let _retryCount     = 0;

async function syncProfile(commanderName, journalCache) {
  const now = Date.now();

  if (now < _nextAllowedAt) {
    if (_cachedResult) {
      return { ..._cachedResult, fromCache: true, nextSyncAt: _nextAllowedAt };
    }
    return {
      skipped:    true,
      nextSyncAt: _nextAllowedAt,
      success:    false,
      error:      'Rate-limited — next sync at ' + new Date(_nextAllowedAt).toLocaleTimeString(),
    };
  }

  _lastSyncAt    = now;
  _nextAllowedAt = now + SYNC_INTERVAL_MS;

  const result = await syncCommanderProfile(commanderName, journalCache);

  if (result.success) {
    _cachedResult  = result;
    _retryCount    = 0;
    _nextAllowedAt = now + SYNC_INTERVAL_MS;
    logger.debug('INARA', 'Sync succeeded — next allowed at ' + new Date(_nextAllowedAt).toLocaleTimeString());
  } else if (result.retryable) {
    const delay    = RETRY_DELAYS_MS[Math.min(_retryCount, RETRY_DELAYS_MS.length - 1)];
    _retryCount   += 1;
    _nextAllowedAt = now + delay;
    logger.warn('INARA',
      `Transient error (attempt ${_retryCount}) — retrying in ${delay / 1000}s at ` +
      new Date(_nextAllowedAt).toLocaleTimeString(),
    );
  } else {
    _retryCount    = 0;
    _nextAllowedAt = now + SYNC_INTERVAL_MS;
    logger.warn('INARA', 'Permanent error — applying full cooldown until ' + new Date(_nextAllowedAt).toLocaleTimeString());
  }

  return { ...result, fromCache: false, nextSyncAt: _nextAllowedAt };
}

function getSyncStatus() {
  return {
    lastSyncAt:  _lastSyncAt,
    nextSyncAt:  _nextAllowedAt,
    cooldownMs:  SYNC_INTERVAL_MS,
    hasCached:   !!_cachedResult,
    retryCount:  _retryCount,
  };
}

module.exports = { syncProfile, getSyncStatus };
