'use strict';

/**
 * network-server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Serves the Elite Explorer UI over HTTP so any device on the local network
 * can access it in a browser.
 *
 * Architecture
 * ────────────
 *  • Static files: ui/ is served as-is, but HTML pages get a <script> tag
 *    injected that loads /network-api.js BEFORE the page's own scripts.
 *    This script polyfills window.electronAPI using fetch + SSE.
 *
 *  • REST endpoints: every ipcMain.handle() call is mirrored as an HTTP
 *    POST /api/<channel> endpoint.  The body is the first argument JSON-
 *    encoded, the response is the return value JSON-encoded.
 *
 *  • Server-Sent Events (/api/events): the browser connects once and
 *    receives a stream of { channel, data } objects for every push event
 *    that main.js would normally send via webContents.send().
 *    The network server patches mainWindow.webContents.send to also emit
 *    on the networkBus, which then writes to all open SSE connections.
 *
 *  • Features that require Electron GUI (browse-journal-path,
 *    import-stars-file, debug-save-log, open-journal-folder) are handled
 *    gracefully: browse/import return a "not supported" response and the
 *    client shim surfaces a user-friendly message.
 */

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const networkBus = require('./networkBus');

// ── Lazy references set by start() ───────────────────────────────────────────
let _mainWindow         = null;
let _journalProvider    = null;
let _historyProvider    = null;
let _edsmSyncService    = null;
let _edsmClient         = null;
let _capiService        = null;
let _readConfig         = null;
let _writeConfig        = null;
let _logger             = null;
let _port               = 3722;

