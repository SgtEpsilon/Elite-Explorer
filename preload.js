const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  triggerScanAll:    () => ipcRenderer.invoke('trigger-scan-all'),
  onScanAll:         (cb) => ipcRenderer.on('scan-all-journals', cb),
  onProgress:        (cb) => ipcRenderer.on('scan-progress', (e, data) => cb(data)),
  onCmdrData:        (cb) => ipcRenderer.on('cmdr-data', (e, data) => cb(data)),
  onLocation:        (cb) => ipcRenderer.on('location-data', (e, data) => cb(data)),
  onJournalPathMissing: (cb) => ipcRenderer.on('journal-path-missing', (e, p) => cb(p)),
  // Options
  getJournalPath:    () => ipcRenderer.invoke('get-journal-path'),
  saveJournalPath:   (p) => ipcRenderer.invoke('save-journal-path', p),
  browseJournalPath: () => ipcRenderer.invoke('browse-journal-path'),
  openJournalFolder: (p) => ipcRenderer.invoke('open-journal-folder', p),
});
