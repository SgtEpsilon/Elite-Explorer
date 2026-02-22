'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, protocol, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');

// ── Engine / service imports ──────────────────────────────────────────────────
const logger           = require('./engine/core/logger');
const journalProvider  = require('./engine/providers/journalProvider');
const historyProvider  = require('./engine/providers/historyProvider');
const edsmClient       = require('./engine/services/edsmClient');
const eddnRelay        = require('./engine/services/eddnRelay');
const edsmSyncService  = require('./engine/services/edsmSyncService');
const capiService      = require('./engine/services/capiService');
const updaterService   = require('./engine/services/updaterService');
const engine           = require('./engine/core/engine');
const api              = require('./engine/api/server');

// ── Config path ───────────────────────────────────────────────────────────────────
// Live config lives in userData so it is always writable, even when the app
// is packaged inside an asar archive where __dirname is read-only.
// On first launch we seed it from the bundled config.json defaults.
const CONFIG_DEFAULTS_PATH = path.join(__dirname, 'config.json');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// ── Config helpers ────────────────────────────────────────────────────────────
function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    try {
      const defaults = fs.existsSync(CONFIG_DEFAULTS_PATH)
        ? fs.readFileSync(CONFIG_DEFAULTS_PATH, 'utf8')
        : '{}';
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, defaults);
    } catch { /* leave empty; readConfig will return {} */ }
  }
}
function readConfig() {
  ensureConfig();
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  ensureConfig();
  const cfg = readConfig();
  Object.assign(cfg, patch);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ── Application Menu ──────────────────────────────────────────────────────────
function buildMenu() {
  const cfg     = readConfig();
  const isBeta  = cfg.updateChannel === 'beta';

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click() {
            if (!mainWindow) return;
            // The prefs modal is injected into every page by prefs-modal.js.
            // Just send the IPC message — no navigation needed.
            mainWindow.webContents.send('open-preferences');
          },
        },
        { type: 'separator' },
        {
          label: 'Quit Elite Explorer',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click() { app.quit(); },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 880,
    minWidth:  900,
    minHeight: 600,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#090e18',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // ── Wire mainWindow into every service that sends to the renderer ─────────
  journalProvider .setMainWindow(mainWindow);
  historyProvider .setMainWindow(mainWindow);
  edsmClient      .setMainWindow(mainWindow);
  eddnRelay       .setMainWindow(mainWindow);
  edsmSyncService .setMainWindow(mainWindow);
  capiService     .setMainWindow(mainWindow);
  updaterService  .setMainWindow(mainWindow);

  // ── Replay cached data whenever any page (re)loads ────────────────────────
  // When the user navigates between Live / Profile / History tabs, the new
  // page fires 'did-finish-load' and we push whatever was cached so data
  // appears immediately without re-scanning.
  mainWindow.webContents.on('did-finish-load', () => {
    historyProvider.replayToPage();      // → history-data
    journalProvider.replayToPage();      // → live-data, profile-data, bodies-data
    edsmClient.replayToPage();           // → edsm-system, edsm-bodies
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const { version } = require('./package.json');
  logger.info('APP', `Elite Explorer v${version} starting`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
  });

  app.setAsDefaultProtocolClient('eliteexplorer');

  buildMenu();
  createWindow();

  engine.start();      // DB + eventBus listeners
  logger.info('ENGINE', 'Engine started');
  api.start();         // REST API on :3721
  logger.info('API', 'REST API started on :3721');

  edsmClient.start();  // listens on eventBus for location events
  eddnRelay.start();   // listens on eventBus for raw journal events

  // journalProvider.start() kicks off three things in parallel:
  //   1. readLiveJournal()  → emits bodies-data, live-data to renderer
  //   2. readProfileData()  → emits profile-data to renderer
  //   3. chokidar watcher   → tails latest journal for real-time updates
  journalProvider.start();

  // historyProvider.scan() spawns a Worker Thread that reads ALL journal files
  // for FSDJump entries and emits history-data when done.
  historyProvider.scan();

  await capiService.start();

  // Start auto-updater (checks after 5s, then every 4 hours)
  updaterService.start();
});

// ── macOS / Linux: custom URI scheme for cAPI OAuth callback ──────────────────
app.on('open-url', (event, url) => {
  event.preventDefault();
  capiService.handleCallback(url).catch(console.error);
});

// ── Windows: second-instance carries the custom URI as a CLI arg ──────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find(a => a.startsWith('eliteexplorer://'));
    if (url) capiService.handleCallback(url).catch(console.error);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ═══════════════════════════════════════════════════════════════════════════════
// IPC HANDLERS — expose operations to the renderer via preload.js
// ═══════════════════════════════════════════════════════════════════════════════

// ── Journal path ──────────────────────────────────────────────────────────────
ipcMain.handle('get-journal-path', () => journalProvider.getJournalPath());

ipcMain.handle('save-journal-path', (_e, newPath) => {
  writeConfig({ journalPath: newPath || '' });
  return true;
});

ipcMain.handle('browse-journal-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Elite Dangerous Journal Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const chosen = result.filePaths[0];
  writeConfig({ journalPath: chosen });
  return chosen;
});

ipcMain.handle('open-journal-folder', async (_e, folderPath) => {
  const target = folderPath || journalProvider.getJournalPath();
  if (target) await shell.openPath(target);
});

// ── Config ────────────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => readConfig());
ipcMain.handle('save-config', (_e, patch) => { writeConfig(patch); return true; });

