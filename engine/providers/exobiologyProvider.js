/**
 * exobiologyProvider.js
 * Owns the exobiology genus/species catalog end-to-end — mirrors
 * historyProvider.js's shape:
 *   - Resolves the journal path
 *   - Spawns exobiologyWorker.js in a Worker Thread for the full lifetime scan
 *   - Forwards progress + results to the renderer via IPC
 *   - Caches the last result so any page that navigates in gets it immediately
 *   - Applies live ScanOrganic / CodexEntry / SellOrganicData events on top of
 *     the cache as they happen, without needing a full re-scan
 */

const fs   = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const commanderRegistry = require('../services/commanderRegistry');

let mainWindow     = null;
let isScanning     = false;
let cachedCatalog  = null;   // keyed object: catalogKey -> entry (internal working form)
let scanComplete   = false;
let pendingRaw     = [];     // { kind, entry } pairs that arrived before the scan finished

function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function catalogKey(genus, species, variant) {
  return [genus || '?', species || '?', variant || ''].join('|');
}

function toList() {
  return cachedCatalog ? Object.values(cachedCatalog) : [];
}

function replayToPage() {
  if (cachedCatalog) send('exobiology-data', toList());
}

// ── Resolve journal path (mirrors historyProvider logic, self-contained) ──
function getJournalPath() {
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

function scan() {
  if (isScanning) {
    console.log('[exobiology] Scan already in progress, skipping');
    return;
  }
  isScanning = true;

  let journalPath;
  try {
    journalPath = getJournalPath();
  } catch (err) {
    console.error('[exobiology] Cannot resolve journal path:', err.message);
    send('exobiology-path-missing', err.message);
    isScanning = false;
    return;
  }

  if (!fs.existsSync(journalPath)) {
    console.error('[exobiology] Journal directory not found:', journalPath);
    send('exobiology-path-missing', journalPath);
    isScanning = false;
    return;
  }

  commanderRegistry.setJournalDir(journalPath);

  let files;
  try {
    files = fs.readdirSync(journalPath)
      .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
      .map(f => ({ name: f, fullPath: path.join(journalPath, f), mtime: fs.statSync(path.join(journalPath, f)).mtime }))
      .sort((a, b) => a.mtime - b.mtime)
      .map(f => f.fullPath);
  } catch (err) {
    console.error('[exobiology] Failed to list journal files:', err.message);
    isScanning = false;
    return;
  }

  // Scope to whichever commander is currently being viewed, same as History.
  const viewingFid = commanderRegistry.getViewingFid();
  if (viewingFid) {
    const scoped = new Set(commanderRegistry.getFilesForFid(viewingFid));
    const filtered = files.filter(f => scoped.has(f));
    if (filtered.length) files = filtered;
  }

  if (!files.length) {
    console.log('[exobiology] No journal files found');
    isScanning = false;
    return;
  }

  console.log('[exobiology] Starting scan of', files.length, 'journal file(s)');
  send('exobiology-scan-start', { totalFiles: files.length });

  const worker = new Worker(path.join(__dirname, 'exobiologyWorker.js'), {
    workerData: { files }
  });

  worker.on('message', (msg) => {
    switch (msg.type) {
      case 'progress':
        send('exobiology-progress', {
          file:         msg.file,
          currentLine:  msg.currentLine,
          totalLines:   msg.totalLines,
          fileIndex:    msg.fileIndex,
          totalFiles:   msg.totalFiles,
          speciesFound: msg.speciesFound,
        });
        break;

      case 'done': {
        cachedCatalog = {};
        (msg.catalog || []).forEach(rec => {
          cachedCatalog[catalogKey(rec.genus, rec.species, rec.variant)] = rec;
        });
        isScanning   = false;
        scanComplete = true;
        console.log('[exobiology] Scan complete —', Object.keys(cachedCatalog).length, 'species found');

        if (pendingRaw.length) {
          console.log('[exobiology] Flushing', pendingRaw.length, 'pending live event(s)');
          for (const { kind, entry } of pendingRaw) _apply(kind, entry);
          pendingRaw = [];
        }

        send('exobiology-data', toList());
        break;
      }

      case 'error':
        console.error('[exobiology] Worker error:', msg.file || '', msg.message);
        break;
    }
  });

  worker.on('error', (err) => {
    console.error('[exobiology] Worker threw:', err);
    isScanning = false;
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error('[exobiology] Worker exited with code', code);
      isScanning = false;
    }
  });
}

