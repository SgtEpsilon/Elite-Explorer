/**
 * history-script.js
 * Standalone script for history.html only.
 * No coupling to script.js, journalProvider, or the live/profile scans.
 */

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function set(id, v) {
  var el = document.getElementById(id);
  if (el) el.textContent = (v != null ? v : '\u2014');
}

// ─── STATE ────────────────────────────────────────────────────────────────────
var _allJumps   = [];
var _isScanning = false;

// ─── RENDER ───────────────────────────────────────────────────────────────────
function renderHistory(jumps) {
  var tbody    = document.getElementById('hist-tbody');
  var table    = document.getElementById('hist-table');
  var empty    = document.getElementById('hist-empty');
  var statsBar = document.getElementById('hist-stats-bar');
  var scanning = document.getElementById('hist-scanning');
  if (!tbody) return;

  if (scanning) scanning.style.display = 'none';

  if (!jumps.length) {
    if (empty)    empty.style.display    = _isScanning ? 'none' : 'flex';
    if (table)    table.style.display    = 'none';
    if (statsBar) statsBar.style.display = 'none';
    return;
  }

  if (empty)    empty.style.display    = 'none';
  if (table)    table.style.display    = 'table';
  if (statsBar) statsBar.style.display = 'flex';

  var totalDist  = 0;
  var farthest   = 0;
  var discoCount = 0;

  // Build fragment for performance on large datasets
  var frag = document.createDocumentFragment();

  jumps.forEach(function(j, idx) {
    totalDist += j.jumpDist || 0;
    if ((j.jumpDist || 0) > farthest) farthest = j.jumpDist || 0;
    if (!j.wasDiscovered) discoCount++;

    var tr = document.createElement('tr');
    tr.className = 'hist-row' + (idx % 2 === 1 ? ' hist-row-alt' : '');

    var ts        = j.timestamp ? j.timestamp.replace('T', ' ').slice(0, 19) : '\u2014';
    var dist      = j.jumpDist  != null ? j.jumpDist.toFixed(2) + ' ly' : '\u2014';
    var bodyCount = j.bodyCount != null ? j.bodyCount : '\u2014';
    var disco     = !j.wasDiscovered
      ? '<span class="disco-star" title="First Discovery \u2014 you found this system!">&#9733;</span>'
      : '';

    tr.innerHTML =
      '<td class="hist-col-disco">' + disco + '</td>' +
      '<td class="hist-col-sys">'   + (j.system || '\u2014') + '</td>' +
      '<td class="hist-col-ts">'    + ts + '</td>' +
      '<td class="hist-col-dist">'  + dist + '</td>' +
      '<td class="hist-col-star">'  + (j.starClass || '\u2014') + '</td>' +
      '<td class="hist-col-bodies">'+ bodyCount + '</td>';

    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);

  var countEl = document.getElementById('hist-count');
  if (countEl) countEl.textContent = jumps.length.toLocaleString() + ' jumps shown';

  set('hstat-jumps',    _allJumps.length.toLocaleString());
  set('hstat-disco',    discoCount.toLocaleString());
  set('hstat-dist',     Math.round(totalDist).toLocaleString() + ' ly');
  set('hstat-farthest', farthest.toFixed(2) + ' ly');
}

function applyFilters() {
  var q         = ((document.getElementById('hist-search')       || {}).value || '').trim().toLowerCase();
  var discoOnly  = (document.getElementById('hist-filter-disco') || {}).checked;
  var filtered   = _allJumps.filter(function(j) {
    if (discoOnly && j.wasDiscovered !== false) return false;
    if (q && !(j.system || '').toLowerCase().includes(q)) return false;
    return true;
  });
  renderHistory(filtered);
}

// ─── SCAN STATUS ──────────────────────────────────────────────────────────────
function showScanStatus(text, color) {
  var el = document.getElementById('hist-scan-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || 'var(--text-dim)';
}

function updateProgressBar(pct) {
  var bar  = document.getElementById('hist-progress-bar');
  var wrap = document.getElementById('hist-progress-wrap');
  if (wrap) wrap.style.display = pct < 100 ? 'flex' : 'none';
  if (bar)  bar.style.width    = Math.min(100, pct) + '%';
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
if (window.electronAPI) {

  // Topbar name/credits from live-data (shared across all pages)
  window.electronAPI.onLiveData(function(d) {
    if (d.name)    set('tb-cmdr', 'CMDR ' + d.name);
    if (d.credits != null) set('tb-credits', Number(d.credits).toLocaleString() + ' CR');
    if (d.currentSystem) set('tb-sys', d.currentSystem);
    var star = document.getElementById('tb-discovery-star');
    if (star) star.style.display = d.lastJumpWasFirstDiscovery ? 'inline' : 'none';
  });

  // Scan started
  window.electronAPI.onHistoryScanStart(function(d) {
    _isScanning = true;
    showScanStatus('Scanning ' + d.totalFiles + ' journal file(s)\u2026', 'var(--gold)');
    updateProgressBar(0);

    var scanning = document.getElementById('hist-scanning');
    if (scanning && !_allJumps.length) scanning.style.display = 'flex';
  });

  // Progress updates
  window.electronAPI.onHistoryProgress(function(d) {
    var overall = Math.round(((d.fileIndex - 1 + d.currentLine / d.totalLines) / d.totalFiles) * 100);
    showScanStatus(
      'File ' + d.fileIndex + ' / ' + d.totalFiles +
      ' \u00B7 ' + d.jumpsFound.toLocaleString() + ' jumps found',
      'var(--text-dim)'
    );
    updateProgressBar(overall);
  });

  // Full dataset arrived
  window.electronAPI.onHistoryData(function(data) {
    _isScanning = false;
    _allJumps   = data || [];
    showScanStatus(
      _allJumps.length.toLocaleString() + ' jumps across all journals',
      'var(--cyan)'
    );
    updateProgressBar(100);
    applyFilters();
  });

  // Path missing
  window.electronAPI.onHistoryPathMissing(function(p) {
    showScanStatus('Journal folder not found: ' + p, 'var(--red)');
    _isScanning = false;
    updateProgressBar(100);
  });

  // Rescan button
  var rescanBtn = document.getElementById('hist-rescan-btn');
  if (rescanBtn) {
    rescanBtn.addEventListener('click', function() {
      if (_isScanning) return;
      window.electronAPI.triggerHistoryScan();
      showScanStatus('Scan triggered\u2026', 'var(--gold)');
    });
  }

}

// ─── FILTERS ──────────────────────────────────────────────────────────────────
var histSearch = document.getElementById('hist-search');
if (histSearch) histSearch.addEventListener('input', applyFilters);

var histDiscoFilter = document.getElementById('hist-filter-disco');
if (histDiscoFilter) histDiscoFilter.addEventListener('change', applyFilters);

// ─── OPTIONS PANEL ────────────────────────────────────────────────────────────
function openOptions() {
  document.getElementById('options-panel').classList.add('open');
  document.getElementById('options-overlay').classList.add('open');
  if (window.electronAPI && window.electronAPI.getJournalPath) {
    window.electronAPI.getJournalPath()
      .then(function(p) { if (p) document.getElementById('opt-journal-path').value = p; })
      .catch(function() {});
  }
}
function closeOptions() {
  document.getElementById('options-panel').classList.remove('open');
  document.getElementById('options-overlay').classList.remove('open');
}

document.getElementById('options-btn').addEventListener('click', openOptions);
document.getElementById('options-close').addEventListener('click', closeOptions);
document.getElementById('options-overlay').addEventListener('click', closeOptions);

var browseBtn = document.getElementById('opt-browse-btn');
if (browseBtn) browseBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  try {
    var chosen = await window.electronAPI.browseJournalPath();
    if (chosen) {
      document.getElementById('opt-journal-path').value = chosen;
      document.getElementById('opt-path-hint').textContent = 'Path saved \u2014 restart to apply';
      document.getElementById('opt-path-hint').style.color = 'var(--green)';
    }
  } catch {}
});

var openBtn = document.getElementById('opt-open-btn');
if (openBtn) openBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  try { await window.electronAPI.openJournalFolder(document.getElementById('opt-journal-path').value.trim() || null); }
  catch {}
});

