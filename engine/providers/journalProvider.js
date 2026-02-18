const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const eventBus = require('../core/eventBus');
const config = require('../../config.json');

const LAST_FILE = path.join(__dirname, '../../lastProcessed.json');
let lastProcessed = {};
if (fs.existsSync(LAST_FILE)) {
  try { lastProcessed = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { lastProcessed = {}; }
}

// Use async file write so saving never blocks either
async function saveLastProcessed() {
  await fs.promises.writeFile(LAST_FILE, JSON.stringify(lastProcessed, null, 2));
}

let mainWindow = null;
function setMainWindow(win) { mainWindow = win; }

// Cross-platform journal folder detection
function getJournalPath() {
  if (config.journalPath) return config.journalPath;

  const os = process.platform;

  if (os === 'win32') {
    return path.join(process.env.USERPROFILE, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
  } else if (os === 'darwin') {
    return path.join(process.env.HOME, 'Library', 'Application Support', 'Frontier Developments', 'Elite Dangerous');
  } else if (os === 'linux') {
    return path.join(
      process.env.HOME,
      '.local', 'share', 'Steam', 'steamapps', 'compatdata',
      '359320', 'pfx', 'drive_c', 'users', 'steamuser',
      'Saved Games', 'Frontier Developments', 'Elite Dangerous'
    );
  } else {
    throw new Error(`Unsupported OS: ${os}. Please set journalPath in config.json`);
  }
}

/**
 * Runs a list of journal files through the worker thread.
 * The worker does all the heavy reading OFF the main thread,
 * so the UI stays responsive the entire time.
 */
function runWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, 'journalWorker.js'),
      {
        workerData: {
          files,
          lastProcessed: { ...lastProcessed } // pass a snapshot
        }
      }
    );

    worker.on('message', async (msg) => {
      switch (msg.type) {

        case 'progress':
          // Forward progress to the UI
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan-progress', {
              file: msg.file,
              currentLine: msg.currentLine,
              totalLines: msg.totalLines,
              fileIndex: msg.fileIndex,
              totalFiles: msg.totalFiles
            });
          }
          break;

        case 'event':
          // Re-emit journal events so engine.js writes them to the database
          if (msg.event === 'journal.scan') {
            eventBus.emit('journal.scan', {
              system: msg.data.system,
              body: msg.data.body,
              type: msg.data.bodyType,
              timestamp: msg.data.timestamp
            });
          }
          if (msg.event === 'journal.location') {
            eventBus.emit('journal.location', {
              system: msg.data.system,
              timestamp: msg.data.timestamp
            });
          }
          break;

        case 'done':
          // Save the updated lastProcessed map the worker sent back
          lastProcessed = msg.updatedLastProcessed;
          await saveLastProcessed();
          resolve();
          break;

        case 'error':
          console.error('Worker error:', msg.message);
          // Don't reject on a single file error — just log and continue
          break;
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}

// Startup: read last 31 entries from the most recent journal only
async function readLastEntries() {
  const journalPath = getJournalPath();
  const files = fs.readdirSync(journalPath)
    .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
    .map(f => ({ file: f, time: fs.statSync(path.join(journalPath, f)).mtime }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) return;

  const latestFile = path.join(journalPath, files[0].file);
  await runWorker([latestFile]);
}

// Scan ALL journals — runs in worker thread so UI never freezes
async function readAllJournals() {
  const journalPath = getJournalPath();
  const files = fs.readdirSync(journalPath)
    .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
    .map(f => path.join(journalPath, f))
    .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime);

  if (!files.length) return;

  await runWorker(files);
}

// Watch for real-time updates
function start() {
  const journalPath = getJournalPath();
  readLastEntries();

  const watcher = chokidar.watch(`${journalPath}${path.sep}Journal.*.log`, { persistent: true, ignoreInitial: false });
  watcher.on('change', filePath => runWorker([filePath]));
}

module.exports = { start, readAllJournals, setMainWindow };
