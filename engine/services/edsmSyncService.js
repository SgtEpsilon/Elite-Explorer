/**
 * engine/services/edsmSyncService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls the commander's complete flight log FROM EDSM and merges it with
 * the locally-scanned journal jumps.
 *
 * EDSM API used: GET https://www.edsm.net/api-logs-v1/get-logs
 *   Required params: commanderName, apiKey
 *   Optional params: startDateTime, endDateTime, showCoordinates=1, showId=1
 *
 * RATE LIMIT: 360 requests/hour (~1 per 10s). We fetch in 7-day windows and
 * pause 1.5s between each batch to stay well inside the limit.
 *
 * RESPONSE per log entry:
 *   { shipId, system, systemId, firstDiscover, date }
 *   With showCoordinates=1: adds { coordinates: { x, y, z } }
 *
 * MERGE STRATEGY:
 *   - Normalise both sets of jumps to the same shape
 *   - De-duplicate by (system, date) — journal entries are authoritative
 *     (they have jumpDist, starClass, bodyCount), EDSM fills in gaps
 *   - Result is sorted newest-first, same as historyProvider output
 *   - Merged result is sent to the renderer via 'history-data' so the
 *     existing history page renders it without any changes
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config.json');
const GET_LOGS_URL = 'https://www.edsm.net/api-logs-v1/get-logs';

// How long to wait between weekly batch requests (ms)
const BATCH_DELAY_MS = 1500;

let mainWindow = null;
function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// EDSM expects "YYYY-MM-DD HH:MM:SS" UTC strings.
function toEdsmDate(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Build an array of [start, end] Date pairs covering windowStart → now,
// each spanning exactly 7 days (EDSM's maximum batch size).
function buildWeeklyWindows(windowStart) {
  const windows = [];
  const now = new Date();
  let cursor = new Date(windowStart);
  while (cursor < now) {
    const end = new Date(cursor);
    end.setDate(end.getDate() + 7);
    windows.push([new Date(cursor), end > now ? now : end]);
    cursor = end;
  }
  return windows;
}

// ── Fetch one weekly batch ────────────────────────────────────────────────────
async function fetchBatch(commanderName, apiKey, startDate, endDate) {
  const params = new URLSearchParams({
    commanderName,
    apiKey,
    startDateTime:    toEdsmDate(startDate),
    endDateTime:      toEdsmDate(endDate),
    showCoordinates:  '1',
    showId:           '1',
  });
  const url = GET_LOGS_URL + '?' + params.toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('EDSM HTTP ' + res.status);
  const json = await res.json();
  // msgnum 100 = OK, 203 = commander not found / bad key
  if (json.msgnum === 203) throw new Error('Commander not found or API key invalid');
  if (json.msgnum !== 100) throw new Error('EDSM error ' + json.msgnum + ': ' + json.msg);
  return json.logs || [];
}

// ── Normalise an EDSM log entry into the app's jump shape ─────────────────────
// EDSM firstDiscover: true  → player was the first to report this system
//                     false → system was already in EDSM when they visited
// wasDiscovered mirrors the journal field: false = first discovery (★), true = already known
function normaliseEdsmEntry(entry) {
  return {
    system:        entry.system || null,
    timestamp:     entry.date   ? entry.date.replace(' ', 'T') + 'Z' : null,
    jumpDist:      null,          // EDSM doesn't provide jump distance
    pos:           entry.coordinates
                     ? [entry.coordinates.x, entry.coordinates.y, entry.coordinates.z]
                     : null,
    wasDiscovered: entry.firstDiscover === true ? false : true,
    starClass:     null,          // not in EDSM logs
    bodyCount:     null,
    fromEdsm:      true,
  };
}

// ── Build a Set of system names that EDSM says were first discoveries ──────────
// Used to back-fill wasDiscovered on existing journal jumps where the local flag
// may be wrong (e.g. pre-Odyssey journals didn't record SystemAlreadyDiscovered).
function buildFirstDiscoverSet(allEdsmLogs) {
  const s = new Set();
  for (const entry of allEdsmLogs) {
    if (entry.firstDiscover === true && entry.system) {
      s.add(entry.system.toLowerCase());
    }
  }
  return s;
}

// ── Main sync function ────────────────────────────────────────────────────────
// journalJumps: the existing array from historyProvider (newest-first)
// Returns: merged array (newest-first), plus a summary object
async function syncFromEdsm(journalJumps, onProgress) {
  const cfg = readConfig();

  if (!cfg.edsmCommanderName) throw new Error('No EDSM Commander Name set in Options');
  if (!cfg.edsmApiKey)        throw new Error('No EDSM API Key set in Options');

  // Build a lookup of existing journal jumps by (system, truncated-minute)
  // so we can de-duplicate without requiring exact timestamp matches.
  // Journal timestamps are "2024-01-15T18:23:45Z", EDSM are "2024-01-15 18:23:45"
  // We normalise to minute-level to tolerate small clock drift.
  const journalKeys = new Set();
  for (const j of journalJumps) {
    if (j.system && j.timestamp) {
      const key = j.system.toLowerCase() + '|' + j.timestamp.slice(0, 16);
      journalKeys.add(key);
    }
  }

  // Determine the earliest date to sync from.
  // If we have journal data, start from 7 days before the oldest journal jump
  // (to catch anything that fell through the cracks). Otherwise go back 1 year.
  let syncFrom;
  if (journalJumps.length > 0) {
    // journalJumps is newest-first, so last entry is oldest
    const oldest = journalJumps[journalJumps.length - 1];
    syncFrom = new Date(oldest.timestamp);
    syncFrom.setDate(syncFrom.getDate() - 7);
  } else {
    syncFrom = new Date();
    syncFrom.setFullYear(syncFrom.getFullYear() - 10); // full history
  }

  const windows = buildWeeklyWindows(syncFrom);
  let totalFetched = 0;
  let newJumps = 0;
  const edsmEntries = [];
  const allEdsmLogs = [];   // keep every raw log entry to build first-discover set

  for (let i = 0; i < windows.length; i++) {
    const [start, end] = windows[i];

    onProgress && onProgress({
      phase:   'fetching',
      batch:   i + 1,
      total:   windows.length,
      fetched: totalFetched,
    });

    const batch = await fetchBatch(cfg.edsmCommanderName, cfg.edsmApiKey, start, end);
    totalFetched += batch.length;
    allEdsmLogs.push(...batch);   // accumulate for first-discover pass

    for (const entry of batch) {
      if (!entry.system || !entry.date) continue;
      const key = entry.system.toLowerCase() + '|' + entry.date.slice(0, 16);
      if (!journalKeys.has(key)) {
        edsmEntries.push(normaliseEdsmEntry(entry));
        newJumps++;
      }
    }

    // Pause between batches to respect rate limits (except after last batch)
    if (i < windows.length - 1) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Build a set of system names EDSM says were first discoveries.
  // Use this to back-fill wasDiscovered on existing journal jumps — older
  // journals often didn't record SystemAlreadyDiscovered at all, leaving the
  // flag defaulting to true even when the player really was first in.
  const firstDiscoverSystems = buildFirstDiscoverSet(allEdsmLogs);
  let backFilledCount = 0;
  const enrichedJournalJumps = journalJumps.map(j => {
    if (j.system && firstDiscoverSystems.has(j.system.toLowerCase()) && j.wasDiscovered !== false) {
      backFilledCount++;
      return { ...j, wasDiscovered: false };
    }
    return j;
  });

  // Merge: combine enriched journal jumps + new EDSM-only entries, sort newest-first
  const merged = [...enrichedJournalJumps, ...edsmEntries].sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return b.timestamp.localeCompare(a.timestamp);
  });

  return {
    jumps:            merged,
    totalEdsm:        totalFetched,
    newFromEdsm:      newJumps,
    firstDiscoFromEdsm: backFilledCount,
    totalMerged:      merged.length,
  };
}

module.exports = { setMainWindow, syncFromEdsm };