var journalPathInput = document.getElementById('opt-journal-path');
if (journalPathInput) journalPathInput.addEventListener('change', async function() {
  if (!window.electronAPI) return;
  var val = journalPathInput.value.trim();
  try {
    await window.electronAPI.saveJournalPath(val);
    document.getElementById('opt-path-hint').textContent = val ? 'Path saved \u2014 restart to apply' : 'Leave blank to use the default path for your OS';
    document.getElementById('opt-path-hint').style.color = val ? 'var(--green)' : '';
  } catch {}
});

// ─── THEMES ───────────────────────────────────────────────────────────────────
var THEMES = {
  default: { '--gold':'#c8972a','--gold2':'#e8b840','--gold-dim':'#7a5a10','--gold-glow':'rgba(200,151,42,0.15)','--cyan':'#2ecfcf','--cyan2':'#5ee8e8','--cyan-dim':'rgba(46,207,207,0.1)' },
  red:     { '--gold':'#e05252','--gold2':'#f07070','--gold-dim':'#a03030','--gold-glow':'rgba(224,82,82,0.15)' ,'--cyan':'#cf7a3e','--cyan2':'#e89060','--cyan-dim':'rgba(207,122,62,0.1)' },
  green:   { '--gold':'#4caf7d','--gold2':'#70d090','--gold-dim':'#2a7a50','--gold-glow':'rgba(76,175,125,0.15)','--cyan':'#a0cf3e','--cyan2':'#c0e060','--cyan-dim':'rgba(160,207,62,0.1)' },
  purple:  { '--gold':'#a855f7','--gold2':'#c080ff','--gold-dim':'#7a30c0','--gold-glow':'rgba(168,85,247,0.15)','--cyan':'#cf3ecf','--cyan2':'#e060e0','--cyan-dim':'rgba(207,62,207,0.1)' },
};
function applyTheme(name) {
  var t = THEMES[name] || THEMES.default;
  Object.entries(t).forEach(function(kv) { document.documentElement.style.setProperty(kv[0], kv[1]); });
  document.querySelectorAll('.opt-theme-swatch').forEach(function(el) {
    el.classList.toggle('active', el.dataset.theme === name);
  });
  localStorage.setItem('ee-theme', name);
}
document.querySelectorAll('.opt-theme-swatch').forEach(function(el) {
  el.addEventListener('click', function() { applyTheme(el.dataset.theme); });
});
applyTheme(localStorage.getItem('ee-theme') || 'default');

