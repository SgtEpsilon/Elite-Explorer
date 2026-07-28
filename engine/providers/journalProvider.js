const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const eventBus = require('../core/eventBus');
const logger   = require('../core/logger');
const config = require('../../config.json');

const { app: electronApp } = (() => { try { return require('electron'); } catch { return {}; } })();
const userDataDir = (electronApp && electronApp.getPath) ? electronApp.getPath('userData') : path.join(__dirname, '../..');
const LAST_FILE = path.join(userDataDir, 'lastProcessed.json');
let lastProcessed = {};
if (fs.existsSync(LAST_FILE)) {
  try { lastProcessed = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { lastProcessed = {}; }
}

async function saveLastProcessed() {
  await fs.promises.writeFile(LAST_FILE, JSON.stringify(lastProcessed, null, 2));
}

let mainWindow = null;
function setMainWindow(win) { mainWindow = win; }

// ── Replay cache — keeps the last payload of each type so any page that loads
// after the initial scan still gets populated data immediately. ──────────────
const _cache = {
  liveData:     null,   // last live-data payload
  profileData:  null,   // last profile-data payload
  bodiesData:   null,   // last bodies-data payload
  missionsData: null,   // last missions-data payload
};

// Raw keyed maps behind the last bodies-data payload (the worker sends both
// the display-shaped arrays above AND these — see postBodiesData() in
// journalWorker.js). Kept separately because reconstructing a map from the
// array form isn't always safe (station keys can collide when StationName is
// absent) — these are the real accumulator state, not a derived reshape.
const _liveSeedMaps = { bodies: {}, stations: {} };

// Build the seed handed to the next live worker run so it can resume from
// where the last one left off instead of starting empty. This is what makes
// live mode incremental (see runLiveWorker below) instead of re-parsing the
// whole journal file — and replaying every earlier FSDJump — on every write.
function buildLiveSeed() {
  return {
    liveData:       _cache.liveData ? { ..._cache.liveData } : null,
    liveBodySystem: _cache.bodiesData ? _cache.bodiesData.system : null,
    liveBodies:     { ..._liveSeedMaps.bodies },
    liveSignals:    _cache.bodiesData ? { ...(_cache.bodiesData.signals || {}) } : {},
    liveStations:   { ..._liveSeedMaps.stations },
    liveMissions:   _cache.missionsData ? { ...(_cache.missionsData.missions || {}) } : {},
  };
}

function replayToPage() {
  if (_cache.liveData)     send('live-data',     _cache.liveData);
  if (_cache.profileData)  send('profile-data',  _cache.profileData);
  if (_cache.bodiesData)   send('bodies-data',   _cache.bodiesData);
  if (_cache.missionsData) send('missions-data', _cache.missionsData);
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function getJournalPath() {
  if (config.journalPath && config.journalPath.trim()) return config.journalPath.trim();
  const os = process.platform;
  if (os === 'win32')  return path.join(process.env.USERPROFILE, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
  if (os === 'darwin') return path.join(process.env.HOME, 'Library', 'Application Support', 'Frontier Developments', 'Elite Dangerous');
  if (os === 'linux')  return path.join(process.env.HOME, '.local', 'share', 'Steam', 'steamapps', 'compatdata', '359320', 'pfx', 'drive_c', 'users', 'steamuser', 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
  throw new Error('Unsupported OS. Set journalPath in config.json');
}

function getSortedJournalFiles(journalPath) {
  return fs.readdirSync(journalPath)
    .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
    .map(f => ({ file: f, fullPath: path.join(journalPath, f), time: fs.statSync(path.join(journalPath, f)).mtime }))
    .sort((a, b) => b.time - a.time);
}

// ── Generic worker runner ─────────────────────────────────────────────────────
function runWorker(files, { mode = 'all', useLastProcessed = false, updateLastProcessed = false, liveSeed = null } = {}) {
  return new Promise((resolve, reject) => {
    const lp = useLastProcessed ? { ...lastProcessed } : {};
    const worker = new Worker(path.join(__dirname, 'journalWorker.js'), {
      workerData: { files, lastProcessed: lp, mode, liveSeed }
    });

    worker.on('message', async (msg) => {
      switch (msg.type) {
        case 'progress':
          send('scan-progress', {
            file: msg.file, currentLine: msg.currentLine,
            totalLines: msg.totalLines, fileIndex: msg.fileIndex, totalFiles: msg.totalFiles
          });
          break;

        case 'event':
          if (msg.event === 'journal.scan')
            eventBus.emit('journal.scan', msg.data);
          if (msg.event === 'journal.location') {
            eventBus.emit('journal.location', msg.data);
            send('location-data', msg.data);
          }
          if (msg.event === 'journal.fss-scan')
            eventBus.emit('journal.fss-scan', msg.data);
          break;

        case 'raw':
          // Forward raw journal entries to EDDN relay — only fires from live watcher
          eventBus.emit('journal.raw.' + msg.event, msg.entry);
          break;

        case 'bodies-data':
          _cache.bodiesData = { system: msg.system, bodies: msg.bodies, signals: msg.signals, stations: msg.stations || [] };
          // Raw keyed maps for seeding the next incremental live run — kept
          // separately from the display-shaped arrays above (see _liveSeedMaps).
          _liveSeedMaps.bodies   = msg.bodiesMap   || {};
          _liveSeedMaps.stations = msg.stationsMap || {};
          send('bodies-data', { system: msg.system, bodies: msg.bodies, signals: msg.signals, stations: msg.stations || [] });
          eventBus.emit('journal.bodies', { system: msg.system, bodies: msg.bodies, signals: msg.signals, stations: msg.stations || [] });
          break;

        case 'missions-data':
          _cache.missionsData = { missions: msg.missions };
          send('missions-data', { missions: msg.missions });
          break;

        case 'live-data':
          // partial:true means this is a mid-file real-time update (Loadout, HullHealth,
          // Resurrect). Send it to the renderer immediately but do NOT overwrite the cache —
          // the cache must always hold the complete end-of-file payload so replayToPage
          // gives new pages a full data set rather than a sparse mid-session snapshot.
          if (!msg.partial) _cache.liveData = msg.data;
          send('live-data', msg.data);
          eventBus.emit('journal.live', msg.data);
          break;

        case 'profile-data':
          _cache.profileData = msg.data;
          send('profile-data', msg.data);
          eventBus.emit('journal.profile', msg.data);
          break;

        case 'bodies-clear-summary': {
          const { count, transitions, finalSystem } = msg.data;
          // Full transition list goes into the exportable debug log (getDebugLog/
          // saveDebugLog) — this is the detail needed to actually see *why* a
          // pass cleared the panel, not just that it happened.
          logger.info(
            'JOURNAL',
            `Bodies panel rebuilt via ${count} clear/rebuild pass(es) this read, ending in ${finalSystem || '?'}`,
            transitions.map((t) => `${t.prevSystem || '(none)'} → ${t.newSystem} @ ${t.timestamp}`).join('; ')
          );
          send('bodies-clear-summary', msg.data);
          break;
        }

        case 'carrier-event':
          // Not cached/replayed — this is a one-shot trigger for capiProvider
          // (docked-at-carrier / trade-order / trade), not renderer-facing data.
          eventBus.emit('journal.carrierEvent', msg.data);
          break;

        case 'done':
          if (updateLastProcessed) {
            lastProcessed = { ...lastProcessed, ...msg.updatedLastProcessed };
            await saveLastProcessed();
          }
          resolve();
          break;

        case 'error':
          logger.error('JOURNAL-WORKER', (msg.file || '') + ' ' + msg.message);
          break;
      }
    });

    worker.on('error', reject);
    worker.on('exit', code => { if (code !== 0) reject(new Error('Worker exited ' + code)); });
  });
}

// ── LIVE: single latest journal only ─────────────────────────────────────────
// Always a full read from line 0 (used at boot and by "Scan All Journals") —
// but updateLastProcessed:true records where it left off, so the *next*
// watcher-triggered write (runLiveWorker, below) can go straight to
// incremental mode instead of redundantly re-parsing the whole file once more.
async function readLiveJournal(journalPath) {
  const files = getSortedJournalFiles(journalPath);
  if (!files.length) return;
  const latest = files[0];
  logger.info('JOURNAL', 'Reading live journal: ' + latest.file);
  await runWorker([latest.fullPath], { mode: 'live', updateLastProcessed: true });
}

// ── PROFILE: scan backwards until all 5 key event types are found ─────────────
async function readProfileData(journalPath) {
  const files = getSortedJournalFiles(journalPath);
  if (!files.length) return;

  const REQUIRED = new Set(['LoadGame', 'Rank', 'Progress', 'Reputation', 'Statistics']);
  const found    = new Set();
  const batch    = [];

  for (const f of files) {
    batch.push(f.fullPath);
    try {
      const content = fs.readFileSync(f.fullPath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); if (REQUIRED.has(e.event)) found.add(e.event); } catch {}
        if (found.size === REQUIRED.size) break;
      }
    } catch {}
    if (found.size === REQUIRED.size) break;
  }

  logger.debug('JOURNAL', `Profile scan: checking ${batch.length} file(s)`, { found: [...found].join(', ') || 'none' });
  // Reverse so the worker processes oldest→newest: each event type overwrites
  // the previous, meaning the most-recent Statistics (and LoadGame, Rank, etc.)
  // is always the final value emitted in the profile-data payload.
  await runWorker(batch.reverse(), { mode: 'profile' });
}

// ── Exported "Scan All Journals" (Options button) ─────────────────────────────
// Only covers live + profile. History is owned by historyProvider.
async function scanAll() {
  let journalPath;
  try { journalPath = getJournalPath(); } catch (err) {
    logger.error('JOURNAL', 'scanAll: cannot resolve journal path', err);
    return;
  }
  if (!fs.existsSync(journalPath)) {
    send('journal-path-missing', journalPath);
    return;
  }
  send('scan-all-journals', {});
  await Promise.all([
    readLiveJournal(journalPath),
    readProfileData(journalPath),
  ]);
}

function getLatestJournalFile(journalPath) {
  try { const f = getSortedJournalFiles(journalPath); return f.length ? f[0] : null; } catch { return null; }
}

// ── Start: boot all three scopes + attach live watcher ───────────────────────
function start() {
  let journalPath;
  try { journalPath = getJournalPath(); } catch (err) {
    logger.error('JOURNAL', 'Cannot resolve journal path', err);
    return;
  }
  if (!fs.existsSync(journalPath)) {
    logger.warn('JOURNAL', 'Journal directory not found: ' + journalPath);
    send('journal-path-missing', journalPath);
    return;
  }

  // Boot live + profile scopes (history is owned by historyProvider)
  readLiveJournal(journalPath);
  readProfileData(journalPath);

  // Live watcher — only fires live-data updates
  let latestFile  = getLatestJournalFile(journalPath);
  let watchedPath = latestFile ? latestFile.fullPath : null;
  if (watchedPath) logger.info('JOURNAL', 'Watcher tracking journal file', { file: latestFile.file });

  // FIX: guard against worker thread pileup — only one live worker runs at a
  // time. If a change fires while one is already running, we set a flag and
  // re-run exactly once after the current worker finishes, rather than
  // spawning an unbounded number of concurrent workers.
  let _liveWorkerBusy = false;
  let _pendingLiveRun = false;

  // FIX: this used to always re-parse the whole file from line 0 (no
  // useLastProcessed/updateLastProcessed), which meant every single journal
  // write — even something as minor as entering supercruise or scooping fuel
  // — replayed every earlier FSDJump in the session, each one wiping and
  // rebuilding the System Bodies panel before landing back on the correct
  // state (see the "N replayed jump(s)" log). Now it only parses the lines
  // written since the last pass, seeded with the accumulated state from
  // buildLiveSeed() so it still has the full current picture (current
  // system's bodies/stations/missions/ship data) rather than starting blank.
  function runLiveWorker(filePath) {
    if (_liveWorkerBusy) {
      _pendingLiveRun = true;
      return;
    }
    _liveWorkerBusy = true;
    runWorker([filePath], {
      mode:                 'live',
      useLastProcessed:     true,
      updateLastProcessed:  true,
      liveSeed:             buildLiveSeed(),
    }).finally(() => {
      _liveWorkerBusy = false;
      if (_pendingLiveRun) {
        _pendingLiveRun = false;
        runLiveWorker(filePath);
      }
    });
  }

  const watcher = chokidar.watch(journalPath + path.sep + 'Journal.*.log', {
    persistent: true,
    ignoreInitial: true,
  });

  const handleFileEvent = (filePath) => {
    const nowLatest = getLatestJournalFile(journalPath);
    if (nowLatest && nowLatest.fullPath !== watchedPath) {
      logger.info('JOURNAL', 'New game session detected — switching to new journal file', { file: nowLatest.file });
      // A brand-new journal file means a brand-new game session — the
      // previous file's cached bodies/stations/ship state no longer applies
      // (and lastProcessed has no entry for this filename yet anyway, so it
      // will read from line 0 regardless). Clear the seed so this first pass
      // over the new file starts clean; the file's own LoadGame/Location/
      // FSDJump events will repopulate everything correctly.
      _cache.liveData      = null;
      _cache.bodiesData    = null;
      _cache.missionsData  = null;
      _liveSeedMaps.bodies   = {};
      _liveSeedMaps.stations = {};
      watchedPath = nowLatest.fullPath;
    }
    if (filePath === watchedPath) {
      runLiveWorker(filePath);
    }
  };

  watcher.on('add', handleFileEvent);
  watcher.on('change', handleFileEvent);

  // ── Status.json watcher — keeps the fuel panel live ──────────────────────
  // Status.json is rewritten by Elite every ~1 s while in-game and contains
  // Fuel.FuelMain (main tank) and Fuel.FuelReservoir (reserve). We read it
  // on every change and push a partial live-data update so the fuel bar and
  // display update in real time — independent of FSDJump/FuelScoop journal
  // events which only fire at discrete moments.
  const statusPath = path.join(journalPath, 'Status.json');

  function readStatusFuel() {
    try {
      const raw    = fs.readFileSync(statusPath, 'utf8');
      const status = JSON.parse(raw);
      const fuel   = status.Fuel;
      if (!fuel) return;

      const fuelMain      = fuel.FuelMain      ?? null;
      const fuelReservoir = fuel.FuelReservoir ?? null;
      if (fuelMain === null) return;

      // Capacity comes from Loadout events stored in the live-data cache.
      // Fall back to fuelMain itself (100%) if we haven't seen a Loadout yet.
      const fuelCapacity = (_cache.liveData && _cache.liveData.fuelCapacity)
        ? _cache.liveData.fuelCapacity
        : null;

      const fuelTotal   = fuelMain;
      const fuelPct     = fuelCapacity
        ? Math.min(100, Math.round((fuelTotal / fuelCapacity) * 100))
        : null;
      const fuelDisplay = fuelCapacity
        ? fuelMain.toFixed(1) + ' / ' + fuelCapacity
        : fuelMain.toFixed(1) + ' t';

      // Build a minimal live-data patch — only overwrite the fuel fields.
      // The receiver merges using the existing `if (d.field)` guards so
      // non-fuel fields are untouched.
      const patch = {
        fuelMain,
        fuelReservoir,
        fuelTotal,
        fuelPct,
        fuelDisplay,
      };

      // Update the cache so replayToPage sends current fuel to new page loads.
      if (_cache.liveData) {
        _cache.liveData = { ..._cache.liveData, ...patch };
      }

      send('live-data', patch);
    } catch {
      // Status.json may be transiently locked during an Elite write — skip quietly.
    }
  }

  const statusWatcher = chokidar.watch(statusPath, {
    persistent:       true,
    ignoreInitial:    false,   // read once on start so the bar is correct immediately
    awaitWriteFinish: false,   // react as soon as the file is touched
  });
  statusWatcher.on('add',    readStatusFuel);
  statusWatcher.on('change', readStatusFuel);
}

// ── refreshProfile: re-scan profile data on demand (used by 2-min poll) ──────
async function refreshProfile() {
  let journalPath;
  try { journalPath = getJournalPath(); } catch { return; }
  if (!fs.existsSync(journalPath)) return;
  await readProfileData(journalPath);
}

function getCache() { return { ..._cache }; }

module.exports = { start, scanAll, refreshProfile, setMainWindow, getJournalPath, replayToPage, getCache };
