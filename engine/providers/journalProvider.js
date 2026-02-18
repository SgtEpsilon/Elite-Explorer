const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const eventBus = require('../core/eventBus');
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
          break;

        case 'raw':
          // Forward raw journal entries to EDDN relay — only fires from live watcher
          eventBus.emit('journal.raw.' + msg.event, msg.entry);
          break;

        case 'live-data':
          send('live-data', msg.data);
          eventBus.emit('journal.live', msg.data);
          break;

        case 'profile-data':
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
          console.error('[worker error]', msg.file || '', msg.message);
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
  console.log('[live] Reading:', latest.file);
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

  console.log('[profile] Scanning ' + batch.length + ' file(s), found: ' + [...found].join(', '));
  await runWorker(batch, { mode: 'profile' });
}

// ── Exported "Scan All Journals" (Options button) ─────────────────────────────
// Only covers live + profile. History is owned by historyProvider.
async function scanAll() {
  let journalPath;
  try { journalPath = getJournalPath(); } catch (err) {
    console.error('[scanAll] Cannot resolve journal path:', err.message);
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
    console.error('[start] Cannot resolve journal path:', err.message);
    return;
  }
  if (!fs.existsSync(journalPath)) {
    console.error('[start] Journal directory not found:', journalPath);
    send('journal-path-missing', journalPath);
    return;
  }

  // Boot live + profile scopes (history is owned by historyProvider)
  readLiveJournal(journalPath);
  readProfileData(journalPath);

  // Live watcher — only fires live-data updates
  let latestFile  = getLatestJournalFile(journalPath);
  let watchedPath = latestFile ? latestFile.fullPath : null;
  if (watchedPath) console.log('[watcher] Tracking:', latestFile.file);

  const watcher = chokidar.watch(journalPath + path.sep + 'Journal.*.log', {
    persistent: true,
    ignoreInitial: true,
  });

  const handleFileEvent = (filePath) => {
    const nowLatest = getLatestJournalFile(journalPath);
    if (nowLatest && nowLatest.fullPath !== watchedPath) {
      console.log('[watcher] New session:', nowLatest.file);
      watchedPath = nowLatest.fullPath;
    }
    if (filePath === watchedPath) {
      runWorker([filePath], { mode: 'live' });
    }
  };

  watcher.on('add', handleFileEvent);
  watcher.on('change', handleFileEvent);
}

module.exports = { start, scanAll, setMainWindow, getJournalPath };
