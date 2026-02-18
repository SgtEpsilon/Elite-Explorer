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

function getJournalPath() {
  if (config.journalPath) return config.journalPath;
  const os = process.platform;
  if (os === 'win32')  return path.join(process.env.USERPROFILE, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
  if (os === 'darwin') return path.join(process.env.HOME, 'Library', 'Application Support', 'Frontier Developments', 'Elite Dangerous');
  if (os === 'linux')  return path.join(process.env.HOME, '.local', 'share', 'Steam', 'steamapps', 'compatdata', '359320', 'pfx', 'drive_c', 'users', 'steamuser', 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
  throw new Error(`Unsupported OS: ${os}. Set journalPath in config.json`);
}

function runWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'journalWorker.js'), {
      workerData: { files, lastProcessed: { ...lastProcessed } }
    });

    worker.on('message', async (msg) => {
      switch (msg.type) {

        case 'progress':
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan-progress', {
              file: msg.file, currentLine: msg.currentLine,
              totalLines: msg.totalLines, fileIndex: msg.fileIndex, totalFiles: msg.totalFiles
            });
          }
          break;

        case 'event':
          if (msg.event === 'journal.scan') {
            eventBus.emit('journal.scan', { system: msg.data.system, body: msg.data.body, type: msg.data.bodyType, timestamp: msg.data.timestamp });
          }
          if (msg.event === 'journal.location') {
            eventBus.emit('journal.location', { system: msg.data.system, timestamp: msg.data.timestamp });
          }
          break;

        // ── NEW: forward cmdr data to the renderer ───────────────────
        case 'cmdr':
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cmdr-data', msg.data);
          }
          // Also store latest on eventBus so anything else can listen
          eventBus.emit('journal.cmdr', msg.data);
          break;

        case 'done':
          lastProcessed = msg.updatedLastProcessed;
          await saveLastProcessed();
          resolve();
          break;

        case 'error':
          console.error('Worker error:', msg.message);
          break;
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
  });
}

async function readLastEntries() {
  const journalPath = getJournalPath();
  const files = fs.readdirSync(journalPath)
    .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
    .map(f => ({ file: f, time: fs.statSync(path.join(journalPath, f)).mtime }))
    .sort((a, b) => b.time - a.time);
  if (!files.length) return;
  await runWorker([path.join(journalPath, files[0].file)]);
}

async function readAllJournals() {
  const journalPath = getJournalPath();
  const files = fs.readdirSync(journalPath)
    .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
    .map(f => path.join(journalPath, f))
    .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime);
  if (!files.length) return;
  await runWorker(files);
}

function start() {
  const journalPath = getJournalPath();
  readLastEntries();
  const watcher = chokidar.watch(`${journalPath}${path.sep}Journal.*.log`, { persistent: true, ignoreInitial: false });
  watcher.on('change', filePath => runWorker([filePath]));
}

module.exports = { start, readAllJournals, setMainWindow };
