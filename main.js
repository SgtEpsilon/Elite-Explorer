const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const engine = require('./engine/core/engine');
const journalProvider = require('./engine/providers/journalProvider');
const historyProvider = require('./engine/providers/historyProvider');
const eddnRelay       = require('./engine/services/eddnRelay');
const edsmClient      = require('./engine/services/edsmClient');
const eventBus = require('./engine/core/eventBus');
const api = require('./engine/api/server');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function readConfig()        { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function writeConfig(obj)    { fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2)); }

let mainWindow;
let isScanning = false;

// ── Scan all journals (triggered from Options button) ────────────────────────
async function runScan() {
  if (isScanning) return;
  isScanning = true;
  try {
    await journalProvider.scanAll();
  } catch (err) {
    console.error('Error during full scan:', err);
  } finally {
    isScanning = false;
  }
}

// ── Create Main Window ───────────────────────────────────────────────────────
function createWindow() {
  try {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      frame: true,
      transparent: false,
      resizable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
    journalProvider.setMainWindow(mainWindow);
    historyProvider.setMainWindow(mainWindow);
    eddnRelay.setMainWindow(mainWindow);
    edsmClient.setMainWindow(mainWindow);

    // ── Cache payloads for page navigation replays ───────────────────────────
    let cachedLive    = null;
    let cachedProfile = null;
    let cachedEdsm    = null;   // last EDSM system info

    eventBus.on('journal.live',    d => { cachedLive    = d; });
    eventBus.on('journal.profile', d => { cachedProfile = d; });

    // EDSM sends via IPC directly — intercept a copy for replay
    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow.isDestroyed()) return;
      if (cachedLive)    mainWindow.webContents.send('live-data',    cachedLive);
      if (cachedProfile) mainWindow.webContents.send('profile-data', cachedProfile);
      if (cachedEdsm)    mainWindow.webContents.send('edsm-system',  cachedEdsm);
      historyProvider.replayToPage();
    });

    // Intercept edsm-system to cache it for replay
    eventBus.on('edsm.system', d => { cachedEdsm = d; });

    // ── Start engine on first load ───────────────────────────────────────────
    mainWindow.webContents.once('did-finish-load', () => {
      engine.start();
      api.start();
      eddnRelay.start();
      edsmClient.start();
      historyProvider.scan();
    });

    // ── IPC handlers ─────────────────────────────────────────────────────────
    ipcMain.handle('trigger-scan-all',    () => runScan());
    ipcMain.handle('trigger-history-scan', () => historyProvider.scan());

    // Open external URL in system browser (for EDSM link)
    ipcMain.handle('open-external', (e, url) => {
      if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
        shell.openExternal(url);
      }
    });

    // Full config read/write for EDDN + EDSM settings
    ipcMain.handle('get-config', () => readConfig());
    ipcMain.handle('save-config', (e, patch) => {
      const cfg = readConfig();
      Object.assign(cfg, patch);
      writeConfig(cfg);
      return cfg;
    });

    ipcMain.handle('app-quit', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    ipcMain.handle('get-journal-path', () => readConfig().journalPath || '');

    ipcMain.handle('save-journal-path', (e, newPath) => {
      try {
        const cfg = readConfig();
        cfg.journalPath = newPath;
        writeConfig(cfg);
        return true;
      } catch { return false; }
    });

    ipcMain.handle('browse-journal-path', async () => {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Elite Dangerous Journal Folder',
        properties: ['openDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('open-journal-folder', async (e, folderPath) => {
      const target = folderPath || journalProvider.getJournalPath?.() || '';
      if (target) await shell.openPath(target);
    });

    mainWindow.on('closed', () => { mainWindow = null; });

  } catch (err) {
    console.error('Failed to create main window:', err);
  }
}

// ── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException',    err    => console.error('Uncaught Exception:', err));
process.on('unhandledRejection',   reason => console.error('Unhandled Rejection:', reason));
