// main.js
// Electron main process — boots the app, creates the window, wires up all IPC.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');  // NEW: used for EDSM discovery checks

const engine          = require('./engine/core/engine');
const journalProvider = require('./engine/providers/journalProvider');
const historyProvider = require('./engine/providers/historyProvider');
const eddnRelay       = require('./engine/services/eddnRelay');
const edsmClient      = require('./engine/services/edsmClient');
const capiService     = require('./engine/services/capiService');
const edsmSyncService = require('./engine/services/edsmSyncService');
const eventBus        = require('./engine/core/eventBus');
const api             = require('./engine/api/server');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function readConfig()     { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function writeConfig(obj) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2)); }

let mainWindow;
let isScanning = false;

// ── NEW: EDSM discovery cache ────────────────────────────────────────────────
// Calling EDSM for every system in history would be thousands of requests.
// We cache results for 10 minutes so navigating away and back doesn't re-fetch.
//
// Map structure: systemName (lowercase) → { discovered: bool|null, cachedAt: timestamp }
const edsmDiscoveryCache = new Map();
const EDSM_CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

// Check a single system against EDSM's database.
// EDSM returns id: 0 or missing when the system is unknown (i.e. you found it!)
function checkEdsmDiscoverySingle(systemName) {
  return new Promise((resolve) => {
    // Check the cache first — don't re-fetch something we just looked up
    const cacheKey = systemName.toLowerCase();
    const cached   = edsmDiscoveryCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < EDSM_CACHE_TTL) {
      return resolve({ systemName, discovered: cached.discovered });
    }

    const url = 'https://www.edsm.net/api-v1/system?systemName=' +
      encodeURIComponent(systemName) + '&showId=1&showInformation=1';

    // Node's https.get — no CORS, no browser restrictions
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          // EDSM returns id > 0 if the system is in their database (discovered)
          // id === 0 or missing means it wasn't in EDSM when you visited
          const discovered = !!(json && json.id && json.id > 0);
          edsmDiscoveryCache.set(cacheKey, { discovered, cachedAt: Date.now() });
          resolve({ systemName, discovered });
        } catch {
          resolve({ systemName, discovered: null, error: 'parse error' });
        }
      });
    });

    req.on('error', (err) => resolve({ systemName, discovered: null, error: err.message }));
    req.on('timeout', ()  => { req.destroy(); resolve({ systemName, discovered: null, error: 'timeout' }); });
  });
}