function getCache() { return { species: toList() }; }

function _touch(genus, genusName, species, speciesName, variant, variantName) {
  const key = catalogKey(genus, species, variant);
  if (!cachedCatalog[key]) {
    cachedCatalog[key] = {
      genus, genusName, species, speciesName,
      variant: variant || null, variantName: variantName || null,
      firstSystem: null, firstBody: null, firstSeenAt: null,
      scansLogged: 0, individualsFound: 0, timesSold: 0, creditsEarned: 0,
      firstDiscovery: false,
    };
  }
  return cachedCatalog[key];
}

// ── Internal: apply one live event on top of the cache ────────────────────
function _apply(kind, entry) {
  if (!cachedCatalog) return;

  if (kind === 'ScanOrganic') {
    const rec = _touch(entry.Genus, entry.Genus_Localised, entry.Species, entry.Species_Localised,
      entry.Variant, entry.Variant_Localised);
    rec.scansLogged++;
    if (entry.ScanType === 'Log') rec.individualsFound++;
    if (!rec.firstSeenAt) {
      rec.firstSeenAt = entry.timestamp || new Date().toISOString();
      rec.firstSystem = _lastKnownSystem;
      rec.firstBody   = _lastKnownBody || (entry.Body != null ? ('Body ' + entry.Body) : null);
    }
    send('exobiology-data', toList());
    return;
  }

  if (kind === 'CodexEntry') {
    if (entry.Category !== '$Codex_Category_Biology;' || !entry.IsNewEntry) return;
    const localisedName = entry.Name_Localised || entry.Name || null;
    if (!localisedName) return;
    let changed = false;
    Object.keys(cachedCatalog).forEach(k => {
      const rec = cachedCatalog[k];
      if (rec.variantName === localisedName || rec.speciesName === localisedName) {
        rec.firstDiscovery = true;
        changed = true;
      }
    });
    if (changed) send('exobiology-data', toList());
    return;
  }

  if (kind === 'SellOrganicData' && Array.isArray(entry.BioData)) {
    entry.BioData.forEach(bio => {
      const rec = _touch(bio.Genus, bio.Genus_Localised, bio.Species, bio.Species_Localised,
        bio.Variant, bio.Variant_Localised);
      rec.timesSold++;
      rec.creditsEarned += (bio.Value || 0) + (bio.Bonus || 0);
    });
    send('exobiology-data', toList());
  }
}

// Location tracking for live ScanOrganic events, fed by main.js from the
// same journal.raw.FSDJump/Location events historyProvider already listens
// to — ScanOrganic itself doesn't carry a system/body name (see the worker
// comment for why).
let _lastKnownSystem = null;
let _lastKnownBody   = null;
function noteLocation(entry) {
  if (entry && entry.StarSystem) {
    _lastKnownSystem = entry.StarSystem;
    _lastKnownBody = null;
  }
}
function noteBody(entry) {
  if (entry && entry.Body) _lastKnownBody = entry.Body;
}

// ── Public: called by main.js on journal.raw.ScanOrganic / CodexEntry / SellOrganicData ──
function appendEvent(kind, entry) {
  if (!entry) return;
  if (!scanComplete) {
    pendingRaw.push({ kind, entry });
    return;
  }
  _apply(kind, entry);
}

module.exports = { scan, replayToPage, setMainWindow, getCache, appendEvent, noteLocation, noteBody };
