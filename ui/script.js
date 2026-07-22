// ─── RANK TABLES ──────────────────────────────────────────────────
const COMBAT_RANKS  = ['Harmless','Mostly Harmless','Novice','Competent','Expert','Master','Dangerous','Deadly','Elite'];
const TRADE_RANKS   = ['Penniless','Mostly Penniless','Peddler','Dealer','Merchant','Broker','Entrepreneur','Tycoon','Elite'];
const EXPLORE_RANKS = ['Aimless','Mostly Aimless','Scout','Surveyor','Trailblazer','Pathfinder','Ranger','Pioneer','Elite'];
const CQC_RANKS     = ['Helpless','Mostly Helpless','Amateur','Semi-Pro','Professional','Champion','Hero','Gladiator','Elite'];
const EMPIRE_RANKS  = ['None','Outsider','Serf','Master','Squire','Knight','Lord','Baron','Viscount','Count','Earl','Marquis','Duke','Prince','King'];
const FED_RANKS     = ['None','Recruit','Cadet','Midshipman','Petty Officer','Chief Petty Officer','Warrant Officer','Ensign','Lieutenant','Lt. Commander','Post Commander','Post Captain','Rear Admiral','Vice Admiral','Admiral'];
const EXOBIO_RANKS  = ['Directionless','Mostly Directionless','Compiler','Collector','Cataloguer','Taxonomist','Ecologist','Geneticist','Elite'];

// ─── UTILITIES ────────────────────────────────────────────────────
function fmt(n)    { return (n == null || n === 0) ? '\u2014' : Number(n).toLocaleString() + ' cr'; }
function fmtNum(n) { return n == null ? '\u2014' : Number(n).toLocaleString(); }
function fmtCr(n)  { return n == null ? '\u2014' : Number(n).toLocaleString() + ' cr'; }
function fmtTime(s){ if (!s) return '\u2014'; const h = Math.floor(s/3600), d = Math.floor(h/24); return d > 0 ? d+'d '+(h%24)+'h' : h+'h'; }
function repLabel(v){ if (v >= 90) return 'Allied'; if (v >= 50) return 'Friendly'; if (v >= 10) return 'Cordial'; if (v >= -10) return 'Neutral'; if (v >= -50) return 'Unfriendly'; return 'Hostile'; }
function ts() { return new Date().toTimeString().slice(0,8); }
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = (v != null ? v : '\u2014'); }

function toggleStations() {
  _showStations = !_showStations;
  var btn = document.getElementById('btn-toggle-stations');
  if (btn) {
    btn.style.background  = _showStations ? 'rgba(46,207,207,0.1)'  : 'transparent';
    btn.style.color       = _showStations ? 'var(--cyan)'            : 'var(--text-mute)';
    btn.style.borderColor = _showStations ? 'rgba(46,207,207,0.3)'  : 'var(--border2)';
  }
  renderBodies(_currentSystem);
}

// ─── LOGGING (live page only) ──────────────────────────────────────
const LOG_MAX_ENTRIES = 200;
let logCount = 0;
function log(msg, type = 'info') {
  const countEl   = document.getElementById('log-count');
  const entriesEl = document.getElementById('log-entries');
  if (!entriesEl) return;
  logCount++;
  if (countEl) countEl.textContent = logCount + ' entries';
  const e = document.createElement('div');
  e.className = 'log-entry';
  e.innerHTML = '<span class="log-ts">' + ts() + '</span><span class="log-msg ' + type + '">' + msg + '</span>';
  entriesEl.insertBefore(e, entriesEl.firstChild);
  // FIX: cap DOM entries to prevent unbounded growth and layout thrashing
  while (entriesEl.children.length > LOG_MAX_ENTRIES) {
    entriesEl.removeChild(entriesEl.lastChild);
  }
}

// ─── BODY RENDERING ───────────────────────────────────────────────
// State: journal scan data + EDSM data are merged here.
var _journalBodies = {};   // bodyName → journal Scan entry
var _journalSignals = {};  // bodyName → [signal strings]
var _edsmBodies     = [];  // array of EDSM body objects
var _edsmStations   = [];  // array of EDSM station objects
var _currentSystem  = null;
var _showStations   = true; // toggle: show stations/settlements in bodies table
var _expandedBodyGroups = new Set(); // bodyKey (lowercased body name) → expanded in the bodies table

// Map journal scan data → icon type
function bodyIconType(b) {
  if (b.type === 'Star')   return 'star';
  if (b.type === 'Belt')   return 'moon';
  if (b.planetClass) {
    var pc = b.planetClass.toLowerCase();
    if (pc.includes('gas giant') || pc.includes('sudarsky')) return 'gas';
    if (pc.includes('icy'))        return 'icy';
    if (pc.includes('rocky'))      return 'rocky';
    if (pc.includes('metal'))      return 'hmc';
    if (pc.includes('water'))      return 'icy';
    if (pc.includes('ammonia'))    return 'gas';
    if (pc.includes('earth'))      return 'hmc';
  }
  return 'rocky';
}

// Shorten body name relative to system name
function shortBodyName(name, system) {
  if (!system || !name) return name || '—';
  if (name.toLowerCase().startsWith(system.toLowerCase() + ' ')) {
    return name.slice(system.length + 1);
  }
  return name;
}

// Format a distance in LS
function fmtLS(ls) {
  if (ls == null) return '—';
  if (ls < 0.01)  return (ls * 299792.458).toFixed(0) + ' km';
  if (ls < 1)     return ls.toFixed(3) + ' ls';
  if (ls < 1000)  return ls.toFixed(1) + ' ls';
  return (ls / 499.004785).toFixed(2) + ' AU';
}

// Estimate base scan value from planet class (fallback when journal doesn't give it)
function estimateValue(b) {
  if (!b.planetClass) return null;
  var pc = b.planetClass.toLowerCase();
  if (pc.includes('earth'))   return 700000;
  if (pc.includes('ammonia'))  return 500000;
  if (pc.includes('water giant')) return 100000;
  if (pc.includes('water'))   return 100000;
  if (pc.includes('metal'))   return 20000;
  if (pc.includes('high metal')) return 20000;
  if (pc.includes('class i gas'))  return 3000;
  if (pc.includes('class ii gas')) return 8000;
  if (pc.includes('class iii'))    return 5000;
  if (pc.includes('class iv'))     return 5000;
  if (pc.includes('class v'))      return 6000;
  if (pc.includes('icy'))     return 1000;
  if (pc.includes('rocky'))   return 500;
  return null;
}

// Determine if a body is a moon (has a parent that is not a belt or barycentre)
// Heuristic: body name has more than one letter/number segment after system name
function isMoonBody(b, system) {
  var short = shortBodyName(b.name, system);
  // If the short name has a letter then another segment (e.g. "1 a" or "A 1"), it's a moon
  return /\d+\s+[a-z]/i.test(short) || /[a-z]\s+\d+/i.test(short);
}

// Parse a short body name into sortable key parts.
// Elite body names follow patterns like: "A", "1", "2", "3 a", "3 b", "4", "5 a", "5 b"
// We need to produce sort keys that give: Main Star < 1 < 2 < 3 < 3A < 4 < 5 < 5A < 5B
function bodyNameSortKey(name, system) {
  var short = shortBodyName(name, system).trim().toUpperCase();
  // Split into tokens: numbers and letters separately
  var tokens = short.match(/[A-Z]+|\d+/g) || [];
  // Build a sort tuple: [firstNum, firstLetter, secondNum, secondLetter, ...]
  var parts = [];
  for (var i = 0; i < tokens.length; i++) {
    if (/^\d+$/.test(tokens[i])) {
      parts.push(parseInt(tokens[i], 10));
    } else {
      // Letter component (e.g. "A", "B") — encode as offset after preceding number
      parts.push(tokens[i].charCodeAt(0) - 64); // A=1, B=2, etc.
    }
  }
  return parts;
}

