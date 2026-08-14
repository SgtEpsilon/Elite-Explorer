/**
 * exobiology-script.js
 * Standalone script for exobiology.html only.
 * No coupling to script.js, journalProvider, or the live/profile scans.
 *
 * Renders the lifetime genus/species catalog built by exobiologyProvider.js
 * (backed by exobiologyWorker.js — a full journal scan, same pattern as
 * History). Credits earned come straight from the commander's own
 * SellOrganicData journal events rather than a hand-maintained value table,
 * so payout numbers stay accurate even after Frontier rebalances exobiology.
 */

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function set(id, v) {
  var el = document.getElementById(id);
  if (el) el.textContent = (v != null ? v : '\u2014');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ─── STATE ────────────────────────────────────────────────────────────────────
var _allSpecies = [];
var _isScanning = false;

// ─── DISPLAY NAME HELPERS ───────────────────────────────────────────────────
// A "raw" fallback key (e.g. "$Codex_Ent_Bacterial_Genus_Name;") only shows up
// if the localized name is missing — happens if a journal was written before
// the game populated *_Localised fields, or the commander is playing in a
// locale we haven't seen. Strip the Codex wrapper so it's at least readable.
function prettyFallback(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/^\$Codex_Ent_/, '').replace(/^\$/, '').replace(/;$/, '')
    .replace(/_Name$/, '').replace(/_/g, ' ');
}

function genusDisplayName(rec) {
  return rec.genusName || prettyFallback(rec.genus) || 'Unknown Genus';
}

