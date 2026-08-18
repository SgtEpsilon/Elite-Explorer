/**
 * historyProvider.js
 * Completely standalone — no coupling to journalProvider, engine, or eventBus.
 * Owns the history scan end-to-end:
 *   - Resolves the journal path
 *   - Spawns historyWorker.js in a Worker Thread
 *   - Forwards progress + results to the renderer via IPC
 *   - Caches the last result so any page that navigates in gets it immediately
 */

const fs   = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const commanderRegistry = require('../services/commanderRegistry');
const edsmSystemCache = require('../services/edsmSystemCache');

const { app: electronApp } = (() => { try { return require('electron'); } catch { return {}; } })();

let mainWindow    = null;
let isScanning    = false;
let cachedJumps   = null;  // last successful result, replayed on page load
let scanComplete  = false; // true once the initial full scan has finished
let pendingJumps  = [];    // appendJump calls that arrived before scan completed

function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Replay cached data to a freshly loaded page ───────────────────────────────
function replayToPage() {
  if (cachedJumps) send('history-data', cachedJumps);
}

// ── Resolve journal path (mirrors journalProvider logic, but self-contained) ──
function getJournalPath() {
  // Prefer config.json if it exists and has a value
  try {
    const cfgPath = path.join(__dirname, '../../config.json');
    const cfg     = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.journalPath && cfg.journalPath.trim()) return cfg.journalPath.trim();
  } catch {}

  const os = process.platform;
  if (os === 'win32')
    return path.join(process.env.USERPROFILE, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
  if (os === 'darwin')
    return path.join(process.env.HOME, 'Library', 'Application Support', 'Frontier Developments', 'Elite Dangerous');
  if (os === 'linux')
    return path.join(process.env.HOME, '.local', 'share', 'Steam', 'steamapps', 'compatdata',
      '359320', 'pfx', 'drive_c', 'users', 'steamuser', 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
  throw new Error('Unsupported OS — set journalPath in config.json');
}

// ── Main scan function ────────────────────────────────────────────────────────
function scan() {
  if (isScanning) {
    console.log('[history] Scan already in progress, skipping');
    return;
  }
  isScanning = true;

  let journalPath;
  try {
    journalPath = getJournalPath();
  } catch (err) {
    console.error('[history] Cannot resolve journal path:', err.message);
    send('history-path-missing', err.message);
    isScanning = false;
    return;
  }

  if (!fs.existsSync(journalPath)) {
    console.error('[history] Journal directory not found:', journalPath);
    send('history-path-missing', journalPath);
    isScanning = false;
    return;
  }

  commanderRegistry.setJournalDir(journalPath);

  // Collect all journal files, oldest first so the jump list ends up chronological
  let files;
  try {
    files = fs.readdirSync(journalPath)
      .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
      .map(f => ({ name: f, fullPath: path.join(journalPath, f), mtime: fs.statSync(path.join(journalPath, f)).mtime }))
      .sort((a, b) => a.mtime - b.mtime) // oldest first → worker reverses at the end
      .map(f => f.fullPath);
  } catch (err) {
    console.error('[history] Failed to list journal files:', err.message);
    isScanning = false;
    return;
  }

  // Scope to whichever commander is currently being viewed, so an alt's
  // jump history doesn't get mixed into another commander's History page.
  // Falls back to the unfiltered list if the registry hasn't populated yet.
  const viewingFid = commanderRegistry.getViewingFid();
  if (viewingFid) {
    const scoped = new Set(commanderRegistry.getFilesForFid(viewingFid));
    const filtered = files.filter(f => scoped.has(f));
    if (filtered.length) files = filtered;
  }

  if (!files.length) {
    console.log('[history] No journal files found');
    isScanning = false;
    return;
  }

  console.log('[history] Starting scan of', files.length, 'journal file(s)');
  send('history-scan-start', { totalFiles: files.length });

  const worker = new Worker(path.join(__dirname, 'historyWorker.js'), {
    workerData: { files }
  });

  worker.on('message', (msg) => {
    switch (msg.type) {
      case 'progress':
        send('history-progress', {
          file:        msg.file,
          currentLine: msg.currentLine,
          totalLines:  msg.totalLines,
          fileIndex:   msg.fileIndex,
          totalFiles:  msg.totalFiles,
          jumpsFound:  msg.jumpsFound,
        });
        break;

      case 'done':
        cachedJumps  = msg.jumps;
        isScanning   = false;
        scanComplete = true;
        console.log('[history] Scan complete —', cachedJumps.length, 'jumps found');

        // Flush any live jumps that arrived while the scan was running.
        // These are genuinely new jumps (jumped during the scan window);
        // dedup them against the freshly-built cache before inserting.
        if (pendingJumps.length) {
          console.log('[history] Flushing', pendingJumps.length, 'pending live jump(s)');
          for (const entry of pendingJumps) _doAppendJump(entry);
          pendingJumps = [];
        }

        send('history-data', cachedJumps);
        enrichMissing();
        break;

      case 'error':
        console.error('[history] Worker error:', msg.file || '', msg.message);
        break;
    }
  });

  worker.on('error', (err) => {
    console.error('[history] Worker threw:', err);
    isScanning = false;
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error('[history] Worker exited with code', code);
      isScanning = false;
    }
  });
}

function getCache() { return { jumps: cachedJumps }; }

