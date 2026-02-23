'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// ── Helper: register a one-way IPC listener ───────────────────────────────────
function on(channel, cb) {
  ipcRenderer.on(channel, (_event, data) => cb(data));
}

// ── electronAPI — the bridge the renderer scripts use ────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {

  // ── Inbound: main → renderer (push / events) ─────────────────────────────
  onLiveData:           (cb) => on('live-data',             cb),
  onProfileData:        (cb) => on('profile-data',          cb),
  onBodiesData:         (cb) => on('bodies-data',           cb),
  onLocation:           (cb) => on('location-data',         cb),
  onProgress:           (cb) => on('scan-progress',         cb),
  onScanAll:            (cb) => on('scan-all-journals',     cb),
  onJournalPathMissing: (cb) => on('journal-path-missing',  cb),

  // EDSM
  onEdsmSystem:         (cb) => on('edsm-system',           cb),
  onEdsmBodies:         (cb) => on('edsm-bodies',           cb),
  onEdsmSyncProgress:   (cb) => on('edsm-sync-progress',    cb),

  // EDDN
  onEddnStatus:         (cb) => on('eddn-status',           cb),

  // History
  onHistoryScanStart:   (cb) => on('history-scan-start',    cb),
  onHistoryProgress:    (cb) => on('history-progress',      cb),
  onHistoryData:        (cb) => on('history-data',          cb),
  onHistoryPathMissing: (cb) => on('history-path-missing',  cb),

  // ── Outbound: renderer → main (invoke / request) ─────────────────────────
  getJournalPath:    ()          => ipcRenderer.invoke('get-journal-path'),
  saveJournalPath:   (p)         => ipcRenderer.invoke('save-journal-path',      p),
  browseJournalPath: ()          => ipcRenderer.invoke('browse-journal-path'),
  openJournalFolder: (p)         => ipcRenderer.invoke('open-journal-folder',    p),

  getConfig:         ()          => ipcRenderer.invoke('get-config'),
  saveConfig:        (patch)     => ipcRenderer.invoke('save-config',            patch),
  getNetworkInfo:    ()          => ipcRenderer.invoke('get-network-info'),

  triggerScanAll:    ()          => ipcRenderer.invoke('trigger-scan-all'),
  triggerHistoryScan:()          => ipcRenderer.invoke('trigger-history-scan'),
  triggerProfileRefresh: ()      => ipcRenderer.invoke('trigger-profile-refresh'),

  openExternal:      (url)       => ipcRenderer.invoke('open-external',          url),

  // EDSM
  checkEdsmDiscoveryBulk: (names) => ipcRenderer.invoke('check-edsm-discovery-bulk', names),
  edsmSyncLogs:      (jumps)     => ipcRenderer.invoke('edsm-sync-logs',         jumps),
  importStarsFile:   (jumps)     => ipcRenderer.invoke('import-stars-file',      jumps),

  // cAPI
  capiLogin:         ()          => ipcRenderer.invoke('capi-login'),
  capiLogout:        ()          => ipcRenderer.invoke('capi-logout'),
  capiGetStatus:     ()          => ipcRenderer.invoke('capi-get-status'),
  capiGetProfile:    ()          => ipcRenderer.invoke('capi-get-profile'),
  capiGetMarket:     (id)        => ipcRenderer.invoke('capi-get-market',        id),

  // Auto-updater
  onUpdateStatus:      (cb)      => on('update-status', cb),
  checkForUpdates:     ()        => ipcRenderer.invoke('updater-check'),
  downloadUpdateNow:   ()        => ipcRenderer.invoke('updater-download-now'),
  downloadUpdateOnQuit:()        => ipcRenderer.invoke('updater-download-on-quit'),
  skipVersion:         (version) => ipcRenderer.invoke('updater-skip-version', version),
  installAndRestart:   ()        => ipcRenderer.invoke('updater-install-restart'),
  getUpdateChannel:    ()        => ipcRenderer.invoke('updater-get-channel'),
  setUpdateChannel:    (ch)      => ipcRenderer.invoke('updater-set-channel', ch),

  // Preferences: direct push when already on index.html
  onOpenPreferences:   (cb)      => {
    ipcRenderer.removeAllListeners('open-preferences');
    ipcRenderer.on('open-preferences', function () { cb(); });
  },

  // Debug log
  getDebugLog:         ()        => ipcRenderer.invoke('debug-get-log'),
  getDebugEntries:     ()        => ipcRenderer.invoke('debug-get-entries'),
  saveDebugLog:        ()        => ipcRenderer.invoke('debug-save-log'),
});