function compareSortKeys(ak, bk) {
  var len = Math.max(ak.length, bk.length);
  for (var i = 0; i < len; i++) {
    var av = ak[i] != null ? ak[i] : 0;
    var bv = bk[i] != null ? bk[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Merge journal + EDSM data into a unified list sorted by body name order
function buildMergedBodies(system) {
  var merged = {};  // name.toLowerCase() → merged body

  // Start from journal bodies
  Object.values(_journalBodies).forEach(function(b) {
    var key = b.name.toLowerCase();
    merged[key] = { source: 'journal', journal: b, edsm: null };
  });

  // Overlay EDSM bodies
  _edsmBodies.forEach(function(eb) {
    var key = (eb.name || '').toLowerCase();
    if (merged[key]) {
      merged[key].edsm = eb;
    } else {
      merged[key] = { source: 'edsm', journal: null, edsm: eb };
    }
  });

  var sys = system || _currentSystem;
  return Object.values(merged).sort(function(a, b) {
    // Helper: is this entry the arrival/main star (distance ≈ 0 or missing)?
    function isMainStar(entry) {
      var jb = entry.journal, eb = entry.edsm;
      var isStar = (jb && jb.type === 'Star') || (eb && eb.type === 'Star');
      if (!isStar) return false;
      var dist = (jb && jb.distanceFromArrival) || (eb && eb.distanceToArrival);
      return !dist || dist < 0.001;
    }
    var aMain = isMainStar(a), bMain = isMainStar(b);
    if (aMain && !bMain) return -1;
    if (!aMain && bMain) return 1;

    // Sort by parsed body name: e.g. "1" < "2" < "3" < "3 A" < "4" < "5" < "5 A" < "5 B"
    var aName = (a.journal && a.journal.name) || (a.edsm && a.edsm.name) || '';
    var bName = (b.journal && b.journal.name) || (b.edsm && b.edsm.name) || '';
    var ak = bodyNameSortKey(aName, sys);
    var bk = bodyNameSortKey(bName, sys);

    // If both have no parseable tokens (edge case), fall back to distance
    if (!ak.length && !bk.length) {
      var aDist = (a.journal && a.journal.distanceFromArrival) || (a.edsm && a.edsm.distanceToArrival) || 999999;
      var bDist = (b.journal && b.journal.distanceFromArrival) || (b.edsm && b.edsm.distanceToArrival) || 999999;
      return aDist - bDist;
    }

    return compareSortKeys(ak, bk);
  });
}

// Group EDSM stations by the planetary body they belong to.
// EDSM includes a "body" field ({name, id, ...}) on stations/settlements
// that sit on or orbit a specific body. Stations with no body field are
// system-wide (e.g. most orbital starports) and are listed separately.
function groupStationsByBody(stations) {
  var byBody    = {}; // lowercased body name → [station, ...]
  var unassigned = [];
  (stations || []).forEach(function(st) {
    var bodyName = st.body && st.body.name;
    if (bodyName) {
      var key = bodyName.toLowerCase();
      if (!byBody[key]) byBody[key] = [];
      byBody[key].push(st);
    } else {
      unassigned.push(st);
    }
  });
  return { byBody: byBody, unassigned: unassigned };
}

// Build a single <tr> for one station/settlement/carrier.
// extraClass lets callers mark a row as a hidden child of a body group.
function buildStationRowHtml(st, extraClass) {
  var stType = st.type || 'Station';
  var isSettlement = /settlement|surface|planetary|installation/i.test(stType);
  var isCarrier    = /fleet carrier/i.test(stType);
  var iconCls      = isSettlement ? 'settlement' : isCarrier ? 'carrier' : 'station';
  var rowCls       = 'body-station' + (isSettlement ? ' body-settlement' : '') + (extraClass ? ' ' + extraClass : '');

  var distDisplay = st.distanceToArrival != null ? fmtLS(st.distanceToArrival) : '\u2014';

  var services = st.otherServices || [];
  var serviceHtml = '';
  if (st.haveMarket)   serviceHtml += '<span class="info-tag poi">Market</span>';
  if (st.haveShipyard) serviceHtml += '<span class="info-tag poi">Shipyard</span>';
  if (st.haveOutfitting) serviceHtml += '<span class="info-tag poi">Outfitting</span>';
  if (services.indexOf('Black Market') !== -1) serviceHtml += '<span class="info-tag alien">B.Market</span>';
  if (services.indexOf('Material Trader') !== -1) serviceHtml += '<span class="info-tag geo">Materials</span>';
  if (services.indexOf('Technology Broker') !== -1) serviceHtml += '<span class="info-tag geo">Tech Broker</span>';
  if (services.indexOf('Interstellar Factors Contact') !== -1) serviceHtml += '<span class="info-tag human">I.Factors</span>';

  var factionHtml = st.controllingFaction && st.controllingFaction.name
    ? '<div style="font-size:0.75em;color:var(--text-mute);margin-top:1px">' + st.controllingFaction.name + '</div>'
    : '';

  return (
    '<tr class="' + rowCls + '">' +
      '<td style="text-align:center;padding:4px;">' +
        '<div style="display:flex;justify-content:center;">' +
          '<div class="body-icon ' + iconCls + '"></div>' +
        '</div>' +
      '</td>' +
      '<td class="body-indent">' +
        '<div class="body-name-cell">' +
          '<span class="station-indicator"></span>' +
          '<span style="font-size:0.9em;font-weight:400;color:var(--text)">' + (st.name || '?') + '</span>' +
        '</div>' +
        factionHtml +
      '</td>' +
      '<td class="body-class" style="color:var(--text-dim)">' + stType + '</td>' +
      '<td style="font-size:0.75em;color:var(--text-dim);white-space:nowrap">' + distDisplay + '</td>' +
      '<td>' + (serviceHtml ? '<div style="margin-top:2px">' + serviceHtml + '</div>' : '') + '</td>' +
      '<td class="val-cell">\u2014</td>' +
      '<td class="val-cell muted" style="font-size:0.75em">\u2014</td>' +
    '</tr>'
  );
}

function renderBodies(system) {
  var tbody = document.getElementById('bodies-tbody');
  if (!tbody) return;

  var bodies = buildMergedBodies(system || _currentSystem);

  if (!bodies.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">&#9678;</div><div class="msg">Awaiting scan data</div></div></td></tr>';
    set('body-count', '0 bodies');
    set('sum-stars', 0); set('sum-planets', 0); set('sum-moons', 0); set('sum-total', 0);
    return;
  }

  var stars = 0, planets = 0, moons = 0;
  var rows = [];

  var stationGroups = _showStations ? groupStationsByBody(_edsmStations) : { byBody: {}, unassigned: [] };

  bodies.forEach(function(entry) {
    var jb  = entry.journal;
    var eb  = entry.edsm;
    var sys = system || _currentSystem;

    // ── Derive display values preferring journal data, filling from EDSM ──
    var name         = (jb && jb.name) || (eb && eb.name) || '?';
    var shortName    = shortBodyName(name, sys);
    var isMain       = jb ? (jb.type === 'Star' || !isMoonBody(jb, sys)) : (eb ? eb.type === 'Star' || !isMoonBody(eb, sys) : true);
    var isStar       = (jb && jb.type === 'Star') || (eb && eb.type === 'Star');

    // ── Stations/settlements attached to this body ──
    var bodyKey          = name.toLowerCase();
    var attachedStations = stationGroups.byBody[bodyKey] || [];
    var groupExpanded    = _expandedBodyGroups.has(bodyKey);

    var displayClass;
    if (jb && jb.type === 'Star') {
      displayClass = (jb.starType || '') + (jb.subclass != null ? jb.subclass : '') + (jb.luminosity ? ' ' + jb.luminosity : '') + ' star';
    } else if (jb && jb.planetClass) {
      displayClass = jb.planetClass;
      if (jb.terraformable) displayClass += ' (T)';
    } else if (eb) {
      displayClass = eb.subType || eb.type || '—';
    } else {
      displayClass = '—';
    }

    var distLS     = (jb && jb.distanceFromArrival) || (eb && eb.distanceToArrival);
    var distDisplay = isStar && (!distLS || distLS < 0.001) ? 'Main Star' : fmtLS(distLS);

    var icon = jb ? bodyIconType(jb) : (isStar ? 'star' : eb && eb.type === 'Planet' ? 'rocky' : 'moon');

    // ── Info lines ──
    var infoLines = [];

    if (jb && jb.type === 'Star') {
      if (jb.solarMasses)  infoLines.push('Mass: ' + jb.solarMasses + ' SM');
      if (jb.solarRadius)  infoLines.push('Radius: ' + jb.solarRadius + ' SR');
      if (eb && eb.solarRadius) infoLines.push('Radius: ' + eb.solarRadius.toFixed(3) + ' SR');
      if (jb.surfaceTemp)  infoLines.push('Temp: ' + jb.surfaceTemp.toLocaleString() + ' K');
      if (jb.isScoopable)  infoLines.push('Scoopable');
    } else if (jb) {
      if (jb.radius)       infoLines.push('Radius: ' + jb.radius.toLocaleString() + ' km');
      if (jb.gravity)      infoLines.push('Gravity: ' + jb.gravity + ' g');
      if (jb.surfaceTemp)  infoLines.push('Temp: ' + jb.surfaceTemp + ' K');
      if (jb.massEM)       infoLines.push('Mass: ' + jb.massEM + ' EM');
      if (jb.atmosphere && jb.atmosphere !== 'No atmosphere' && jb.atmosphere !== '')
        infoLines.push('Atm: ' + (jb.atmosphereType || jb.atmosphere));
      if (jb.volcanism && jb.volcanism !== 'No volcanism')
        infoLines.push('Volc: ' + jb.volcanism.replace('minor ', '').replace(' volcanism', ''));
      if (jb.landable)     infoLines.push('Landable');
    } else if (eb) {
      if (eb.radius)       infoLines.push('Radius: ' + Math.round(eb.radius).toLocaleString() + ' km');
      if (eb.gravity)      infoLines.push('Gravity: ' + parseFloat(eb.gravity).toFixed(2) + ' g');
      if (eb.surfaceTemp)  infoLines.push('Temp: ' + Math.round(eb.surfaceTemp) + ' K');
      if (eb.isLandable)   infoLines.push('Landable');
    }

    if (jb && jb.rings)  infoLines.push('Rings: ' + (jb.ringTypes.join(', ') || 'present'));
    else if (eb && eb.rings) infoLines.push('Rings');

    // ── Tags ──
    var tags = [];

    // Atmosphere tag
    if (jb && jb.atmosphere && jb.atmosphere !== 'No atmosphere' && jb.atmosphere !== '')
      tags.push({ text: 'Atmos', cls: 'atm' });

    // Terraformable
    if (jb && jb.terraformable)
      tags.push({ text: 'Terraformable', cls: 'terra' });

    // First discovery / mapping
    if (jb && !jb.wasDiscovered)
      tags.push({ text: '★ First Discovery', cls: 'disco' });
    if (jb && !jb.wasMapped)
      tags.push({ text: '✦ First Mapped', cls: 'mapped' });

    // Signals (bio, geo, human, thargoid etc)
    var signals = _journalSignals[name] || [];
    signals.forEach(function(sig) {
      var cls = 'poi';
      var sl = sig.toLowerCase();
      if (sl.includes('biolog')) cls = 'bio';
      else if (sl.includes('geological') || sl.includes('geo')) cls = 'geo';
      else if (sl.includes('human') || sl.includes('station') || sl.includes('settlement')) cls = 'human';
      else if (sl.includes('thargoid') || sl.includes('guardian')) cls = 'alien';
      tags.push({ text: sig, cls: cls });
    });

    // EDSM extra: stations/settlements
    if (eb && eb.type === 'Star') {
      // nothing extra
    }

    // ── Value ──
    var value    = (jb && jb.estimatedValue) || estimateValue(jb || {});
    var maxValue = (jb && jb.mappedValue)    || (value ? Math.round(value * 3.3) : null);

    // Count body types
    if (isStar)      stars++;
    else if (!isMain) moons++;
    else             planets++;

    var rowClass = isMain ? 'body-main' : 'body-moon';

    var tagHtml = tags.map(function(t) {
      return '<span class="info-tag ' + t.cls + '">' + t.text + '</span>';
    }).join('');

    var infoHtml = infoLines.map(function(l) { return '<div>' + l + '</div>'; }).join('');

    // Clickable "N stations ▾/▸" badge shown inline next to the body name,
    // only when this body actually has stations/settlements attached.
    var stationBadgeHtml = '';
    if (attachedStations.length) {
      stationBadgeHtml =
        '<span class="body-station-toggle' + (groupExpanded ? ' expanded' : '') + '" data-group="' + bodyKey.replace(/"/g, '&quot;') + '">' +
          '<span class="body-station-toggle-arrow">' + (groupExpanded ? '\u25be' : '\u25b8') + '</span>' +
          ' ' + attachedStations.length + ' station' + (attachedStations.length !== 1 ? 's' : '') +
        '</span>';
    }

    rows.push(
      '<tr class="' + rowClass + '">' +
        '<td style="text-align:center;padding:4px;">' +
          '<div style="display:flex;justify-content:center;">' +
            '<div class="body-icon ' + icon + '"></div>' +
          '</div>' +
        '</td>' +
        '<td class="' + (isMain ? '' : 'body-indent') + '">' +
          '<div class="body-name-cell">' +
            (!isMain ? '<span class="moon-indicator"></span>' : '') +
            '<span style="font-size:' + (isMain ? '1em' : '0.9em') + ';font-weight:' + (isMain ? '600' : '400') + ';color:' + (isMain ? 'var(--text)' : 'var(--text-dim)') + '">' + shortName + '</span>' +
            stationBadgeHtml +
          '</div>' +
        '</td>' +
        '<td class="body-class">' + displayClass + '</td>' +
        '<td style="font-size:0.75em;color:var(--text-dim);white-space:nowrap">' + distDisplay + '</td>' +
        '<td>' +
          '<div class="info-text">' + infoHtml + '</div>' +
          (tagHtml ? '<div style="margin-top:3px">' + tagHtml + '</div>' : '') +
        '</td>' +
        '<td class="val-cell">' + (value ? value.toLocaleString() + ' cr' : '—') + '</td>' +
        '<td class="val-cell muted" style="font-size:0.75em">' + (maxValue ? maxValue.toLocaleString() + ' cr' : '—') + '</td>' +
      '</tr>'
    );

    // Hidden-until-expanded rows for this body's stations/settlements.
    if (attachedStations.length) {
      attachedStations.forEach(function(st) {
        rows.push(buildStationRowHtml(st, 'body-station-child' + (groupExpanded ? ' expanded' : '')));
      });
    }
  });

  // ── Stations EDSM didn't attach to any specific body ──────────────────────
  // (mostly plain orbital starports that just orbit the system, not a body)
  if (_showStations && stationGroups.unassigned.length) {
    rows.push(
      '<tr class="body-section-header"><td colspan="7">Other Stations (Orbital / No Body Data)</td></tr>'
    );
    stationGroups.unassigned.forEach(function(st) {
      rows.push(buildStationRowHtml(st, ''));
    });
  }

  tbody.innerHTML = rows.join('');
  var stationCount = _showStations ? _edsmStations.length : 0;
  var bodyTotal    = bodies.length;
  var countLabel   = bodyTotal + ' bod' + (bodyTotal !== 1 ? 'ies' : 'y');
  if (stationCount) countLabel += ' · ' + stationCount + ' station' + (stationCount !== 1 ? 's' : '');
  set('body-count', countLabel);
  set('sum-stars',   stars);
  set('sum-planets', planets);
  set('sum-moons',   moons);
  set('sum-total',   stars + planets + moons);
}

// One delegated listener handles every "N stations ▸" badge, in every body
// row, forever — even after the table is fully rebuilt by renderBodies().
document.addEventListener('click', function(e) {
  var toggle = e.target.closest && e.target.closest('.body-station-toggle');
  if (!toggle) return;
  var key = toggle.getAttribute('data-group');
  if (!key) return;
  if (_expandedBodyGroups.has(key)) _expandedBodyGroups.delete(key);
  else _expandedBodyGroups.add(key);
  renderBodies();
});

function populateBodies() {
  renderBodies(_currentSystem);
}

// Debounced version of renderBodies — coalesces rapid calls (e.g. onLocation +
// onBodiesData + onEdsmBodies firing in quick succession) into a single DOM
// update, eliminating the flicker seen when switching systems.
var _renderBodiesTimer = null;
function renderBodiesDebounced(system) {
  if (_renderBodiesTimer) clearTimeout(_renderBodiesTimer);
  _renderBodiesTimer = setTimeout(function() {
    _renderBodiesTimer = null;
    renderBodies(system || _currentSystem);
  }, 80);
}

// ─── SCAN VALUES PANEL ────────────────────────────────────────────
var _scanEntries = {};  // bodyName → { value, mapped }

function renderScans() {
  var tbody = document.getElementById('scan-tbody');
  if (!tbody) return;
  var entries = Object.values(_scanEntries);
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state" style="height:60px;"><div class="msg">No scans yet</div></div></td></tr>';
    set('scan-total', '—');
    return;
  }
  entries.sort(function(a, b) { return (b.value || 0) - (a.value || 0); });
  var total = 0;
  var rows = entries.map(function(s) {
    total += (s.value || 0);
    return '<tr>' +
      '<td style="font-size:0.75em">' + shortBodyName(s.body, _currentSystem) + '</td>' +
      '<td style="font-size:0.6667em;color:var(--text-dim)">' + (s.type || '') + '</td>' +
      '<td style="text-align:center"><span class="mapped-icon ' + (s.mapped ? 'yes' : 'no') + '"></span></td>' +
      '<td class="scan-val">' + (s.value ? s.value.toLocaleString() : '—') + '</td>' +
    '</tr>';
  });
  tbody.innerHTML = rows.join('');
  set('scan-total', total.toLocaleString() + ' cr');
}

function populateScans() {
  renderScans();
}

// ─── SHIP ALERTS (fuel strip + hull highlight + log) ───────────────
var _shipAlertCfg = { fuelPct: 25, hullPct: 70 };
var _prevHullForAlert = null;
var _fuelBelowLogged = false;

function clampShipAlertPct(v, fallback) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function syncShipAlertCfgFromObject(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  _shipAlertCfg.fuelPct = cfg.fuelAlertThresholdPct != null
    ? clampShipAlertPct(cfg.fuelAlertThresholdPct, 25)
    : 25;
  _shipAlertCfg.hullPct = cfg.hullAlertThresholdPct != null
    ? clampShipAlertPct(cfg.hullAlertThresholdPct, 70)
    : 70;
}

function refreshShipAlertCfg() {
  if (!window.electronAPI || !window.electronAPI.getConfig) return;
  window.electronAPI.getConfig().then(function(cfg) {
    syncShipAlertCfgFromObject(cfg);
    var fi = document.getElementById('opt-fuel-alert-pct');
    var hi = document.getElementById('opt-hull-alert-pct');
    if (fi) fi.value = String(_shipAlertCfg.fuelPct);
    if (hi) hi.value = String(_shipAlertCfg.hullPct);
  }).catch(function() {});
}

function applyShipAlerts(d) {
  if (!document.getElementById('ship-hull')) return;
  var ft = _shipAlertCfg.fuelPct;
  var ht = _shipAlertCfg.hullPct;
  var fuelStrip = document.getElementById('live-alert-fuel');
  var fuelStripWasHidden = fuelStrip ? fuelStrip.hidden : true;

  if (d.fuelPct != null && ft > 0) {
    var fuelLow = d.fuelPct < ft;
    if (fuelStrip) {
      fuelStrip.hidden = !fuelLow;
      fuelStrip.classList.toggle('live-alert-strip--active', fuelLow);
      var txt = fuelStrip.querySelector('.live-alert-strip__text');
      if (txt && fuelLow) {
        txt.textContent = 'Low fuel — ' + Math.round(d.fuelPct) + '% (threshold ' + ft + '%)';
      }
    }
    if (fuelLow) {
      if (!_fuelBelowLogged) {
        log('Fuel below ' + ft + '% (' + Math.round(d.fuelPct) + '% main tank)', 'warn');
        _fuelBelowLogged = true;
      }
    } else {
      _fuelBelowLogged = false;
    }
  } else {
    if (fuelStrip) {
      fuelStrip.hidden = true;
      fuelStrip.classList.remove('live-alert-strip--active');
    }
    _fuelBelowLogged = false;
  }

  if (d.hull != null && ht > 0) {
    var hullEl = document.getElementById('ship-hull');
    var hullRow = document.getElementById('ship-hull-row');
    var below = d.hull < ht;
    if (hullRow) hullRow.classList.toggle('stat-row--hull-alert', below);
    if (hullEl) {
      hullEl.textContent = d.hull + '%';
      if (below) {
        hullEl.className = 'stat-val red ship-hull-below-threshold';
      } else {
        hullEl.className = 'stat-val ' + (d.hull >= 70 ? 'green' : d.hull >= 40 ? 'gold' : 'red');
      }
    }
    if (_prevHullForAlert != null && _prevHullForAlert >= ht && d.hull < ht) {
      log('Hull integrity below ' + ht + '% (' + d.hull + '%)', 'warn');
    }
    _prevHullForAlert = d.hull;
  } else {
    var hullRow2 = document.getElementById('ship-hull-row');
    if (hullRow2) hullRow2.classList.remove('stat-row--hull-alert');
    if (d.hull != null) {
      var hullEl2 = document.getElementById('ship-hull');
      if (hullEl2) {
        hullEl2.textContent = d.hull + '%';
        hullEl2.className = 'stat-val ' + (d.hull >= 70 ? 'green' : d.hull >= 40 ? 'gold' : 'red');
      }
      _prevHullForAlert = d.hull;
    } else {
      _prevHullForAlert = null;
    }
  }

}

// ─── ELECTRON IPC ─────────────────────────────────────────────────
if (window.electronAPI) {

  refreshShipAlertCfg();

  // ── LIVE DATA → index.html ─────────────────────────────────────
  // Ship state, fuel, location, docking — sourced from the latest journal only.
  window.electronAPI.onLiveData(function(d) {
    // Top bar (name + system shown on all pages)
    if (d.name)          set('tb-cmdr', 'CMDR ' + d.name);
    if (d.currentSystem) set('tb-sys',  d.currentSystem);
    if (d.credits != null) set('tb-credits', Number(d.credits).toLocaleString() + ' CR');

    // Always track the current system — needed so onBodiesData renders correctly
    // regardless of whether live-data or bodies-data arrives first on launch
    if (d.currentSystem) _currentSystem = d.currentSystem;

    // Live panel elements (only exist on index.html — set() is a no-op on other pages)
    if (d.currentSystem) set('sys-name',   d.currentSystem);
    if (d.pos)           set('sys-pos',    d.pos);
    if (d.ship || d.shipName)
      set('ship-name', [d.shipName, d.ship].filter(Boolean).join(' \u00B7 ') || '\u2014');
    if (d.ship)          set('ship-type',  d.ship);
    if (d.shipIdent)     set('ship-ident', d.shipIdent);
    if (d.maxJumpRange)  set('ship-range', d.maxJumpRange);
    if (d.cargoCapacity != null) set('ship-cargo', d.cargoCapacity + ' T');
    if (d.fuelDisplay)   set('ship-fuel',  d.fuelDisplay);
    if (d.rebuy  != null) set('ship-rebuy', fmtCr(d.rebuy));
    if (d.credits != null) set('credits',  fmtCr(d.credits));

    // Fuel reservoir (from Status.json, updated ~1s while in-game)
    if (d.fuelReservoir != null) {
      set('ship-fuel-reserve', d.fuelReservoir.toFixed(2) + ' t');
    }

    // Fuel bar — colour-coded: cyan ≥50%, gold 25–49%, red <25%
    var fuelBar = document.getElementById('fuel-bar');
    if (fuelBar && d.fuelPct != null) {
      fuelBar.style.width = d.fuelPct + '%';
      fuelBar.style.background = d.fuelPct >= 50
        ? 'var(--cyan)'
        : d.fuelPct >= 25
          ? 'var(--gold)'
          : 'var(--red, #e05252)';
    }

    applyShipAlerts(d);

    set('station-name',    d.dockedStation     || '\u2014');
    set('station-type',    d.dockedStationType || '\u2014');
    set('station-faction', d.dockedFaction     || '\u2014');

    // Discovery star in topbar
    var tbStar = document.getElementById('tb-discovery-star');
    if (tbStar) tbStar.style.display = d.lastJumpWasFirstDiscovery ? 'inline' : 'none';

    // Activate EDSM link immediately using current system name as fallback URL.
    // This ensures the link works even before onEdsmSystem fires (e.g. EDSM disabled).
    if (d.currentSystem) {
      var edsmLinkEl = document.getElementById('edsm-link');
      if (edsmLinkEl && edsmLinkEl.style.pointerEvents === 'none') {
        var sysUrl = 'https://www.edsm.net/en/system/id/-/name/' + encodeURIComponent(d.currentSystem);
        edsmLinkEl.style.opacity = '0.6';
        edsmLinkEl.style.pointerEvents = 'auto';
        edsmLinkEl.title = 'View ' + d.currentSystem + ' on EDSM';
        edsmLinkEl.onclick = (function(url) { return function(e) {
          e.preventDefault();
          if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url);
          return false;
        }; })(sysUrl);
      }
    }

    // Profile page: live data provides always-current values for fields that
    // change during play (system, jump range, ship, credits) — these must
    // reflect the actual current state, not just the profile snapshot from boot.
    if (d.currentSystem) set('prof-system', d.currentSystem);
    if (d.maxJumpRange)  set('prof-jump',   d.maxJumpRange);
    // Ship identity on profile page — kept in sync with live Loadout events
    if (d.ship || d.shipName) {
      set('prof-ship-type',  d.ship      || '\u2014');
      set('prof-ship-name',  d.shipName  || '\u2014');
    }
    if (d.shipIdent)     set('prof-ship-ident', d.shipIdent);
    if (d.credits != null) set('prof-credits', Number(d.credits).toLocaleString() + ' cr');
    var discoBadge = document.getElementById('prof-discovery-badge');
    if (discoBadge) discoBadge.style.display = d.lastJumpWasFirstDiscovery ? 'inline' : 'none';

    log('Live data: ' + (d.currentSystem || d.name || '?'), 'good');
  });

  // ── PROFILE DATA → profile.html ───────────────────────────────
  // Sourced by scanning backwards through journals until LoadGame +
  // Rank + Progress + Reputation + Statistics have all been found.
  window.electronAPI.onProfileData(function(p) {
    var id  = p.identity   || {};
    var rk  = p.ranks      || {};
    var pr  = p.progress   || {};
    var rep = p.reputation || {};
    var st  = p.stats      || {}; // raw Statistics event — sub-keys are Exploration, Trading, etc.

    // Top bar (name visible on all pages)
    if (id.name) set('tb-cmdr', 'CMDR ' + id.name);

    // Identity card — set name and game mode from the profile snapshot.
    // Ship, credits, and system are kept live via onLiveData so they stay
    // accurate after ship switches, purchases, or jumps mid-session.
    // We only write these here if live data hasn't populated them yet
    // (i.e. the element still shows the default dash).
    set('prof-name', id.name ? 'CMDR ' + id.name : '\u2014');
    set('prof-mode', id.gameMode || '\u2014');

    var shipTypeEl = document.getElementById('prof-ship-type');
    if (shipTypeEl && (shipTypeEl.textContent === '\u2014' || shipTypeEl.textContent === '—'))
      shipTypeEl.textContent = id.ship || '\u2014';

    var shipNameEl = document.getElementById('prof-ship-name');
    if (shipNameEl && (shipNameEl.textContent === '\u2014' || shipNameEl.textContent === '—'))
      shipNameEl.textContent = id.shipName || '\u2014';

    var shipIdentEl = document.getElementById('prof-ship-ident');
    if (shipIdentEl && (shipIdentEl.textContent === '\u2014' || shipIdentEl.textContent === '—'))
      shipIdentEl.textContent = id.shipIdent || '\u2014';

    var creditsEl = document.getElementById('prof-credits');
    if (creditsEl && (creditsEl.textContent === '\u2014' || creditsEl.textContent === '—'))
      creditsEl.textContent = id.credits != null ? Number(id.credits).toLocaleString() + ' cr' : '\u2014';

    // Ranks grid
    var ranksGrid = document.getElementById('prof-ranks-grid');
    if (ranksGrid) {
      var rankDefs = [
        { cls:'combat',  label:'Combat',      r:rk.combat,     p:pr.combat,     max:8  },
        { cls:'trade',   label:'Trade',       r:rk.trade,      p:pr.trade,      max:8  },
        { cls:'explore', label:'Exploration', r:rk.explore,    p:pr.explore,    max:8  },
        { cls:'exobio',  label:'Exobiology',  r:rk.exobiology, p:pr.exobiology != null ? pr.exobiology : null, max:8  },
        { cls:'empire',  label:'Empire',      r:rk.empire,     p:pr.empire,     max:14 },
        { cls:'fed',     label:'Federation',  r:rk.federation, p:pr.federation, max:14 },
        { cls:'cqc',     label:'CQC',         r:rk.cqc,        p:pr.cqc,        max:8  },
      ];
      ranksGrid.innerHTML = rankDefs.map(function(rd) {
        var name   = rd.r ? rd.r.name : '\u2014';
        var barPct = rd.p != null ? rd.p : (rd.r ? Math.round((rd.r.level / rd.max) * 100) : 0);
        var pctLbl = rd.p != null ? rd.p + '%' : '';
        return '<div class="rank-card ' + rd.cls + '">' +
          '<div class="rank-label">' + rd.label + '</div>' +
          '<div class="rank-name">' + name + '</div>' +
          '<div class="rank-bar-wrap"><div class="rank-bar" style="width:' + barPct + '%"></div></div>' +
          '<div class="rank-pct">' + pctLbl + '</div></div>';
      }).join('');
    }

    // Reputation bars
    function setRep(prefix, val) {
      if (!document.getElementById(prefix + '-num')) return;
      var v   = val != null ? val : 0;
      var bar = Math.round(((v + 100) / 200) * 100);
      var sign = v >= 0 ? '+' : '';
      set(prefix + '-num', sign + v.toFixed(1));
      set(prefix + '-lbl', repLabel(v));
      var el = document.getElementById(prefix + '-bar');
      if (el) el.style.width = bar + '%';
    }
    setRep('rep-empire', rep.empire);
    setRep('rep-fed',    rep.federation);
    setRep('rep-all',    rep.alliance);
    setRep('rep-ind',    rep.independent);

    // Lifetime statistics — st is the raw Statistics event object
    var statsEl = document.getElementById('prof-stats-cols');
    if (statsEl) {
      var ex  = st.Exploration       || {};
      var tr  = st.Trading           || {};
      var cb  = st.Combat            || {};
      var mn  = st.Mining            || {};
      var sm  = st.Smuggling         || {};
      var ba  = st.Bank_Account      || {};
      var exo = st.Exobiology        || {};
      var sr  = st.Search_And_Rescue || {};
      var statCols = [
        { title:'Exploration', color:'c-cyan', rows:[
          ['Systems Visited',    fmtNum(ex.Systems_Visited)],
          ['Total Jumps',        fmtNum(ex.Total_Hyperspace_Jumps)],
          ['Distance Traveled',  ex.Total_Hyperspace_Distance ? Math.round(ex.Total_Hyperspace_Distance).toLocaleString() + ' ly' : '\u2014'],
          ['Furthest From Home', ex.Greatest_Distance_From_Start ? Math.round(ex.Greatest_Distance_From_Start).toLocaleString() + ' ly' : '\u2014'],
          ['Planets Scanned',    fmtNum(ex.Planets_Scanned_To_Level_3)],
          ['Efficient Scans',    fmtNum(ex.Efficient_Scans)],
          ['First Footfalls',    fmtNum(ex.First_Footfalls)],
          ['Exploration Profit', fmtCr(ex.Exploration_Profits)],
          ['Time Played',        fmtTime(ex.Time_Played)],
        ]},
        { title:'Trade & Mining', color:'c-green', rows:[
          ['Trade Transactions', fmtNum(tr.Market_Transactions_Count)],
          ['Trade Profit',       fmtCr(tr.Market_Profits)],
          ['Highest Single Trade',fmtCr(tr.Highest_Single_Transaction)],
          ['Markets Traded',     fmtNum(tr.Markets_Traded_With)],
          ['Mining Profit',      fmtCr(mn.Mining_Profits)],
          ['Qty Mined',          fmtNum(mn.Quantity_Mined)],
          ['Black Market',       fmtCr(sm.Black_Market_Profits)],
          ['Search & Rescue',    fmtCr(sr.SearchRescue_Profit)],
          ['Total Wealth',       fmtCr(ba.Current_Wealth)],
        ]},
        { title:'Combat', color:'c-red', rows:[
          ['Bounties Claimed',   fmtNum(cb.Bounties_Claimed)],
          ['Bounty Profit',      fmtCr(cb.Bounty_Hunting_Profit)],
          ['Highest Reward',     fmtCr(cb.Highest_Single_Reward)],
          ['Combat Bonds',       fmtNum(cb.Combat_Bonds)],
          ['Bond Profits',       fmtCr(cb.Combat_Bond_Profits)],
          ['Assassinations',     fmtNum(cb.Assassinations)],
          ['Assassination Cr.',  fmtCr(cb.Assassination_Profits)],
        ]},
        { title:'Exobiology', color:'c-purple', rows:[
          ['Organic Data Sold',  fmtNum(exo.Organics_Sold)],
          ['Exobiology Profit',  fmtCr(exo.Exobiology_Profits)],
          ['First Logged',       fmtCr(exo.First_Logged_Profits)],
          ['Genus Encountered',  fmtNum(exo.Organic_Genus_Encountered)],
          ['Species Found',      fmtNum(exo.Organic_Species_Encountered)],
          ['Systems',            fmtNum(exo.Organic_Systems)],
          ['Planets',            fmtNum(exo.Organic_Planets)],
        ]},
        { title:'Spending', color:'c-gold', rows:[
          ['On Ships',           fmtCr(ba.Spent_On_Ships)],
          ['On Outfitting',      fmtCr(ba.Spent_On_Outfitting)],
          ['On Repairs',         fmtCr(ba.Spent_On_Repairs)],
          ['On Insurance',       fmtCr(ba.Spent_On_Insurance)],
          ['On Suits',           fmtCr(ba.Spent_On_Suits)],
          ['On Weapons',         fmtCr(ba.Spent_On_Weapons)],
          ['Ships Owned',        fmtNum(ba.Owned_Ship_Count)],
          ['Suits Owned',        fmtNum(ba.Suits_Owned)],
          ['Weapons Owned',      fmtNum(ba.Weapons_Owned)],
        ]},
      ];
      statsEl.innerHTML = statCols.map(function(col) {
        return '<div class="stat-block">' +
          '<div class="stat-block-title ' + col.color + '">' + col.title + '</div>' +
          col.rows.map(function(row) {
            return '<div class="mini-stat"><span class="ms-key">' + row[0] + '</span><span class="ms-val">' + row[1] + '</span></div>';
          }).join('') + '</div>';
      }).join('');
    }

    // Show profile content, hide "no data" placeholder
    var noData  = document.getElementById('prof-no-data');
    var content = document.getElementById('prof-content');
    if (noData)  noData.style.display  = 'none';
    if (content) content.style.display = 'block';

    log('Profile data loaded: ' + (id.name || '?'), 'good');
  });

  // ── REAL-TIME LOCATION (watcher fires on FSDJump AND Location events) ───────
  // Location events fire for many in-system activities: entering FSS mode,
  // supercruise exit, approaching a body, etc. We must only clear body state
  // when the system actually changes - not every time Location fires.
  window.electronAPI.onLocation(function(data) {
    if (!data.system) return;

    var isNewSystem = data.system !== _currentSystem;

    set('sys-name', data.system);
    set('tb-sys',   data.system);

    if (isNewSystem) {
      log('Jump: ' + data.system, 'info');

      // Clear body state - entering a new system
      _currentSystem  = data.system;
      _journalBodies  = {};
      _journalSignals = {};
      _edsmBodies     = [];
      _edsmStations   = [];
      _scanEntries    = {};
      _expandedBodyGroups = new Set();
      renderBodiesDebounced(data.system);
      renderScans();

      // Clear EDSM fields until new system data arrives
      set('sys-security',   '\u2014');
      set('sys-allegiance', '\u2014');
      set('sys-economy',    '\u2014');
      set('sys-population', '\u2014');

      // Activate EDSM link immediately with a fallback URL
      var link = document.getElementById('edsm-link');
      if (link) {
        var fallbackUrl = 'https://www.edsm.net/en/system/id/-/name/' + encodeURIComponent(data.system);
        link.style.opacity = '0.6';
        link.style.pointerEvents = 'auto';
        link.title = 'View ' + data.system + ' on EDSM';
        link.onclick = function(e) {
          e.preventDefault();
          if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(fallbackUrl);
          return false;
        };
      }
      var dot = document.getElementById('edsm-dot');
      if (dot) { dot.style.background = 'var(--text-mute)'; dot.title = 'EDSM: fetching\u2026'; }
    }
    // Same-system Location events (FSS entry, supercruise exit, approach body, etc.)
    // are intentionally ignored here - body state is preserved.
  });

  // ── JOURNAL SCAN DATA → live bodies panel ───────────────────────────────────────────
  if (window.electronAPI.onBodiesData) {
    window.electronAPI.onBodiesData(function(data) {
      if (!data || !data.bodies) return;

      var incomingSystem = data.system || _currentSystem;

      // If the system changed, flush stale EDSM bodies and scan entries
      if (incomingSystem && incomingSystem !== _currentSystem) {
        _edsmBodies   = [];
        _edsmStations = [];
        _scanEntries  = {};
      }

      _currentSystem  = incomingSystem;
      _journalBodies  = {};
      _journalSignals = data.signals || {};
      (data.bodies || []).forEach(function(b) {
        _journalBodies[b.name] = b;
        if (b.estimatedValue || b.mappedValue) {
          _scanEntries[b.name] = {
            body:   b.name,
            type:   b.planetClass || b.starType || b.type || '',
            mapped: b.wasMapped === false,
            value:  b.estimatedValue || null,
          };
        }
      });
      renderBodiesDebounced(_currentSystem);
      renderScans();
    });
  }

  // ── EDSM BODIES → merge into bodies panel ─────────────────────────────────
  if (window.electronAPI.onEdsmBodies) {
    window.electronAPI.onEdsmBodies(function(data) {
      if (!data || !data.bodies) return;

      // Discard only genuinely stale data: we know the player is in a different
      // system AND _currentSystem is already confirmed. On boot or right after a
      // jump _currentSystem may not be set yet — in that case always accept.
      if (data.system && _currentSystem && data.system !== _currentSystem) {
        log('EDSM: discarding stale bodies for ' + data.system + ' (now in ' + _currentSystem + ')', 'warn');
        return;
      }

      // If _currentSystem wasn't known yet, set it now from the EDSM response.
      if (data.system && !_currentSystem) _currentSystem = data.system;

      _edsmBodies   = data.bodies   || [];
      _edsmStations = data.stations || [];
      renderBodiesDebounced(data.system || _currentSystem);
      log('EDSM: ' + _edsmBodies.length + ' bodies, ' + _edsmStations.length + ' stations for ' + (data.system || _currentSystem || '?'), 'info');
    });
  }

  window.electronAPI.onEdsmSystem(function(d) {
    // Security colour coding
    var secColor = 'var(--text-dim)';
    if (d.security) {
      var s = d.security.toLowerCase();
      if (s.includes('high'))   secColor = 'var(--green)';
      else if (s.includes('medium')) secColor = 'var(--gold)';
      else if (s.includes('low') || s.includes('anarchy') || s.includes('lawless')) secColor = 'var(--red, #e05252)';
    }
    var secEl = document.getElementById('sys-security');
    if (secEl) { secEl.textContent = d.security || '\u2014'; secEl.style.color = secColor; }

    set('sys-allegiance', d.allegiance || '\u2014');
    set('sys-economy',    d.economy    || '\u2014');
    set('sys-population', d.population != null ? Number(d.population).toLocaleString() : '\u2014');

    // Update EDSM link — edsmUrl is always provided by the service, even on error
    var link = document.getElementById('edsm-link');
    if (link) {
      var url = d.edsmUrl || ('https://www.edsm.net/en/system/id/-/name/' + encodeURIComponent(d.name || ''));
      link.style.opacity = d.error ? '0.5' : '1';
      link.style.pointerEvents = 'auto';
      link.onclick = function(e) {
        e.preventDefault();
        if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url);
        return false;
      };
      link.title = (d.error ? 'EDSM lookup failed — ' : 'View ') + (d.name || '') + ' on EDSM';
    }

    var dot = document.getElementById('edsm-dot');
    if (dot) {
      dot.style.background = d.error ? 'var(--red, #e05252)' : 'var(--cyan)';
      dot.title = d.error ? 'EDSM: ' + d.error : 'EDSM: ' + d.name;
    }

    if (!d.error) log('EDSM: ' + d.name + (d.allegiance ? ' \u00B7 ' + d.allegiance : '') + (d.security ? ' \u00B7 ' + d.security : ''), 'info');
  });

  // ── EDDN: submission status ───────────────────────────────────────────────
  window.electronAPI.onEddnStatus(function(d) {
    var dot = document.getElementById('eddn-dot');
    if (!dot) return;
    if (d.ok) {
      dot.style.background = 'var(--cyan)';
      dot.title = 'EDDN: submitted ' + (d.schema || '');
      // Fade back to dim after 3s
      clearTimeout(dot._fadeTimer);
      dot._fadeTimer = setTimeout(function() {
        dot.style.background = 'var(--text-mute)';
        dot.title = 'EDDN: enabled';
      }, 3000);
    } else {
      dot.style.background = 'var(--red, #e05252)';
      dot.title = 'EDDN error: ' + (d.message || d.status || '?');
    }
  });

  window.electronAPI.onScanAll(function() { log('Full journal scan triggered', 'warn'); });

  window.electronAPI.onJournalPathMissing(function(p) {
    log('Journal folder not found: ' + p, 'error');
    log('Set the correct path in Options \u2699', 'warn');
  });

  window.electronAPI.onProgress(function(data) {
    var overall = Math.round(((data.fileIndex - 1 + data.currentLine / data.totalLines) / data.totalFiles) * 100);
    var filePct = Math.round((data.currentLine / data.totalLines) * 100);
    var bar = document.getElementById('progress-bar');
    if (bar) bar.style.width = overall + '%';
    set('progress-pct',    overall + '%');
    set('progress-info',   'File ' + data.fileIndex + ' of ' + data.totalFiles);
    set('progress-detail', data.file + '  \u00B7  line ' + data.currentLine + ' / ' + data.totalLines + '  (' + filePct + '%)');
    if (overall >= 100) {
      setTimeout(function() {
        if (bar) bar.style.width = '0%';
        set('progress-pct',    '\u2014');
        set('progress-info',   'Ready');
        set('progress-detail', '');
        log('Scan complete', 'good');
      }, 800);
    }
  });

}

async function refreshStats() {
  try { var res = await fetch('http://localhost:3721/stats'); var d = await res.json(); log('DB scans: ' + d.scans, 'info'); } catch {}
}

// ─── MISSIONS ─────────────────────────────────────────────────────
var _missions = {};  // missionID → mission object
var _missionsActiveTab = 'active';

var MISSION_TYPE_MAP = [
  { match: /massacre|assassin|kill|destroy/i,       type: 'Combat',     color: 'var(--red, #e05252)' },
  { match: /delivery|transport|smuggle/i,            type: 'Delivery',   color: 'var(--cyan)' },
  { match: /collect|mine|source|recover|salvage/i,  type: 'Collection', color: 'var(--gold)' },
  { match: /scan|survey|explore/i,                  type: 'Scan',       color: 'var(--cyan)' },
  { match: /courier/i,                               type: 'Courier',    color: 'var(--cyan)' },
  { match: /passenger/i,                             type: 'Passenger',  color: 'var(--green, #4caf7d)' },
  { match: /rescue/i,                                type: 'Rescue',     color: 'var(--green, #4caf7d)' },
];

function missionType(name) {
  if (!name) return { type: 'Other', color: 'var(--text-dim)' };
  for (var i = 0; i < MISSION_TYPE_MAP.length; i++) {
    if (MISSION_TYPE_MAP[i].match.test(name)) return MISSION_TYPE_MAP[i];
  }
  return { type: 'Other', color: 'var(--text-dim)' };
}

function fmtExpiry(iso) {
  if (!iso) return null;
  var ms    = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { label: 'Expired', urgent: true };
  var hours = Math.floor(ms / 3600000);
  var mins  = Math.floor((ms % 3600000) / 60000);
  if (hours < 1)  return { label: mins + 'm left', urgent: true };
  if (hours < 6)  return { label: hours + 'h ' + mins + 'm left', urgent: true };
  if (hours < 24) return { label: hours + 'h left', urgent: false };
  return { label: Math.floor(hours / 24) + 'd left', urgent: false };
}

function influenceDots(inf) {
  if (!inf) return '';
  var n = typeof inf === 'string' ? inf.length : (inf || 0);
  return '<span style="color:var(--green,#4caf7d);letter-spacing:1px;">' + '▲'.repeat(Math.min(n, 5)) + '</span>';
}

function renderMissions() {
  var missions = Object.values(_missions);
  var active   = missions.filter(function(m) { return m.status === 'Active'; })
                         .sort(function(a, b) {
                           if (!a.expiry && !b.expiry) return 0;
                           if (!a.expiry) return 1;
                           if (!b.expiry) return -1;
                           return new Date(a.expiry) - new Date(b.expiry);
                         });
  var past     = missions.filter(function(m) { return m.status !== 'Active'; })
                         .sort(function(a, b) {
                           return new Date(b.doneTimestamp || 0) - new Date(a.doneTimestamp || 0);
                         });

  var badgeA = document.getElementById('missions-badge-active');
  var badgeP = document.getElementById('missions-badge-past');
  if (badgeA) badgeA.textContent = active.length;
  if (badgeP) badgeP.textContent = past.length;

  renderMissionList('missions-active-list', active);
  renderMissionList('missions-past-list',   past);
}

function renderMissionList(containerId, list) {
  var el = document.getElementById(containerId);
  if (!el) return;

  if (!list.length) {
    el.innerHTML = '<div class="empty-state" style="height:60px;"><div class="msg">No missions</div></div>';
    return;
  }

  el.innerHTML = list.map(function(m) {
    var t       = missionType(m.internalName || m.name);
    var expiry  = fmtExpiry(m.expiry);
    var statusColor = m.status === 'Complete'  ? 'var(--green,#4caf7d)'
                    : m.status === 'Failed'    ? 'var(--red,#e05252)'
                    : m.status === 'Abandoned' ? 'var(--text-dim)'
                    : 'var(--cyan)';

    return '<div class="mission-row" onclick="this.classList.toggle(\'expanded\')">' +
      '<div class="mission-row-main">' +
        '<div class="mission-dot" style="background:' + t.color + '"></div>' +
        '<div class="mission-info">' +
          '<div class="mission-name">' + (m.name || 'Unknown Mission') + '</div>' +
          '<div class="mission-meta">' +
            (m.faction ? '<span class="mission-faction">' + m.faction + '</span>' : '') +
            '<span class="mission-type-tag" style="color:' + t.color + ';border-color:' + t.color + '">' + t.type + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="mission-right">' +
          '<span class="mission-status" style="color:' + statusColor + '">' + m.status + '</span>' +
          (expiry ? '<span class="mission-expiry' + (expiry.urgent ? ' urgent' : '') + '">' + expiry.label + '</span>' : '') +
          (m.reward ? '<span class="mission-reward">' + fmtCr(m.reward) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="mission-detail">' +
        (m.destinationSystem  ? '<div class="mission-detail-row"><span class="mdk">Destination</span><span class="mdv">' + (m.destinationStation ? m.destinationStation + ' · ' : '') + m.destinationSystem + '</span></div>' : '') +
        (m.commodity          ? '<div class="mission-detail-row"><span class="mdk">Cargo</span><span class="mdv">' + m.commodity + (m.count ? ' × ' + m.count : '') + '</span></div>' : '') +
        (m.targetFaction      ? '<div class="mission-detail-row"><span class="mdk">Target</span><span class="mdv">' + m.targetFaction + (m.targetType ? ' (' + m.targetType + ')' : '') + '</span></div>' : '') +
        (m.influence          ? '<div class="mission-detail-row"><span class="mdk">Influence</span><span class="mdv">' + influenceDots(m.influence) + '</span></div>' : '') +
        (m.expiry             ? '<div class="mission-detail-row"><span class="mdk">Expires</span><span class="mdv">' + new Date(m.expiry).toLocaleString() + '</span></div>' : '') +
        (m.acceptedTimestamp  ? '<div class="mission-detail-row"><span class="mdk">Accepted</span><span class="mdv">' + new Date(m.acceptedTimestamp).toLocaleString() + '</span></div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// Sub-tab switching
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.missions-tab');
  if (!btn) return;
  var tab = btn.dataset.mtab;
  _missionsActiveTab = tab;
  document.querySelectorAll('.missions-tab').forEach(function(b) { b.classList.toggle('active', b.dataset.mtab === tab); });
  var activeList = document.getElementById('missions-active-list');
  var pastList   = document.getElementById('missions-past-list');
  if (activeList) activeList.style.display = tab === 'active' ? '' : 'none';
  if (pastList)   pastList.style.display   = tab === 'past'   ? '' : 'none';
});

// IPC listener
if (window.electronAPI && window.electronAPI.onMissionsData) {
  window.electronAPI.onMissionsData(function(data) {
    if (!data || !data.missions) return;
    _missions = data.missions;
    renderMissions();
    var active = Object.values(_missions).filter(function(m) { return m.status === 'Active'; }).length;
    log('Missions: ' + active + ' active', 'info');
  });
}

// ─── OPTIONS PANEL ────────────────────────────────────────────────
function capiUpdateUI(status) {
  // status: { hasClientId, isLoggedIn, tokenValid, tokenExpiry } from capiGetStatus()
  // OR null/undefined when not available
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
    expiryRow.style.display = 'none';
    if (loginSub)  loginSub.textContent  = 'Opens Frontier auth in your browser';
    if (loginBtn)  loginBtn.style.display  = '';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

function openOptions() {
  document.getElementById('options-panel').classList.add('open');
  document.getElementById('options-overlay').classList.add('open');
  if (!window.electronAPI) return;
  // Load journal path
  window.electronAPI.getJournalPath()
    .then(function(p) { if (p) document.getElementById('opt-journal-path').value = p; })
    .catch(function() {});
  // Load full config for EDDN/EDSM/cAPI fields
  window.electronAPI.getConfig().then(function(cfg) {
    var el;
    el = document.getElementById('opt-eddn-enabled'); if (el) el.checked = !!cfg.eddnEnabled;
    el = document.getElementById('opt-cmdr-name');    if (el) el.value  = cfg.commanderName    || '';
    el = document.getElementById('opt-edsm-enabled'); if (el) el.checked = !!cfg.edsmEnabled;
    el = document.getElementById('opt-edsm-cmdr');    if (el) el.value  = cfg.edsmCommanderName || '';
    el = document.getElementById('opt-edsm-key');     if (el) el.value  = cfg.edsmApiKey        || '';
    // Inara settings
    el = document.getElementById('opt-inara-cmdr-name');  if (el) el.value = cfg.inaraCommanderName || '';
    // Network server settings
    el = document.getElementById('opt-network-enabled'); if (el) el.checked = !!cfg.networkServerEnabled;
    el = document.getElementById('opt-network-port');    if (el) el.value  = cfg.networkServerPort || 3722;
    el = document.getElementById('opt-fuel-alert-pct'); if (el) el.value = cfg.fuelAlertThresholdPct != null ? cfg.fuelAlertThresholdPct : 25;
    el = document.getElementById('opt-hull-alert-pct'); if (el) el.value = cfg.hullAlertThresholdPct != null ? cfg.hullAlertThresholdPct : 70;
    syncShipAlertCfgFromObject(cfg);
    // Fetch live network info and render clickable URLs
    if (window.electronAPI.getNetworkInfo) {
      window.electronAPI.getNetworkInfo().then(function(info) {
        var urlsDiv = document.getElementById('opt-network-urls');
        if (!urlsDiv) return;
        if (info && info.enabled && info.ips && info.ips.length) {
          var port = info.port || 3722;
          var links = info.ips.map(function(ip) {
            var url = 'http://' + ip + ':' + port;
            return '<a href="' + url + '" style="color:var(--green);text-decoration:none;font-family:monospace;font-size:1.05em;" ' +
              'onclick="if(window.electronAPI&&window.electronAPI.openExternal){event.preventDefault();window.electronAPI.openExternal(\'' + url + '\');}">' +
              url + '</a>';
          }).join('<br>');
          urlsDiv.style.display = 'block';
          urlsDiv.innerHTML =
            '<div style="margin-bottom:4px;color:var(--text-mute);">Network UI is active — open on any device:</div>' +
            links;
        } else if (info && info.enabled && (!info.ips || !info.ips.length)) {
          urlsDiv.style.display = 'block';
          urlsDiv.innerHTML = '<span style="color:var(--text-dim);">No network interfaces found. Check your network connection.</span>';
        } else {
          urlsDiv.style.display = 'none';
        }
      }).catch(function() {
        var urlsDiv = document.getElementById('opt-network-urls');
        if (urlsDiv) urlsDiv.style.display = 'none';
      });
    }
    // Reflect enabled state in dots
    var eddnDot = document.getElementById('eddn-dot');
    if (eddnDot) { eddnDot.style.background = cfg.eddnEnabled ? 'var(--text-mute)' : 'var(--border2)'; eddnDot.title = cfg.eddnEnabled ? 'EDDN: enabled' : 'EDDN: disabled'; }
    var edsmDot = document.getElementById('edsm-dot');
    if (edsmDot) { edsmDot.style.background = cfg.edsmEnabled ? 'var(--text-mute)' : 'var(--border2)'; edsmDot.title = cfg.edsmEnabled ? 'EDSM: enabled' : 'EDSM: disabled'; }
  }).catch(function() {});
  // Load cAPI auth state
  window.electronAPI.capiGetStatus().then(capiUpdateUI).catch(function() {});
}
function closeOptions() {
  document.getElementById('options-panel').classList.remove('open');
  document.getElementById('options-overlay').classList.remove('open');
}

document.getElementById('options-btn').addEventListener('click', openOptions);
document.getElementById('options-close').addEventListener('click', closeOptions);
document.getElementById('options-overlay').addEventListener('click', closeOptions);

var scanBtn = document.getElementById('opt-scan-btn');
if (scanBtn) scanBtn.addEventListener('click', function() {
  if (window.electronAPI) window.electronAPI.triggerScanAll();
  log('Scan All Journals triggered', 'warn');
  closeOptions();
});

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
  } catch { log('Browse not available', 'warn'); }
});

var openBtn = document.getElementById('opt-open-btn');
if (openBtn) openBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  try { await window.electronAPI.openJournalFolder(document.getElementById('opt-journal-path').value.trim() || null); }
  catch { log('Could not open folder', 'warn'); }
});

