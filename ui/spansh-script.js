/**
 * spansh-script.js
 * Handles all Spansh API interactions for spansh.html.
 *
 * Supported routers:
 *   neutron  — POST /api/route            (neutron star routing)
 *   riches   — POST /api/riches/route     (road to riches)
 *   exact    — POST /api/exact-plotter    (fuel-aware exact router)
 *
 * All routes use the two-step Spansh pattern:
 *   1. POST to submit job → get { job }
 *   2. Poll GET /api/results/{job} until { status: "ok" }
 */

'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────────
var SPANSH_BASE    = 'https://spansh.co.uk';
var POLL_INTERVAL  = 1500;   // ms between polls
var POLL_TIMEOUT   = 120000; // 2 min max
var MAX_TABLE_ROWS = 2000;   // safety cap for very long routes

// ─── STATE ────────────────────────────────────────────────────────
var _currentPanel   = 'neutron';
var _pollTimer      = null;
var _pollStart      = 0;
var _isRunning      = false;
var _lastRoute      = null;   // { type, systems: [] }
var _liveSystem     = null;   // from IPC
var _liveJumpRange  = null;   // from IPC (e.g. "24.55 ly")

// Road to Riches option toggles
var _rtrOptions = { mappingValue: false, avoidThargoids: false, loop: false };

// Exomastery option toggles (defaults match Spansh website)
var _exoOptions = { avoidThargoids: true, loop: true };

// Fleet Carrier type: 'player' or 'squadron'
var _fcType = 'player';
// Player carrier: bare minimum services (~0 t used capacity preset)
// Squadron carrier: fully loaded with services/cargo (~8000 t preset)
// { used_capacity, tritium_fuel, tritium_market }
var FC_PRESETS = {
  player:   { cargo: 0,    fuel: 1000, market: 0 },
  squadron: { cargo: 8000, fuel: 1000, market: 0 },
};

// ─── UTILITIES ────────────────────────────────────────────────────
function set(id, v) {
  var el = document.getElementById(id);
  if (el) el.textContent = v != null ? v : '\u2014';
}

function fmtCr(n) {
  if (n == null || n === 0) return '\u2014';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B cr';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M cr';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K cr';
  return Number(n).toLocaleString() + ' cr';
}

function fmtLy(n) {
  if (n == null) return '\u2014';
  return Number(n).toFixed(2) + ' ly';
}

