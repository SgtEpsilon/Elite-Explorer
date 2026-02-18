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
      frame: false, // BORDERLESS
      transparent: false, // true if you want full transparency
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

    // ── Forward location updates to renderer safely
    eventBus.on('journal.location', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('location-data', data);
      }
    });

    // ── IPC: Renderer triggers scan
    ipcMain.handle('trigger-scan-all', () => runScan());

    // Optional: safe quit button from renderer
    ipcMain.handle('app-quit', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    // ── Window Controls ──────────────────────────────────────────────
    ipcMain.handle('win-minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    });
    ipcMain.handle('win-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
      }
    });
    ipcMain.handle('win-close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });
    ipcMain.handle('win-is-maximized', () => {
      return mainWindow ? mainWindow.isMaximized() : false;
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
  engine.start();
  api.start();

  app.on('activate', () => {
    // macOS behavior: recreate window if none exist
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
