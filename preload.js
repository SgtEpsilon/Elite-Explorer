// preload.js
// ─────────────────────────────────────────────────────────────────────────────
// THE SECURE BRIDGE between the UI (index.html, history.html etc.) and main.js
//
// Electron runs two isolated worlds:
//   1. MAIN PROCESS  — full Node.js. Can access files, network, OS, etc.
//   2. RENDERER      — essentially a webpage, sandboxed for security.
//
// They cannot talk directly. This file runs in a special middle zone and uses
// contextBridge to expose ONLY the specific functions the UI is allowed to use.
// Think of it as a hotel reception desk — only approved calls get through.
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Journal scans ──────────────────────────────────────────────────────────
  triggerScanAll:    () => ipcRenderer.invoke('trigger-scan-all'),
  onScanAll:         (cb) => ipcRenderer.on('scan-all-journals', (_e, d) => cb(d)),
  onProgress:        (cb) => ipcRenderer.on('scan-progress',     (_e, d) => cb(d)),

  // ── Per-page live data ─────────────────────────────────────────────────────
  onLiveData:        (cb) => ipcRenderer.on('live-data',     (_e, d) => cb(d)),
  onProfileData:     (cb) => ipcRenderer.on('profile-data',  (_e, d) => cb(d)),
  onLocation:        (cb) => ipcRenderer.on('location-data', (_e, d) => cb(d)),

  // ── History ────────────────────────────────────────────────────────────────
  onHistoryData:        (cb) => ipcRenderer.on('history-data',         (_e, d) => cb(d)),
  onHistoryProgress:    (cb) => ipcRenderer.on('history-progress',     (_e, d) => cb(d)),
  onHistoryScanStart:   (cb) => ipcRenderer.on('history-scan-start',   (_e, d) => cb(d)),
  onHistoryPathMissing: (cb) => ipcRenderer.on('history-path-missing', (_e, d) => cb(d)),
  triggerHistoryScan:   () => ipcRenderer.invoke('trigger-history-scan'),

  // ── EDSM system info (live page) ───────────────────────────────────────────
  onEdsmSystem:  (cb) => ipcRenderer.on('edsm-system',  (_e, d) => cb(d)),
  onEdsmBodies:  (cb) => ipcRenderer.on('edsm-bodies',  (_e, d) => cb(d)),

  // ── Live bodies (journal Scan events) ─────────────────────────────────────
  // Fires after each Scan/SAASignalsFound/FSSBodySignals in the current session.
  // Payload: { system, bodies: [...], signals: { bodyName: ['Bio ×3', ...] } }
  onBodiesData:  (cb) => ipcRenderer.on('bodies-data',  (_e, d) => cb(d)),

  // ── NEW: EDSM Discovery Check ──────────────────────────────────────────────
  // Asks main.js to call EDSM's API to check if a system exists in their database.
  //
  // WHY in main and not the webpage?
  //   The renderer (webpage) can't make arbitrary https calls to external sites
  //   without relaxing Electron's Content Security Policy. The main process uses
  //   Node's built-in https module — zero CORS restrictions.
  //
  // Single system:
  //   Returns: { systemName, discovered: bool|null, error?: string }
  //     discovered = true  → EDSM has it (someone found it before you)
  //     discovered = false → EDSM has NO record = you likely found it first! ⭐
  //     discovered = null  → network/timeout error, unknown
  checkEdsmDiscovery: (systemName) =>
    ipcRenderer.invoke('check-edsm-discovery', systemName),

  // Bulk check — pass an array of names, get back an array of results.
  // Main staggers requests 150ms apart to be polite to EDSM's rate limits.
  checkEdsmDiscoveryBulk: (systemNames) =>
    ipcRenderer.invoke('check-edsm-discovery-bulk', systemNames),

  // ── EDDN ──────────────────────────────────────────────────────────────────
  onEddnStatus:  (cb) => ipcRenderer.on('eddn-status',  (_e, d) => cb(d)),

  // ── External links ─────────────────────────────────────────────────────────
  // Opens a URL in the user's REAL browser (Chrome/Firefox), NOT inside Electron.
  openExternal:  (url) => ipcRenderer.invoke('open-external', url),

  // ── Config ─────────────────────────────────────────────────────────────────
  getConfig:     () => ipcRenderer.invoke('get-config'),
  saveConfig:    (patch) => ipcRenderer.invoke('save-config', patch),

  // ── Journal path helpers ───────────────────────────────────────────────────
  onJournalPathMissing: (cb) => ipcRenderer.on('journal-path-missing', (_e, p) => cb(p)),
  getJournalPath:    () => ipcRenderer.invoke('get-journal-path'),
  saveJournalPath:   (p) => ipcRenderer.invoke('save-journal-path', p),
  browseJournalPath: () => ipcRenderer.invoke('browse-journal-path'),
  openJournalFolder: (p) => ipcRenderer.invoke('open-journal-folder', p),

  // ── NEW: Frontier Companion API (cAPI) ────────────────────────────────────
  // The cAPI gives live commander data straight from Frontier's servers:
  // credits, ship, ranks, location, market prices, etc.
  //
  // HOW IT WORKS (OAuth2):
  //   1. User clicks Login → capiLogin() fires
  //   2. A tiny local HTTP server starts on port 12345
  //   3. Frontier's login page opens in the user's real browser
  //   4. After login, Frontier redirects to localhost:12345/capi/callback
  //   5. The local server grabs the auth code, swaps it for access tokens
  //   6. Tokens are saved to config.json and auto-refreshed before expiry
  //
  // SETUP (one-time):
  //   1. Register at https://auth.frontierstore.net
  //   2. Set redirect URI: http://localhost:12345/capi/callback
  //   3. Add to config.json: "capiClientId": "your-client-id-here"

  // Start OAuth2 login (opens Frontier's site in browser, waits for callback)
  // Returns: { success: true } or { success: false, error: '...' }
  capiLogin:      () => ipcRenderer.invoke('capi-login'),

  // Clear saved tokens (log out)
  capiLogout:     () => ipcRenderer.invoke('capi-logout'),

  // Check auth state without any API calls
  // Returns: { hasClientId, isLoggedIn, tokenValid, tokenExpiry }
  capiGetStatus:  () => ipcRenderer.invoke('capi-get-status'),

  // Fetch commander profile from Frontier's servers
  // Returns: { success: true, data: { commander: { name, credits, rank... } } }
  //      or: { success: false, error: '...' }
  capiGetProfile: () => ipcRenderer.invoke('capi-get-profile'),

  // Receive cAPI data pushed from main (e.g. after auto-refresh)
  // Callback receives: { type: 'profile', data: { ... } }
  onCapiData:     (cb) => ipcRenderer.on('capi-data', (_e, d) => cb(d)),

  // -- EDSM flight log sync --
  // Pull complete flight log from EDSM and merge with local journal jumps.
  // Returns: { success, totalEdsm, newFromEdsm, totalMerged } or { success: false, error }
  // Merged jump list is pushed automatically via onHistoryData().
  edsmSyncLogs:       (journalJumps) => ipcRenderer.invoke('edsm-sync-logs', journalJumps),

  // Progress updates during sync — fires once per weekly batch.
  // Callback receives: { phase, batch, total, fetched }
  onEdsmSyncProgress: (cb) => ipcRenderer.on('edsm-sync-progress', (_e, d) => cb(d)),
});
