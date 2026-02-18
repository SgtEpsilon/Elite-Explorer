const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onScanAll: (callback) => ipcRenderer.on('scan-all-journals', callback),
  onProgress: (callback) => ipcRenderer.on('scan-progress', (event, data) => callback(data))
});
