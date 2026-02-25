/**
 * history-script.js
 * Standalone script for history.html only.
 * No coupling to script.js, journalProvider, or the live/profile scans.
 *
 * NEW in this version:
 *   - EDSM discovery check: after the history loads, we cross-reference every
 *     system in your journal against EDSM's database. Systems that EDSM doesn't
 *     know about get an extra ⭐ "EDSM Undiscovered" indicator — meaning you
 *     likely got to them before anyone else reported them to EDSM.
 *
 *   NOTE: This is different from the journal's SystemAlreadyDiscovered flag.
 *   The journal flag comes from the game servers (FC) at jump time.
 *   The EDSM flag is about whether anyone has *reported* the system to EDSM.
 *   They're related but not identical — a system can be "discovered" in-game
 *   but not yet in EDSM if nobody submitted their journal data.
 */

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function set(id, v) {
  var el = document.getElementById(id);
  if (el) el.textContent = (v != null ? v : '\u2014');
}

// ─── STATE ────────────────────────────────────────────────────────────────────
var _allJumps   = [];
var _isScanning = false;

// Cache for EDSM discovery results.
// Key = system name (lowercase), value = { discovered: bool|null, checked: true }
// We store this so navigating away and back doesn't re-check everything.
var edsmResultsCache = {};

// Cache for star class / body count enrichment from EDSM.
// Key = system name (lowercase), value = { starClass: string|null, bodyCount: number|null }
var enrichmentCache = {};

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

    // Store the system name on the row so EDSM check can find it later
    if (j.system) tr.dataset.systemName = j.system;
    tr.dataset.idx = idx;

    var ts        = j.timestamp ? j.timestamp.replace('T', ' ').slice(0, 19) : '\u2014';
    var dist      = j.jumpDist  != null ? j.jumpDist.toFixed(2) + ' ly' : '\u2014';
    var bodyCount = j.bodyCount != null ? j.bodyCount : '\u2014';

    // Pre-fill star class and body count from enrichment cache if journal data is missing
    var starClass = j.starClass || null;
    var cacheKeyE = (j.system || '').toLowerCase();
    if (enrichmentCache[cacheKeyE]) {
      if (!starClass && enrichmentCache[cacheKeyE].starClass) starClass = enrichmentCache[cacheKeyE].starClass;
      if (bodyCount === '\u2014' && enrichmentCache[cacheKeyE].bodyCount != null) bodyCount = enrichmentCache[cacheKeyE].bodyCount;
    }

    // Mark rows that still need enrichment so the enrichment pass can find them
    if (!starClass)         tr.dataset.needsStar   = '1';
    if (bodyCount === '\u2014') tr.dataset.needsBodies = '1';

    // Journal first-discovery star (from game servers at jump time)
    var disco = !j.wasDiscovered
      ? '<span class="disco-star" title="First Discovery \u2014 game servers confirmed you found this!">&#9733;</span>'
      : '';

    // ImportStars.txt badge — cyan star after the system name
    var importBadge = j.isImportedStar
      ? '<span class="import-star-badge" title="First discovery imported from EDSM ImportStars.txt">&#9733;</span>'
      : '';

    // EDSM undiscovered cell — starts empty, filled in after EDSM check
    // We look up cached results immediately in case the user navigated back
    var edsmCell = '';
    var cacheKey = (j.system || '').toLowerCase();
    if (edsmResultsCache[cacheKey]) {
      var cached = edsmResultsCache[cacheKey];
      if (cached.discovered === false) {
        edsmCell = '<span class="edsm-undiscovered" title="Not in EDSM \u2014 you may have been first to report this system!">&#11088;</span>';
      } else if (cached.discovered === null) {
        edsmCell = '<span class="edsm-unknown" title="EDSM check failed">?</span>';
      }
    }

    tr.innerHTML =
      '<td class="hist-col-disco">'  + disco + '</td>' +
      '<td class="hist-col-sys">'    + (j.system || '\u2014') + importBadge + '</td>' +
      '<td class="hist-col-ts">'     + ts + '</td>' +
      '<td class="hist-col-dist">'   + dist + '</td>' +
      '<td class="hist-col-star">'   + (starClass || '\u2014') + '</td>' +
      '<td class="hist-col-bodies">' + bodyCount + '</td>' +
      '<td class="hist-col-edsm">'   + edsmCell + '</td>';

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

