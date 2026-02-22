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
      'width:440px;max-width:calc(100vw - 32px);',
      'background:linear-gradient(160deg,#0b1a30 0%,#091220 100%);',
      'border:1px solid #1e3f6a;border-radius:14px;',
      'padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.8),0 0 0 1px rgba(100,180,255,0.06);',
      'font-family:inherit;color:#c8d8f0;font-size:0.88em;box-sizing:border-box;',
    '">',

      // Header
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">',
        '<div style="display:flex;align-items:center;gap:10px;">',
          '<span style="font-size:1.4em;">\u2699\ufe0f</span>',
          '<span style="font-weight:700;color:#7eb8f7;font-size:1.1em;">Preferences</span>',
        '</div>',
        '<button id="prefs-close" style="background:none;border:none;color:#3a5a7a;cursor:pointer;font-size:1.3em;padding:0;line-height:1;" title="Close">\u2715</button>',
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
        '<div style="font-size:0.78em;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#4a6a8a;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #0e2040;">Debug &amp; Bug Reports</div>',
        '<div style="color:#5a7a9a;font-size:0.88em;margin-bottom:12px;line-height:1.5;">Save a debug log and attach it when filing a bug report on GitHub. It includes recent application events but <strong style="color:#a0b8d0;">no personal game data</strong>.</div>',
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">',
          '<button id="prefs-save-log" style="padding:7px 16px;border-radius:6px;cursor:pointer;font-size:0.88em;font-weight:600;background:#0d1f35;color:#7eb8f7;border:1px solid #1e3a5f;">\ud83d\udcc4 Save Debug Log\u2026</button>',
          '<button id="prefs-view-log" style="padding:7px 16px;border-radius:6px;cursor:pointer;font-size:0.88em;font-weight:600;background:#0d1f35;color:#5a9abf;border:1px solid #1a3050;">\ud83d\udd0d Preview Log</button>',
        '</div>',
        '<div id="prefs-log-status" style="font-size:0.82em;color:#4a6a8a;min-height:1.4em;margin-top:8px;"></div>',
        '<div id="prefs-log-preview" style="display:none;margin-top:10px;max-height:180px;overflow-y:auto;background:#040b14;border:1px solid #0e2040;border-radius:6px;padding:8px 10px;font-family:\'Share Tech Mono\',monospace;font-size:0.75em;color:#5a8aaa;white-space:pre;line-height:1.5;"></div>',
      '</div>',

      // Footer
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">',
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
  var btnClose    = document.getElementById('prefs-close');
  var btnDone     = document.getElementById('prefs-done');
  var btnCheck    = document.getElementById('prefs-check-now');
  var radioStable = document.getElementById('pref-ch-stable');
  var radioBeta   = document.getElementById('pref-ch-beta');
  var lblStable   = document.getElementById('pref-ch-stable-label');
  var lblBeta     = document.getElementById('pref-ch-beta-label');
  var status      = document.getElementById('pref-channel-status');
  var btnSaveLog  = document.getElementById('prefs-save-log');
  var btnViewLog  = document.getElementById('prefs-view-log');
  var logStatus   = document.getElementById('prefs-log-status');
  var logPreview  = document.getElementById('prefs-log-preview');

  var logVisible = false;

  function highlightChannel() {
    lblStable.style.borderColor = radioBeta.checked ? '#1e3f6a' : '#7eb8f7';
    lblBeta.style.borderColor   = radioBeta.checked ? '#f0a030' : '#1e3f6a';
  }

  function openPreferences() {
    status.textContent    = '';
    overlay.style.display = 'block';
    modal.style.display   = 'block';
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
    logPreview.style.display = 'none';
    btnViewLog.textContent   = '\ud83d\udd0d Preview Log';
    logVisible               = false;
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
      logPreview.style.display = 'none';
      btnViewLog.textContent   = '\ud83d\udd0d Preview Log';
      logVisible               = false;
      return;
    }
    window.electronAPI.getDebugLog().then(function (content) {
      logPreview.textContent   = content;
      logPreview.style.display = 'block';
      logPreview.scrollTop     = logPreview.scrollHeight;
      btnViewLog.textContent   = '\ud83d\ude48 Hide Preview';
      logVisible               = true;
    }).catch(function (e) {
      logStatus.style.color = '#f05050';
      logStatus.textContent = 'Error: ' + e.message;
    });
  });

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
          '<div class="opt-btn-sub">Update channel, debug log &amp; more</div>' +
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