// ─── PER-ROW COPY HELPER ──────────────────────────────────────────
function copyRowSystem(systemName, btn) {
  navigator.clipboard.writeText(systemName).then(function() {
    var orig = btn.textContent;
    btn.textContent = '\u2713 Copied';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = orig; btn.classList.remove('copied'); }, 1600);
  }).catch(function() {
    var ta = document.createElement('textarea');
    ta.value = systemName;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ─── ROW BUILDER HELPERS ──────────────────────────────────────────
function makeVisitedCb(tr) {
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'row-visited-cb';
  cb.title = 'Mark as visited';
  cb.addEventListener('change', function() { tr.classList.toggle('row-done', cb.checked); });
  return cb;
}

function makeCopyBtn(systemName) {
  var btn = document.createElement('button');
  btn.className = 'row-copy-btn';
  btn.textContent = '\u2398 Copy';
  btn.title = 'Copy system name';
  btn.addEventListener('click', function() { copyRowSystem(systemName, btn); });
  return btn;
}

function parseJumpRange(str) {
  if (!str) return null;
  var m = String(str).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

// ─── SLIDER ↔ INPUT SYNC ──────────────────────────────────────────
function sliderFill(slider) {
  var min = parseFloat(slider.min);
  var max = parseFloat(slider.max);
  var v   = parseFloat(slider.value);
  slider.style.setProperty('--fill', Math.round(((v - min) / (max - min)) * 100) + '%');
}

function bindSliderPair(sliderId, inputId, labelId, formatter) {
  var sl = document.getElementById(sliderId);
  var inp = document.getElementById(inputId);
  if (!sl || !inp) return;
  var fmt = formatter || function(v) { return v; };

  function sync(src) {
    var v = parseFloat(src.value);
    if (isNaN(v)) return;
    sl.value  = v;
    inp.value = v;
    sliderFill(sl);
    if (labelId) set(labelId, fmt(v));
  }

  sl.addEventListener('input',  function() { sync(sl); });
  inp.addEventListener('input', function() { sync(inp); });
  inp.addEventListener('change', function() {
    var v = Math.min(parseFloat(inp.max||1e9), Math.max(parseFloat(inp.min||0), parseFloat(inp.value)||0));
    inp.value = v;
    sync(inp);
  });
  sliderFill(sl);
  if (labelId) set(labelId, fmt(parseFloat(sl.value)));
}

// ─── STATUS HELPERS ───────────────────────────────────────────────
function setStatus(text, state, meta) {
  var dot  = document.getElementById('status-dot');
  var txt  = document.getElementById('status-text');
  var met  = document.getElementById('status-meta');
  if (dot) { dot.className = 'status-dot ' + (state || ''); }
  if (txt) txt.textContent = text || '';
  if (met) met.textContent = meta  || '';
}

function showProgress(pct) {
  var wrap = document.getElementById('spansh-progress-bar-wrap');
  var fill = document.getElementById('spansh-progress-bar-fill');
  if (!wrap || !fill) return;
  wrap.style.display = pct >= 100 ? 'none' : 'block';
  fill.style.width   = Math.min(100, pct) + '%';
}

function showError(msg) {
  var el = document.getElementById('submit-error');
  if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}

function setRunning(yes) {
  _isRunning = yes;
  var btn = document.getElementById('spansh-submit');
  if (!btn) return;
  btn.disabled = yes;
  btn.classList.toggle('loading', yes);
  set('submit-label', yes ? 'Calculating\u2026' : 'Calculate Route');
}

// ─── SUB-TAB SWITCHING ────────────────────────────────────────────
document.querySelectorAll('.sub-tab').forEach(function(btn) {
  btn.addEventListener('click', function() {
    if (_isRunning) return;
    _currentPanel = btn.dataset.panel;
    document.querySelectorAll('.sub-tab').forEach(function(b) { b.classList.toggle('active', b === btn); });
    document.querySelectorAll('.form-panel').forEach(function(p) { p.classList.toggle('active', p.id === 'form-' + _currentPanel); });
    var labels = { neutron: 'Calculate Route', riches: 'Find Systems', exobio: 'Find Organisms', carrier: 'Plot FC Route' };
    var tritBtn = document.getElementById('fc-tritium-btn');
    if (tritBtn) tritBtn.style.display = btn.dataset.panel === 'carrier' ? 'flex' : 'none';
    set('submit-label', labels[_currentPanel] || 'Calculate');
    // Reset results area
    hideResults();
    showError('');
    updateCarrierMassPanel();
  });
});

function hideResults() {
  var table   = document.getElementById('spansh-table');
  var idle    = document.getElementById('spansh-idle');
  var summary = document.getElementById('route-summary');
  if (table)   table.style.display   = 'none';
  if (idle)    idle.style.display     = '';
  if (summary) summary.style.display  = 'none';
  setStatus('Enter a route and click Calculate', '', '');
  showProgress(100);
}

// ─── ROAD TO RICHES OPTION TOGGLES ──────────────────────────────
(function() {
  var mappingBtn = document.getElementById('rtr-mapping-val');
  var thargoidBtn = document.getElementById('rtr-avoid-thargoids');
  var loopBtn = document.getElementById('rtr-loop');

  function bindToggle(btn, key, optObj) {
    if (!btn) return;
    btn.classList.toggle('active', !!optObj[key]);
    btn.addEventListener('click', function() {
      optObj[key] = !optObj[key];
      btn.classList.toggle('active', optObj[key]);
    });
  }
  bindToggle(mappingBtn,  'mappingValue',   _rtrOptions);
  bindToggle(thargoidBtn, 'avoidThargoids', _rtrOptions);
  bindToggle(loopBtn,     'loop',           _rtrOptions);

  // Exomastery toggles
  bindToggle(document.getElementById('exo-avoid-thargoids'), 'avoidThargoids', _exoOptions);
  bindToggle(document.getElementById('exo-loop'),            'loop',           _exoOptions);
})();

// Fleet Carrier type buttons (mutually exclusive)
(function() {
  var btnPlayer    = document.getElementById('fc-type-player');
  var btnSquadron  = document.getElementById('fc-type-squadron');
  var cargoSlider  = document.getElementById('fc-cargo-sl');
  var cargoInput   = document.getElementById('fc-cargo');
  var cargoVal     = document.getElementById('fc-cargo-val');

  function setFcType(type) {
    _fcType = type;
    if (btnPlayer)   btnPlayer.classList.toggle('active',   type === 'player');
    if (btnSquadron) btnSquadron.classList.toggle('active', type === 'squadron');
    var preset = FC_PRESETS[type] || FC_PRESETS.player;

    // Used capacity
    if (cargoSlider) { cargoSlider.value = preset.cargo; sliderFill(cargoSlider); }
    if (cargoInput)  cargoInput.value = preset.cargo;
    if (cargoVal)    cargoVal.textContent = Number(preset.cargo).toLocaleString() + ' t';

    // Tritium in tank
    var fuelSl  = document.getElementById('fc-fuel-sl');
    var fuelInp = document.getElementById('fc-fuel');
    var fuelVal = document.getElementById('fc-fuel-val');
    if (fuelSl)  { fuelSl.value = preset.fuel; sliderFill(fuelSl); }
    if (fuelInp) fuelInp.value = preset.fuel;
    if (fuelVal) fuelVal.textContent = Number(preset.fuel).toLocaleString() + ' t';

    // Tritium in cargo
    var mktSl  = document.getElementById('fc-market-sl');
    var mktInp = document.getElementById('fc-market');
    var mktVal = document.getElementById('fc-market-val');
    if (mktSl)  { mktSl.value = preset.market; sliderFill(mktSl); }
    if (mktInp) mktInp.value = preset.market;
    if (mktVal) mktVal.textContent = Number(preset.market).toLocaleString() + ' t';
  }

  if (btnPlayer)   btnPlayer.addEventListener('click',   function() { setFcType('player'); });
  if (btnSquadron) btnSquadron.addEventListener('click', function() { setFcType('squadron'); });
})();

// ─── CARRIER MASS PANEL: only active in Fleet Carrier tab ────────
function updateCarrierMassPanel() {
  var massSection = document.querySelector('#form-carrier .form-section-title');
  // Find the Carrier Mass section by title text
  var allSections = document.querySelectorAll('#form-carrier .form-section');
  allSections.forEach(function(sec) {
    var title = sec.querySelector('.form-section-title');
    if (title && title.textContent.trim() === 'Carrier Mass') {
      if (_currentPanel === 'carrier') {
        sec.classList.remove('section-disabled');
      } else {
        sec.classList.add('section-disabled');
      }
    }
  });
}

// ─── "USE CURRENT SYSTEM" quick-fill ─────────────────────────────
['from-fill-btn','rtr-fill-btn','exo-fill-btn','fc-fill-btn'].forEach(function(id, i) {
  var btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', function() {
    if (!_liveSystem) return;
    var targets = ['n-from', 'r-from', 'exo-from', 'fc-from'];
    var inp = document.getElementById(targets[i]);
    if (inp) inp.value = _liveSystem;
  });
});

// Show "Use current" buttons if we have a live system
function updateFillBtns() {
  ['from-fill-btn','rtr-fill-btn','exo-fill-btn','fc-fill-btn'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = _liveSystem ? 'inline' : 'none';
  });
}

// ─── SPANSH LINK ──────────────────────────────────────────────────
var spanshLink = document.getElementById('spansh-link');
if (spanshLink) {
  spanshLink.addEventListener('click', function() {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal('https://spansh.co.uk');
    }
  });
}

// ─── COPY SYSTEMS ─────────────────────────────────────────────────
// Tritium requirements button
var fcTritBtn = document.getElementById('fc-tritium-btn');
if (fcTritBtn) {
  fcTritBtn.addEventListener('click', function() {
    if (_isRunning) return;
    showError('');
    stopPoll();
    submitTritiumCalc();
  });
}