// ─── EDSM STAR CLASS + BODY COUNT ENRICHMENT ─────────────────────────────────
//
// After history renders, any rows where the journal didn't record StarClass or
// Body_count are queued for enrichment from EDSM's bodies API.
// Results are cached so back-navigation and re-filters don't re-fetch.
// Runs AFTER the discovery check so the two don't compete for rate limit budget.

var _enrichInProgress  = false;
var _enrichQueue       = [];   // pending after discovery check finishes

function updateEnrichStatus(done, total, finished) {
  var el = document.getElementById('edsm-check-status');
  if (!el) return;
  if (finished && total === 0) {
    el.textContent = 'EDSM: all systems enriched';
  } else if (finished) {
    el.textContent = 'EDSM: enriched ' + done + ' / ' + total + ' systems';
  } else {
    el.textContent = 'EDSM: enriching ' + done + ' / ' + total + ' \u2026';
  }
  var bar = document.getElementById('edsm-progress-bar-inner');
  if (bar && total > 0) bar.style.width = Math.round((done / total) * 100) + '%';
  if (bar && finished)  bar.style.width = '100%';
}

function runEnrichment() {
  if (!window.electronAPI || !window.electronAPI.enrichHistoryBulk) return;
  if (_enrichInProgress) return;

  // Collect rows that still need star class or body count
  var rows = document.querySelectorAll('#hist-tbody tr[data-system-name]');
  var seen    = new Set();
  var toEnrich = [];

  rows.forEach(function(row) {
    var name = row.dataset.systemName;
    if (!name || seen.has(name.toLowerCase())) return;
    var needsStar   = row.dataset.needsStar   === '1';
    var needsBodies = row.dataset.needsBodies === '1';
    // Skip if already enriched from cache
    var cached = enrichmentCache[name.toLowerCase()];
    if (cached) {
      if (needsStar && cached.starClass)       needsStar   = false;
      if (needsBodies && cached.bodyCount != null) needsBodies = false;
    }
    if (!needsStar && !needsBodies) return;
    seen.add(name.toLowerCase());
    toEnrich.push({ system: name, index: parseInt(row.dataset.idx || '0', 10) });
  });

  if (!toEnrich.length) return;

  console.log('[Enrich] Fetching EDSM data for', toEnrich.length, 'systems missing star class / body count');
  _enrichInProgress = true;
  showEdsmProgressBar(true);
  var barReset = document.getElementById('edsm-progress-bar-inner');
  if (barReset) barReset.style.width = '0%';
  updateEnrichStatus(0, toEnrich.length, false);

  var BATCH = 10;
  var done  = 0;
  var batchIdx = 0;
  var batches = [];
  for (var i = 0; i < toEnrich.length; i += BATCH) batches.push(toEnrich.slice(i, i + BATCH));

  function nextBatch() {
    if (batchIdx >= batches.length) {
      _enrichInProgress = false;
      updateEnrichStatus(done, toEnrich.length, true);
      setTimeout(function() { showEdsmProgressBar(false); }, 2500);
      return;
    }
    var batch = batches[batchIdx++];
    window.electronAPI.enrichHistoryBulk(batch).then(function(results) {
      // FIX: build a name→rows index once per batch (O(n)) instead of
      // calling querySelectorAll for every result (was O(n * batch) = O(n²)).
      var rowMap = {};
      document.querySelectorAll('#hist-tbody tr[data-system-name]').forEach(function(row) {
        var key = (row.dataset.systemName || '');
        if (!rowMap[key]) rowMap[key] = [];
        rowMap[key].push(row);
      });

      results.forEach(function(r) {
        // Store in cache
        var key = r.system.toLowerCase();
        if (!enrichmentCache[key]) enrichmentCache[key] = {};
        if (r.starClass)           enrichmentCache[key].starClass  = r.starClass;
        if (r.bodyCount != null)   enrichmentCache[key].bodyCount  = r.bodyCount;

        // Update every row for this system using the pre-built index
        (rowMap[r.system] || []).forEach(function(row) {
          var starCell  = row.querySelector('.hist-col-star');
          var bodyCell  = row.querySelector('.hist-col-bodies');
          if (starCell && row.dataset.needsStar === '1' && r.starClass) {
            starCell.textContent = r.starClass;
            delete row.dataset.needsStar;
          }
          if (bodyCell && row.dataset.needsBodies === '1' && r.bodyCount != null) {
            bodyCell.textContent = r.bodyCount;
            delete row.dataset.needsBodies;
          }
        });
      });
      done += results.length;
      updateEnrichStatus(done, toEnrich.length, false);
      setTimeout(nextBatch, 80);
    }).catch(function(err) {
      console.warn('[Enrich] Batch error:', err);
      done += batch.length;
      setTimeout(nextBatch, 80);
    });
  }

  nextBatch();
}

