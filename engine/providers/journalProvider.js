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
  liveData:    null,   // last live-data payload
  profileData: null,   // last profile-data payload
  bodiesData:  null,   // last bodies-data payload
};

function replayToPage() {
  if (_cache.liveData)    send('live-data',    _cache.liveData);
  if (_cache.profileData) send('profile-data', _cache.profileData);
  if (_cache.bodiesData)  send('bodies-data',  _cache.bodiesData);
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
function runWorker(files, { mode = 'all', useLastProcessed = false, updateLastProcessed = false } = {}) {
  return new Promise((resolve, reject) => {
    const lp = useLastProcessed ? { ...lastProcessed } : {};
    const worker = new Worker(path.join(__dirname, 'journalWorker.js'), {
      workerData: { files, lastProcessed: lp, mode }
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
          _cache.bodiesData = { system: msg.system, bodies: msg.bodies, signals: msg.signals };
          send('bodies-data', { system: msg.system, bodies: msg.bodies, signals: msg.signals });
          eventBus.emit('journal.bodies', { system: msg.system, bodies: msg.bodies, signals: msg.signals });
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
async function readLiveJournal(journalPath) {
  const files = getSortedJournalFiles(journalPath);
  if (!files.length) return;
  const latest = files[0];
  logger.info('JOURNAL', 'Reading live journal: ' + latest.file);
  await runWorker([latest.fullPath], { mode: 'live' });
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
  await runWorker(batch, { mode: 'profile' });
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

  function runLiveWorker(filePath) {
    if (_liveWorkerBusy) {
      _pendingLiveRun = true;
      return;
    }
    _liveWorkerBusy = true;
    runWorker([filePath], { mode: 'live' }).finally(() => {
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
      watchedPath = nowLatest.fullPath;
    }
    if (filePath === watchedPath) {
      runLiveWorker(filePath);
    }
  };

  watcher.on('add', handleFileEvent);
  watcher.on('change', handleFileEvent);
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