var shipAlertsSaveBtn = document.getElementById('opt-ship-alerts-save-btn');
if (shipAlertsSaveBtn) shipAlertsSaveBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  var fuelRaw = ((document.getElementById('opt-fuel-alert-pct') || {}).value || '').trim();
  var hullRaw = ((document.getElementById('opt-hull-alert-pct') || {}).value || '').trim();
  var fuelAlertThresholdPct = clampShipAlertPct(fuelRaw, 25);
  var hullAlertThresholdPct = clampShipAlertPct(hullRaw, 70);
  try {
    await window.electronAPI.saveConfig({ fuelAlertThresholdPct, hullAlertThresholdPct });
    _shipAlertCfg.fuelPct = fuelAlertThresholdPct;
    _shipAlertCfg.hullPct = hullAlertThresholdPct;
    var hint = document.getElementById('opt-ship-alerts-hint');
    if (hint) {
      hint.textContent = 'Saved \u2714';
      hint.style.color = 'var(--green)';
      setTimeout(function() { hint.textContent = 'Applies immediately'; hint.style.color = ''; }, 2000);
    }
    log('Ship alert thresholds saved', 'good');
  } catch (e) {
    log('Failed to save ship alerts', 'error');
  }
});

var journalPath = document.getElementById('opt-journal-path');
if (journalPath) journalPath.addEventListener('change', async function() {
  if (!window.electronAPI) return;
  var val = journalPath.value.trim();
  try {
    await window.electronAPI.saveJournalPath(val);
    document.getElementById('opt-path-hint').textContent = val ? 'Path saved \u2014 restart to apply' : 'Leave blank to use the default path for your OS';
    document.getElementById('opt-path-hint').style.color = val ? 'var(--green)' : '';
  } catch {}
});

