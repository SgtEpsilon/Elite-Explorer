const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const engine = require('./engine/core/engine');
const journalProvider = require('./engine/providers/journalProvider');
const historyProvider = require('./engine/providers/historyProvider');
const eventBus = require('./engine/core/eventBus');
const api = require('./engine/api/server');

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

    // ── Cache the three data payloads so any page that navigates in
    // receives its data immediately without waiting for a re-scan.
    let cachedLive    = null;
    let cachedProfile = null;

    eventBus.on('journal.live',    d => { cachedLive    = d; });
    eventBus.on('journal.profile', d => { cachedProfile = d; });

    // Re-send cached data every time a page finishes loading (navigation, reload)
    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow.isDestroyed()) return;
      if (cachedLive)    mainWindow.webContents.send('live-data',    cachedLive);
      if (cachedProfile) mainWindow.webContents.send('profile-data', cachedProfile);
      // History replays itself via historyProvider.replayToPage()
      historyProvider.replayToPage();
    });

    // ── Start engine on first load ───────────────────────────────────────────
    mainWindow.webContents.once('did-finish-load', () => {
      engine.start();
      api.start();
      // History runs independently — kick it off on startup
      historyProvider.scan();
    });

    // ── IPC handlers ─────────────────────────────────────────────────────────
    ipcMain.handle('trigger-scan-all', () => runScan());
    ipcMain.handle('trigger-history-scan', () => historyProvider.scan());

    ipcMain.handle('app-quit', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    ipcMain.handle('get-journal-path', () => {
      try {
        const cfg = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
        return cfg.journalPath || '';
      } catch { return ''; }
    });

    ipcMain.handle('save-journal-path', (e, newPath) => {
      try {
        const cfgPath = path.join(__dirname, 'config.json');
        const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
        cfg.journalPath = newPath;
        require('fs').writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
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
      const { shell } = require('electron');
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
