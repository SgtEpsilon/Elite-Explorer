/**
 * update-modal.js — Update-available popup, shared across all pages.
 *
 * Injected into every page via <script src="update-modal.js"></script>.
 * Dynamically inserts its own HTML so no page needs to carry the markup.
 * Listens for the 'update-status' IPC push from updaterService.js.
 *
 * States handled:
 *   available   → shows "Download now / Next launch / Skip" buttons
 *   downloading → shows progress bar
 *   downloaded  → shows "Restart and install" or auto-close for on-quit installs
 *   error       → shows sanitised error message with Retry button
 *   checking / not-available → intentionally silent
 */
(function () {
  'use strict';

  // ── 1. Inject modal HTML ────────────────────────────────────────────────────
  var html = [
    '<div id="update-overlay" style="',
      'display:none;position:fixed;inset:0;z-index:9990;',
      'background:rgba(0,0,0,0.65);backdrop-filter:blur(3px);',
      'align-items:center;justify-content:center;',
    '"></div>',

    '<div id="update-modal" style="',
      'display:none;position:fixed;z-index:9999;',
      'top:50%;left:50%;transform:translate(-50%,-50%);',
      'width:420px;max-width:calc(100vw - 32px);',
      'background:linear-gradient(160deg,#0b1a30 0%,#091220 100%);',
      'border:1px solid #1e3f6a;border-radius:14px;',
      'padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.8),0 0 0 1px rgba(100,180,255,0.06);',
      'font-family:inherit;color:#c8d8f0;font-size:0.88em;box-sizing:border-box;',
    '">',

      // Header
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;">',
        '<div style="display:flex;align-items:center;gap:10px;">',
          '<div id="um-icon" style="font-size:2em;line-height:1;">\uD83D\uDE80</div>',
          '<div>',
            '<div id="um-title" style="font-weight:700;color:#7eb8f7;font-size:1.15em;line-height:1.2;"></div>',
            '<div id="um-channel-badge" style="',
              'display:none;margin-top:4px;padding:2px 8px;border-radius:20px;',
              'font-size:0.78em;font-weight:600;',
              'background:#1a3a1a;color:#4caf82;border:1px solid #2a5a2a;',
            '"></div>',
          '</div>',
        '</div>',
        '<button id="um-close" style="',
          'background:none;border:none;color:#3a5a7a;cursor:pointer;',
          'font-size:1.3em;padding:0 0 0 8px;line-height:1;flex-shrink:0;',
        '" title="Dismiss">\u2715</button>',
      '</div>',

      // Body
      '<div id="um-body" style="color:#8fa8c8;line-height:1.6;margin-bottom:14px;"></div>',

      // Release notes
      '<div id="um-notes-wrap" style="display:none;margin-bottom:14px;">',
        '<div style="font-size:0.82em;color:#4a6a8a;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;">What\'s new</div>',
        '<div id="um-notes" style="',
          'background:#060f1e;border:1px solid #1a3050;border-radius:8px;',
          'padding:10px 12px;max-height:100px;overflow-y:auto;',
          'color:#6a8aaa;font-size:0.9em;line-height:1.55;',
        '"></div>',
      '</div>',

      // Progress
      '<div id="um-progress-wrap" style="display:none;margin-bottom:14px;">',
        '<div style="background:#0d1f35;border-radius:4px;height:6px;overflow:hidden;">',
          '<div id="um-progress-bar" style="',
            'height:100%;width:0%;',
            'background:linear-gradient(90deg,#1a4a8f,#7eb8f7);',
            'transition:width 0.25s;',
          '"></div>',
        '</div>',
        '<div id="um-progress-lbl" style="margin-top:6px;font-size:0.85em;color:#4a6a8a;"></div>',
      '</div>',

      // Actions
      '<div id="um-actions" style="display:flex;flex-direction:column;gap:8px;"></div>',

    '</div>',
  ].join('');

  var container = document.createElement('div');
  container.innerHTML = html;
  while (container.firstChild) document.body.appendChild(container.firstChild);

  // ── 2. Element references ───────────────────────────────────────────────────
  var overlay   = document.getElementById('update-overlay');
  var modal     = document.getElementById('update-modal');
  var umIcon    = document.getElementById('um-icon');
  var umTitle   = document.getElementById('um-title');
  var umBadge   = document.getElementById('um-channel-badge');
  var umBody    = document.getElementById('um-body');
  var umNotesW  = document.getElementById('um-notes-wrap');
  var umNotes   = document.getElementById('um-notes');
  var umProgW   = document.getElementById('um-progress-wrap');
  var umProgBar = document.getElementById('um-progress-bar');
  var umProgLbl = document.getElementById('um-progress-lbl');
  var umActions = document.getElementById('um-actions');
  var umClose   = document.getElementById('um-close');

  var currentVersion = null;

  // ── 3. Helpers ──────────────────────────────────────────────────────────────
  function openModal()  { overlay.style.display = 'flex'; modal.style.display = 'block'; }
  function closeModal() { overlay.style.display = 'none'; modal.style.display = 'none'; }

  umClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', closeModal);

  function showChannelBadge(channel) {
    if (channel === 'beta') {
      umBadge.textContent        = '\uD83E\uDDEA Alpha / Beta channel';
      umBadge.style.background   = '#2a1a0a';
      umBadge.style.color        = '#f0a030';
      umBadge.style.border       = '1px solid #4a3010';
    } else {
      umBadge.textContent        = '\uD83D\uDEE1\uFE0F Stable channel';
      umBadge.style.background   = '#1a3a1a';
      umBadge.style.color        = '#4caf82';
      umBadge.style.border       = '1px solid #2a5a2a';
    }
    umBadge.style.display = 'inline-block';
  }

  function makeBtn(label, style, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    var styles = {
      primary:   'background:#1a4a8f;color:#d0e8ff;border:1px solid #2a6abf;',
      secondary: 'background:#0d1f35;color:#7eb8f7;border:1px solid #1e3a5f;',
      ghost:     'background:transparent;color:#4a6a8a;border:1px solid transparent;',
    };
    b.style.cssText = [
      'width:100%;padding:8px 12px;border-radius:7px;cursor:pointer;',
      'font-size:0.9em;font-weight:600;text-align:left;',
      styles[style] || styles.secondary,
    ].join('');
    b.addEventListener('click', onClick);
    return b;
  }

  function showUpdate(iconChar, titleText, bodyText, channel) {
    umIcon.textContent  = iconChar;
    umTitle.textContent = titleText;
    umBody.textContent  = bodyText;
    umActions.innerHTML = '';
    umNotesW.style.display = 'none';
    umProgW.style.display  = 'none';
    showChannelBadge(channel || 'stable');
    openModal();
  }

  function showReleaseNotes(html) {
    if (!html) return;
    if (Array.isArray(html)) {
      html = html.map(function (r) {
        return typeof r === 'object' ? (r.note || r.body || '') : r;
      }).join('\n');
    }
    var decoder = document.createElement('textarea');
    decoder.innerHTML = String(html);
    var text = decoder.value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    umNotes.textContent    = text;
    umNotesW.style.display = 'block';
  }

  function lockButtons(message) {
    umActions.innerHTML = '';
    var p = document.createElement('div');
    p.style.cssText = 'color:#4a6a8a;font-size:0.88em;padding:4px 0;';
    p.textContent   = message;
    umActions.appendChild(p);
  }

  // ── 4. Update-status IPC listener ──────────────────────────────────────────
  if (window.electronAPI && window.electronAPI.onUpdateStatus) {
    window.electronAPI.onUpdateStatus(function (data) {
      switch (data.status) {

        case 'available': {
          currentVersion = data.version;
          showUpdate(
            '\uD83D\uDE80',
            'Update v' + data.version + ' Available',
            'A new version of Elite Explorer is ready. How would you like to proceed?',
            data.channel
          );
          showReleaseNotes(data.releaseNotes);

          umActions.appendChild(makeBtn('\u26A1\uFE0F  Download and update now', 'primary', function () {
            lockButtons('Downloading\u2026');
            umProgW.style.display = 'block';
            window.electronAPI.downloadUpdateNow();
          }));
          umActions.appendChild(makeBtn('\uD83D\uDD53  Download and update next launch', 'secondary', function () {
            lockButtons('Will download in the background and install on next launch.');
            umProgW.style.display = 'block';
            window.electronAPI.downloadUpdateOnQuit();
          }));
          umActions.appendChild(makeBtn('\u2715  Skip this version', 'ghost', function () {
            window.electronAPI.skipVersion(currentVersion);
            closeModal();
          }));
          break;
        }

        case 'downloading': {
          umIcon.textContent  = '\u2B07\uFE0F';
          umTitle.textContent = 'Downloading Update\u2026';
          umProgW.style.display = 'block';
          umProgBar.style.width = data.percent + '%';
          var mb    = (data.transferred   / 1048576).toFixed(1);
          var total = (data.total         / 1048576).toFixed(1);
          var kbps  = (data.bytesPerSecond / 1024).toFixed(0);
          umProgLbl.textContent = mb + ' / ' + total + ' MB  \u00B7  ' + kbps + ' KB/s  (' + data.percent + '%)';
          openModal();
          break;
        }

        case 'downloaded': {
          if (data.installOnQuit) {
            showUpdate(
              '\u2705',
              'Update Ready',
              'v' + data.version + ' will be installed the next time you launch Elite Explorer.',
              data.channel
            );
            setTimeout(closeModal, 5000);
          } else {
            showUpdate(
              '\u2705',
              'v' + data.version + ' Ready to Install',
              'Download complete. Restart now to apply the update.',
              data.channel
            );
            umActions.appendChild(makeBtn('\u26A1\uFE0F  Restart and install', 'primary', function () {
              window.electronAPI.installAndRestart();
            }));
            umActions.appendChild(makeBtn('Later', 'ghost', closeModal));
          }
          break;
        }

        case 'error': {
          var rawMsg = data.message || '';
          var errMsg = rawMsg
            .split(/\r?\n/)[0]
            .replace(/<[^>]*>/g, '')
            .replace(/,?\s*XML:.*$/s, '')
            .replace(/,?\s*Headers:.*$/s, '')
            .trim();

          if (
            !errMsg ||
            errMsg.length > 120 ||
            errMsg.includes('<?xml') ||
            errMsg.includes('<feed') ||
            errMsg.includes('HttpError') ||
            errMsg.toLowerCase().includes('unable to find latest')
          ) {
            errMsg = 'Could not reach the update server. Check your internet connection or try again later.';
          }

          showUpdate('\u26A0\uFE0F', 'Update Error', errMsg, data.channel || 'stable');
          umActions.appendChild(makeBtn('Retry', 'secondary', function () {
            closeModal();
            window.electronAPI.checkForUpdates();
          }));
          setTimeout(closeModal, 10000);
          break;
        }

        // 'checking' and 'not-available' are intentionally silent
      }
    });
  }

}());