// ─── NEW: EDSM DISCOVERY CHECK ────────────────────────────────────────────────
//
// HOW IT WORKS:
//   1. We collect all unique system names from the rendered table.
//   2. We filter out ones we've already checked (using edsmResultsCache).
//   3. We send them to main.js in batches via checkEdsmDiscoveryBulk().
//   4. Main.js calls EDSM's API for each, staggered 150ms apart.
//   5. As results come in we update the table cells in real time.
//
// WHY BATCHES?
//   If you've done 1000 jumps, we can't send 1000 names at once — main.js
//   processes them sequentially anyway (to respect rate limits). We send
//   batches of 20 so the UI updates progressively instead of all at once at
//   the end. This gives a nice "checking..." animation.

var _edsmCheckInProgress = false;

function runEdsmDiscoveryCheck() {
  // Only run if the electronAPI bridge is available (i.e. running in Electron)
  if (!window.electronAPI || !window.electronAPI.checkEdsmDiscoveryBulk) return;
  if (_edsmCheckInProgress) return;

  // Collect all unique system names from the current table rows
  var rows = document.querySelectorAll('#hist-tbody tr[data-system-name]');
  if (!rows.length) return;

  // Deduplicate and filter out already-cached systems
  var seen     = new Set();
  var toCheck  = [];
  rows.forEach(function(row) {
    var name = row.dataset.systemName;
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    if (!edsmResultsCache[name.toLowerCase()]) {
      toCheck.push(name);
    }
  });

  if (!toCheck.length) {
    // Everything already cached — just apply cached results to table
    applyEdsmResults([]);
    updateEdsmProgress(0, 0, true);
    // Still run enrichment for missing star class / body count
    setTimeout(runEnrichment, 300);
    return;
  }

  console.log('[EDSM discovery] Checking', toCheck.length, 'systems...');
  _edsmCheckInProgress = true;
  updateEdsmProgress(0, toCheck.length, false);
  showEdsmProgressBar(true);

  // Send in batches of 20 for progressive UI updates
  var BATCH_SIZE = 20;
  var batches    = [];
  for (var i = 0; i < toCheck.length; i += BATCH_SIZE) {
    batches.push(toCheck.slice(i, i + BATCH_SIZE));
  }

  var totalChecked = 0;
  var batchIndex   = 0;

  function processBatch() {
    if (batchIndex >= batches.length) {
      // All done — kick off star class / body count enrichment for any rows
      // still missing that data. Runs after discovery check so both don't
      // hammer EDSM simultaneously.
      _edsmCheckInProgress = false;
      updateEdsmProgress(totalChecked, toCheck.length, true);
      setTimeout(function() {
        runEnrichment();
        if (!_enrichInProgress) showEdsmProgressBar(false);
      }, 500);
      return;
    }

    var batch = batches[batchIndex++];
    window.electronAPI.checkEdsmDiscoveryBulk(batch).then(function(results) {
      // Cache results and update the table
      results.forEach(function(r) {
        edsmResultsCache[r.systemName.toLowerCase()] = r;
      });
      applyEdsmResults(results);
      totalChecked += results.length;
      updateEdsmProgress(totalChecked, toCheck.length, false);

      // Small delay between batches so the UI can update visually
      setTimeout(processBatch, 50);
    }).catch(function(err) {
      console.warn('[EDSM discovery] Batch error:', err);
      totalChecked += batch.length;
      batchIndex++;
      setTimeout(processBatch, 50);
    });
  }

  processBatch();
}