function speciesDisplayName(rec) {
  // Prefer the variant name when present — that's the specific thing you
  // actually scanned (e.g. "Bactrus Ostrinum" is a Species; some genera also
  // subdivide into Variants like colour morphs).
  return rec.variantName || rec.speciesName || prettyFallback(rec.species) || 'Unknown Species';
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function passesFilters(rec) {
  var discoOnly = document.getElementById('exo-filter-disco').checked;
  var soldOnly  = document.getElementById('exo-filter-sold').checked;
  var q = (document.getElementById('exo-search').value || '').trim().toLowerCase();

  if (discoOnly && !rec.firstDiscovery) return false;
  if (soldOnly && !rec.timesSold) return false;

  if (q) {
    var hay = (genusDisplayName(rec) + ' ' + speciesDisplayName(rec)).toLowerCase();
    if (hay.indexOf(q) === -1) return false;
  }
  return true;
}

function renderCatalog() {
  var list     = document.getElementById('exo-genus-list');
  var empty    = document.getElementById('exo-empty');
  var statsBar = document.getElementById('exo-stats-bar');
  var scanning = document.getElementById('exo-scanning');
  if (!list) return;

  if (scanning) scanning.style.display = 'none';

  if (!_allSpecies.length) {
    if (empty)    empty.style.display    = _isScanning ? 'none' : 'flex';
    if (list)     list.style.display     = 'none';
    if (statsBar) statsBar.style.display = 'none';
    return;
  }

  var filtered = _allSpecies.filter(passesFilters);

  if (empty)    empty.style.display = filtered.length ? 'none' : 'flex';
  if (list)     list.style.display  = 'block';
  if (statsBar) statsBar.style.display = 'flex';

  // ── Lifetime stats (computed off the FULL catalog, not the filtered view) ──
  var totalCredits = 0, totalIndividuals = 0, discoCount = 0;
  var generaSeen = {};
  _allSpecies.forEach(function (rec) {
    totalCredits     += rec.creditsEarned || 0;
    totalIndividuals += rec.individualsFound || 0;
    if (rec.firstDiscovery) discoCount++;
    generaSeen[genusDisplayName(rec)] = true;
  });
  set('estat-species',     _allSpecies.length.toLocaleString());
  set('estat-genera',      Object.keys(generaSeen).length.toLocaleString());
  set('estat-disco',       discoCount.toLocaleString());
  set('estat-individuals', totalIndividuals.toLocaleString());
  set('estat-credits',     totalCredits.toLocaleString() + ' CR');

  // ── Group filtered results by genus ─────────────────────────────────────
  var byGenus = {};
  filtered.forEach(function (rec) {
    var g = genusDisplayName(rec);
    (byGenus[g] = byGenus[g] || []).push(rec);
  });
  var genera = Object.keys(byGenus).sort();

  var frag = document.createDocumentFragment();

  genera.forEach(function (genus) {
    var recs = byGenus[genus].slice().sort(function (a, b) {
      return speciesDisplayName(a).localeCompare(speciesDisplayName(b));
    });

    var section = document.createElement('div');
    section.className = 'exo-genus-section';

    var header = document.createElement('div');
    header.className = 'exo-genus-header';
    header.innerHTML =
      '<span class="exo-genus-name">' + esc(genus) + '</span>' +
      '<span class="exo-genus-count">' + recs.length + ' species logged</span>';
    section.appendChild(header);

    var grid = document.createElement('div');
    grid.className = 'exo-species-grid';

    recs.forEach(function (rec) {
      var card = document.createElement('div');
      card.className = 'exo-species-card';

      var discoBadge = rec.firstDiscovery
        ? '<span class="exo-disco-star" title="First logged by you \u2014 5x payout bonus applied">&#9733;</span>'
        : '';

      var soldBadge = rec.timesSold
        ? '<span class="exo-sold-badge" title="Sold to Vista Genomics">&#10003; SOLD</span>'
        : '<span class="exo-unsold-badge" title="Logged but not yet sold">NOT SOLD</span>';

      var firstSeenLine = rec.firstSeenAt
        ? (rec.firstSystem || '\u2014') + (rec.firstBody ? ' \u2014 ' + rec.firstBody : '') +
          '<br>' + rec.firstSeenAt.replace('T', ' ').slice(0, 19)
        : '\u2014';

      card.innerHTML =
        '<div class="exo-card-top">' +
          '<span class="exo-species-name">' + esc(speciesDisplayName(rec)) + '</span>' +
          discoBadge +
        '</div>' +
        '<div class="exo-card-row">' + soldBadge + '</div>' +
        '<div class="exo-card-stats">' +
          '<div><span class="exo-stat-label">Individuals</span><span class="exo-stat-val">' + (rec.individualsFound || 0) + '</span></div>' +
          '<div><span class="exo-stat-label">Sold</span><span class="exo-stat-val">' + (rec.timesSold || 0) + '</span></div>' +
          '<div><span class="exo-stat-label">Credits</span><span class="exo-stat-val exo-stat-credits">' + (rec.creditsEarned || 0).toLocaleString() + '</span></div>' +
        '</div>' +
        '<div class="exo-card-first">' + firstSeenLine + '</div>';

      grid.appendChild(card);
    });

    section.appendChild(grid);
    frag.appendChild(section);
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

// ─── SCAN STATUS ──────────────────────────────────────────────────────────────
function showScanStatus(text, color) {
  var el = document.getElementById('exo-scan-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || 'var(--text-dim)';
}

function updateProgressBar(pct) {
  var bar  = document.getElementById('exo-progress-bar');
  var wrap = document.getElementById('exo-progress-wrap');
  if (wrap) wrap.style.display = pct < 100 ? 'flex' : 'none';
  if (bar)  bar.style.width    = Math.min(100, pct) + '%';
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
if (window.electronAPI) {

  // Top bar name / credits from live-data (shared across all pages)
  window.electronAPI.onLiveData(function (d) {
    if (d.name)            set('tb-cmdr', 'CMDR ' + d.name);
    if (d.credits != null) set('tb-credits', Number(d.credits).toLocaleString() + ' CR');
    if (d.currentSystem)   set('tb-sys', d.currentSystem);
    var star = document.getElementById('tb-discovery-star');
    if (star) star.style.display = d.lastJumpWasFirstDiscovery ? 'inline' : 'none';
  });

  window.electronAPI.onExobiologyScanStart(function (d) {
    _isScanning = true;
    showScanStatus('Scanning ' + d.totalFiles + ' journal file(s)\u2026', 'var(--gold)');
    updateProgressBar(0);

    var scanning = document.getElementById('exo-scanning');
    if (scanning && !_allSpecies.length) scanning.style.display = 'flex';
  });

  window.electronAPI.onExobiologyProgress(function (d) {
    var overall = Math.round(((d.fileIndex - 1 + d.currentLine / d.totalLines) / d.totalFiles) * 100);
    showScanStatus(
      'File ' + d.fileIndex + ' / ' + d.totalFiles +
      ' \u00B7 ' + d.speciesFound.toLocaleString() + ' species found',
      'var(--text-dim)'
    );
    updateProgressBar(overall);
  });

  window.electronAPI.onExobiologyData(function (data) {
    _isScanning  = false;
    _allSpecies  = data || [];
    showScanStatus(
      _allSpecies.length.toLocaleString() + ' species logged across all journals',
      'var(--cyan)'
    );
    updateProgressBar(100);
    set('exo-count', _allSpecies.length ? _allSpecies.length.toLocaleString() + ' species' : null);
    renderCatalog();
  });

  window.electronAPI.onExobiologyPathMissing(function (p) {
    showScanStatus('Journal folder not found: ' + p, 'var(--red)');
    _isScanning = false;
    updateProgressBar(100);
  });

  var rescanBtn = document.getElementById('exo-rescan-btn');
  if (rescanBtn) {
    rescanBtn.addEventListener('click', function () {
      if (_isScanning) return;
      window.electronAPI.triggerExobiologyScan();
      showScanStatus('Scan triggered\u2026', 'var(--gold)');
    });
  }
}

// ─── FILTERS ──────────────────────────────────────────────────────────────────
['exo-filter-disco', 'exo-filter-sold'].forEach(function (id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener('change', renderCatalog);
});
var searchEl = document.getElementById('exo-search');
if (searchEl) {
  var debounceTimer = null;
  searchEl.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderCatalog, 150);
  });
}
