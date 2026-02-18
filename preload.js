const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Journal scans ──────────────────────────────────────────────────────────
  triggerScanAll:    () => ipcRenderer.invoke('trigger-scan-all'),
  onScanAll:         (cb) => ipcRenderer.on('scan-all-journals', (_e, d) => cb(d)),
  onProgress:        (cb) => ipcRenderer.on('scan-progress',     (_e, d) => cb(d)),

  // ── Per-page data ──────────────────────────────────────────────────────────
  onLiveData:        (cb) => ipcRenderer.on('live-data',     (_e, d) => cb(d)),
  onProfileData:     (cb) => ipcRenderer.on('profile-data',  (_e, d) => cb(d)),
  onLocation:        (cb) => ipcRenderer.on('location-data', (_e, d) => cb(d)),

  // ── History ────────────────────────────────────────────────────────────────
  onHistoryData:        (cb) => ipcRenderer.on('history-data',         (_e, d) => cb(d)),
  onHistoryProgress:    (cb) => ipcRenderer.on('history-progress',     (_e, d) => cb(d)),
  onHistoryScanStart:   (cb) => ipcRenderer.on('history-scan-start',   (_e, d) => cb(d)),
  onHistoryPathMissing: (cb) => ipcRenderer.on('history-path-missing', (_e, d) => cb(d)),
  triggerHistoryScan:   () => ipcRenderer.invoke('trigger-history-scan'),

  // ── EDSM ──────────────────────────────────────────────────────────────────
  onEdsmSystem:  (cb) => ipcRenderer.on('edsm-system',  (_e, d) => cb(d)),
  onEdsmBodies:  (cb) => ipcRenderer.on('edsm-bodies',  (_e, d) => cb(d)),

  // ── EDDN ──────────────────────────────────────────────────────────────────
  onEddnStatus:  (cb) => ipcRenderer.on('eddn-status',  (_e, d) => cb(d)),

  // ── External link (opens in system browser) ───────────────────────────────
  openExternal:  (url) => ipcRenderer.invoke('open-external', url),

  // ── Config (full read/write for EDDN + EDSM settings) ────────────────────
  getConfig:     () => ipcRenderer.invoke('get-config'),
  saveConfig:    (patch) => ipcRenderer.invoke('save-config', patch),

  // ── Journal path helpers ──────────────────────────────────────────────────
  onJournalPathMissing: (cb) => ipcRenderer.on('journal-path-missing', (_e, p) => cb(p)),
  getJournalPath:    () => ipcRenderer.invoke('get-journal-path'),
  saveJournalPath:   (p) => ipcRenderer.invoke('save-journal-path', p),
  browseJournalPath: () => ipcRenderer.invoke('browse-journal-path'),
  openJournalFolder: (p) => ipcRenderer.invoke('open-journal-folder', p),
});