// ── SSE client registry ───────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(channel, data) {
  const payload = `data: ${JSON.stringify({ channel, data })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// Hook networkBus → SSE broadcast
networkBus.on('push', ({ channel, data }) => broadcastSSE(channel, data));

// ── Patch webContents.send so push events reach SSE clients ──────────────────
function patchWebContents(win) {
  if (!win || !win.webContents) return;
  const original = win.webContents.send.bind(win.webContents);
  win.webContents.send = function (channel, ...args) {
    original(channel, ...args);                          // still works in Electron
    networkBus.emit('push', { channel, data: args[0] }); // also goes to SSE
  };
}

// ── Helper: get local network IPs ─────────────────────────────────────────────
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

// ── HTML injection: insert network-api.js as first script ────────────────────
function injectNetworkApiScript(html) {
  // Inject right after <head> (or at start of <body> as fallback)
  const tag = '<script src="/network-api.js"></script>\n';
  if (html.includes('<head>')) return html.replace('<head>', '<head>\n' + tag);
  if (html.includes('<head ')) return html.replace(/<head[^>]*>/, m => m + '\n' + tag);
  return tag + html;
}

// ── Build Express app ─────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const uiDir = path.join(__dirname, '..', '..', 'ui');

  // ── Serve network-api.js from the engine/api directory ───────────────────
  app.get('/network-api.js', (_req, res) => {
    res.sendFile(path.join(__dirname, 'network-api.js'));
  });

  // ── SSE endpoint ──────────────────────────────────────────────────────────
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Send a heartbeat comment every 25 s to keep the connection alive
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
    }, 25_000);

    sseClients.add(res);
    if (_logger) _logger.info('NETWORK', `SSE client connected (${sseClients.size} total)`);

    // Replay cached data immediately so the new client gets current state
    if (_journalProvider && typeof _journalProvider.replayToPage === 'function') {
      try { _journalProvider.replayToPage(); } catch {}
    }
    if (_historyProvider && typeof _historyProvider.replayToPage === 'function') {
      try { _historyProvider.replayToPage(); } catch {}
    }

    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
      if (_logger) _logger.info('NETWORK', `SSE client disconnected (${sseClients.size} total)`);
    });
  });

  // ── State snapshot — returns all current cached data in one request ──────
  // Polled by the network-api.js shim every few seconds to keep remote
  // browsers up to date without relying solely on SSE push events.
  app.get('/api/state', (_req, res) => {
    try {
      const journal = _journalProvider ? _journalProvider.getCache() : {};
      const history = _historyProvider ? _historyProvider.getCache() : {};
      const edsm    = _edsmClient      ? _edsmClient.getCache()      : {};
      res.json({
        liveData:    journal.liveData    || null,
        profileData: journal.profileData || null,
        bodiesData:  journal.bodiesData  || null,
        historyData: history.jumps       || null,
        edsmSystem:  edsm.system         || null,
        edsmBodies:  edsm.bodies         || null,
        ts: Date.now(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/get-config', (_req, res) => {
    try { res.json(_readConfig()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/save-config', (req, res) => {
    try { res.json(_writeConfig(req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/get-network-info', (_req, res) => {
    try {
      const cfg = _readConfig();
      const ifaces = os.networkInterfaces();
      const ips = [];
      for (const iface of Object.values(ifaces)) {
        for (const addr of iface) {
          if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
        }
      }
      res.json({ enabled: !!cfg.networkServerEnabled, port: cfg.networkServerPort || 3722, ips });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/get-journal-path', (_req, res) => {
    try { res.json({ path: _journalProvider.getJournalPath() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/save-journal-path', (req, res) => {
    try {
      _writeConfig({ journalPath: req.body.path || '' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // browse-journal-path requires a native dialog — not supported remotely
  app.post('/api/browse-journal-path', (_req, res) => {
    res.json({ __networkUnsupported: true, message: 'Directory browsing is only available in the desktop app.' });
  });

  // open-journal-folder — silently no-op remotely
  app.post('/api/open-journal-folder', (_req, res) => {
    res.json({ __networkUnsupported: true, message: 'Opening folders is only available in the desktop app.' });
  });

  app.post('/api/trigger-scan-all', (_req, res) => {
    try { _journalProvider.scanAll(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/trigger-history-scan', (_req, res) => {
    try { _historyProvider.scan(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/trigger-profile-refresh', (_req, res) => {
    try { _journalProvider.refreshProfile(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // open-external — no-op in network mode (browser handles links natively)
  app.post('/api/open-external', (req, res) => {
    res.json({ ok: true, url: req.body.url });
  });

  app.post('/api/check-edsm-discovery-bulk', async (req, res) => {
    const systemNames = req.body.systemNames || [];
    const results = [];
    for (const name of systemNames) {
      try {
        const url = `https://www.edsm.net/api-v1/system?systemName=${encodeURIComponent(name)}&showId=1`;
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const data = await r.json();
          results.push({ systemName: name, discovered: !!(data && data.id) });
        } else {
          results.push({ systemName: name, discovered: null });
        }
      } catch {
        results.push({ systemName: name, discovered: null });
      }
      await new Promise(r => setTimeout(r, 150));
    }
    res.json(results);
  });

  app.post('/api/edsm-sync-logs', async (req, res) => {
    try {
      const result = await _edsmSyncService.syncFromEdsm(req.body.localJumps || []);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // import-stars-file requires a file dialog — not supported remotely
  app.post('/api/import-stars-file', (_req, res) => {
    res.json({ __networkUnsupported: true, success: false, message: 'File import is only available in the desktop app.' });
  });

  // cAPI endpoints
  app.post('/api/capi-login',       async (_req, res) => { try { res.json(await _capiService.startOAuthLogin()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/capi-logout',      async (_req, res) => { try { res.json(await _capiService.logout());           } catch (e) { res.status(500).json({ error: e.message }); } });
  app.get( '/api/capi-get-status',  async (_req, res) => { try { res.json(await _capiService.getStatus());        } catch (e) { res.status(500).json({ error: e.message }); } });
  app.get( '/api/capi-get-profile', async (_req, res) => { try { res.json(await _capiService.getProfile());       } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/api/capi-get-market',  async (req, res)  => { try { res.json(await _capiService.getMarket(req.body.id)); } catch (e) { res.status(500).json({ error: e.message }); } });

  // Debug log
  app.get('/api/debug-get-log', (_req, res) => {
    try {
      const { version } = require('../../package.json');
      res.type('text/plain').send(_logger.format({ 'App Ver': version, Source: 'network-server' }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // debug-save-log — not supported remotely (no save dialog)
  app.post('/api/debug-save-log', (_req, res) => {
    res.json({ __networkUnsupported: true, success: false, message: 'Saving log files is only available in the desktop app.' });
  });

  // ── Updater stubs (no-op in network mode) ────────────────────────────────
  app.get( '/api/updater-get-channel', (_req, res) => res.json({ channel: 'stable' }));
  app.post('/api/updater-set-channel', (_req, res) => res.json({ ok: true }));
  app.post('/api/updater-check',       (_req, res) => res.json({ ok: true }));
  app.post('/api/updater-download-now',       (_req, res) => res.json({ ok: true }));
  app.post('/api/updater-download-on-quit',   (_req, res) => res.json({ ok: true }));
  app.post('/api/updater-skip-version',       (_req, res) => res.json({ ok: true }));
  app.post('/api/updater-install-restart',    (_req, res) => res.json({ ok: true }));

  // ── Existing REST stats endpoint (keep as-is) ────────────────────────────
  const db = require('../db/database');
  app.get('/stats', (_req, res) => {
    try {
      const row = db.get('SELECT COUNT(*) as count FROM personal_scans');
      res.json({ scans: row ? row.count : 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Static UI — HTML files get the network-api.js injection ─────────────
  app.use((req, res, next) => {
    const filePath = path.join(uiDir, req.path === '/' ? 'index.html' : req.path);
    if (filePath.endsWith('.html') && fs.existsSync(filePath)) {
      try {
        const html = fs.readFileSync(filePath, 'utf8');
        res.type('html').send(injectNetworkApiScript(html));
      } catch { next(); }
    } else {
      next();
    }
  });

  app.use(express.static(uiDir));

  // Catch-all → index.html (SPA fallback)
  app.get('*', (_req, res) => {
    const index = path.join(uiDir, 'index.html');
    if (fs.existsSync(index)) {
      const html = fs.readFileSync(index, 'utf8');
      res.type('html').send(injectNetworkApiScript(html));
    } else {
      res.status(404).send('Not found');
    }
  });

  return app;
}

// ── Public API ────────────────────────────────────────────────────────────────
function start({ mainWindow, journalProvider, historyProvider, edsmSyncService,
                 edsmClient, capiService, readConfig, writeConfig, logger, port = 3722 }) {
  _mainWindow      = mainWindow;
  _journalProvider = journalProvider;
  _historyProvider = historyProvider;
  _edsmSyncService = edsmSyncService;
  _edsmClient      = edsmClient;
  _capiService     = capiService;
  _readConfig      = readConfig;
  _writeConfig     = writeConfig;
  _logger          = logger;
  _port            = port;

  patchWebContents(mainWindow);

  const app = buildApp();
  app.listen(port, '0.0.0.0', () => {
    const ips = getLocalIPs();
    if (logger) {
      logger.info('NETWORK', `UI network server running on port ${port}`);
      logger.info('NETWORK', `Access from other devices:`);
      for (const ip of ips) logger.info('NETWORK', `  http://${ip}:${port}`);
    }
    console.log(`\n🌐 Elite Explorer network UI available at:`);
    for (const ip of ips) console.log(`   http://${ip}:${port}`);
    console.log('');
  });
}

module.exports = { start };