// ─── EDDN / EDSM SAVE BUTTON ──────────────────────────────────────
var saveApiBtn = document.getElementById('opt-save-api-btn');
if (saveApiBtn) saveApiBtn.addEventListener('click', async function() {
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
    // Update dots
    var eddnDot = document.getElementById('eddn-dot');
    if (eddnDot) { eddnDot.style.background = eddnEnabled ? 'var(--text-mute)' : 'var(--border2)'; eddnDot.title = eddnEnabled ? 'EDDN: enabled' : 'EDDN: disabled'; }
    var edsmDot = document.getElementById('edsm-dot');
    if (edsmDot) { edsmDot.style.background = edsmEnabled ? 'var(--text-mute)' : 'var(--border2)'; edsmDot.title = edsmEnabled ? 'EDSM: enabled' : 'EDSM: disabled'; }
    log('API settings saved', 'good');
  } catch { log('Failed to save API settings', 'error'); }
});

// ─── NETWORK UI SERVER BUTTON ─────────────────────────────────────
var networkSaveBtn = document.getElementById('opt-network-save-btn');
if (networkSaveBtn) networkSaveBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  var networkServerEnabled = (document.getElementById('opt-network-enabled') || {}).checked || false;
  var portVal = parseInt(((document.getElementById('opt-network-port') || {}).value || '3722'), 10);
  var networkServerPort = (portVal >= 1024 && portVal <= 65535) ? portVal : 3722;
  try {
    await window.electronAPI.saveConfig({ networkServerEnabled, networkServerPort });
    var hint = document.getElementById('opt-network-hint');
    if (hint) { hint.textContent = 'Saved \u2714 — restart the app to apply'; hint.style.color = 'var(--green)'; setTimeout(function() { hint.textContent = 'Restart required to apply changes'; hint.style.color = ''; }, 3000); }
    // Show live URLs if the server is already running (e.g. was enabled before)
    if (window.electronAPI.getNetworkInfo) {
      window.electronAPI.getNetworkInfo().then(function(info) {
        var urlsDiv = document.getElementById('opt-network-urls');
        if (!urlsDiv) return;
        if (info && info.enabled && info.ips && info.ips.length) {
          var port = networkServerPort;
          var links = info.ips.map(function(ip) {
            var url = 'http://' + ip + ':' + port;
            return '<a href="' + url + '" style="color:var(--green);text-decoration:none;font-family:monospace;font-size:1.05em;" ' +
              'onclick="if(window.electronAPI&&window.electronAPI.openExternal){event.preventDefault();window.electronAPI.openExternal(\'' + url + '\');}">' +
              url + '</a>';
          }).join('<br>');
          urlsDiv.style.display = 'block';
          urlsDiv.innerHTML =
            '<div style="margin-bottom:4px;color:var(--text-mute);">Will be available after restart:</div>' + links;
        } else if (networkServerEnabled) {
          urlsDiv.style.display = 'block';
          urlsDiv.innerHTML = '<span style="color:var(--text-dim);">Will start on port <strong>' + networkServerPort + '</strong> after restart.</span>';
        } else {
          urlsDiv.style.display = 'none';
        }
      }).catch(function() {});
    }
    log('Network settings saved — restart to apply', 'good');
  } catch { log('Failed to save network settings', 'error'); }
});