var copyBtn = document.getElementById('copy-route-btn');
if (copyBtn) {
  copyBtn.addEventListener('click', function() {
    if (!_lastRoute || !_lastRoute.systems.length) return;
    var text = _lastRoute.systems.join('\n');
    navigator.clipboard.writeText(text).then(function() {
      var orig = copyBtn.textContent;
      copyBtn.textContent = '\u2713 Copied!';
      setTimeout(function() { copyBtn.textContent = orig; }, 1800);
    }).catch(function() {
      // fallback
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  });
}

// ─── POLLING ENGINE ───────────────────────────────────────────────
function stopPoll() {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
}

function pollJob(jobId, onDone, onError) {
  var elapsed = Date.now() - _pollStart;
  if (elapsed > POLL_TIMEOUT) {
    onError('Timed out waiting for Spansh — please try again.');
    return;
  }

  var pct = Math.min(90, Math.round((elapsed / POLL_TIMEOUT) * 100));
  showProgress(pct);
  setStatus('Waiting for Spansh\u2026', 'busy', Math.round(elapsed / 1000) + 's elapsed');

  fetch(SPANSH_BASE + '/api/results/' + encodeURIComponent(jobId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === 'ok') {
        onDone(data);
      } else if (data.status === 'queued' || data.status === 'processing') {
        _pollTimer = setTimeout(function() { pollJob(jobId, onDone, onError); }, POLL_INTERVAL);
      } else if (data.error) {
        onError(data.error);
      } else if (Array.isArray(data) || (typeof data === 'object' && data !== null &&
                 !data.status && Object.keys(data).length > 0)) {
        // Spansh may return results directly without a status wrapper
        onDone(data);
      } else {
        onError('Spansh returned an unexpected status: ' + data.status);
      }
    })
    .catch(function(err) {
      onError('Network error while polling: ' + err.message);
    });
}

// ─── SUBMIT HANDLER ───────────────────────────────────────────────
document.getElementById('spansh-submit').addEventListener('click', function() {
  if (_isRunning) return;
  showError('');
  stopPoll();

  if (_currentPanel === 'neutron')  submitNeutron();
  else if (_currentPanel === 'riches')  submitRiches();
  else if (_currentPanel === 'exobio')  submitExobio();
  else if (_currentPanel === 'carrier') submitCarrier();
  // Reset tritium result when re-routing
  var tritRes = document.getElementById('fc-tritium-result');
  if (tritRes && _currentPanel !== 'carrier') tritRes.style.display = 'none';
});

// ─── NEUTRON ROUTER ───────────────────────────────────────────────
function submitNeutron() {
  var from  = (document.getElementById('n-from')  || {}).value.trim();
  var to    = (document.getElementById('n-to')    || {}).value.trim();
  var range = parseFloat((document.getElementById('n-range') || {}).value) || 0;
  var eff   = parseFloat((document.getElementById('n-eff')   || {}).value) || 60;

  if (!from) { showError('Please enter a source system.'); return; }
  if (!to)   { showError('Please enter a destination system.'); return; }
  if (range < 1) { showError('Jump range must be at least 1 ly.'); return; }

  setRunning(true);
  setStatus('Submitting job to Spansh\u2026', 'busy');
  showProgress(5);
  _pollStart = Date.now();

  var body = new URLSearchParams({ from: from, to: to, range: range, efficiency: eff });

  fetch(SPANSH_BASE + '/api/route', { method: 'POST', body: body })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.job) throw new Error(data.error || 'No job ID returned.');
      pollJob(data.job, renderNeutron, handleApiError);
    })
    .catch(handleApiError);
}

function renderNeutron(data) {
  showProgress(100);
  var route = (data.result && data.result.system_jumps) ? data.result.system_jumps : [];
  if (!route.length) { handleApiError('No route found between these systems. Try adjusting range or efficiency.'); return; }

  var systems = route.map(function(h) { return h.system || h.name || '?'; });
  var totalDist   = 0;
  var neutronHops = 0;
  route.forEach(function(h) {
    totalDist += h.distance_jumped || h.distance || 0;
    if (h.neutron_star || h.is_neutron) neutronHops++;
  });

  _lastRoute = { type: 'neutron', systems: systems };

  // Summary
  set('rsm-jumps',   route.length);
  set('rsm-dist',    fmtLy(totalDist));
  set('rsm-neutron', neutronHops);
  set('rsm-value',   '\u2014');

  showSummary(true);
  setStatus('Route calculated \u2014 ' + route.length + ' jumps', 'ok',
    systems[0] + ' \u2192 ' + systems[systems.length - 1]);

  // Table header — no Star Type column
  document.getElementById('spansh-thead').innerHTML =
    '<tr><th style="width:28px"></th><th style="width:24px"></th><th>System</th><th style="text-align:right">Jump</th><th style="text-align:right">Remaining</th><th style="width:60px"></th></tr>';

  var totalJumps  = route.length;
  var totalRemain = totalDist;
  var tbody = document.getElementById('spansh-tbody');
  var frag  = document.createDocumentFragment();

  route.slice(0, MAX_TABLE_ROWS).forEach(function(h, i) {
    var sys      = h.system || h.name || '?';
    var dist     = h.distance_jumped || h.distance || 0;
    var isNeutron = h.neutron_star || h.is_neutron;
    var isDest   = (i === totalJumps - 1);
    totalRemain -= dist;

    var tr = document.createElement('tr');
    tr.className = i % 2 === 1 ? 'alt-row' : '';

    var sysClass = isDest ? 'hop-sys dest' : (isNeutron ? 'hop-sys neutron' : 'hop-sys');
    var tag = isDest ? '<span class="hop-tag dest">Destination</span>'
            : isNeutron ? '<span class="hop-tag neutron">&#9885; Neutron</span>' : '';

    // visited checkbox
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'row-visited-cb';
    cb.title = 'Mark as visited';
    cb.addEventListener('change', function() { tr.classList.toggle('row-done', cb.checked); });

    // copy button
    var cpBtn = document.createElement('button');
    cpBtn.className = 'row-copy-btn';
    cpBtn.textContent = '⎘ Copy';
    cpBtn.title = 'Copy system name';
    cpBtn.addEventListener('click', function() { copyRowSystem(sys, cpBtn); });

    var cbTd = document.createElement('td');
    cbTd.appendChild(cb);

    var cpTd = document.createElement('td');
    cpTd.appendChild(cpBtn);

    tr.innerHTML =
      '<td><span class="hop-num">' + (i + 1) + '</span></td>' +
      '<td></td>' + // placeholder for cb
      '<td class="' + sysClass + '">' + sys + tag + '</td>' +
      '<td class="hop-dist">' + (dist ? fmtLy(dist) : '\u2014') + '</td>' +
      '<td class="hop-rem">'  + (totalRemain > 0 ? fmtLy(totalRemain) : '0.00 ly') + '</td>' +
      '<td></td>'; // placeholder for copy

    tr.cells[1].replaceWith(cbTd);
    tr.cells[tr.cells.length - 1].replaceWith(cpTd);
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);

  document.getElementById('spansh-idle').style.display  = 'none';
  document.getElementById('spansh-table').style.display = 'table';
  setRunning(false);
}

// ─── ROAD TO RICHES ───────────────────────────────────────────────
function submitRiches() {
  var from    = (document.getElementById('r-from')    || {}).value.trim();
  var to      = (document.getElementById('r-to')      || {}).value.trim();
  var range   = parseFloat((document.getElementById('r-range')   || {}).value) || 0;
  var radius  = parseFloat((document.getElementById('r-maxdist') || {}).value) || 500;
  var results = parseInt((document.getElementById('r-results')   || {}).value) || 100;
  var minVal  = parseInt((document.getElementById('r-minval')    || {}).value) || 0;
  var maxLs   = parseInt((document.getElementById('r-maxls')     || {}).value) || 0;

  if (!from)    { showError('Please enter a starting system.'); return; }
  if (range < 1){ showError('Jump range must be at least 1 ly.'); return; }

  setRunning(true);
  setStatus('Submitting job to Spansh\u2026', 'busy');
  showProgress(5);
  _pollStart = Date.now();

  // Build params to exactly mirror what spansh.co.uk/riches sends
  var bodyParams = new URLSearchParams({
    from:        from,
    range:       range,
    radius:      radius,
    max_results: results,
    min_value:   minVal,
  });

  // Optional destination — omit entirely when blank (circular route)
  if (to) bodyParams.set('to', to);

  // Only send flag params when they are actually ON (matching Spansh's own form)
  if (_rtrOptions.mappingValue)    bodyParams.set('use_mapping_value', 1);
  if (_rtrOptions.avoidThargoids)  bodyParams.set('avoid_thargoids',   1);
  if (_rtrOptions.loop)            bodyParams.set('loop',               1);

  // Max distance to arrival in ls — omit when 0 (no limit)
  if (maxLs > 0) bodyParams.set('max_distance', maxLs);

  console.log('[RTR] POST params:', bodyParams.toString());

  fetch(SPANSH_BASE + '/api/riches/route', { method: 'POST', body: bodyParams })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      console.log('[RTR] POST response:', JSON.stringify(data));
      if (!data.job) throw new Error(data.error || 'No job ID returned.');
      pollJob(data.job, renderRiches, handleApiError);
    })
    .catch(handleApiError);
}