// ─── DISPLAY SLIDERS ──────────────────────────────────────────────────────────
var SLIDER_DEFAULTS = { scale:100, font:12, density:3, left:220, right:320, bottom:120, bright:100, opacity:100, scan:1, glow:100, border:2 };
var DENSITY_LABELS  = ['Compact','Tight','Normal','Relaxed','Spacious'];
var SCAN_LABELS     = ['Off','Low','Medium','High','Intense','Max'];
var BORDER_LABELS   = ['None','Faint','Medium','Bold','Heavy'];

var scanlineStyle = document.createElement('style');
scanlineStyle.id  = 'dynamic-scanlines';
document.head.appendChild(scanlineStyle);

var panelOpacityStyle = document.createElement('style');
panelOpacityStyle.id  = 'dynamic-opacity';
document.head.appendChild(panelOpacityStyle);

function applyDisplay(key, v) {
  var root = document.documentElement;
  var wrap = document.getElementById('app-wrapper');
  switch (key) {
    case 'scale':
      if (wrap) {
        wrap.style.transform       = 'scale(' + (v/100) + ')';
        wrap.style.transformOrigin = 'top left';
        wrap.style.width           = Math.round(10000/v) + '%';
        wrap.style.height          = 'calc(' + Math.round(10000/v) + 'vh - ' + Math.round(44*100/v) + 'px)';
      }
      break;
    case 'font':
      document.body.style.fontSize = v + 'px';
      var tb = document.getElementById('topbar');
      if (tb) tb.style.fontSize = v + 'px';
      break;
    case 'density': {
      var pad = [2,3,4,6,8][v-1] + 'px';
      root.style.setProperty('--row-pad', pad);
      var ds = document.getElementById('density-style') || document.createElement('style');
      ds.id = 'density-style';
      ds.textContent = '.hist-row td { padding-top:' + pad + '; padding-bottom:' + pad + '; }';
      document.head.appendChild(ds);
      break;
    }
    case 'left':   root.style.setProperty('--left-w',   v + 'px'); break;
    case 'right':  root.style.setProperty('--right-w',  v + 'px'); break;
    case 'bottom': root.style.setProperty('--bottom-h', Math.max(105, v) + 'px'); break;
    case 'bright':
      if (wrap) wrap.style.filter = 'brightness(' + (v/100) + ') saturate(' + (0.8 + (v/100)*0.4) + ')';
      break;
    case 'opacity':
      panelOpacityStyle.textContent =
        '.panel, #panel-summary { background: rgba(9,14,24,' + (v/100) + ') !important; }' +
        '#options-panel { background: rgba(9,14,24,' + Math.min(1, v/100+0.1) + ') !important; }';
      break;
    case 'scan':
      if (v === 0) {
        scanlineStyle.textContent = 'body::after { display:none; }';
      } else {
        var opacity = [0.02, 0.04, 0.07, 0.11, 0.16][v-1];
        var gap     = [4, 4, 3, 3, 2][v-1];
        scanlineStyle.textContent =
          'body::after { background: repeating-linear-gradient(0deg, transparent, transparent ' +
          (gap-1) + 'px, rgba(0,0,0,' + opacity + ') ' + (gap-1) + 'px, rgba(0,0,0,' + opacity + ') ' + gap + 'px) !important; }';
      }
      break;
    case 'glow': {
      var g = v / 100;
      root.style.setProperty('--gold-glow', 'rgba(200,151,42,' + (0.15*g) + ')');
      var gs = document.getElementById('glow-style') || document.createElement('style');
      gs.id = 'glow-style';
      gs.textContent = '.tb-logo { text-shadow: 0 0 ' + Math.round(16*g) + 'px var(--gold-glow) !important; }';
      document.head.appendChild(gs);
      break;
    }
    case 'border': {
      var bw = [0, 0.5, 1, 1.5, 2][v];
      root.style.setProperty('--border-w', bw + 'px');
      var bs = document.getElementById('border-style') || document.createElement('style');
      bs.id = 'border-style';
      bs.textContent = '#topbar { border-bottom-width:' + bw + 'px !important; }';
      document.head.appendChild(bs);
      break;
    }
  }
}