// ── Scan all journals (Options button) ──────────────────────────────────────
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
    capiService.setMainWindow(mainWindow);
    edsmSyncService.setMainWindow(mainWindow);

    // ── Cache payloads for page-navigation replays ───────────────────────────
    // When the user clicks Live / Profile / History tabs, a new HTML page loads.
    // The new page fires 'did-finish-load' and we replay the last known data
    // so it shows something immediately rather than waiting for the next event.
    let cachedLive    = null;
    let cachedProfile = null;
    let cachedEdsm    = null;
    let cachedBodies  = null;
    let cachedEdsmBodies = null;

    eventBus.on('journal.live',    d => { cachedLive    = d; });
    eventBus.on('journal.profile', d => { cachedProfile = d; });
    eventBus.on('edsm.system',     d => { cachedEdsm    = d; });
    eventBus.on('journal.bodies',  d => { cachedBodies  = d; });

    eventBus.on('edsm.bodies',    d => { cachedEdsmBodies = d; });

    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow.isDestroyed()) return;
      if (cachedLive)       mainWindow.webContents.send('live-data',    cachedLive);
      if (cachedProfile)    mainWindow.webContents.send('profile-data', cachedProfile);
      if (cachedEdsm)       mainWindow.webContents.send('edsm-system',  cachedEdsm);
      if (cachedBodies)     mainWindow.webContents.send('bodies-data',  cachedBodies);
      if (cachedEdsmBodies) mainWindow.webContents.send('edsm-bodies',  cachedEdsmBodies);
      historyProvider.replayToPage();
    });

    // ── Start engine on first load ───────────────────────────────────────────
    mainWindow.webContents.once('did-finish-load', () => {
      engine.start();
      api.start();
      eddnRelay.start();
      edsmClient.start();
      capiService.start();   // NEW — boots token refresh loop if already logged in
      historyProvider.scan();
    });

    // ════════════════════════════════════════════════════════════════════════
    // IPC HANDLERS
    // Each ipcMain.handle() corresponds to one ipcRenderer.invoke() in preload.js
    // ════════════════════════════════════════════════════════════════════════

    ipcMain.handle('trigger-scan-all',     () => runScan());
    ipcMain.handle('trigger-history-scan', () => historyProvider.scan());

    // Open URL in system browser (for EDSM "View System" link)
    ipcMain.handle('open-external', (e, url) => {
      if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
        shell.openExternal(url);
      }
    });

    ipcMain.handle('get-config',    ()         => readConfig());
    ipcMain.handle('save-config',   (e, patch) => {
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

    // ── NEW: EDSM Discovery IPC handlers ─────────────────────────────────────
    //
    // WHY here and not in edsmClient.js?
    //   edsmClient.js handles live system lookups (security, population etc.)
    //   Discovery checking is a separate concern used only by the history page.
    //   Keeping them separate avoids coupling and is easier to maintain.

    // Single system check — called one at a time from the history page
    ipcMain.handle('check-edsm-discovery', async (e, systemName) => {
      if (!systemName || typeof systemName !== 'string') {
        return { systemName, discovered: null, error: 'invalid name' };
      }
      return checkEdsmDiscoverySingle(systemName.trim());
    });

    // Bulk check — called with an array of names.
    // We stagger requests 150ms apart so we don't flood EDSM's API.
    // EDSM has a rate limit; being polite prevents your IP getting blocked.
    ipcMain.handle('check-edsm-discovery-bulk', async (e, systemNames) => {
      if (!Array.isArray(systemNames)) return [];

      const results = [];
      for (const name of systemNames) {
        if (!name || typeof name !== 'string') {
          results.push({ systemName: name, discovered: null, error: 'invalid' });
          continue;
        }
        const result = await checkEdsmDiscoverySingle(name.trim());
        results.push(result);
        // Wait 150ms between each request — polite rate limiting
        await new Promise(r => setTimeout(r, 150));
      }
      return results;
    });

    // ── NEW: cAPI IPC handlers ────────────────────────────────────────────────
    // All cAPI logic lives in engine/services/capiService.js
    // These handlers are just thin wires connecting the UI to that service.

    // Start the OAuth2 login flow
    ipcMain.handle('capi-login', async () => {
      return capiService.startOAuthLogin();
    });

    // Log out (clear tokens from config)
    ipcMain.handle('capi-logout', async () => {
      return capiService.logout();
    });

    // Check auth status without hitting the API
    ipcMain.handle('capi-get-status', async () => {
      return capiService.getStatus();
    });

    // Fetch commander profile from Frontier's servers
    ipcMain.handle('capi-get-profile', async () => {
      return capiService.getProfile();
    });

    // -- EDSM flight log sync --
    // Fetches the full flight log from EDSM in weekly batches, merges with
    // local journal jumps, pushes merged result back via history-data.
    ipcMain.handle('edsm-sync-logs', async (e, journalJumps) => {
      try {
        const result = await edsmSyncService.syncFromEdsm(
          journalJumps || [],
          (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('edsm-sync-progress', progress);
            }
          }
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('history-data', result.jumps);
        }
        return { success: true, totalEdsm: result.totalEdsm, newFromEdsm: result.newFromEdsm, totalMerged: result.totalMerged };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    mainWindow.on('closed', () => { mainWindow = null; });

  } catch (err) {
    console.error('Failed to create main window:', err);
  }
}

// ── App Lifecycle ────────────────────────────────────────────────────────────

// Single-instance lock — required on Windows so the OS can pass the
// eliteexplorer:// callback URI to the already-running instance rather than
// launching a second one. On macOS/Linux the open-url event handles this.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // A second instance was launched (e.g. by the OS handling the URI scheme).
  // Quit immediately — the first instance will receive the URI via second-instance.
  app.quit();
} else {
  // Windows: when the OS launches a second instance to handle eliteexplorer://,
  // we get the URI here in argv. Focus the existing window too.
  app.on('second-instance', (event, argv) => {
    const callbackUrl = argv.find(a => a.startsWith('eliteexplorer://'));
    if (callbackUrl) capiService.handleCallback(callbackUrl);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// macOS / Linux: the OS fires open-url when eliteexplorer:// is handled.
// Must be registered before app is ready.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('eliteexplorer://')) capiService.handleCallback(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException',  err    => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));
