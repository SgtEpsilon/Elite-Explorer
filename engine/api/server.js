const express = require('express');
const db = require('../db/database');

// Default kept in sync with ui/script.js, which hardcodes http://localhost:3721.
// If this ever needs to be user-configurable, thread it through main.js's live
// (userData) config the same way networkServerPort is — do not read config.json
// directly from here, since require('../../config.json') resolves to the
// bundled/packaged copy, not the live config the rest of the app reads/writes.
const DEFAULT_API_PORT = 3721;

function start(port) {
  const app = express();
  const listenPort = port || DEFAULT_API_PORT;

  app.get('/stats', (req, res) => {
    try {
      const row = db.get('SELECT COUNT(*) as count FROM personal_scans');
      res.json({ scans: row ? row.count : 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const server = app.listen(listenPort, () => console.log('API running on port', listenPort));

  // A failed listen() (e.g. EADDRINUSE from a leftover instance still running)
  // emits an 'error' event on the server object. Without this handler that
  // event is unhandled and crashes the entire Electron main process. Log it
  // and carry on instead — the REST API just won't be available this run.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`REST API: port ${listenPort} is already in use — is another copy of Elite Explorer already running? Skipping REST API startup.`);
    } else {
      console.error('REST API failed to start:', err);
    }
  });

  return server;
}

module.exports = { start };