// ─── FRONTIER cAPI BUTTONS ────────────────────────────────────────
// (Client ID is baked into the app itself — see capiService.js — so there's
// no user-facing Client ID field to save anymore.)

// Login button — starts the OAuth2 flow in capiService.js
var capiLoginBtn = document.getElementById('capi-login-btn');
if (capiLoginBtn) capiLoginBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  var sub = document.getElementById('capi-login-sub');
  if (sub) sub.textContent = 'Waiting for browser login\u2026';
  capiLoginBtn.disabled = true;
  try {
    var result = await window.electronAPI.capiLogin();
    if (result && result.success) {
      log('cAPI login successful', 'good');
      // Re-fetch status to update the UI (profile fetch happens in capiService)
      var status = await window.electronAPI.capiGetStatus();
      capiUpdateUI(status);
    } else {
      var errMsg = (result && result.error) ? result.error : 'Login failed';
      log('cAPI: ' + errMsg, 'error');
      if (sub) sub.textContent = 'Login failed \u2014 see log';
      // Reset after a moment
      setTimeout(function() { if (sub) sub.textContent = 'Opens Frontier auth in your browser'; }, 4000);
    }
  } catch (err) {
    log('cAPI login error: ' + (err.message || err), 'error');
    if (sub) sub.textContent = 'Error \u2014 see log';
    setTimeout(function() { if (sub) sub.textContent = 'Opens Frontier auth in your browser'; }, 4000);
  } finally {
    capiLoginBtn.disabled = false;
  }
});