function renderRiches(data) {
  showProgress(100);

  // Extract body array from whatever structure Spansh returns.
  // Spansh has changed this format multiple times; we try every known variant
  // and pick the first non-empty result rather than an if/else chain that can
  // short-circuit on an empty intermediate value.
  function numericEntries(obj) {
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj)
      .filter(function(k) { return k !== '' && !isNaN(Number(k)); })
      .sort(function(a, b) { return Number(a) - Number(b); })
      .map(function(k) { return obj[k]; })
      .filter(function(v) { return v !== null && typeof v === 'object'; });
  }

  var r = data.result;
  var candidates = [
    Array.isArray(data)              ? data              : [],
    Array.isArray(r)                 ? r                 : [],
    r && Array.isArray(r.bodies)     ? r.bodies          : [],
    r && Array.isArray(r.systems)    ? r.systems         : [],
    r && Array.isArray(r.waypoints)  ? r.waypoints       : [],
    r && typeof r === 'object'       ? numericEntries(r) : [],
    numericEntries(data),
  ];

  var route = [];
  for (var ci = 0; ci < candidates.length; ci++) {
    if (candidates[ci].length > 0) { route = candidates[ci]; break; }
  }

  console.log('[RTR] candidates lengths:', candidates.map(function(c){return c.length;}).join(','),
    '| picked:', route.length, '| data keys:', Object.keys(data).slice(0,10).join(','));
  if (route.length > 0) console.log('[RTR] First item:', JSON.stringify(route[0]).slice(0,200));

  if (!route.length) {
    handleApiError('No bodies found. API response keys: ' + Object.keys(data).join(', ') +
      ' | result type: ' + (r === undefined ? 'undefined' : Array.isArray(r) ? 'array['+r.length+']' : typeof r));
    return;
  }

  var systems  = route.map(function(b) { return b.system_name || b.systemName || b.system || '?'; });
  var uniqueSys = systems.filter(function(v, i, a) { return a.indexOf(v) === i; });
  var totalVal = route.reduce(function(acc, b) { return acc + (b.estimated_mapping_value || b.mapping_value || b.value || 0); }, 0);

  _lastRoute = { type: 'riches', systems: uniqueSys };

  set('rsm-jumps',   uniqueSys.length + ' systems');
  set('rsm-dist',    route.length + ' bodies');
  set('rsm-neutron', '\u2014');
  set('rsm-value',   fmtCr(totalVal));

  showSummary(true);
  setStatus('Found ' + route.length + ' valuable bodies in ' + uniqueSys.length + ' systems', 'ok',
    'Est. ' + fmtCr(totalVal) + ' total');

  // Table header
  document.getElementById('spansh-thead').innerHTML =
    '<tr><th style="width:28px"></th><th style="width:24px"></th><th>System</th><th>Body</th><th>Type</th><th style="text-align:right">Distance</th><th style="text-align:right">Map Value</th><th style="width:60px"></th></tr>';

  var tbody = document.getElementById('spansh-tbody');
  var frag  = document.createDocumentFragment();

  route.slice(0, MAX_TABLE_ROWS).forEach(function(b, i) {
    var sys  = b.system_name || b.systemName || b.system || '?';
    var body = b.body_name   || b.bodyName   || b.name   || '?';
    var type = b.subtype     || b.type       || '?';
    var dist = b.distance    || b.distance_to_arrival || null;
    var val  = b.estimated_mapping_value || b.mapping_value || b.value || 0;

    var tr   = document.createElement('tr');
    tr.className = i % 2 === 1 ? 'alt-row' : '';

    var cbTd = document.createElement('td');
    cbTd.appendChild(makeVisitedCb(tr));
    var cpTd = document.createElement('td');
    cpTd.appendChild(makeCopyBtn(sys));

    tr.innerHTML =
      '<td><span class="hop-num">' + (i + 1) + '</span></td>' +
      '<td></td>' +
      '<td class="hop-sys">' + sys + '</td>' +
      '<td style="font-size:0.85em;color:var(--text-dim)">' + body + '</td>' +
      '<td><span class="scan-type-chip">' + type + '</span></td>' +
      '<td class="hop-dist">' + (dist != null ? Number(dist).toFixed(0) + ' ls' : '\u2014') + '</td>' +
      '<td class="hop-val">'  + fmtCr(val) + '</td>' +
      '<td></td>';

    tr.cells[1].replaceWith(cbTd);
    tr.cells[tr.cells.length - 1].replaceWith(cpTd);
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);

  document.getElementById('spansh-idle').style.display  = 'none';
  document.getElementById('spansh-table').style.display = 'table';
  setRunning(false);
}

