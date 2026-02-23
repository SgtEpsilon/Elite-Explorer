'use strict';

/**
 * updaterService.js
 * -----------------
 * Wraps electron-updater and bridges update events to the renderer via IPC.
 *
 * Update channels:
 *   'stable'  — checks the main branch on GitHub (https://github.com/SgtEpsilon/Elite-Explorer)
 *               Downloads latest.yml, only non-prerelease builds.
 *   'beta'    — checks the development branch on GitHub (https://github.com/SgtEpsilon/Elite-Explorer/tree/development)
 *               Downloads beta.yml, includes pre-release builds.
 *
 * How GitHub releasing works with two channels:
 *   - Stable builds: tagged on main, electron-builder publishes latest.yml to the release assets.
 *   - Beta builds:   tagged on development, electron-builder publishes beta.yml to the release assets.
 *                    Run: electron-builder --publish always -c.publish.channel=beta
 *   autoUpdater.setFeedURL() switches which YAML manifest it fetches, so each
 *   channel only ever sees its own releases — stable users never get beta builds.
 *
 * Events pushed to renderer (channel: 'update-status'):
 *   { status: 'checking' }
 *   { status: 'available',     version, releaseNotes, channel }
 *   { status: 'not-available', version }
 *   { status: 'downloading',   percent, bytesPerSecond, transferred, total }
 *   { status: 'downloaded',    version, releaseNotes, installOnQuit, channel }
 *   { status: 'error',         message }
 *
 * IPC handlers exposed to renderer:
 *   'updater-check'              — manually trigger an update check
 *   'updater-download-now'       — download and immediately restart to install
 *   'updater-download-on-quit'   — download silently, install on next quit
 *   'updater-skip-version'       — persist skipped version, suppress future toasts
 *   'updater-install-restart'    — quit and install an already-downloaded update
 *   'updater-get-channel'        — returns current channel ('stable' | 'beta')
 *   'updater-set-channel'        — sets channel, saves to config, re-checks
 */

const { autoUpdater } = require('electron-updater');
const { ipcMain, app } = require('electron');
const path             = require('path');
const fs               = require('fs');

// ── GitHub repo coordinates ───────────────────────────────────────────────────
const GITHUB_OWNER = 'SgtEpsilon';
const GITHUB_REPO  = 'Elite-Explorer';

// ── Config helpers (inline to avoid circular dep with main.js) ────────────────
// Config is stored in userData (writable at runtime, even inside an asar).
// This must match the CONFIG_PATH used by main.js.
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function patchConfig(patch) {
  const cfg = readConfig();
  Object.assign(cfg, patch);
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch { /* ignore */ }
}

// ── Channel helpers ───────────────────────────────────────────────────────────
// 'stable' → reads latest.yml  from main-branch GitHub releases (non-prerelease only)
// 'beta'   → reads beta.yml    from development-branch GitHub releases (prerelease)
function getChannel() {
  return readConfig().updateChannel === 'beta' ? 'beta' : 'stable';
}

function applyChannel(channel) {
  const isBeta = channel === 'beta';

  // Point autoUpdater at the correct YAML manifest for this channel.
  // electron-updater fetches:  https://github.com/<owner>/<repo>/releases/latest/download/<channel>.yml
  // Stable publishes latest.yml;  beta builds publish beta.yml (via -c.publish.channel=beta).
  autoUpdater.setFeedURL({
    provider:        'github',
    owner:           GITHUB_OWNER,
    repo:            GITHUB_REPO,
    channel:         isBeta ? 'beta' : 'latest',
    releaseType:     isBeta ? 'prerelease' : 'release',
  });

  // Also set the flag so electron-updater won't filter out prerelease entries
  // when reading a beta manifest.
  autoUpdater.allowPrerelease = isBeta;

  console.log(`[updater] feed set → channel="${isBeta ? 'beta' : 'latest'}" allowPrerelease=${isBeta}`);
}

// ── Configuration ─────────────────────────────────────────────────────────────
autoUpdater.autoDownload         = false; // we control all downloads manually
autoUpdater.autoInstallOnAppQuit = false; // we set this per-choice
autoUpdater.logger               = null;  // suppress internal logs (we handle errors ourselves)

// Defer feed URL setup until app is ready — calling setFeedURL() before
// app.whenReady() can fail silently on some electron-updater versions.
app.whenReady().then(() => applyChannel(getChannel()));

// ── Skipped-version persistence ───────────────────────────────────────────────
// Stored in userData so it survives app updates/reinstalls correctly.
const SKIP_FILE = path.join(app.getPath('userData'), 'skipped-update.json');