// Apply EDSM results to the table rows that match
function applyEdsmResults(results) {
  // FIX: build a name→rows index once (O(n)) instead of calling
  // querySelectorAll inside every result loop (was O(n * results) = O(n²)).
  var rowMap = {};
  document.querySelectorAll('#hist-tbody tr[data-system-name]').forEach(function(row) {
    var key = (row.dataset.systemName || '').toLowerCase();
    if (!rowMap[key]) rowMap[key] = [];
    rowMap[key].push(row);
  });

  // Apply the new results we just got — O(results)
  results.forEach(function(r) {
    var key = r.systemName.toLowerCase();
    edsmResultsCache[key] = r;
    (rowMap[key] || []).forEach(function(row) {
      var cell = row.querySelector('.hist-col-edsm');
      if (!cell) return;
      if (r.discovered === false) {
        cell.innerHTML = '<span class="edsm-undiscovered" title="Not in EDSM \u2014 you may have been first to report this system!">&#11088;</span>';
      } else if (r.discovered === null) {
        cell.innerHTML = '<span class="edsm-unknown" title="EDSM check failed or timed out">?</span>';
      } else {
        cell.innerHTML = '';
      }
    });
  });

  // Also apply any already-cached results visible in the current filtered view
  // (e.g. user filtered the table while check was running) — single O(n) pass
  Object.keys(rowMap).forEach(function(key) {
    var cached = edsmResultsCache[key];
    if (!cached) return;
    (rowMap[key] || []).forEach(function(row) {
      var cell = row.querySelector('.hist-col-edsm');
      if (!cell || cell.innerHTML !== '') return;
      if (cached.discovered === false) {
        cell.innerHTML = '<span class="edsm-undiscovered" title="Not in EDSM \u2014 you may have been first to report this system!">&#11088;</span>';
      } else if (cached.discovered === null) {
        cell.innerHTML = '<span class="edsm-unknown" title="EDSM check failed">?</span>';
      }
    });
  });
}

// Update the EDSM check progress display
function updateEdsmProgress(done, total, finished) {
  var statusEl = document.getElementById('edsm-check-status');
  if (!statusEl) return;
  if (finished && total === 0) {
    statusEl.textContent = 'EDSM: all systems checked';
  } else if (finished) {
    statusEl.textContent = 'EDSM: ' + done + ' systems checked';
  } else if (total > 0) {
    statusEl.textContent = 'EDSM: checking ' + done + ' / ' + total + '\u2026';
  }
  var bar = document.getElementById('edsm-progress-bar-inner');
  if (bar && total > 0) bar.style.width = Math.round((done / total) * 100) + '%';
  if (bar && finished)  bar.style.width = '100%';
}