// ─── EXPRESSWAY TO EXOMASTERY ─────────────────────────────────────
function submitExobio() {
  var from    = (document.getElementById('exo-from')    || {}).value.trim();
  var to      = (document.getElementById('exo-to')      || {}).value.trim();
  var range   = parseFloat((document.getElementById('exo-range')   || {}).value) || 0;
  var radius  = parseFloat((document.getElementById('exo-radius')  || {}).value) || 25;
  var results = parseInt((document.getElementById('exo-results')   || {}).value) || 100;
  var minVal  = parseInt((document.getElementById('exo-minval')    || {}).value) || 0;
  var minBio  = parseInt((document.getElementById('exo-minbio')    || {}).value) || 1;
  var maxLs   = parseInt((document.getElementById('exo-maxls')     || {}).value) || 0;

  if (!from)    { showError('Please enter a starting system.'); return; }
  if (range < 1){ showError('Jump range must be at least 1 ly.'); return; }

  setRunning(true);
  setStatus('Submitting job to Spansh\u2026', 'busy');
  showProgress(5);
  _pollStart = Date.now();

  var body = new URLSearchParams({
    from:        from,
    range:       range,
    radius:      radius,
    max_results: results,
    min_value:   minVal,
    min_bio:     minBio,
  });

  if (to)                         body.set('to',               to);
  if (maxLs > 0)                  body.set('max_distance',     maxLs);
  if (_exoOptions.avoidThargoids) body.set('avoid_thargoids',  1);
  if (_exoOptions.loop)           body.set('loop',              1);

  console.log('[EXO] POST params:', body.toString());

  fetch(SPANSH_BASE + '/api/exobiology/route', { method: 'POST', body: body })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.job) throw new Error(data.error || 'No job ID returned.');
      pollJob(data.job, renderExobio, handleApiError);
    })
    .catch(handleApiError);
}

function renderExobio(data) {
  showProgress(100);

  // Spansh returns an array of SYSTEM objects, each with a nested bodies[] array.
  // Flatten into individual body rows, stamping system name and jumps onto each.
  var systemList = [];
  if (data.result && Array.isArray(data.result))         systemList = data.result;
  else if (data.result && Array.isArray(data.result.systems)) systemList = data.result.systems;
  else if (data.result && Array.isArray(data.result.bodies))  systemList = data.result.bodies;

  var route = [];
  systemList.forEach(function(sys) {
    var sysName = sys.name || sys.system_name || '?';
    var sysJumps = sys.jumps != null ? sys.jumps : '—';
    var bodies = Array.isArray(sys.bodies) ? sys.bodies : [];
    bodies.forEach(function(b) {
      b._sysName = sysName;
      b._sysJumps = sysJumps;
      route.push(b);
    });
  });

  if (!route.length) {
    handleApiError('No organisms found matching your criteria. Try widening the search radius, reducing minimum value, or lowering jump range threshold.');
    return;
  }

  // Unique systems list for summary / copy
  var systems = [];
  var seenSys = {};
  route.forEach(function(b) {
    var s = b._sysName;
    if (!seenSys[s]) { seenSys[s] = true; systems.push(s); }
  });

  var totalVal = route.reduce(function(acc, b) {
    return acc + (b.landmark_value != null ? b.landmark_value : (b.value || b.estimated_value || 0));
  }, 0);
  var totalOrg = route.reduce(function(acc, b) {
    return acc + (typeof b.num_landmarks === 'number' ? b.num_landmarks : (b.count || b.signals || 1));
  }, 0);

  _lastRoute = { type: 'exobio', systems: systems };

  set('rsm-jumps',   systems.length + ' systems');
  set('rsm-dist',    route.length + ' bodies');
  set('rsm-neutron', totalOrg + ' organisms');
  set('rsm-value',   fmtCr(totalVal));

  showSummary(true);
  setStatus('Found ' + route.length + ' bodies with organisms in ' + systems.length + ' systems', 'ok',
    'Est. ' + fmtCr(totalVal) + ' total');

  document.getElementById('spansh-thead').innerHTML =
    '<tr>' +
      '<th style="width:24px"></th>' +
      '<th>System Name</th>' +
      '<th>Body Name</th>' +
      '<th>Subtype</th>' +
      '<th style="text-align:right">Distance (LS)</th>' +
      '<th>Landmark Subtype</th>' +
      '<th style="text-align:right">Count</th>' +
      '<th style="text-align:right">Landmark Value</th>' +
      '<th style="text-align:right">Jumps</th>' +
    '</tr>';

  var tbody = document.getElementById('spansh-tbody');
  var frag  = document.createDocumentFragment();

  route.slice(0, MAX_TABLE_ROWS).forEach(function(b, i) {
    var sys     = b._sysName;
    var jumps   = b._sysJumps;
    var body    = b.name || '?';
    if (body.toLowerCase().startsWith(sys.toLowerCase() + ' ')) body = body.slice(sys.length + 1);
    var subtype = b.subtype || '\u2014';
    var dist    = b.distance_to_arrival != null ? b.distance_to_arrival : null;
    var val     = b.landmark_value || 0;

    // Count = sum of counts across all landmarks on this body
    var count = 0;
    var landmarkSubtype = '\u2014';
    if (Array.isArray(b.landmarks) && b.landmarks.length) {
      var seen = {}; var subtypes = [];
      b.landmarks.forEach(function(lm) {
        count += lm.count || 0;
        var s = lm.subtype || '';
        if (s && !seen[s]) { seen[s] = true; subtypes.push(s); }
      });
      if (subtypes.length) landmarkSubtype = subtypes.join(', ');
    }
    if (!count) count = '\u2014';

    var tr = document.createElement('tr');
    tr.className = i % 2 === 1 ? 'alt-row' : '';

    var cbTd = document.createElement('td');
    cbTd.appendChild(makeVisitedCb(tr));

    tr.innerHTML =
      '<td></td>' +
      '<td class="hop-sys">' + sys + '</td>' +
      '<td style="font-size:0.85em;color:var(--text-dim)">' + body + '</td>' +
      '<td style="font-size:0.85em;">' + subtype + '</td>' +
      '<td class="hop-dist">' + (dist != null ? Number(dist).toFixed(0) : '\u2014') + '</td>' +
      '<td style="font-size:0.8em;">' + landmarkSubtype + '</td>' +
      '<td style="text-align:right;">' + count + '</td>' +
      '<td class="hop-val">'  + fmtCr(val) + '</td>' +
      '<td style="text-align:right;">' + jumps + '</td>';

    tr.cells[0].replaceWith(cbTd);
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);

  document.getElementById('spansh-idle').style.display  = 'none';
  document.getElementById('spansh-table').style.display = 'table';
  setRunning(false);
}

// ─── FLEET CARRIER ROUTER ────────────────────────────────────────
function buildFcParams(from, to, cargo, fuel, market) {
  // Spansh /api/fleetcarrier/route params:
  //   source, destination, tank_size, starting_fuel, used_capacity
  var p = new URLSearchParams({
    source:        from,
    destination:   to,
    tank_size:     1000,
    starting_fuel: fuel,
    used_capacity: cargo,
  });
  return p;
}

function submitCarrier() {
  var from   = (document.getElementById('fc-from')   || {}).value.trim();
  var to     = (document.getElementById('fc-to')     || {}).value.trim();
  var cargo  = parseFloat((document.getElementById('fc-cargo')  || {}).value) || 0;
  var fuel   = parseFloat((document.getElementById('fc-fuel')   || {}).value) || 1000;
  var market = parseFloat((document.getElementById('fc-market') || {}).value) || 0;

  if (!from) { showError('Please enter a source system.'); return; }
  if (!to)   { showError('Please enter a destination system.'); return; }

  var tritRes = document.getElementById('fc-tritium-result');
  if (tritRes) tritRes.style.display = 'none';

  setRunning(true);
  setStatus('Submitting FC route to Spansh\u2026', 'busy');
  showProgress(5);
  _pollStart = Date.now();

  var body = buildFcParams(from, to, cargo, fuel, market);
  console.log('[FC] POST params:', body.toString());

  fetch(SPANSH_BASE + '/api/fleetcarrier/route', { method: 'POST', body: body })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      console.log('[FC] POST response:', JSON.stringify(data));
      if (!data.job) throw new Error(data.error || 'No job ID returned.');
      pollJob(data.job, renderCarrier, handleApiError);
    })
    .catch(handleApiError);
}