// Logout button — clears stored tokens
var capiLogoutBtn = document.getElementById('capi-logout-btn');
if (capiLogoutBtn) capiLogoutBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  try {
    await window.electronAPI.capiLogout();
    capiUpdateUI({ isLoggedIn: false, tokenValid: false });
    log('cAPI logged out', 'info');
  } catch { log('cAPI logout failed', 'error'); }
});

// Refresh button — manually triggers capiProvider.refreshAll() (profile,
// market/shipyard if docked, fleet carrier, community goals)
var capiRefreshBtn = document.getElementById('capi-refresh-btn');
if (capiRefreshBtn) capiRefreshBtn.addEventListener('click', async function() {
  if (!window.electronAPI || !window.electronAPI.capiRefreshAll) return;
  var sub = document.getElementById('capi-refresh-sub');
  capiRefreshBtn.disabled = true;
  if (sub) sub.textContent = 'Refreshing\u2026';
  try {
    var result = await window.electronAPI.capiRefreshAll();
    if (result && result.success) {
      log('cAPI data refreshed', 'good');
      if (sub) sub.textContent = 'Fetch profile, fleet carrier & community goals';
    } else {
      var errMsg = (result && result.error) ? result.error : 'Refresh failed';
      log('cAPI: ' + errMsg, 'error');
      if (sub) sub.textContent = errMsg;
      setTimeout(function() { if (sub) sub.textContent = 'Fetch profile, fleet carrier & community goals'; }, 4000);
    }
  } catch (err) {
    log('cAPI refresh error: ' + (err.message || err), 'error');
  } finally {
    capiRefreshBtn.disabled = false;
  }
});

