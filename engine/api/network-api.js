/**
 * network-api.js  —  Client-side electronAPI shim for network access
 * ───────────────────────────────────────────────────────────────────
 * Injected by the network server into every HTML page.  Provides the
 * same window.electronAPI surface that preload.js exposes in Electron,
 * but backed by fetch() (for invoke calls) and Server-Sent Events
 * (for push/event subscriptions).
 *
 * The SSE connection is opened once and shared across all callbacks.
 * Callers register via the on* methods exactly as they do in Electron.
 */

(function () {
  'use strict';

  // ── SSE ──────────────────────────────────────────────────────────────────
  const listeners = {}; // channel → [cb, cb, …]

  function onChannel(channel, cb) {
    if (!listeners[channel]) listeners[channel] = [];
    listeners[channel].push(cb);
  }

  function fireChannel(channel, data) {
    const cbs = listeners[channel] || [];
    cbs.forEach(cb => { try { cb(data); } catch {} });
  }

  function openSSE() {
    const es = new EventSource('/api/events');
    es.onmessage = function (e) {
      try {
        const { channel, data } = JSON.parse(e.data);
        fireChannel(channel, data);
      } catch {}
    };
    es.onerror = function () {
      es.close();
      setTimeout(openSSE, 3000);
    };
  }

  openSSE();

  // ── Polling — fetches /api/state every 3 s and fires callbacks on change ─
  // This ensures remote browsers stay current even if SSE events are missed
  // (e.g. the browser was backgrounded, or the SSE connection briefly dropped).
  const _lastState = {};

  function stateChanged(key, next) {
    const prev = _lastState[key];
    if (next === null || next === undefined) return false;
    const nextStr = JSON.stringify(next);
    if (nextStr === _lastState[key + '_str']) return false;
    _lastState[key + '_str'] = nextStr;
    return true;
  }

  async function pollState() {
    try {
      const res  = await fetch('/api/state');
      if (!res.ok) return;
      const s = await res.json();

      if (stateChanged('live',    s.liveData))    fireChannel('live-data',    s.liveData);
      if (stateChanged('profile', s.profileData)) fireChannel('profile-data', s.profileData);
      if (stateChanged('bodies',  s.bodiesData))  fireChannel('bodies-data',  s.bodiesData);
      if (stateChanged('history', s.historyData)) fireChannel('history-data', s.historyData);
      if (stateChanged('esystem', s.edsmSystem))  fireChannel('edsm-system',  s.edsmSystem);
      if (stateChanged('ebodies', s.edsmBodies))  fireChannel('edsm-bodies',  s.edsmBodies);
    } catch {}
  }

  // Initial fetch immediately on load, then every 3 seconds
  pollState();
  setInterval(pollState, 3000);

  // ── fetch helper ─────────────────────────────────────────────────────────
  async function api(endpoint, body) {
    const opts = body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' };
    const res = await fetch(endpoint, opts);
    return res.json();
  }

  // ── Expose window.electronAPI ────────────────────────────────────────────
  window.electronAPI = {

    // ── Push / event subscriptions ────────────────────────────────────────
    onLiveData:           cb => onChannel('live-data',           cb),
    onProfileData:        cb => onChannel('profile-data',        cb),
    onBodiesData:         cb => onChannel('bodies-data',         cb),
    onLocation:           cb => onChannel('location-data',       cb),
    onProgress:           cb => onChannel('scan-progress',       cb),
    onScanAll:            cb => onChannel('scan-all-journals',   cb),
    onJournalPathMissing: cb => onChannel('journal-path-missing', cb),

    onEdsmSystem:         cb => onChannel('edsm-system',         cb),
    onEdsmBodies:         cb => onChannel('edsm-bodies',         cb),
    onEdsmSyncProgress:   cb => onChannel('edsm-sync-progress',  cb),

    onEddnStatus:         cb => onChannel('eddn-status',         cb),

    onHistoryScanStart:   cb => onChannel('history-scan-start',  cb),
    onHistoryProgress:    cb => onChannel('history-progress',    cb),
    onHistoryData:        cb => onChannel('history-data',        cb),
    onHistoryPathMissing: cb => onChannel('history-path-missing', cb),

    onUpdateStatus:       cb => onChannel('update-status',       cb),
    onOpenPreferences:    cb => onChannel('open-preferences',    cb),

    // ── Invoke / request calls ────────────────────────────────────────────
    getJournalPath:    ()       => api('/api/get-journal-path').then(r => r.path),
    saveJournalPath:   p        => api('/api/save-journal-path', { path: p }),
    browseJournalPath: ()       => api('/api/browse-journal-path', {}).then(r => {
      if (r.__networkUnsupported) { alert(r.message); return null; }
      return r;
    }),
    openJournalFolder: p        => api('/api/open-journal-folder', { path: p }),

    getConfig:         ()       => api('/api/get-config'),
    saveConfig:        patch    => api('/api/save-config', patch),
    getNetworkInfo:    ()       => api('/api/get-network-info'),

    triggerScanAll:        ()   => api('/api/trigger-scan-all',     {}),
    triggerHistoryScan:    ()   => api('/api/trigger-history-scan', {}),
    triggerProfileRefresh: ()   => api('/api/trigger-profile-refresh', {}),

    // In network mode the browser handles external links natively
    openExternal: url => { if (url) window.open(url, '_blank', 'noopener'); return Promise.resolve(); },

    checkEdsmDiscoveryBulk: names  => api('/api/check-edsm-discovery-bulk', { systemNames: names }),
    edsmSyncLogs:           jumps  => api('/api/edsm-sync-logs',            { localJumps: jumps }),
    importStarsFile:        jumps  => api('/api/import-stars-file',         { localJumps: jumps }).then(r => {
      if (r.__networkUnsupported) { alert(r.message); return { success: false, canceled: true }; }
      return r;
    }),

    capiLogin:       ()   => api('/api/capi-login',       {}),
    capiLogout:      ()   => api('/api/capi-logout',      {}),
    capiGetStatus:   ()   => api('/api/capi-get-status'),
    capiGetProfile:  ()   => api('/api/capi-get-profile'),
    capiGetMarket:   id   => api('/api/capi-get-market',  { id }),

    // Auto-updater — gracefully stubbed (updates must be done on the host machine)
    checkForUpdates:      ()  => api('/api/updater-check',              {}),
    downloadUpdateNow:    ()  => api('/api/updater-download-now',       {}),
    downloadUpdateOnQuit: ()  => api('/api/updater-download-on-quit',   {}),
    skipVersion:          v   => api('/api/updater-skip-version',       { version: v }),
    installAndRestart:    ()  => api('/api/updater-install-restart',    {}),
    getUpdateChannel:     ()  => api('/api/updater-get-channel').then(r => r.channel),
    setUpdateChannel:     ch  => api('/api/updater-set-channel',        { channel: ch }),

    getDebugLog:  () => fetch('/api/debug-get-log').then(r => r.text()),
    saveDebugLog: () => api('/api/debug-save-log', {}).then(r => {
      if (r.__networkUnsupported) { alert(r.message); return { success: false, canceled: true }; }
      return r;
    }),
  };

  console.log('[EliteExplorer] Running in network mode — electronAPI shim active.');
})();