function submitTritiumCalc() {
  var from   = (document.getElementById('fc-from')   || {}).value.trim();
  var to     = (document.getElementById('fc-to')     || {}).value.trim();
  var cargo  = parseFloat((document.getElementById('fc-cargo')  || {}).value) || 0;
  var fuel   = parseFloat((document.getElementById('fc-fuel')   || {}).value) || 1000;
  var market = parseFloat((document.getElementById('fc-market') || {}).value) || 0;

  if (!from) { showError('Please enter a source system.'); return; }
  if (!to)   { showError('Please enter a destination system.'); return; }

  setRunning(true);
  setStatus('Calculating tritium requirements\u2026', 'busy');
  showProgress(5);
  _pollStart = Date.now();

  var body = buildFcParams(from, to, cargo, fuel, market);

  fetch(SPANSH_BASE + '/api/fleetcarrier/route', { method: 'POST', body: body })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.job) throw new Error(data.error || 'No job ID returned.');
      pollJob(data.job, renderTritiumResult, handleApiError);
    })
    .catch(handleApiError);
}


function renderTritiumResult(data) {
  showProgress(100);
  var route = [];
  if (data.result && Array.isArray(data.result.jumps))        route = data.result.jumps;
  else if (data.result && Array.isArray(data.result.systems)) route = data.result.systems;
  else if (Array.isArray(data.result))                        route = data.result;

  if (!route.length) { handleApiError('Could not calculate route. Check system names.'); return; }

  var totalFuel = 0;
  var totalDist = 0;
  route.forEach(function(h) {
    totalFuel += h.fuel_used || h.tritium_used || 0;
    totalDist += h.distance  || h.distance_jumped || 0;
  });
  totalFuel = Math.ceil(totalFuel);

  var tritRes    = document.getElementById('fc-tritium-result');
  var tritAmount = document.getElementById('fc-tritium-amount');
  var tritDetail = document.getElementById('fc-tritium-detail');
  if (tritAmount) tritAmount.textContent = Number(totalFuel).toLocaleString() + ' t tritium';
  if (tritDetail) tritDetail.textContent =
    route.length + ' jumps · ' + fmtLy(totalDist) +
    ' · approx. ' + Math.ceil(totalFuel / 1000 * 100) / 100 + '× full tanks';
  if (tritRes) tritRes.style.display = 'block';

  setStatus('Tritium needed: ' + Number(totalFuel).toLocaleString() + ' t across ' + route.length + ' jumps', 'ok', fmtLy(totalDist));
  setRunning(false);
}

