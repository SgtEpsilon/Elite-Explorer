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

const { app: electronApp } = (() => { try { return require('electron'); } catch { return {}; } })();

let mainWindow  = null;
let isScanning  = false;
let cachedJumps = null; // last successful result, replayed on page load

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
        cachedJumps = msg.jumps;
        console.log('[history] Scan complete —', cachedJumps.length, 'jumps found');
        send('history-data', cachedJumps);
        isScanning = false;
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

module.exports = { scan, replayToPage, setMainWindow };
