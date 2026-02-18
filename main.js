const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const engine = require('./engine/core/engine');
const journalProvider = require('./engine/providers/journalProvider');
const eventBus = require('./engine/core/eventBus');
const api = require('./engine/api/server');

let mainWindow;
let isScanning = false; // guard against double-triggering

// ── Scan Function ────────────────────────────────────────────────
async function runScan() {
  if (isScanning) return;
  isScanning = true;

  try {
    console.log('Scan All Journals starting...');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-all-journals');
    }
    await journalProvider.readAllJournals();
    console.log('Scan All Journals completed.');
  } catch (err) {
    console.error('Error scanning all journals:', err);
  } finally {
    isScanning = false;
  }
}

// ── Create Main Window ──────────────────────────────────────────
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

    // Assign mainWindow to journalProvider
    journalProvider.setMainWindow(mainWindow);

    // ── Wait for renderer to finish loading before starting the engine
    // so IPC listeners are registered before we send any data.
    mainWindow.webContents.once('did-finish-load', () => {
      engine.start();
      api.start();
    });

    // ── Forward location updates to renderer safely
    eventBus.on('journal.location', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('location-data', data);
      }
    });

    // ── IPC: Renderer triggers scan
    ipcMain.handle('trigger-scan-all', () => runScan());

    // ── Window Controls ──────────────────────────────────────────────
    // Optional: safe quit button from renderer
    ipcMain.handle('app-quit', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    // ── Options: Journal Path ────────────────────────────────────────
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



    // ── Optional: Handle window closed
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

  } catch (err) {
    console.error('Failed to create main window:', err);
  }
}

// ── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit app when all windows closed (except macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Global Exception Guard ──────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});