function showEdsmProgressBar(visible) {
  var wrap = document.getElementById('edsm-progress-wrap');
  if (wrap) wrap.style.display = visible ? 'flex' : 'none';
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

  // Top bar name / credits from live-data (shared across all pages)
  window.electronAPI.onLiveData(function(d) {
    if (d.name)          set('tb-cmdr', 'CMDR ' + d.name);
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

  // Full dataset arrived — render table then kick off EDSM check
  window.electronAPI.onHistoryData(function(data) {
    _isScanning = false;
    _allJumps   = data || [];
    showScanStatus(
      _allJumps.length.toLocaleString() + ' jumps across all journals',
      'var(--cyan)'
    );
    updateProgressBar(100);
    applyFilters();

    // Wait 500ms after rendering so the table is in the DOM before we start
    // querying it for system names
    setTimeout(function() {
      runEdsmDiscoveryCheck();
    }, 500);
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
if (histSearch) histSearch.addEventListener('input', function() {
  applyFilters();
  // Re-apply cached EDSM results to the newly filtered rows
  setTimeout(function() { applyEdsmResults([]); }, 50);
});

var histDiscoFilter = document.getElementById('hist-filter-disco');
if (histDiscoFilter) histDiscoFilter.addEventListener('change', function() {
  applyFilters();
  setTimeout(function() { applyEdsmResults([]); }, 50);
});

// ─── OPTIONS PANEL ────────────────────────────────────────────────────────────
function capiUpdateUI(status) {
  var dot       = document.getElementById('capi-dot');
  var label     = document.getElementById('capi-status-label');
  var expiryRow = document.getElementById('capi-expiry-row');
  var expiryVal = document.getElementById('capi-expiry-val');
  var loginBtn  = document.getElementById('capi-login-btn');
  var logoutBtn = document.getElementById('capi-logout-btn');
  var loginSub  = document.getElementById('capi-login-sub');
  if (!dot) return;
  if (status && status.isLoggedIn && status.tokenValid) {
    dot.style.background = 'var(--green)';
    label.textContent    = 'AUTHENTICATED';
    label.style.color    = 'var(--green)';
    if (status.tokenExpiry) {
      expiryVal.textContent   = new Date(status.tokenExpiry).toLocaleString();
      expiryRow.style.display = '';
    }
    if (loginBtn)  loginBtn.style.display  = 'none';
    if (logoutBtn) logoutBtn.style.display = '';
  } else if (status && status.isLoggedIn && !status.tokenValid) {
    dot.style.background = 'var(--gold)';
    label.textContent    = 'TOKEN EXPIRED \u2014 re-login required';
    label.style.color    = 'var(--gold)';
    if (status.tokenExpiry) {
      expiryVal.textContent   = new Date(status.tokenExpiry).toLocaleString() + ' (expired)';
      expiryRow.style.display = '';
    }
    if (loginSub)  loginSub.textContent  = 'Re-authenticate to refresh token';
    if (loginBtn)  loginBtn.style.display  = '';
    if (logoutBtn) logoutBtn.style.display = '';
  } else {
    dot.style.background = 'var(--border2)';
    label.textContent    = 'NOT AUTHENTICATED';
    label.style.color    = 'var(--text-mute)';
    expiryRow.style.display = 'none';
    if (loginSub)  loginSub.textContent  = 'Opens Frontier auth in your browser';
    if (loginBtn)  loginBtn.style.display  = '';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

function openOptions() {
  document.getElementById('options-panel').classList.add('open');
  document.getElementById('options-overlay').classList.add('open');
  if (window.electronAPI && window.electronAPI.getJournalPath) {
    window.electronAPI.getJournalPath()
      .then(function(p) { if (p) document.getElementById('opt-journal-path').value = p; })
      .catch(function() {});
  }
  if (window.electronAPI && window.electronAPI.getConfig) {
    window.electronAPI.getConfig().then(function(cfg) {
      var el = document.getElementById('capi-client-id');
      if (el) el.value = cfg.capiClientId || '';
      var cmdrEl = document.getElementById('opt-edsm-cmdr');
      if (cmdrEl) cmdrEl.value = cfg.edsmCommanderName || '';
      var keyEl = document.getElementById('opt-edsm-key');
      if (keyEl) keyEl.value = cfg.edsmApiKey || '';
    }).catch(function() {});
  }
  if (window.electronAPI && window.electronAPI.capiGetStatus) {
    window.electronAPI.capiGetStatus().then(capiUpdateUI).catch(function() {});
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

// ─── FRONTIER cAPI BUTTONS (history page) ─────────────────────────────────────
var capiClientIdInputH = document.getElementById('capi-client-id');
if (capiClientIdInputH) capiClientIdInputH.addEventListener('change', async function() {
  if (!window.electronAPI) return;
  try { await window.electronAPI.saveConfig({ capiClientId: capiClientIdInputH.value.trim() }); } catch {}
});

var capiLoginBtnH = document.getElementById('capi-login-btn');
if (capiLoginBtnH) capiLoginBtnH.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  var clientIdEl = document.getElementById('capi-client-id');
  if (clientIdEl && clientIdEl.value.trim()) {
    try { await window.electronAPI.saveConfig({ capiClientId: clientIdEl.value.trim() }); } catch {}
  }
  var sub = document.getElementById('capi-login-sub');
  if (sub) sub.textContent = 'Waiting for browser login\u2026';
  capiLoginBtnH.disabled = true;
  try {
    var result = await window.electronAPI.capiLogin();
    if (result && result.success) {
      var status = await window.electronAPI.capiGetStatus();
      capiUpdateUI(status);
    } else {
      var errMsg = (result && result.error) ? result.error : 'Login failed';
      if (sub) sub.textContent = errMsg;
      setTimeout(function() { if (sub) sub.textContent = 'Opens Frontier auth in your browser'; }, 4000);
    }
  } catch (err) {
    if (sub) sub.textContent = 'Error \u2014 check log';
    setTimeout(function() { if (sub) sub.textContent = 'Opens Frontier auth in your browser'; }, 4000);
  } finally {
    capiLoginBtnH.disabled = false;
  }
});

var capiLogoutBtnH = document.getElementById('capi-logout-btn');
if (capiLogoutBtnH) capiLogoutBtnH.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  try {
    await window.electronAPI.capiLogout();
    capiUpdateUI({ isLoggedIn: false, tokenValid: false });
  } catch {}
});

// --- EDSM CREDENTIALS (history page) -----------------------------------------
var edsmCmdrInput = document.getElementById('opt-edsm-cmdr');
if (edsmCmdrInput) edsmCmdrInput.addEventListener('change', async function() {
  if (!window.electronAPI) return;
  try { await window.electronAPI.saveConfig({ edsmCommanderName: edsmCmdrInput.value.trim() }); } catch {}
});

var edsmKeyInput = document.getElementById('opt-edsm-key');
if (edsmKeyInput) edsmKeyInput.addEventListener('change', async function() {
  if (!window.electronAPI) return;
  try { await window.electronAPI.saveConfig({ edsmApiKey: edsmKeyInput.value.trim() }); } catch {}
});

// --- EDSM FLIGHT LOG SYNC ---
// Passes current _allJumps to main, which fetches all EDSM logs in weekly
// batches, de-duplicates, and pushes merged array back via onHistoryData.
if (window.electronAPI && window.electronAPI.onEdsmSyncProgress) {
  window.electronAPI.onEdsmSyncProgress(function(p) {
    var hint = document.getElementById('opt-edsm-sync-hint');
    if (hint) hint.textContent = 'Fetching batch ' + p.batch + ' / ' + p.total + ' (' + p.fetched + ' entries so far…)';
  });
}

var edsmSyncBtn = document.getElementById('opt-edsm-sync-btn');
if (edsmSyncBtn) edsmSyncBtn.addEventListener('click', async function() {
  if (!window.electronAPI || !window.electronAPI.edsmSyncLogs) return;
  var hint = document.getElementById('opt-edsm-sync-hint');
  edsmSyncBtn.disabled = true;
  if (hint) hint.textContent = 'Connecting to EDSM…';
  try {
    var payload = (_allJumps || []).map(function(j) {
      return { system: j.system, timestamp: j.timestamp };
    });
    var result = await window.electronAPI.edsmSyncLogs(payload);
    if (result.success) {
      var parts = [];
      if (result.newFromEdsm > 0)
        parts.push(result.newFromEdsm + ' new jump' + (result.newFromEdsm !== 1 ? 's' : '') + ' added');
      if (result.firstDiscoFromEdsm > 0)
        parts.push(result.firstDiscoFromEdsm + ' first discover' + (result.firstDiscoFromEdsm !== 1 ? 'ies' : 'y') + ' imported');
      var msg = (parts.length ? parts.join(', ') : 'No new entries') +
                ' (' + result.totalMerged + ' total)';
      if (hint) { hint.textContent = msg; hint.style.color = 'var(--green)'; }
      setTimeout(function() {
        if (hint) { hint.textContent = 'Pull your EDSM history & merge with local journals'; hint.style.color = ''; }
      }, 5000);
    } else {
      if (hint) { hint.textContent = 'Error: ' + result.error; hint.style.color = 'var(--red, #e05252)'; }
      setTimeout(function() {
        if (hint) { hint.textContent = 'Pull your EDSM history & merge with local journals'; hint.style.color = ''; }
      }, 6000);
    }
  } catch (err) {
    if (hint) hint.textContent = 'Sync failed: ' + (err.message || err);
  } finally {
    edsmSyncBtn.disabled = false;
  }
});

// --- IMPORTSTARS.TXT IMPORT ---
// ImportStars.txt = EDSM export of systems the commander first discovered.
// We mark every system in the file as wasDiscovered:false (first disco) and
// add isImportedStar:true so a distinct cyan ★ badge appears beside the name.
var importStarsBtn = document.getElementById('opt-import-stars-btn');
if (importStarsBtn) importStarsBtn.addEventListener('click', async function() {
  if (!window.electronAPI || !window.electronAPI.importStarsFile) return;
  var hint = document.getElementById('opt-import-stars-hint');
  importStarsBtn.disabled = true;
  if (hint) { hint.textContent = 'Choose your ImportStars.txt\u2026'; hint.style.color = ''; }

  try {
    // Pass full jump objects so main.js can back-fill existing entries in place
    var result = await window.electronAPI.importStarsFile(_allJumps || []);

    if (result.canceled) {
      if (hint) { hint.textContent = 'Import cancelled'; hint.style.color = 'var(--text-mute)'; }
      setTimeout(function() {
        if (hint) { hint.textContent = 'Import your EDSM first-discovery list'; hint.style.color = ''; }
      }, 3000);
      return;
    }

    if (result.success) {
      _allJumps = result.merged;
      applyFilters();

      var parts = [];
      if (result.newStubs   > 0) parts.push(result.newStubs   + ' new entr' + (result.newStubs   !== 1 ? 'ies' : 'y') + ' added');
      if (result.backFilled > 0) parts.push(result.backFilled + ' existing updated');
      var msg = (parts.length ? parts.join(', ') : 'No new entries') +
                ' \u2014 ' + result.imported + ' first discoveries in file';
      if (hint) { hint.textContent = msg; hint.style.color = 'var(--green)'; }
      showScanStatus(
        _allJumps.length.toLocaleString() + ' jumps (incl. ImportStars)',
        'var(--cyan)'
      );
      setTimeout(function() {
        if (hint) { hint.textContent = 'Import your EDSM first-discovery list'; hint.style.color = ''; }
      }, 6000);
    } else {
      if (hint) { hint.textContent = 'Error: ' + (result.error || 'Unknown'); hint.style.color = 'var(--red, #e05252)'; }
      setTimeout(function() {
        if (hint) { hint.textContent = 'Import your EDSM first-discovery list'; hint.style.color = ''; }
      }, 6000);
    }
  } catch (err) {
    if (hint) hint.textContent = 'Import failed: ' + (err.message || err);
  } finally {
    importStarsBtn.disabled = false;
  }
});
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