// ── EDSM background enrichment ──────────────────────────────────────────────
// Runs automatically after every scan/append — entirely independent of
// whether history.html happens to be the page currently loaded in the
// window. Checks the local edsm_system_cache first (instant, no network)
// and only falls back to EDSM's bodies API for systems genuinely never
// resolved before, so a fresh install pays the network cost once per
// system and every later launch (or app restart) is instant from then on.
let _enriching = false;
let _enrichQueued = false;
const _failedThisSession = new Set(); // system_lower — systems EDSM has no data for, don't hammer it every append

async function fetchEdsmBodies(system) {
  try {
    const url = `https://www.edsm.net/api-system-v1/bodies?systemName=${encodeURIComponent(system)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const bodies = Array.isArray(data.bodies) ? data.bodies : [];
    const primaryStar = bodies.find(b => b.type === 'Star' && b.distanceToArrival === 0)
                     || bodies.find(b => b.type === 'Star');
    const starClass = primaryStar ? (primaryStar.subType || primaryStar.spectralClass || null) : null;
    const bodyCount = data.bodyCount != null ? data.bodyCount : (bodies.length > 0 ? bodies.length : null);
    return { starClass, bodyCount };
  } catch {
    return null;
  }
}

function enrichMissing() {
  if (!cachedJumps || !cachedJumps.length) return;
  if (_enriching) { _enrichQueued = true; return; } // coalesce a burst of appendJump calls into one pass
  _enriching = true;

  (async () => {
    const seen = new Set();
    const targets = [];
    for (const j of cachedJumps) {
      if (j.starClass && j.bodyCount != null) continue;
      const key = j.system.toLowerCase();
      if (seen.has(key) || _failedThisSession.has(key)) continue;
      seen.add(key);
      targets.push(j.system);
    }

    let patchedAny = false;
    let sinceSend  = 0;

    for (const system of targets) {
      const key = system.toLowerCase();

      // 1. Local cache first — no network, no rate-limit cost.
      let result = edsmSystemCache.getCached(system);

      // 2. Cache miss — ask EDSM once, then persist so every future
      //    launch skips the network for this system entirely.
      if (!result) {
        const fetched = await fetchEdsmBodies(system);
        if (!fetched || (!fetched.starClass && fetched.bodyCount == null)) {
          _failedThisSession.add(key);
          await new Promise(r => setTimeout(r, 250));
          continue;
        }
        edsmSystemCache.setCached(system, fetched.starClass, fetched.bodyCount);
        result = fetched;
        await new Promise(r => setTimeout(r, 250)); // respect EDSM's rate limit — only paid on actual network hits
      }

      // A commander may have jumped to the same system many times across
      // the log — patch every row, not just the first match.
      for (const j of cachedJumps) {
        if (j.system.toLowerCase() !== key) continue;
        if (!j.starClass && result.starClass)      j.starClass = result.starClass;
        if (j.bodyCount == null && result.bodyCount != null) j.bodyCount = result.bodyCount;
      }
      patchedAny = true;
      sinceSend++;

      // Push in small batches (not once per system, not once at the end)
      // so a History page that's open sees it fill in progressively.
      if (sinceSend >= 5) { send('history-data', cachedJumps); sinceSend = 0; }
    }

    if (patchedAny) send('history-data', cachedJumps);

    _enriching = false;
    if (_enrichQueued) { _enrichQueued = false; enrichMissing(); }
  })();
}

// ── Internal: build a jump object from a raw journal FSDJump entry ────────────
function _makeJump(entry) {
  return {
    system:         entry.StarSystem,
    timestamp:      entry.timestamp || new Date().toISOString(),
    jumpDist:       entry.JumpDist  != null ? +entry.JumpDist.toFixed(2) : null,
    starClass:      entry.StarClass || entry.StarType || null,
    bodyCount:      entry.Body_count != null ? entry.Body_count : null,
    wasDiscovered:  entry.SystemAlreadyDiscovered !== false,
    fromEdsm:       false,
    isImportedStar: false,
  };
}

// ── Internal: insert one jump into cachedJumps if it isn't already there ──────
// Builds a dedup Set on every call — O(n) but only called for live jumps (rare).
function _doAppendJump(entry) {
  if (!entry || !entry.StarSystem) return;
  const newJump = _makeJump(entry);

  // Build a set of existing system+timestamp keys for O(1) lookup
  const existing = new Set(
    (cachedJumps || []).map(j => j.system + '|' + j.timestamp)
  );
  if (existing.has(newJump.system + '|' + newJump.timestamp)) {
    console.log('[history] FSDJump duplicate skipped:', newJump.system, newJump.timestamp);
    return;
  }

  cachedJumps = [newJump, ...(cachedJumps || [])];
  console.log('[history] FSDJump appended:', newJump.system, '— total', cachedJumps.length);
  send('history-data', cachedJumps);
  enrichMissing();
}

// ── Public: called by main.js on every journal.raw.FSDJump event ──────────────
// Jumps that arrive before the initial full scan completes are queued and
// flushed (with dedup) once the scan finishes — so they are never lost but
// also never doubled up with what the scan already collected.
function appendJump(entry) {
  if (!entry || !entry.StarSystem) return;

  if (!scanComplete) {
    // Scan still running — queue for later. The scan will collect this jump
    // from the journal file itself; we keep the entry so we catch the rare
    // case where the player jumps in the gap between scan-end and watcher-start.
    pendingJumps.push(entry);
    return;
  }

  _doAppendJump(entry);
}

module.exports = { scan, replayToPage, setMainWindow, getCache, appendJump, enrichMissing };
