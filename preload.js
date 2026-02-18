const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Live + profile scan triggers
  triggerScanAll:    () => ipcRenderer.invoke('trigger-scan-all'),
  onScanAll:         (cb) => ipcRenderer.on('scan-all-journals', (_e, d) => cb(d)),
  onProgress:        (cb) => ipcRenderer.on('scan-progress',     (_e, d) => cb(d)),

  // Per-page data channels
  onLiveData:        (cb) => ipcRenderer.on('live-data',         (_e, d) => cb(d)),
  onProfileData:     (cb) => ipcRenderer.on('profile-data',      (_e, d) => cb(d)),

  // History — fully independent channel
  onHistoryData:         (cb) => ipcRenderer.on('history-data',         (_e, d) => cb(d)),
  onHistoryProgress:     (cb) => ipcRenderer.on('history-progress',     (_e, d) => cb(d)),
  onHistoryScanStart:    (cb) => ipcRenderer.on('history-scan-start',   (_e, d) => cb(d)),
  onHistoryPathMissing:  (cb) => ipcRenderer.on('history-path-missing', (_e, d) => cb(d)),
  triggerHistoryScan:    () => ipcRenderer.invoke('trigger-history-scan'),

  // Real-time location updates (fires on every FSDJump while game is running)
  onLocation:        (cb) => ipcRenderer.on('location-data',     (_e, d) => cb(d)),

  onJournalPathMissing: (cb) => ipcRenderer.on('journal-path-missing', (_e, p) => cb(p)),

  // Options
  getJournalPath:    () => ipcRenderer.invoke('get-journal-path'),
  saveJournalPath:   (p) => ipcRenderer.invoke('save-journal-path', p),
  browseJournalPath: () => ipcRenderer.invoke('browse-journal-path'),
  openJournalFolder: (p) => ipcRenderer.invoke('open-journal-folder', p),
});
