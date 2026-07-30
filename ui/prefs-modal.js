/**
 * prefs-modal.js — Preferences modal, shared across all pages.
 *
 * Injected into every page via <script src="prefs-modal.js"></script>.
 * Dynamically inserts its own HTML so no page needs to carry the markup.
 *
 * Opens via:
 *   1. window.electronAPI.onOpenPreferences IPC push from main.js
 *   2. A "Preferences…" button auto-injected into #options-panel
 *   3. window.dispatchEvent(new CustomEvent('open-preferences'))
 */
(function () {
  'use strict';

  // ── 1. Inject modal HTML ────────────────────────────────────────────────────
  var html = [
    '<div id="prefs-overlay" style="display:none;position:fixed;inset:0;z-index:9980;background:rgba(0,0,0,0.65);backdrop-filter:blur(3px);"></div>',

    '<div id="prefs-modal" style="',
      'display:none;position:fixed;z-index:9989;',
      'top:50%;left:50%;transform:translate(-50%,-50%);',
      'width:480px;max-width:calc(100vw - 32px);max-height:calc(100vh - 48px);',
      'background:linear-gradient(160deg,#0b1a30 0%,#091220 100%);',
      'border:1px solid #1e3f6a;border-radius:14px;',
      'padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.8),0 0 0 1px rgba(100,180,255,0.06);',
      'font-family:inherit;color:#c8d8f0;font-size:0.88em;box-sizing:border-box;',
      'flex-direction:column;',
    '">',

      // Header (fixed, not part of scroll area)
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-shrink:0;">',
        '<div style="display:flex;align-items:center;gap:10px;">',
          '<span style="font-size:1.4em;">\u2699\ufe0f</span>',
          '<span style="font-weight:700;color:#7eb8f7;font-size:1.1em;">Preferences</span>',
        '</div>',
        '<button id="prefs-close" style="background:none;border:none;color:#3a5a7a;cursor:pointer;font-size:1.3em;padding:0;line-height:1;" title="Close">\u2715</button>',
      '</div>',

      // Scrollable body — everything between header and footer
      '<div id="prefs-scroll-body" style="overflow-y:auto;padding-right:6px;margin:0 -6px 4px 0;flex:1 1 auto;min-height:0;">',

      // ── Section: Connections & Data (Network / EDDN / EDSM / cAPI / Inara / Journal Folder) ──
      '<div style="margin-bottom:20px;">',
        '<div style="font-size:0.78em;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#4a6a8a;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #0e2040;">Connections &amp; Data</div>',

        // Network UI Server
        '<div class="opt-section" style="margin-bottom:16px;">',
          '<div class="opt-section-title">Network UI Server</div>',
          '<label class="opt-toggle" style="margin-bottom:8px;">',
            '<input type="checkbox" id="opt-network-enabled">',
            '<span class="tog-track"><span class="tog-thumb"></span></span>',
            '<span class="tog-lbl">Enable network UI server</span>',
          '</label>',
          '<div class="opt-hint">Serves the Elite Explorer UI over HTTP so any device on your local network can access it in a browser. Restart the app after changing this setting.</div>',
          '<div style="margin-top:8px;">',
            '<label style="font-size:0.72em;color:var(--text-dim);display:block;margin-bottom:3px;">Port <span style="opacity:0.5">(default: 3722)</span></label>',
            '<input class="opt-input" id="opt-network-port" type="number" min="1024" max="65535" placeholder="3722" spellcheck="false" style="width:120px;"/>',
          '</div>',
          '<div id="opt-network-urls" style="margin-top:8px;font-size:0.72em;color:var(--text-dim);display:none;"></div>',
          '<button class="opt-action-btn" id="opt-network-save-btn" style="margin-top:10px;">',
            '<span class="opt-btn-icon">&#10003;</span>',
            '<div><div class="opt-btn-label">Save Network Settings</div><div class="opt-btn-sub" id="opt-network-hint">Restart required to apply changes</div></div>',
          '</button>',
        '</div>',

        // EDDN
        '<div class="opt-section" style="margin-bottom:16px;">',
          '<div class="opt-section-title">EDDN &#8212; Data Network</div>',
          '<label class="opt-toggle" style="margin-bottom:8px;">',
            '<input type="checkbox" id="opt-eddn-enabled">',
            '<span class="tog-track"><span class="tog-thumb"></span></span>',
            '<span class="tog-lbl">Submit events to EDDN</span>',
          '</label>',
          '<div class="opt-hint">Shares jump, scan &amp; dock events with the community network. Your commander name is used as the uploader ID.</div>',
          '<div style="margin-top:8px;">',
            '<label style="font-size:0.72em;color:var(--text-dim);display:block;margin-bottom:3px;">Commander Name (uploader ID)</label>',
            '<input class="opt-input" id="opt-cmdr-name" type="text" placeholder="Your in-game commander name" spellcheck="false"/>',
          '</div>',
        '</div>',

        // EDSM
        '<div class="opt-section" style="margin-bottom:16px;">',
          '<div class="opt-section-title">EDSM &#8212; Star Map</div>',
          '<label class="opt-toggle" style="margin-bottom:8px;">',
            '<input type="checkbox" id="opt-edsm-enabled">',
            '<span class="tog-track"><span class="tog-thumb"></span></span>',
            '<span class="tog-lbl">Fetch system data from EDSM</span>',
          '</label>',
          '<div class="opt-hint">Displays security, allegiance, population and enables the EDSM link for each system you visit. No account required for lookups.</div>',
          '<div style="margin-top:8px;">',
            '<label style="font-size:0.72em;color:var(--text-dim);display:block;margin-bottom:3px;">EDSM Commander Name <span style="opacity:0.5">(optional &#8212; for flight log sync)</span></label>',
            '<input class="opt-input" id="opt-edsm-cmdr" type="text" placeholder="Your EDSM commander name" spellcheck="false"/>',
          '</div>',
          '<div style="margin-top:6px;">',
            '<label style="font-size:0.72em;color:var(--text-dim);display:block;margin-bottom:3px;">EDSM API Key <span style="opacity:0.5">(optional &#8212; from edsm.net/en/settings/api)</span></label>',
            '<input class="opt-input" id="opt-edsm-key" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" spellcheck="false"/>',
          '</div>',
          '<button class="opt-action-btn" id="opt-save-api-btn" style="margin-top:10px;">',
            '<span class="opt-btn-icon">&#10003;</span>',
            '<div><div class="opt-btn-label">Save API Settings</div><div class="opt-btn-sub" id="opt-api-hint">Changes take effect immediately</div></div>',
          '</button>',
        '</div>',

        // Frontier cAPI
        '<div class="opt-section" style="margin-bottom:16px;">',
          '<div class="opt-section-title">Frontier cAPI &#8212; Companion API</div>',
          '<div class="opt-hint" style="margin-bottom:8px;">Connects to Frontier\u2019s servers directly for exact credits, fleet carrier, community goals, and last-docked station market/outfitting data. Just log in with your Frontier/Steam/Xbox/PSN account below.</div>',
          '<div style="display:flex;align-items:center;gap:8px;margin-top:10px;">',
            '<span id="capi-dot" style="width:8px;height:8px;border-radius:50%;background:var(--border2);display:inline-block;flex-shrink:0;"></span>',
            '<span id="capi-status-label" style="font-size:0.75em;font-family:var(--mono);color:var(--text-mute);">NOT AUTHENTICATED</span>',
            '<span id="capi-cmdr-badge" style="display:none;font-size:0.72em;color:var(--text-dim);"></span>',
          '</div>',
          '<div id="capi-expiry-row" style="display:none;font-size:0.7em;color:var(--text-mute);margin-top:4px;">Token expires: <span id="capi-expiry-val">&#8212;</span></div>',
          '<button class="opt-action-btn" id="capi-login-btn" style="margin-top:10px;">',
            '<span class="opt-btn-icon">&#8594;</span>',
            '<div><div class="opt-btn-label">Log in with Frontier</div><div class="opt-btn-sub" id="capi-login-sub">Opens Frontier auth in your browser</div></div>',
          '</button>',
          '<button class="opt-action-btn" id="capi-logout-btn" style="margin-top:6px;display:none;">',
            '<span class="opt-btn-icon">&#10005;</span>',
            '<div><div class="opt-btn-label">Log Out</div><div class="opt-btn-sub">Clears saved cAPI tokens</div></div>',
          '</button>',
          '<button class="opt-action-btn" id="capi-refresh-btn" style="margin-top:6px;">',
            '<span class="opt-btn-icon">&#8635;</span>',
            '<div><div class="opt-btn-label">Refresh cAPI Data Now</div><div class="opt-btn-sub" id="capi-refresh-sub">Fetch profile, fleet carrier &amp; community goals</div></div>',
          '</button>',
        '</div>',

        // Inara
        '<div class="opt-section" style="margin-bottom:16px;">',
          '<div class="opt-section-title">Inara &#8212; Commander Profile</div>',
          '<div style="font-size:0.78em;color:var(--text-mute);margin-bottom:8px;line-height:1.5;">Syncs your CMDR profile from Inara every 5 minutes.</div>',
          '<div style="margin-top:6px;">',
            '<label style="font-size:0.72em;color:var(--text-dim);display:block;margin-bottom:3px;">CMDR Name Override <span style="opacity:0.5">(only if different from in-game name)</span></label>',
            '<input class="opt-input" id="opt-inara-cmdr-name" type="text" placeholder="Your Inara display name" spellcheck="false"/>',
          '</div>',
          '<button class="opt-action-btn" id="opt-inara-save-btn" style="margin-top:10px;">',
            '<span class="opt-btn-icon">&#10003;</span>',
            '<div><div class="opt-btn-label">Save Inara Settings</div><div class="opt-btn-sub" id="opt-inara-save-status">Save API key and sync now</div></div>',
          '</button>',
          '<button class="opt-action-btn" id="opt-inara-sync-now-btn" style="margin-top:6px;">',
            '<span class="opt-btn-icon">&#8635;</span>',
            '<div><div class="opt-btn-label">Sync Now</div><div class="opt-btn-sub" id="opt-inara-sync-status">Manually trigger an Inara profile sync</div></div>',
          '</button>',
        '</div>',

        // Journal Folder
        '<div class="opt-section">',
          '<div class="opt-section-title">Journal Folder</div>',
          '<div class="opt-path-row">',
            '<input class="opt-input" id="opt-journal-path" type="text" placeholder="Auto-detected" spellcheck="false"/>',
            '<button class="opt-icon-btn" id="opt-browse-btn" title="Browse">&#9645;</button>',
            '<button class="opt-icon-btn" id="opt-open-btn" title="Open in Explorer">&#8599;</button>',
          '</div>',
          '<div class="opt-hint" id="opt-path-hint">Leave blank to use the default path for your OS</div>',
        '</div>',
      '</div>',

      // Section: Updates
      '<div style="margin-bottom:20px;">',
        '<div style="font-size:0.78em;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#4a6a8a;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #0e2040;">Software Updates</div>',
        '<div style="margin-bottom:14px;">',
          '<div style="font-weight:600;color:#a0c0e8;margin-bottom:4px;">Update Channel</div>',
          '<div style="color:#5a7a9a;font-size:0.88em;margin-bottom:10px;line-height:1.5;">Choose whether you want stable releases or early access to new features.</div>',
          '<div style="display:flex;flex-direction:column;gap:8px;">',

            // Stable
            '<label id="pref-ch-stable-label" style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border-radius:8px;border:2px solid #1e3f6a;cursor:pointer;background:#060f1e;transition:border-color .15s;">',
              '<input type="radio" name="prefs-update-channel" value="stable" id="pref-ch-stable" style="margin-top:2px;accent-color:#7eb8f7;">',
              '<div>',
                '<div style="font-weight:600;color:#c8d8f0;display:flex;align-items:center;gap:6px;">\ud83d\udee1\ufe0f Stable <span style="font-size:0.72em;padding:2px 7px;border-radius:20px;font-weight:600;background:#1a2a1a;color:#4caf82;border:1px solid #2a4a2a;">Recommended</span></div>',
                '<div style="font-size:0.85em;color:#5a7a9a;margin-top:2px;line-height:1.4;">Tracks the <code style="color:#7eb8f7;background:#0a1830;padding:1px 4px;border-radius:3px;">main</code> branch. Tested, reliable builds only.</div>',
              '</div>',
            '</label>',

            // Beta
            '<label id="pref-ch-beta-label" style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border-radius:8px;border:2px solid #1e3f6a;cursor:pointer;background:#060f1e;transition:border-color .15s;">',
              '<input type="radio" name="prefs-update-channel" value="beta" id="pref-ch-beta" style="margin-top:2px;accent-color:#f0a030;">',
              '<div>',
                '<div style="font-weight:600;color:#c8d8f0;display:flex;align-items:center;gap:6px;">\ud83e\uddea Alpha / Beta <span style="font-size:0.72em;padding:2px 7px;border-radius:20px;font-weight:600;background:#2a1a0a;color:#f0a030;border:1px solid #4a3010;">Early Access</span></div>',
                '<div style="font-size:0.85em;color:#5a7a9a;margin-top:2px;line-height:1.4;">Tracks the <code style="color:#f0a030;background:#0a1830;padding:1px 4px;border-radius:3px;">development</code> branch. New features, may be unstable.</div>',
              '</div>',
            '</label>',

          '</div>',
        '</div>',
        '<div id="pref-channel-status" style="font-size:0.82em;color:#4a6a8a;min-height:1.4em;margin-top:2px;"></div>',
      '</div>',

      // Section: Debug Log
      '<div style="margin-bottom:20px;">',
        '<div style="font-size:0.78em;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#4a6a8a;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #0e2040;">Debug &amp; Diagnostics</div>',

        // Filter bar
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;">',
          '<span style="font-size:0.78em;color:#4a6a8a;margin-right:2px;">Filter:</span>',
          '<button class="prefs-lvl-btn" data-level="ALL"  style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.75em;font-weight:600;border:1px solid #1e3f6a;background:#0d1f35;color:#7eb8f7;">ALL</button>',
          '<button class="prefs-lvl-btn" data-level="ERROR" style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.75em;font-weight:600;border:1px solid #1e3f6a;background:#0d1f35;color:#f05050;">ERROR</button>',
          '<button class="prefs-lvl-btn" data-level="WARN"  style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.75em;font-weight:600;border:1px solid #1e3f6a;background:#0d1f35;color:#f0a030;">WARN</button>',
          '<button class="prefs-lvl-btn" data-level="INFO"  style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.75em;font-weight:600;border:1px solid #1e3f6a;background:#0d1f35;color:#4caf82;">INFO</button>',
          '<button class="prefs-lvl-btn" data-level="DEBUG" style="padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.75em;font-weight:600;border:1px solid #1e3f6a;background:#0d1f35;color:#5a9abf;">DEBUG</button>',
          '<span id="prefs-log-count" style="margin-left:auto;font-size:0.75em;color:#3a5a7a;"></span>',
        '</div>',

        // Action buttons
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">',
          '<button id="prefs-view-log" style="padding:6px 14px;border-radius:6px;cursor:pointer;font-size:0.85em;font-weight:600;background:#0d1f35;color:#7eb8f7;border:1px solid #1e3a5f;">&#128269; View Log</button>',
          '<button id="prefs-refresh-log" style="padding:6px 14px;border-radius:6px;cursor:pointer;font-size:0.85em;font-weight:600;background:#0d1f35;color:#5a9abf;border:1px solid #1a3050;display:none;">&#8635; Refresh</button>',
          '<button id="prefs-save-log" style="padding:6px 14px;border-radius:6px;cursor:pointer;font-size:0.85em;font-weight:600;background:#0d1f35;color:#4caf82;border:1px solid #1a3a2a;">&#128196; Save Log\u2026</button>',
        '</div>',

        '<div id="prefs-log-status" style="font-size:0.82em;color:#4a6a8a;min-height:1.2em;margin-bottom:4px;"></div>',

        // Log viewer
        '<div id="prefs-log-viewer" style="display:none;max-height:260px;overflow-y:auto;background:#030a14;border:1px solid #0d1e36;border-radius:8px;font-family:var(--mono);font-size:0.72em;line-height:1.6;">',
        '</div>',
      '</div>',

      '</div>', // /prefs-scroll-body

      // Footer (fixed, not part of scroll area)
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;flex-shrink:0;">',
        '<button id="prefs-check-now" style="padding:7px 16px;border-radius:6px;cursor:pointer;font-size:0.88em;font-weight:600;background:#0d1f35;color:#7eb8f7;border:1px solid #1e3a5f;">Check for Updates</button>',
        '<button id="prefs-done" style="padding:7px 18px;border-radius:6px;cursor:pointer;font-size:0.88em;font-weight:600;background:#1a4a8f;color:#d0e8ff;border:1px solid #2a6abf;">Done</button>',
      '</div>',

    '</div>'
  ].join('');

  var container = document.createElement('div');
  container.innerHTML = html;
  while (container.firstChild) {
    document.body.appendChild(container.firstChild);
  }

  // ── 2. Wire up behaviour ────────────────────────────────────────────────────
  var overlay     = document.getElementById('prefs-overlay');
  var modal       = document.getElementById('prefs-modal');
  // Belt-and-suspenders: force closed at init, in case of any inline-style ordering issues.
  overlay.style.display = 'none';
  modal.style.display   = 'none';
  var btnClose    = document.getElementById('prefs-close');
  var btnDone     = document.getElementById('prefs-done');
  var btnCheck    = document.getElementById('prefs-check-now');
  var radioStable = document.getElementById('pref-ch-stable');
  var radioBeta   = document.getElementById('pref-ch-beta');
  var lblStable   = document.getElementById('pref-ch-stable-label');
  var lblBeta     = document.getElementById('pref-ch-beta-label');
  var status      = document.getElementById('pref-channel-status');
  var btnSaveLog    = document.getElementById('prefs-save-log');
  var btnViewLog    = document.getElementById('prefs-view-log');
  var btnRefreshLog = document.getElementById('prefs-refresh-log');
  var logStatus     = document.getElementById('prefs-log-status');
  var logViewer     = document.getElementById('prefs-log-viewer');
  var logCount      = document.getElementById('prefs-log-count');
  var lvlBtns       = document.querySelectorAll('.prefs-lvl-btn');

  var logVisible    = false;
  var activeLevel   = 'ALL';
  var _allEntries   = [];
  var _autoRefresh  = null;

  // ── Connections & Data — Network / EDDN / EDSM / cAPI / Inara / Journal Folder
  //    (moved here from the cog-wheel options panel so it's all in one place) ──
  function safeLog(msg, type) {
    if (typeof log === 'function') log(msg, type);
  }

  function capiUpdateUI(status) {
    var dot       = document.getElementById('capi-dot');
    var label     = document.getElementById('capi-status-label');
    var badge     = document.getElementById('capi-cmdr-badge');
    var expiryRow = document.getElementById('capi-expiry-row');
    var expiryVal = document.getElementById('capi-expiry-val');
    var loginBtn  = document.getElementById('capi-login-btn');
    var logoutBtn = document.getElementById('capi-logout-btn');
    var loginSub  = document.getElementById('capi-login-sub');
    if (!dot) return;

    if (status && status.isLoggedIn && status.tokenValid) {
      dot.style.background  = 'var(--green)';
      label.textContent     = 'AUTHENTICATED';
      label.style.color     = 'var(--green)';
      if (status.tokenExpiry) {
        expiryVal.textContent  = new Date(status.tokenExpiry).toLocaleString();
        expiryRow.style.display = '';
      }
      if (loginBtn)  loginBtn.style.display  = 'none';
      if (logoutBtn) logoutBtn.style.display = '';
    } else if (status && status.isLoggedIn && !status.tokenValid) {
      dot.style.background  = 'var(--gold)';
      label.textContent     = 'TOKEN EXPIRED — re-login required';
      label.style.color     = 'var(--gold)';
      if (status.tokenExpiry) {
        expiryVal.textContent  = new Date(status.tokenExpiry).toLocaleString() + ' (expired)';
        expiryRow.style.display = '';
      }
      if (loginSub)  loginSub.textContent  = 'Re-authenticate to refresh token';
      if (loginBtn)  loginBtn.style.display  = '';
      if (logoutBtn) logoutBtn.style.display = '';
    } else {
      dot.style.background  = 'var(--border2)';
      label.textContent     = 'NOT AUTHENTICATED';
      label.style.color     = 'var(--text-mute)';
      if (badge) badge.style.display = 'none';
      if (expiryRow) expiryRow.style.display = 'none';
      if (loginSub)  loginSub.textContent  = 'Opens Frontier auth in your browser';
      if (loginBtn)  loginBtn.style.display  = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
    }
  }

  function renderNetworkUrls(info, fallbackEnabled, fallbackPort, restartPhrasing) {
    var urlsDiv = document.getElementById('opt-network-urls');
    if (!urlsDiv) return;
    if (info && info.enabled && info.ips && info.ips.length) {
      var port = info.port || fallbackPort || 3722;
      var links = info.ips.map(function(ip) {
        var url = 'http://' + ip + ':' + port;
        return '<a href="' + url + '" style="color:var(--green);text-decoration:none;font-family:monospace;font-size:1.05em;" ' +
          'onclick="if(window.electronAPI&&window.electronAPI.openExternal){event.preventDefault();window.electronAPI.openExternal(\'' + url + '\');}">' +
          url + '</a>';
      }).join('<br>');
      urlsDiv.style.display = 'block';
      urlsDiv.innerHTML = '<div style="margin-bottom:4px;color:var(--text-mute);">' +
        (restartPhrasing ? 'Will be available after restart:' : 'Network UI is active — open on any device:') +
        '</div>' + links;
    } else if (info && info.enabled && (!info.ips || !info.ips.length)) {
      urlsDiv.style.display = 'block';
      urlsDiv.innerHTML = '<span style="color:var(--text-dim);">No network interfaces found. Check your network connection.</span>';
    } else if (fallbackEnabled) {
      urlsDiv.style.display = 'block';
      urlsDiv.innerHTML = '<span style="color:var(--text-dim);">Will start on port <strong>' + fallbackPort + '</strong> after restart.</span>';
    } else {
      urlsDiv.style.display = 'none';
    }
  }

  function loadConnectionsData() {
    if (!window.electronAPI) return;
    // Journal path
    window.electronAPI.getJournalPath()
      .then(function(p) { var el = document.getElementById('opt-journal-path'); if (el && p) el.value = p; })
      .catch(function() {});
    // EDDN / EDSM / Inara / Network config
    window.electronAPI.getConfig().then(function(cfg) {
      var el;
      el = document.getElementById('opt-eddn-enabled');    if (el) el.checked = !!cfg.eddnEnabled;
      el = document.getElementById('opt-cmdr-name');       if (el) el.value   = cfg.commanderName    || '';
      el = document.getElementById('opt-edsm-enabled');    if (el) el.checked = !!cfg.edsmEnabled;
      el = document.getElementById('opt-edsm-cmdr');       if (el) el.value   = cfg.edsmCommanderName || '';
      el = document.getElementById('opt-edsm-key');        if (el) el.value   = cfg.edsmApiKey        || '';
      el = document.getElementById('opt-inara-cmdr-name'); if (el) el.value   = cfg.inaraCommanderName || '';
      el = document.getElementById('opt-network-enabled'); if (el) el.checked = !!cfg.networkServerEnabled;
      el = document.getElementById('opt-network-port');    if (el) el.value   = cfg.networkServerPort || 3722;

      if (window.electronAPI.getNetworkInfo) {
        window.electronAPI.getNetworkInfo()
          .then(function(info) { renderNetworkUrls(info, cfg.networkServerEnabled, cfg.networkServerPort || 3722, false); })
          .catch(function() { var d = document.getElementById('opt-network-urls'); if (d) d.style.display = 'none'; });
      }

      var eddnDot = document.getElementById('eddn-dot');
      if (eddnDot) { eddnDot.style.background = cfg.eddnEnabled ? 'var(--text-mute)' : 'var(--border2)'; eddnDot.title = cfg.eddnEnabled ? 'EDDN: enabled' : 'EDDN: disabled'; }
      var edsmDot = document.getElementById('edsm-dot');
      if (edsmDot) { edsmDot.style.background = cfg.edsmEnabled ? 'var(--text-mute)' : 'var(--border2)'; edsmDot.title = cfg.edsmEnabled ? 'EDSM: enabled' : 'EDSM: disabled'; }
    }).catch(function() {});
    // cAPI auth state
    if (window.electronAPI.capiGetStatus) {
      window.electronAPI.capiGetStatus().then(capiUpdateUI).catch(function() {});
    }
  }

  // Journal Folder
  var prefsBrowseBtn = document.getElementById('opt-browse-btn');
  if (prefsBrowseBtn) prefsBrowseBtn.addEventListener('click', async function() {
    if (!window.electronAPI) return;
    try {
      var chosen = await window.electronAPI.browseJournalPath();
      if (chosen) {
        document.getElementById('opt-journal-path').value = chosen;
        document.getElementById('opt-path-hint').textContent = 'Path saved \u2014 restart to apply';
        document.getElementById('opt-path-hint').style.color = 'var(--green)';
      }
    } catch (e) { safeLog('Browse not available', 'warn'); }
  });

  var prefsOpenBtn = document.getElementById('opt-open-btn');
  if (prefsOpenBtn) prefsOpenBtn.addEventListener('click', async function() {
    if (!window.electronAPI) return;
    try { await window.electronAPI.openJournalFolder(document.getElementById('opt-journal-path').value.trim() || null); }
    catch (e) { safeLog('Could not open folder', 'warn'); }
  });

  var prefsJournalPath = document.getElementById('opt-journal-path');
  if (prefsJournalPath) prefsJournalPath.addEventListener('change', async function() {
    if (!window.electronAPI) return;
    var val = prefsJournalPath.value.trim();
    try {
      await window.electronAPI.saveJournalPath(val);
      document.getElementById('opt-path-hint').textContent = val ? 'Path saved \u2014 restart to apply' : 'Leave blank to use the default path for your OS';
      document.getElementById('opt-path-hint').style.color = val ? 'var(--green)' : '';
    } catch (e) {}
  });

  // EDDN / EDSM save
  var prefsSaveApiBtn = document.getElementById('opt-save-api-btn');
  if (prefsSaveApiBtn) prefsSaveApiBtn.addEventListener('click', async function() {
    if (!window.electronAPI) return;
    var eddnEnabled = (document.getElementById('opt-eddn-enabled') || {}).checked || false;
    var edsmEnabled = (document.getElementById('opt-edsm-enabled') || {}).checked || false;
    var commanderName     = ((document.getElementById('opt-cmdr-name')  || {}).value || '').trim();
    var edsmCommanderName = ((document.getElementById('opt-edsm-cmdr') || {}).value || '').trim();
    var edsmApiKey        = ((document.getElementById('opt-edsm-key')  || {}).value || '').trim();
    try {
      await window.electronAPI.saveConfig({ eddnEnabled, edsmEnabled, commanderName, edsmCommanderName, edsmApiKey });
      var hint = document.getElementById('opt-api-hint');
      if (hint) { hint.textContent = 'Saved \u2714'; hint.style.color = 'var(--green)'; setTimeout(function() { hint.textContent = 'Changes take effect immediately'; hint.style.color = ''; }, 2500); }
      var eddnDot = document.getElementById('eddn-dot');
      if (eddnDot) { eddnDot.style.background = eddnEnabled ? 'var(--text-mute)' : 'var(--border2)'; eddnDot.title = eddnEnabled ? 'EDDN: enabled' : 'EDDN: disabled'; }
      var edsmDot = document.getElementById('edsm-dot');
      if (edsmDot) { edsmDot.style.background = edsmEnabled ? 'var(--text-mute)' : 'var(--border2)'; edsmDot.title = edsmEnabled ? 'EDSM: enabled' : 'EDSM: disabled'; }
      safeLog('API settings saved', 'good');
    } catch (e) { safeLog('Failed to save API settings', 'error'); }
  });

  // Network UI Server save
  var prefsNetworkSaveBtn = document.getElementById('opt-network-save-btn');
  if (prefsNetworkSaveBtn) prefsNetworkSaveBtn.addEventListener('click', async function() {
    if (!window.electronAPI) return;
    var networkServerEnabled = (document.getElementById('opt-network-enabled') || {}).checked || false;
    var portVal = parseInt(((document.getElementById('opt-network-port') || {}).value || '3722'), 10);
    var networkServerPort = (portVal >= 1024 && portVal <= 65535) ? portVal : 3722;
    try {
      await window.electronAPI.saveConfig({ networkServerEnabled, networkServerPort });
      var hint = document.getElementById('opt-network-hint');
      if (hint) { hint.textContent = 'Saved \u2714 — restart the app to apply'; hint.style.color = 'var(--green)'; setTimeout(function() { hint.textContent = 'Restart required to apply changes'; hint.style.color = ''; }, 3000); }
      if (window.electronAPI.getNetworkInfo) {
        window.electronAPI.getNetworkInfo()
          .then(function(info) { renderNetworkUrls(info, networkServerEnabled, networkServerPort, true); })
          .catch(function() {});
      }
      safeLog('Network settings saved — restart to apply', 'good');
    } catch (e) { safeLog('Failed to save network settings', 'error'); }
  });

  // Frontier cAPI login/logout/refresh
  var prefsCapiLoginBtn = document.getElementById('capi-login-btn');
  if (prefsCapiLoginBtn) prefsCapiLoginBtn.addEventListener('click', async function() {
    if (!window.electronAPI) return;
    var sub = document.getElementById('capi-login-sub');
    if (sub) sub.textContent = 'Waiting for browser login\u2026';
    prefsCapiLoginBtn.disabled = true;
    try {
      var result = await window.electronAPI.capiLogin();
      if (result && result.success) {
        safeLog('cAPI login successful', 'good');
        var status2 = await window.electronAPI.capiGetStatus();
        capiUpdateUI(status2);
      } else {
        var errMsg = (result && result.error) ? result.error : 'Login failed';
        safeLog('cAPI: ' + errMsg, 'error');
        if (sub) sub.textContent = 'Login failed \u2014 see log';
        setTimeout(function() { if (sub) sub.textContent = 'Opens Frontier auth in your browser'; }, 4000);
      }
    } catch (err) {
      safeLog('cAPI login error: ' + (err.message || err), 'error');
      if (sub) sub.textContent = 'Error \u2014 see log';
      setTimeout(function() { if (sub) sub.textContent = 'Opens Frontier auth in your browser'; }, 4000);
    } finally {
      prefsCapiLoginBtn.disabled = false;
    }
  });

  var prefsCapiLogoutBtn = document.getElementById('capi-logout-btn');
  if (prefsCapiLogoutBtn) prefsCapiLogoutBtn.addEventListener('click', async function() {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.capiLogout();
      capiUpdateUI({ isLoggedIn: false, tokenValid: false });
      safeLog('cAPI logged out', 'info');
    } catch (e) { safeLog('cAPI logout failed', 'error'); }
  });

  var prefsCapiRefreshBtn = document.getElementById('capi-refresh-btn');
  if (prefsCapiRefreshBtn) prefsCapiRefreshBtn.addEventListener('click', async function() {
    if (!window.electronAPI || !window.electronAPI.capiRefreshAll) return;
    var sub = document.getElementById('capi-refresh-sub');
    prefsCapiRefreshBtn.disabled = true;
    if (sub) sub.textContent = 'Refreshing\u2026';
    try {
      var result = await window.electronAPI.capiRefreshAll();
      if (result && result.success) {
        safeLog('cAPI data refreshed', 'good');
        if (sub) sub.textContent = 'Fetch profile, fleet carrier & community goals';
      } else {
        var errMsg = (result && result.error) ? result.error : 'Refresh failed';
        safeLog('cAPI: ' + errMsg, 'error');
        if (sub) sub.textContent = errMsg;
        setTimeout(function() { if (sub) sub.textContent = 'Fetch profile, fleet carrier & community goals'; }, 4000);
      }
    } catch (err) {
      safeLog('cAPI refresh error: ' + (err.message || err), 'error');
    } finally {
      prefsCapiRefreshBtn.disabled = false;
    }
  });

  // Inara save / sync
  (function () {
    var inaraSaveBtn    = document.getElementById('opt-inara-save-btn');
    var inaraSaveStatus = document.getElementById('opt-inara-save-status');
    var inaraSyncBtn    = document.getElementById('opt-inara-sync-now-btn');
    var inaraSyncStatus = document.getElementById('opt-inara-sync-status');

    function inaraSetStatus(el, msg, color, resetMs) {
      if (!el) return;
      el.textContent  = msg;
      el.style.color  = color || '';
      if (resetMs) setTimeout(function () { el.textContent = el.dataset.default || ''; el.style.color = ''; }, resetMs);
    }

    if (inaraSaveStatus) inaraSaveStatus.dataset.default = inaraSaveStatus.textContent;
    if (inaraSyncStatus) inaraSyncStatus.dataset.default = inaraSyncStatus.textContent;

    if (inaraSaveBtn && window.electronAPI) {
      inaraSaveBtn.addEventListener('click', function () {
        var cmdrName = (document.getElementById('opt-inara-cmdr-name') || {}).value || '';
        inaraSetStatus(inaraSaveStatus, 'Saving\u2026');
        window.electronAPI.saveConfig({ inaraCommanderName: cmdrName.trim() })
          .then(function () {
            inaraSetStatus(inaraSaveStatus, '\u2713 Saved', 'var(--green)', 3000);
            if (window.electronAPI.inaraSyncProfile) {
              window.electronAPI.inaraSyncProfile(cmdrName.trim()).then(function (r) {
                if (r && r.success) {
                  inaraSetStatus(inaraSyncStatus, '\u2713 Synced at ' + new Date().toLocaleTimeString(), 'var(--green)', 5000);
                } else if (r && !r.skipped) {
                  inaraSetStatus(inaraSyncStatus, '\u26a0 ' + (r.error || 'Sync failed'), 'var(--gold)', 6000);
                }
              }).catch(function () {});
            }
          })
          .catch(function (err) {
            inaraSetStatus(inaraSaveStatus, 'Error: ' + err.message, 'var(--red)', 5000);
          });
      });
    }

    if (inaraSyncBtn && window.electronAPI && window.electronAPI.inaraSyncProfile) {
      inaraSyncBtn.addEventListener('click', function () {
        var cmdrName = (document.getElementById('opt-inara-cmdr-name') || {}).value || '';
        inaraSetStatus(inaraSyncStatus, 'Syncing\u2026');
        inaraSyncBtn.disabled = true;
        window.electronAPI.inaraSyncProfile(cmdrName.trim()).then(function (r) {
          inaraSyncBtn.disabled = false;
          if (!r) { inaraSetStatus(inaraSyncStatus, 'No response', 'var(--red)', 4000); return; }
          if (r.skipped) {
            var remaining = r.nextSyncAt ? Math.max(0, Math.round((r.nextSyncAt - Date.now()) / 1000)) : null;
            var msg = 'Rate-limited' + (remaining !== null ? ' \u2014 ' + remaining + 's remaining' : '');
            inaraSetStatus(inaraSyncStatus, msg, 'var(--text-mute)', 5000);
          } else if (r.success) {
            var cache = r.fromCache ? ' (cached)' : '';
            inaraSetStatus(inaraSyncStatus, '\u2713 Synced at ' + new Date().toLocaleTimeString() + cache, 'var(--green)', 5000);
          } else if (r.retryable) {
            var remaining2 = r.nextSyncAt ? Math.max(0, Math.round((r.nextSyncAt - Date.now()) / 1000)) : null;
            var retryMsg = (r.error || 'Server unavailable') + (remaining2 !== null ? ' \u2014 retrying in ' + remaining2 + 's' : '');
            inaraSetStatus(inaraSyncStatus, '\u26a0 ' + retryMsg, 'var(--gold)', 8000);
          } else {
            inaraSetStatus(inaraSyncStatus, '\u26a0 ' + (r.error || 'Failed'), 'var(--gold)', 6000);
          }
        }).catch(function (err) {
          inaraSyncBtn.disabled = false;
          inaraSetStatus(inaraSyncStatus, 'Error: ' + err.message, 'var(--red)', 5000);
        });
      });
    }
  }());

  // ── Level colours ──────────────────────────────────────────────────────────
  var LEVEL_COLOR = { ERROR: '#f05050', WARN: '#f0a030', INFO: '#4caf82', DEBUG: '#5a9abf' };
  var LEVEL_BG    = { ERROR: 'rgba(240,80,80,0.06)', WARN: 'rgba(240,160,48,0.05)', INFO: '', DEBUG: '' };

  function renderEntries(entries) {
    var filtered = activeLevel === 'ALL' ? entries : entries.filter(function(e) { return e.level === activeLevel; });
    if (logCount) logCount.textContent = filtered.length + ' / ' + entries.length + ' entries';

    if (!filtered.length) {
      logViewer.innerHTML = '<div style="padding:12px 14px;color:#3a5a7a;font-style:italic;">No entries match the current filter.</div>';
      return;
    }

    var rows = filtered.map(function(e) {
      var color  = LEVEL_COLOR[e.level] || '#7eb8f7';
      var bg     = LEVEL_BG[e.level]    || '';
      var time   = e.ts ? e.ts.replace('T', ' ').slice(0, 19) : '';
      var detail = e.detail ? '<div style="color:#3a5a7a;padding:1px 0 3px 0;white-space:pre-wrap;word-break:break-all;">' + escHtml(e.detail) + '</div>' : '';
      return '<div style="padding:3px 10px;border-bottom:1px solid #070f1c;' + (bg ? 'background:' + bg + ';' : '') + '">' +
        '<span style="color:#2a4a6a;">' + escHtml(time) + '</span> ' +
        '<span style="color:' + color + ';font-weight:700;min-width:38px;display:inline-block;">' + escHtml(e.level) + '</span> ' +
        '<span style="color:#4a7aaa;">[' + escHtml(e.tag || '') + ']</span> ' +
        '<span style="color:#a0c0e0;">' + escHtml(e.message || '') + '</span>' +
        detail +
        '</div>';
    });

    logViewer.innerHTML = rows.join('');
    logViewer.scrollTop = logViewer.scrollHeight;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fetchAndRender() {
    if (!window.electronAPI || !window.electronAPI.getDebugEntries) return;
    window.electronAPI.getDebugEntries().then(function(entries) {
      _allEntries = entries || [];
      renderEntries(_allEntries);
    }).catch(function(e) {
      logViewer.innerHTML = '<div style="padding:10px;color:#f05050;">Error loading log: ' + escHtml(e.message) + '</div>';
    });
  }

  // ── Level filter buttons ───────────────────────────────────────────────────
  lvlBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      activeLevel = btn.dataset.level;
      lvlBtns.forEach(function(b) { b.style.outline = ''; });
      btn.style.outline = '2px solid currentColor';
      renderEntries(_allEntries);
    });
  });
  // Highlight ALL by default
  var allBtn = document.querySelector('.prefs-lvl-btn[data-level="ALL"]');
  if (allBtn) allBtn.style.outline = '2px solid #7eb8f7';

  function highlightChannel() {
    lblStable.style.borderColor = radioBeta.checked ? '#1e3f6a' : '#7eb8f7';
    lblBeta.style.borderColor   = radioBeta.checked ? '#f0a030' : '#1e3f6a';
  }

  function openPreferences() {
    status.textContent    = '';
    overlay.style.display = 'block';
    modal.style.display   = 'flex';
    loadConnectionsData();
    if (window.electronAPI) {
      window.electronAPI.getUpdateChannel().then(function (ch) {
        radioStable.checked = (ch !== 'beta');
        radioBeta.checked   = (ch === 'beta');
        highlightChannel();
      }).catch(function () {});
    }
  }

  function closePreferences() {
    overlay.style.display    = 'none';
    modal.style.display      = 'none';
    logViewer.style.display  = 'none';
    btnRefreshLog.style.display = 'none';
    btnViewLog.textContent   = '\ud83d\udd0d View Log';
    logVisible               = false;
    if (_autoRefresh) { clearInterval(_autoRefresh); _autoRefresh = null; }
    logStatus.textContent    = '';
    logStatus.style.color    = '';
    status.textContent       = '';
  }

  btnClose.addEventListener('click', closePreferences);
  btnDone.addEventListener('click', closePreferences);
  overlay.addEventListener('click', closePreferences);

  radioStable.addEventListener('change', highlightChannel);
  radioBeta.addEventListener('change', highlightChannel);

  [radioStable, radioBeta].forEach(function (radio) {
    radio.addEventListener('change', function () {
      if (!window.electronAPI) return;
      var ch = radio.value;
      status.textContent = 'Saving\u2026';
      window.electronAPI.setUpdateChannel(ch).then(function () {
        status.textContent = '\u2713 Switched to ' + (ch === 'beta' ? 'Alpha / Beta' : 'Stable') + ' channel.';
        setTimeout(function () { status.textContent = ''; }, 4000);
      }).catch(function () {
        status.textContent = 'Error saving channel.';
      });
    });
  });

  btnCheck.addEventListener('click', function () {
    if (!window.electronAPI) return;
    status.textContent = 'Checking for updates\u2026';
    window.electronAPI.checkForUpdates().then(function () {
      setTimeout(function () { status.textContent = ''; }, 3000);
    }).catch(function () {
      status.textContent = 'Update check failed.';
    });
  });

  btnSaveLog.addEventListener('click', function () {
    if (!window.electronAPI) return;
    logStatus.style.color = '';
    logStatus.textContent = 'Saving\u2026';
    window.electronAPI.saveDebugLog().then(function (result) {
      if (result && result.success) {
        logStatus.style.color = '#4caf82';
        logStatus.textContent = '\u2713 Saved to ' + result.filePath;
      } else if (result && result.canceled) {
        logStatus.textContent = '';
      } else if (result && result.__networkUnsupported) {
        logStatus.style.color = '#f0a030';
        logStatus.textContent = result.message;
      } else {
        logStatus.style.color = '#f05050';
        logStatus.textContent = 'Error: ' + ((result && result.error) || 'Unknown');
      }
      setTimeout(function () { logStatus.textContent = ''; logStatus.style.color = ''; }, 6000);
    }).catch(function (e) {
      logStatus.style.color = '#f05050';
      logStatus.textContent = 'Error: ' + e.message;
    });
  });

  btnViewLog.addEventListener('click', function () {
    if (!window.electronAPI) return;
    if (logVisible) {
      logViewer.style.display  = 'none';
      btnRefreshLog.style.display = 'none';
      btnViewLog.textContent   = '\ud83d\udd0d View Log';
      logVisible               = false;
      clearInterval(_autoRefresh);
      _autoRefresh = null;
      return;
    }
    logViewer.style.display     = 'block';
    btnRefreshLog.style.display = '';
    btnViewLog.textContent      = '\u2715 Close Log';
    logVisible                  = true;
    fetchAndRender();
    // Auto-refresh every 5 s while open
    _autoRefresh = setInterval(fetchAndRender, 5000);
  });

  if (btnRefreshLog) {
    btnRefreshLog.addEventListener('click', fetchAndRender);
  }

  // ── 3. Listen for the IPC push from main.js ─────────────────────────────────
  if (window.electronAPI && window.electronAPI.onOpenPreferences) {
    window.electronAPI.onOpenPreferences(openPreferences);
  }

  // ── 4. Also respond to a DOM custom event ────────────────────────────────────
  window.addEventListener('open-preferences', openPreferences);

  // ── 5. Inject a "Preferences…" button into #options-panel ───────────────────
  //   Deferred so the options panel markup is guaranteed to be in the DOM.
  function injectPanelButton() {
    var panel = document.getElementById('options-panel');
    if (!panel || document.getElementById('prefs-open-from-panel')) return;

    var section = document.createElement('div');
    section.className = 'opt-section';
    section.innerHTML =
      '<div class="opt-section-title">Application</div>' +
      '<button class="opt-action-btn" id="prefs-open-from-panel">' +
        '<span class="opt-btn-icon">&#9881;</span>' +
        '<div>' +
          '<div class="opt-btn-label">Preferences\u2026</div>' +
          '<div class="opt-btn-sub">Network, EDDN/EDSM/cAPI/Inara, journal folder, updates &amp; log</div>' +
        '</div>' +
      '</button>';

    var body = document.getElementById('options-body') || panel;
    body.appendChild(section);

    document.getElementById('prefs-open-from-panel').addEventListener('click', function () {
      var closeBtn = document.getElementById('options-close');
      if (closeBtn) closeBtn.click();
      openPreferences();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectPanelButton);
  } else {
    injectPanelButton();
  }

}());
