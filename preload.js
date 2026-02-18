const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  triggerScanAll: () => ipcRenderer.invoke('trigger-scan-all'),
  onScanAll:   (cb) => ipcRenderer.on('scan-all-journals', cb),
  onProgress:  (cb) => ipcRenderer.on('scan-progress', (e, data) => cb(data)),
  onCmdrData:  (cb) => ipcRenderer.on('cmdr-data', (e, data) => cb(data)),
  onLocation:  (cb) => ipcRenderer.on('location-data', (e, data) => cb(data)),
  // Window controls
  winMinimize:   () => ipcRenderer.invoke('win-minimize'),
  winMaximize:   () => ipcRenderer.invoke('win-maximize'),
  winClose:      () => ipcRenderer.invoke('win-close'),
  winIsMaximized:() => ipcRenderer.invoke('win-is-maximized'),
});