// ── cAPI push data — cache latest results for use by profile.html's cAPI subtab
window._capiCache = window._capiCache || {};
if (window.electronAPI) {
  if (window.electronAPI.onCapiProfileData) window.electronAPI.onCapiProfileData(function(data) { window._capiCache.profile = data; });
  if (window.electronAPI.onCapiMarketData) window.electronAPI.onCapiMarketData(function(data) { window._capiCache.market = data; });
  if (window.electronAPI.onCapiShipyardData) window.electronAPI.onCapiShipyardData(function(data) { window._capiCache.shipyard = data; });
  if (window.electronAPI.onCapiFleetCarrierData) window.electronAPI.onCapiFleetCarrierData(function(data) { window._capiCache.fleetCarrier = data; });
  if (window.electronAPI.onCapiCommunityGoalsData) window.electronAPI.onCapiCommunityGoalsData(function(data) { window._capiCache.communityGoals = data; });
}

// --- EDSM FLIGHT LOG SYNC (from index/profile options panel) ---
if (window.electronAPI && window.electronAPI.onEdsmSyncProgress) {
  window.electronAPI.onEdsmSyncProgress(function(p) {
    var hint = document.getElementById('opt-edsm-sync-hint');
    if (hint) hint.textContent = 'Fetching batch ' + p.batch + ' / ' + p.total + ' (' + p.fetched + ' entries…)';
  });
}