function readSkipped() {
  try { return JSON.parse(fs.readFileSync(SKIP_FILE, 'utf8')); } catch { return {}; }
}
function writeSkipped(version) {
  fs.writeFileSync(SKIP_FILE, JSON.stringify({ version }), 'utf8');
}
function clearSkipped() {
  try { fs.unlinkSync(SKIP_FILE); } catch { /* ignore */ }
}

// ── Internal state ────────────────────────────────────────────────────────────
let mainWindow      = null;
let updateAvailable = null; // UpdateInfo once an update is found
let installOnQuit   = false; // tracks whether user chose "next launch"

// ── Helper: send a status payload to the renderer ─────────────────────────────
function send(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload);
  }
}

// ── autoUpdater event wiring ──────────────────────────────────────────────────
autoUpdater.on('checking-for-update', () => {
  send({ status: 'checking' });
});

autoUpdater.on('update-available', (info) => {
  // Silently skip if the user previously chose "skip this version"
  const skipped = readSkipped();
  if (skipped.version === info.version) {
    console.log(`[updater] skipping v${info.version} (user chose to skip)`);
    return;
  }

  updateAvailable = info;
  send({
    status:       'available',
    version:      info.version,
    releaseNotes: info.releaseNotes || '',
    channel:      getChannel(),
  });
});

autoUpdater.on('update-not-available', (info) => {
  updateAvailable = null;
  // If the current version is newer than the skipped one, clear the skip record
  const skipped = readSkipped();
  if (skipped.version && skipped.version !== info.version) clearSkipped();
  send({ status: 'not-available', version: info.version });
});

autoUpdater.on('download-progress', (progress) => {
  send({
    status:         'downloading',
    percent:        Math.round(progress.percent),
    bytesPerSecond: progress.bytesPerSecond,
    transferred:    progress.transferred,
    total:          progress.total,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  // Honor the user's choice about when to install
  autoUpdater.autoInstallOnAppQuit = installOnQuit;
  send({
    status:        'downloaded',
    version:       info.version,
    releaseNotes:  info.releaseNotes || '',
    installOnQuit,
    channel:       getChannel(),
  });
});

autoUpdater.on('error', (err) => {
  const msg = err ? (err.message || String(err)) : 'Unknown updater error';
  console.error('[updater]', msg);
  send({ status: 'error', message: msg, channel: getChannel() });
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Manual check (e.g. triggered from settings UI)
ipcMain.handle('updater-check', async () => {
  try { await autoUpdater.checkForUpdates(); }
  catch (err) { send({ status: 'error', message: err.message || String(err) }); }
});

// "Download and update now" — download then immediately restart
ipcMain.handle('updater-download-now', async () => {
  if (!updateAvailable) return;
  installOnQuit = false; // will call quitAndInstall manually after download
  try { await autoUpdater.downloadUpdate(); }
  catch (err) { send({ status: 'error', message: err.message || String(err) }); }
});

// "Download and update next launch" — download silently, install on quit
ipcMain.handle('updater-download-on-quit', async () => {
  if (!updateAvailable) return;
  installOnQuit = true;
  try { await autoUpdater.downloadUpdate(); }
  catch (err) { send({ status: 'error', message: err.message || String(err) }); }
});

// "Skip this version" — persist the decision so future checks are silent
ipcMain.handle('updater-skip-version', (_e, version) => {
  if (version) writeSkipped(version);
  updateAvailable = null;
});

// Restart and install (called from renderer after "downloaded" with installOnQuit=false)
ipcMain.handle('updater-install-restart', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Get current update channel
ipcMain.handle('updater-get-channel', () => getChannel());

// Set update channel — saves to config, re-applies feed URL, then re-checks
ipcMain.handle('updater-set-channel', async (_e, channel) => {
  const validated = channel === 'beta' ? 'beta' : 'stable';
  patchConfig({ updateChannel: validated });
  applyChannel(validated);
  console.log(`[updater] channel switched to "${validated}"`);
  // Trigger a fresh check so the user gets immediate feedback
  try { await autoUpdater.checkForUpdates(); } catch { /* ignore */ }
  return validated;
});

// ── Public API ────────────────────────────────────────────────────────────────
function setMainWindow(win) {
  mainWindow = win;
}

/**
 * Call once from main.js after the window is created.
 * Waits 5 seconds before the first check so startup is not slowed.
 * Rechecks automatically every 4 hours.
 */
function start(win) {
  if (win) mainWindow = win;

  const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] initial check failed:', err.message);
    });
  }, 5_000);

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] periodic check failed:', err.message);
    });
  }, CHECK_INTERVAL_MS);
}

module.exports = { start, setMainWindow };