function sliderFill(input) {
  var min = parseFloat(input.min), max = parseFloat(input.max), v = parseFloat(input.value);
  input.style.setProperty('--fill', Math.round(((v - min) / (max - min)) * 100) + '%');
}

function updateSliderUI(key, v) {
  var valEl = document.getElementById('sv-' + key);
  if (!valEl) return;
  switch (key) {
    case 'scale':                    valEl.textContent = Math.round(v) + '%'; break;
    case 'font':                     valEl.textContent = v + 'px'; break;
    case 'density':                  valEl.textContent = DENSITY_LABELS[v-1] || v; break;
    case 'left': case 'right': case 'bottom': valEl.textContent = v + 'px'; break;
    case 'bright': case 'opacity': case 'glow': valEl.textContent = v + '%'; break;
    case 'scan':                     valEl.textContent = SCAN_LABELS[v] || v; break;
    case 'border':                   valEl.textContent = BORDER_LABELS[v] || v; break;
  }
}

function loadDisplaySettings() {
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('ee-display') || '{}'); } catch {}
  Object.keys(SLIDER_DEFAULTS).forEach(function(key) {
    var v   = saved[key] != null ? saved[key] : SLIDER_DEFAULTS[key];
    var inp = document.getElementById('sl-' + key);
    if (inp) { inp.value = v; sliderFill(inp); }
    updateSliderUI(key, v);
    applyDisplay(key, v);
  });
}

function saveDisplaySettings() {
  var data = {};
  Object.keys(SLIDER_DEFAULTS).forEach(function(key) {
    var inp = document.getElementById('sl-' + key);
    if (inp) data[key] = parseFloat(inp.value);
  });
  localStorage.setItem('ee-display', JSON.stringify(data));
}

Object.keys(SLIDER_DEFAULTS).forEach(function(key) {
  var inp = document.getElementById('sl-' + key);
  if (!inp) return;
  inp.addEventListener('input', function() {
    var v = parseFloat(inp.value);
    sliderFill(inp);
    updateSliderUI(key, v);
    applyDisplay(key, v);
    saveDisplaySettings();
  });
});

var resetBtn = document.getElementById('sl-reset-all');
if (resetBtn) resetBtn.addEventListener('click', function() {
  Object.keys(SLIDER_DEFAULTS).forEach(function(key) {
    var inp = document.getElementById('sl-' + key);
    if (inp) { inp.value = SLIDER_DEFAULTS[key]; sliderFill(inp); }
    updateSliderUI(key, SLIDER_DEFAULTS[key]);
    applyDisplay(key, SLIDER_DEFAULTS[key]);
  });
  localStorage.removeItem('ee-display');
});

loadDisplaySettings();