var edsmSyncBtnMain = document.getElementById('opt-edsm-sync-btn');
if (edsmSyncBtnMain) edsmSyncBtnMain.addEventListener('click', async function() {
  if (!window.electronAPI || !window.electronAPI.edsmSyncLogs) return;
  var hint = document.getElementById('opt-edsm-sync-hint');
  edsmSyncBtnMain.disabled = true;
  if (hint) hint.textContent = 'Connecting to EDSM…';
  try {
    // No local jumps cached on this page — pass empty array.
    // Main fetches all EDSM data and the merged result goes to history-data.
    var result = await window.electronAPI.edsmSyncLogs([]);
    if (result.success) {
      var msg = result.newFromEdsm + ' new jump' + (result.newFromEdsm !== 1 ? 's' : '') + ' pulled from EDSM';
      if (hint) { hint.textContent = msg; hint.style.color = 'var(--green)'; }
      log('EDSM sync: ' + msg, 'good');
      setTimeout(function() {
        if (hint) { hint.textContent = 'Pull your EDSM history & merge with local journals'; hint.style.color = ''; }
      }, 5000);
    } else {
      if (hint) { hint.textContent = 'Error: ' + result.error; hint.style.color = 'var(--red, #e05252)'; }
      log('EDSM sync failed: ' + result.error, 'error');
      setTimeout(function() {
        if (hint) { hint.textContent = 'Pull your EDSM history & merge with local journals'; hint.style.color = ''; }
      }, 6000);
    }
  } catch (err) {
    if (hint) hint.textContent = 'Sync failed: ' + (err.message || err);
    log('EDSM sync error: ' + err.message, 'error');
  } finally {
    edsmSyncBtnMain.disabled = false;
  }
});

// Theme swatches and display sliders (font/density/brightness/opacity/
// scanlines/glow/border) are handled by display-settings.js, shared by
// every page — see that file for the single implementation.

// ─── LIVE LAYOUT: toggleable panes, reflow, persistence (index.html) ─
(function () {
  var viewLive = document.getElementById('view-live');
  if (!viewLive) return;

  var LIVE_PANEL_KEYS = ['commander', 'summary', 'system', 'progress', 'scan', 'missions', 'log'];
  var LIVE_PANEL_ID = {
    commander: 'panel-commander',
    summary: 'panel-summary',
    system: 'panel-system',
    progress: 'panel-progress',
    scan: 'panel-scan',
    missions: 'panel-missions',
    log: 'panel-log',
  };
  var LIVE_PANEL_TOG = {
    commander: 'tog-commander',
    summary: 'tog-summary',
    system: 'tog-system',
    progress: 'tog-progress',
    scan: 'tog-scan',
    missions: 'tog-missions',
    log: 'tog-log',
  };
  var LIVE_PANEL_LABELS = {
    commander: 'Commander',
    summary: 'Scan Summary',
    system: 'System Bodies',
    progress: 'Journal Scan',
    scan: 'Scan Values',
    missions: 'Missions',
    log: 'Application Log',
  };
  var LIVE_COL_LAYOUT = [
    { col: 'live-col-left', restore: 'live-col-left-restore', keys: ['commander', 'summary'] },
    { col: 'live-col-mid', restore: 'live-col-mid-restore', keys: ['system', 'progress'] },
    { col: 'live-col-right', restore: 'live-col-right-restore', keys: ['scan', 'missions', 'log'] },
  ];

  function panelEl(key) {
    return document.getElementById(LIVE_PANEL_ID[key]);
  }

  function isLivePanelVisible(key) {
    var el = panelEl(key);
    return !!(el && !el.classList.contains('live-pane-hidden'));
  }

  function saveLivePanelPrefs() {
    var o = {};
    LIVE_PANEL_KEYS.forEach(function (k) { o[k] = isLivePanelVisible(k); });
    try { localStorage.setItem('ee-live-panels', JSON.stringify(o)); } catch (e) {}
  }

  function setLivePanelVisible(key, visible, opts) {
    opts = opts || {};
    var el = panelEl(key);
    if (!el) return;
    el.classList.toggle('live-pane-hidden', !visible);
    var cb = document.getElementById(LIVE_PANEL_TOG[key]);
    if (cb) cb.checked = visible;
    if (!opts.skipSave) saveLivePanelPrefs();
    if (!opts.skipReflow) reflowLiveLayout();
  }

  function reflowLiveLayout() {
    LIVE_COL_LAYOUT.forEach(function (block) {
      var colEl = document.getElementById(block.col);
      var restoreEl = document.getElementById(block.restore);
      if (!colEl || !restoreEl) return;
      var visibleEls = [];
      var hiddenKeys = [];
      block.keys.forEach(function (k) {
        var el = panelEl(k);
        if (!el) return;
        el.classList.remove('live-pane-grow');
        if (el.classList.contains('live-pane-hidden')) hiddenKeys.push(k);
        else visibleEls.push(el);
      });
      if (visibleEls.length === 1) visibleEls[0].classList.add('live-pane-grow');
      colEl.classList.toggle('live-col-empty', visibleEls.length === 0);
      restoreEl.innerHTML = '';
      if (hiddenKeys.length) {
        restoreEl.style.display = 'flex';
        hiddenKeys.forEach(function (k) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'live-restore-btn';
          b.setAttribute('data-live-panel', k);
          b.textContent = '\u002B ' + LIVE_PANEL_LABELS[k];
          restoreEl.appendChild(b);
        });
      } else restoreEl.style.display = 'none';
    });

    var L = document.getElementById('live-col-left');
    var M = document.getElementById('live-col-mid');
    var R = document.getElementById('live-col-right');
    var lVis = L && !L.classList.contains('live-col-empty');
    var mVis = M && !M.classList.contains('live-col-empty');
    var rVis = R && !R.classList.contains('live-col-empty');
    viewLive.classList.remove(
      'live-grid-lmr', 'live-grid-lm', 'live-grid-lr', 'live-grid-mr',
      'live-grid-l', 'live-grid-m', 'live-grid-r'
    );
    if (lVis && mVis && rVis) viewLive.classList.add('live-grid-lmr');
    else if (lVis && mVis) viewLive.classList.add('live-grid-lm');
    else if (lVis && rVis) viewLive.classList.add('live-grid-lr');
    else if (mVis && rVis) viewLive.classList.add('live-grid-mr');
    else if (lVis) viewLive.classList.add('live-grid-l');
    else if (mVis) viewLive.classList.add('live-grid-m');
    else if (rVis) viewLive.classList.add('live-grid-r');
  }

  viewLive.addEventListener('click', function (e) {
    var t = e.target.closest('.live-pane-toggle');
    if (t && t.getAttribute('data-live-panel')) {
      var k = t.getAttribute('data-live-panel');
      if (LIVE_PANEL_KEYS.indexOf(k) >= 0) setLivePanelVisible(k, !isLivePanelVisible(k));
      return;
    }
    var r = e.target.closest('.live-restore-btn');
    if (r && r.getAttribute('data-live-panel')) {
      var k2 = r.getAttribute('data-live-panel');
      if (LIVE_PANEL_KEYS.indexOf(k2) >= 0) setLivePanelVisible(k2, true);
    }
  });

  LIVE_PANEL_KEYS.forEach(function (k) {
    var cb = document.getElementById(LIVE_PANEL_TOG[k]);
    var el = panelEl(k);
    if (!cb || !el) return;
    cb.addEventListener('change', function () {
      setLivePanelVisible(k, cb.checked);
    });
  });

  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('ee-live-panels') || '{}'); } catch (e) {}
  LIVE_PANEL_KEYS.forEach(function (k) {
    var vis = saved[k] !== false;
    setLivePanelVisible(k, vis, { skipSave: true, skipReflow: true });
  });
  reflowLiveLayout();
}());

// ─── BOOT ─────────────────────────────────────────────────────────
populateBodies();
populateScans();
log('Elite Explorer initialised', 'good');
log('Journal watcher active', 'info');
log('API connected on :3721', 'info');
setInterval(refreshStats, 30000);

// ── Profile refresh poll (every 10 minutes) ─────────────────────────
// Keeps profile.html accurate without requiring a manual rescan.
// FIX: interval raised from 2m → 10m: rank/stats change infrequently
// and each refresh scans journal files + spawns a Worker thread, so
// running it too often wastes CPU for no visible benefit.
if (window.electronAPI && window.electronAPI.triggerProfileRefresh) {
  setInterval(function() {
    window.electronAPI.triggerProfileRefresh();
  }, 10 * 60 * 1000);
}

// ── Inara options panel — shared across all pages ─────────────────────────────
// Save button: persists name, then triggers a sync.
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

  // Preserve default sub-text so we can restore it after a timeout
  if (inaraSaveStatus) inaraSaveStatus.dataset.default = inaraSaveStatus.textContent;
  if (inaraSyncStatus) inaraSyncStatus.dataset.default = inaraSyncStatus.textContent;

  if (inaraSaveBtn && window.electronAPI) {
    inaraSaveBtn.addEventListener('click', function () {
      var cmdrName = (document.getElementById('opt-inara-cmdr-name') || {}).value || '';
      inaraSetStatus(inaraSaveStatus, 'Saving\u2026');
      window.electronAPI.saveConfig({ inaraCommanderName: cmdrName.trim() })
        .then(function () {
          inaraSetStatus(inaraSaveStatus, '\u2713 Saved', 'var(--green)', 3000);
          // Kick off a sync immediately after saving — fire-and-forget from the options panel
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