function renderCarrier(data) {
  showProgress(100);
  var route = [];
  if (data.result && Array.isArray(data.result.jumps))  route = data.result.jumps;
  else if (data.result && Array.isArray(data.result.systems)) route = data.result.systems;
  else if (Array.isArray(data.result)) route = data.result;

  if (!route.length) {
    handleApiError('No route found. Check system names and ensure you have enough tritium for the journey.');
    return;
  }

  var systems       = route.map(function(h) { return h.system || h.name || '?'; });
  var totalDist     = 0;
  var totalFuel     = 0;
  route.forEach(function(h) {
    totalDist += h.distance || h.distance_jumped || 0;
    totalFuel += h.fuel_used || h.tritium_used   || 0;
  });

  _lastRoute = { type: 'carrier', systems: systems };

  set('rsm-jumps',   route.length + ' hops');
  set('rsm-dist',    fmtLy(totalDist));
  set('rsm-neutron', totalFuel > 0 ? Math.ceil(totalFuel) + ' t tritium' : '\u2014');
  set('rsm-value',   '\u2014');

  showSummary(true);
  setStatus('FC route: ' + route.length + ' hops, ' + fmtLy(totalDist), 'ok',
    systems[0] + ' \u2192 ' + systems[systems.length - 1]);

  document.getElementById('spansh-thead').innerHTML =
    '<tr>' +
      '<th style="width:28px"></th>' +
      '<th style="width:24px"></th>' +
      '<th>System</th>' +
      '<th style="text-align:center">Icy Ring</th>' +
      '<th style="text-align:center">Pristine</th>' +
      '<th style="text-align:right">Hop Dist</th>' +
      '<th style="text-align:right">Fuel Used</th>' +
      '<th style="text-align:right">Remaining</th>' +
      '<th style="width:60px"></th>' +
    '</tr>';

  var tbody    = document.getElementById('spansh-tbody');
  var frag     = document.createDocumentFragment();
  var fuelLeft = parseFloat((document.getElementById('fc-fuel') || {}).value) || 1000;

  route.slice(0, MAX_TABLE_ROWS).forEach(function(h, i) {
    var sys       = h.system      || h.name    || '?';
    var dist      = h.distance    || h.distance_jumped || 0;
    var fuelUsed  = h.fuel_used   || h.tritium_used    || null;
    var icy       = h.icy_ring    || h.has_icy_ring     || false;
    var pristine  = h.pristine    || h.is_pristine      || false;
    var restock   = h.restock_tritium || false;
    var isDest    = (i === route.length - 1);
    var remDisplay = h.distance_remaining != null
      ? fmtLy(h.distance_remaining)
      : (i === route.length - 1 ? '0.00 ly' : '\u2014');

    var sysClass = isDest ? 'hop-sys dest' : 'hop-sys';
    var destTag  = isDest ? '<span class="hop-tag dest">Destination</span>' : '';
    var restTag  = restock ? '<span class="hop-tag" style="background:rgba(200,151,42,0.1);color:var(--gold);border:1px solid rgba(200,151,42,0.25);">&#9670; Restock</span>' : '';
    var icyMark  = icy      ? '<span style="color:var(--cyan)">&#10003;</span>'  : '<span style="color:var(--border2)">&#8212;</span>';
    var prMark   = pristine ? '<span style="color:var(--green)">&#10003;</span>' : '<span style="color:var(--border2)">&#8212;</span>';

    var tr = document.createElement('tr');
    tr.className = i % 2 === 1 ? 'alt-row' : '';

    var cbTd = document.createElement('td');
    cbTd.appendChild(makeVisitedCb(tr));
    var cpTd = document.createElement('td');
    cpTd.appendChild(makeCopyBtn(sys));

    tr.innerHTML =
      '<td><span class="hop-num">' + (i + 1) + '</span></td>' +
      '<td></td>' +
      '<td class="' + sysClass + '">' + sys + destTag + restTag + '</td>' +
      '<td style="text-align:center">' + icyMark + '</td>' +
      '<td style="text-align:center">' + prMark + '</td>' +
      '<td class="hop-dist">' + (dist ? fmtLy(dist) : '\u2014') + '</td>' +
      '<td style="text-align:right;color:var(--gold)">' + (fuelUsed != null ? Math.ceil(fuelUsed) + ' t' : '\u2014') + '</td>' +
      '<td class="hop-rem">' + remDisplay + '</td>' +
      '<td></td>';

    tr.cells[1].replaceWith(cbTd);
    tr.cells[tr.cells.length - 1].replaceWith(cpTd);
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);

  document.getElementById('spansh-idle').style.display  = 'none';
  document.getElementById('spansh-table').style.display = 'table';
  setRunning(false);
}

// ─── ERROR HANDLER ────────────────────────────────────────────────
function handleApiError(err) {
  stopPoll();
  setRunning(false);
  showProgress(100);
  var msg = typeof err === 'string' ? err : (err && err.message ? err.message : 'Unknown error');
  setStatus('Error: ' + msg, 'error');
  showError(msg);
}

// ─── SUMMARY STRIP ────────────────────────────────────────────────
function showSummary(yes) {
  var el = document.getElementById('route-summary');
  if (el) el.style.display = yes ? 'flex' : 'none';
  // Show value column for riches and exobio; neutron col label changes per panel
  var valEl  = document.getElementById('rsm-value')   ? document.getElementById('rsm-value').parentElement   : null;
  var valSep = valEl ? valEl.previousElementSibling : null;
  var neuEl  = document.getElementById('rsm-neutron') ? document.getElementById('rsm-neutron').parentElement : null;
  var neuSep = neuEl ? neuEl.previousElementSibling : null;

  var showVal = (_currentPanel === 'riches' || _currentPanel === 'exobio');
  var showNeu = (_currentPanel !== 'neutron' && _currentPanel !== 'riches') || _currentPanel === 'neutron';

  if (valEl)  valEl.style.display  = showVal ? '' : 'none';
  if (valSep) valSep.style.display = showVal ? '' : 'none';

  // Relabel "Neutron Hops" column contextually
  var neuLbl = document.querySelector('#rsm-neutron + .rsm-lbl, #rsm-neutron ~ .rsm-lbl');
  // Actually just find the .rsm-lbl sibling inside neuEl
  if (neuEl) {
    var lbl = neuEl.querySelector('.rsm-lbl');
    if (lbl) {
      if (_currentPanel === 'carrier')  lbl.textContent = 'Tritium';
      else if (_currentPanel === 'exobio') lbl.textContent = 'Organisms';
      else lbl.textContent = 'Neutron Hops';
    }
    neuEl.style.display = '';
    var neuSepEl = neuEl.previousElementSibling;
    if (neuSepEl && neuSepEl.classList.contains('rsm-sep')) neuSepEl.style.display = '';
  }
}

// ─── IPC FROM ELECTRON ────────────────────────────────────────────
if (window.electronAPI) {

  window.electronAPI.onLiveData(function(d) {
    if (d.name)          set('tb-cmdr', 'CMDR ' + d.name);
    if (d.currentSystem) { set('tb-sys', d.currentSystem); _liveSystem = d.currentSystem; updateFillBtns(); }
    if (d.credits != null) set('tb-credits', Number(d.credits).toLocaleString() + ' CR');

    // Autofill jump range if available
    if (d.maxJumpRange) {
      _liveJumpRange = parseJumpRange(d.maxJumpRange);
      if (_liveJumpRange) {
        ['n-range','r-range','exo-range'].forEach(function(id) {
          var inp = document.getElementById(id);
          var sl  = document.getElementById(id + '-sl');
          if (inp && !inp._manualEdit) {
            inp.value = _liveJumpRange.toFixed(2);
            if (sl) { sl.value = _liveJumpRange; sliderFill(sl); }
          }
        });
        set('n-range-val',   _liveJumpRange.toFixed(2) + ' ly');
        set('r-range-val',   _liveJumpRange.toFixed(2) + ' ly');
        set('exo-range-val', _liveJumpRange.toFixed(2) + ' ly');
      }
    }

    var star = document.getElementById('tb-discovery-star');
    if (star) star.style.display = d.lastJumpWasFirstDiscovery ? 'inline' : 'none';
  });

}

// ─── MARK MANUAL EDITS so autofill doesn't override ──────────────
['n-range','r-range','exo-range'].forEach(function(id) {
  var inp = document.getElementById(id);
  if (inp) inp.addEventListener('input', function() { inp._manualEdit = true; });
});

// ─── SLIDER BINDINGS ─────────────────────────────────────────────
bindSliderPair('n-range-sl',    'n-range',    'n-range-val',    function(v) { return v.toFixed(2) + ' ly'; });
bindSliderPair('n-eff-sl',      'n-eff',      'n-eff-val',      function(v) { return v + '%'; });
bindSliderPair('r-range-sl',    'r-range',    'r-range-val',    function(v) { return v.toFixed(2) + ' ly'; });
bindSliderPair('r-maxdist-sl',  'r-maxdist',  'r-maxdist-val',  function(v) { return Number(v).toLocaleString() + ' ly'; });
bindSliderPair('r-results-sl',  'r-results',  'r-results-val',  function(v) { return v; });
bindSliderPair('r-minval-sl',   'r-minval',   'r-minval-val',   function(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' M cr';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K cr';
  return v + ' cr';
});
bindSliderPair('r-maxls-sl',    'r-maxls',    'r-maxls-val',    function(v) {
  return v === 0 ? 'No limit' : Number(v).toLocaleString() + ' ls';
});
// Exobiology sliders
bindSliderPair('exo-range-sl',  'exo-range',  'exo-range-val',  function(v) { return v.toFixed(2) + ' ly'; });
bindSliderPair('exo-radius-sl', 'exo-radius', 'exo-radius-val', function(v) { return Number(v).toLocaleString() + ' ly'; });
bindSliderPair('exo-maxls-sl',  'exo-maxls',  'exo-maxls-val',  function(v) { return v === 0 ? 'No limit' : Number(v).toLocaleString() + ' ls'; });
bindSliderPair('exo-results-sl','exo-results','exo-results-val',function(v) { return v; });
bindSliderPair('exo-minval-sl', 'exo-minval', 'exo-minval-val', function(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' M cr';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K cr';
  return v + ' cr';
});
bindSliderPair('exo-minbio-sl', 'exo-minbio', 'exo-minbio-val', function(v) { return v; });
// Fleet Carrier sliders
bindSliderPair('fc-cargo-sl',  'fc-cargo',  'fc-cargo-val',  function(v) { return Number(v).toLocaleString() + ' t'; });
bindSliderPair('fc-fuel-sl',   'fc-fuel',   'fc-fuel-val',   function(v) { return Number(v).toLocaleString() + ' t'; });
bindSliderPair('fc-market-sl', 'fc-market', 'fc-market-val', function(v) { return Number(v).toLocaleString() + ' t'; });

// ─── ALLOW PRESSING ENTER TO SUBMIT ──────────────────────────────
document.querySelectorAll('.field-input').forEach(function(inp) {
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('spansh-submit').click();
  });
});

