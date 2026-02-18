const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const engine = require('./engine/core/engine');
const journalProvider = require('./engine/providers/journalProvider');
const api = require('./engine/api/server');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Provide mainWindow to journalProvider for progress reporting
  journalProvider.setMainWindow(mainWindow);

  // File menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Scan All Journals',
          click: async () => {
            // FIX: Run the scan here in the main process (Node.js side),
            // where journalProvider actually works.
            // We still send 'scan-all-journals' to the renderer so it knows scanning started.
            console.log('Scan All Journals clicked — starting scan in main process...');
            try {
              mainWindow.webContents.send('scan-all-journals');
              await journalProvider.readAllJournals();
              console.log('Scan All Journals completed.');
            } catch (err) {
              console.error('Error scanning all journals:', err);
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createWindow();
  engine.start();
  api.start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