// ── Scan triggers ─────────────────────────────────────────────────────────────
ipcMain.handle('trigger-scan-all', () => { journalProvider.scanAll(); return true; });
ipcMain.handle('trigger-history-scan', () => { historyProvider.scan(); return true; });
ipcMain.handle('trigger-profile-refresh', () => { journalProvider.refreshProfile(); return true; });

// ── External links ────────────────────────────────────────────────────────────
ipcMain.handle('open-external', (_e, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

// ── EDSM discovery bulk check (history page) ─────────────────────────────────
ipcMain.handle('check-edsm-discovery-bulk', async (_e, systemNames) => {
  const results = [];
  for (const name of systemNames) {
    try {
      const url = `https://www.edsm.net/api-v1/system?systemName=${encodeURIComponent(name)}&showId=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        results.push({ systemName: name, discovered: !!(data && data.id) });
      } else {
        results.push({ systemName: name, discovered: null });
      }
    } catch {
      results.push({ systemName: name, discovered: null });
    }
    await new Promise(r => setTimeout(r, 150)); // respect EDSM rate limit
  }
  return results;
});

// ── EDSM flight log sync ──────────────────────────────────────────────────────
ipcMain.handle('edsm-sync-logs', (_e, localJumps) => edsmSyncService.syncFromEdsm(localJumps));

// ── ImportStars.txt import ────────────────────────────────────────────────────
// ImportStars.txt is an EDSM export of systems the commander was FIRST to
// discover and report. Every line is a system name. We import these as first-
// discovery stubs (wasDiscovered: false) and flag them with isImportedStar: true
// so the UI can show a distinct "imported first discovery" badge.
//
// De-duplication: if a system already exists in the local jump list we just
// ensure wasDiscovered is set to false on that entry (back-fill). If it's
// entirely new we create a stub entry. Either way the star icon is shown.
ipcMain.handle('import-stars-file', async (_e, localJumps) => {
  if (!mainWindow) return { success: false, error: 'No window' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your EDSM ImportStars.txt',
    filters: [
      { name: 'ImportStars Text File', extensions: ['txt'] },
      { name: 'All Files',             extensions: ['*']   },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || !result.filePaths.length) {
    return { success: false, canceled: true };
  }

  try {
    const fs  = require('fs');
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');

    // One system name per line; skip blanks and comment lines
    const importedNames = raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));

    if (!importedNames.length) {
      return { success: false, error: 'No system names found in file' };
    }

    // Index existing jumps by lowercase system name for O(1) lookup
    const existingByName = new Map();
    for (const j of (localJumps || [])) {
      if (j.system) existingByName.set(j.system.toLowerCase(), j);
    }

    const importedSet    = new Set(importedNames.map(n => n.toLowerCase()));
    let backFilled  = 0;
    let newStubs    = 0;

    // 1. Back-fill wasDiscovered + isImportedStar on existing entries
    const enriched = (localJumps || []).map(j => {
      if (j.system && importedSet.has(j.system.toLowerCase())) {
        const changed = j.wasDiscovered !== false || !j.isImportedStar;
        if (changed) backFilled++;
        return { ...j, wasDiscovered: false, isImportedStar: true };
      }
      return j;
    });

    // 2. Add stub entries for names not already in the jump list
    const stubs = importedNames
      .filter(name => !existingByName.has(name.toLowerCase()))
      .map(name => {
        newStubs++;
        return {
          system:        name,
          timestamp:     null,   // no timestamp — imported stubs
          jumpDist:      null,
          starClass:     null,
          bodyCount:     null,
          wasDiscovered: false,  // IS a first discovery — that's the whole point
          fromEdsm:      true,
          isImportedStar: true,  // show the special imported-star badge
        };
      });

    // Stubs go at the end (timestamp null sorts last)
    const merged = [...enriched, ...stubs];

    return {
      success:    true,
      imported:   importedNames.length,
      backFilled,
      newStubs,
      merged,
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

// ── Frontier cAPI ─────────────────────────────────────────────────────────────
ipcMain.handle('capi-login',       ()       => capiService.startOAuthLogin());
ipcMain.handle('capi-logout',      ()       => capiService.logout());
ipcMain.handle('capi-get-status',  ()       => capiService.getStatus());
ipcMain.handle('capi-get-profile', ()       => capiService.getProfile());
ipcMain.handle('capi-get-market',  (_e, id) => capiService.getMarket(id));

// ── Debug Log ─────────────────────────────────────────────────────────────────
ipcMain.handle('debug-get-log', () => {
  const { version } = require('./package.json');
  return logger.format({
    'App Ver': version,
    'Platform': `${process.platform} ${process.arch}`,
    'Electron': process.versions.electron,
    'Node':     process.versions.node,
  });
});

ipcMain.handle('debug-save-log', async () => {
  if (!mainWindow) return { success: false, error: 'No window' };

  const { version } = require('./package.json');
  const content = logger.format({
    'App Ver': version,
    'Platform': `${process.platform} ${process.arch}`,
    'Electron': process.versions.electron,
    'Node':     process.versions.node,
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog(mainWindow, {
    title:       'Save Debug Log',
    defaultPath: `elite-explorer-debug-${ts}.log`,
    filters: [
      { name: 'Log Files', extensions: ['log', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) return { success: false, canceled: true };

  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    logger.info('DEBUG-LOG', `Debug log saved to ${result.filePath}`);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    logger.error('DEBUG-LOG', 'Failed to save debug log', err);
    return { success: false, error: err.message };
  }
});