// ─── OPTIONS PANEL ────────────────────────────────────────────────
function openOptions() {
  document.getElementById('options-panel').classList.add('open');
  document.getElementById('options-overlay').classList.add('open');
  if (!window.electronAPI) return;
  window.electronAPI.getJournalPath()
    .then(function(p) { if (p) document.getElementById('opt-journal-path').value = p; })
    .catch(function() {});
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

var openFolderBtn = document.getElementById('opt-open-btn');
if (openFolderBtn) openFolderBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  try { await window.electronAPI.openJournalFolder(document.getElementById('opt-journal-path').value.trim() || null); }
  catch {}
});

var journalPathInp = document.getElementById('opt-journal-path');
if (journalPathInp) journalPathInp.addEventListener('change', async function() {
  if (!window.electronAPI) return;
  var val = journalPathInp.value.trim();
  try {
    await window.electronAPI.saveJournalPath(val);
    document.getElementById('opt-path-hint').textContent = val
      ? 'Path saved \u2014 restart to apply'
      : 'Leave blank to use the default path for your OS';
    document.getElementById('opt-path-hint').style.color = val ? 'var(--green)' : '';
  } catch {}
});

// ─── THEMES ──────────────────────────────────────────────────────
var THEMES = {
  default: { '--gold':'#c8972a','--gold2':'#e8b840','--gold-dim':'#7a5a10','--gold-glow':'rgba(200,151,42,0.15)','--cyan':'#2ecfcf','--cyan2':'#5ee8e8','--cyan-dim':'rgba(46,207,207,0.1)' },
  red:     { '--gold':'#e05252','--gold2':'#f07070','--gold-dim':'#a03030','--gold-glow':'rgba(224,82,82,0.15)', '--cyan':'#cf7a3e','--cyan2':'#e89060','--cyan-dim':'rgba(207,122,62,0.1)'  },
  green:   { '--gold':'#4caf7d','--gold2':'#70d090','--gold-dim':'#2a7a50','--gold-glow':'rgba(76,175,125,0.15)','--cyan':'#a0cf3e','--cyan2':'#c0e060','--cyan-dim':'rgba(160,207,62,0.1)' },
  purple:  { '--gold':'#a855f7','--gold2':'#c080ff','--gold-dim':'#7a30c0','--gold-glow':'rgba(168,85,247,0.15)','--cyan':'#cf3ecf','--cyan2':'#e060e0','--cyan-dim':'rgba(207,62,207,0.1)'  },
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

// ─── DISPLAY SLIDERS (abbreviated — scale, font, bright, scan, glow) ──
var SLIDER_DEFAULTS = { scale:100, font:12, bright:100, scan:1, glow:100 };
var SCAN_LABELS     = ['Off','Low','Medium','High','Intense','Max'];
var scanlineStyle   = document.createElement('style');
scanlineStyle.id    = 'dynamic-scanlines';
document.head.appendChild(scanlineStyle);

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
    case 'bright':
      if (wrap) wrap.style.filter = 'brightness(' + (v/100) + ') saturate(' + (0.8 + (v/100)*0.4) + ')';
      break;
    case 'scan':
      if (v === 0) { scanlineStyle.textContent = 'body::after { display:none; }'; }
      else {
        var op  = [0.02,0.04,0.07,0.11,0.16][v-1];
        var gap = [4,4,3,3,2][v-1];
        scanlineStyle.textContent = 'body::after { background: repeating-linear-gradient(0deg,transparent,transparent '+(gap-1)+'px,rgba(0,0,0,'+op+') '+(gap-1)+'px,rgba(0,0,0,'+op+') '+gap+'px) !important; }';
      }
      break;
    case 'glow':
      var g = v/100;
      root.style.setProperty('--gold-glow', 'rgba(200,151,42,'+(0.15*g)+')');
      var gs = document.getElementById('glow-style') || document.createElement('style');
      gs.id  = 'glow-style';
      gs.textContent = '.tb-logo { text-shadow: 0 0 '+Math.round(16*g)+'px var(--gold-glow) !important; }';
      document.head.appendChild(gs);
      break;
  }
}

function sliderFillOpt(input) {
  var min = parseFloat(input.min), max = parseFloat(input.max), v = parseFloat(input.value);
  input.style.setProperty('--fill', Math.round(((v-min)/(max-min))*100) + '%');
}
function updateSliderUI(key, v) {
  var el = document.getElementById('sv-' + key);
  if (!el) return;
  switch (key) {
    case 'scale':  el.textContent = Math.round(v) + '%'; break;
    case 'font':   el.textContent = v + 'px'; break;
    case 'bright': el.textContent = v + '%'; break;
    case 'scan':   el.textContent = SCAN_LABELS[v] || v; break;
    case 'glow':   el.textContent = v + '%'; break;
  }
}
function loadDisplaySettings() {
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('ee-display') || '{}'); } catch {}
  Object.keys(SLIDER_DEFAULTS).forEach(function(key) {
    var v   = saved[key] != null ? saved[key] : SLIDER_DEFAULTS[key];
    var inp = document.getElementById('sl-' + key);
    if (inp) { inp.value = v; sliderFillOpt(inp); }
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
    sliderFillOpt(inp);
    updateSliderUI(key, v);
    applyDisplay(key, v);
    saveDisplaySettings();
  });
});
var resetBtn = document.getElementById('sl-reset-all');
if (resetBtn) resetBtn.addEventListener('click', function() {
  Object.keys(SLIDER_DEFAULTS).forEach(function(key) {
    var inp = document.getElementById('sl-' + key);
    if (inp) { inp.value = SLIDER_DEFAULTS[key]; sliderFillOpt(inp); }
    updateSliderUI(key, SLIDER_DEFAULTS[key]);
    applyDisplay(key, SLIDER_DEFAULTS[key]);
  });
  localStorage.removeItem('ee-display');
});
loadDisplaySettings();

// Initialise carrier mass panel state (disabled unless on Fleet Carrier tab)
updateCarrierMassPanel();
