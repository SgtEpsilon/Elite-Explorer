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

// ─── LOGGING (live page only) ──────────────────────────────────────
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
}

// ─── BODY RENDERING ───────────────────────────────────────────────
// State: journal scan data + EDSM data are merged here.
var _journalBodies = {};   // bodyName → journal Scan entry
var _journalSignals = {};  // bodyName → [signal strings]
var _edsmBodies     = [];  // array of EDSM body objects
var _currentSystem  = null;

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

// Merge journal + EDSM data into a unified list sorted by distance
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
    // Stars before non-stars
    var aIsstar = (a.journal && a.journal.type === 'Star') || (a.edsm && a.edsm.type === 'Star');
    var bIsStar = (b.journal && b.journal.type === 'Star') || (b.edsm && b.edsm.type === 'Star');
    if (aIsstar && !bIsStar) return -1;
    if (!aIsstar && bIsStar)  return 1;
    // Within same tier, sort by distance
    var aDist = (a.journal && a.journal.distanceFromArrival) || (a.edsm && a.edsm.distanceToArrival) || 999999;
    var bDist = (b.journal && b.journal.distanceFromArrival) || (b.edsm && b.edsm.distanceToArrival) || 999999;
    return aDist - bDist;
  });
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

  bodies.forEach(function(entry) {
    var jb  = entry.journal;
    var eb  = entry.edsm;
    var sys = system || _currentSystem;

    // ── Derive display values preferring journal data, filling from EDSM ──
    var name         = (jb && jb.name) || (eb && eb.name) || '?';
    var shortName    = shortBodyName(name, sys);
    var isMain       = jb ? (jb.type === 'Star' || !isMoonBody(jb, sys)) : (eb ? eb.type === 'Star' || !isMoonBody(eb, sys) : true);
    var isStar       = (jb && jb.type === 'Star') || (eb && eb.type === 'Star');

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
  });

  tbody.innerHTML = rows.join('');
  set('body-count', bodies.length + ' bod' + (bodies.length !== 1 ? 'ies' : 'y'));
  set('sum-stars',   stars);
  set('sum-planets', planets);
  set('sum-moons',   moons);
  set('sum-total',   stars + planets + moons);
}

function populateBodies() {
  renderBodies(_currentSystem);
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

// ─── ELECTRON IPC ─────────────────────────────────────────────────
if (window.electronAPI) {

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

    // Hull — colour-coded: green ≥70%, gold 40–69%, red <40%
    if (d.hull != null) {
      var hullEl = document.getElementById('ship-hull');
      if (hullEl) {
        hullEl.textContent = d.hull + '%';
        hullEl.className   = 'stat-val ' + (d.hull >= 70 ? 'green' : d.hull >= 40 ? 'gold' : 'red');
      }
    }

    var fuelBar = document.getElementById('fuel-bar');
    if (fuelBar && d.fuelPct != null) fuelBar.style.width = d.fuelPct + '%';
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
      _scanEntries    = {};
      renderBodies(data.system);
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
        _edsmBodies  = [];
        _scanEntries = {};
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
      renderBodies(_currentSystem);
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

      _edsmBodies = data.bodies || [];
      renderBodies(data.system || _currentSystem);
      log('EDSM: ' + _edsmBodies.length + ' bodies for ' + (data.system || _currentSystem || '?'), 'info');
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
    el = document.getElementById('capi-client-id');   if (el) el.value  = cfg.capiClientId      || '';
    // Network server settings
    el = document.getElementById('opt-network-enabled'); if (el) el.checked = !!cfg.networkServerEnabled;
    el = document.getElementById('opt-network-port');    if (el) el.value  = cfg.networkServerPort || 3722;
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
// Save Client ID whenever it changes (needed before login)
var capiClientIdInput = document.getElementById('capi-client-id');
if (capiClientIdInput) capiClientIdInput.addEventListener('change', async function() {
  if (!window.electronAPI) return;
  var val = capiClientIdInput.value.trim();
  try { await window.electronAPI.saveConfig({ capiClientId: val }); }
  catch { log('Failed to save cAPI Client ID', 'error'); }
});

// Login button — starts the OAuth2 flow in capiService.js
var capiLoginBtn = document.getElementById('capi-login-btn');
if (capiLoginBtn) capiLoginBtn.addEventListener('click', async function() {
  if (!window.electronAPI) return;
  // Save the client ID field first (in case user just typed it)
  var clientIdEl = document.getElementById('capi-client-id');
  if (clientIdEl && clientIdEl.value.trim()) {
    try { await window.electronAPI.saveConfig({ capiClientId: clientIdEl.value.trim() }); } catch {}
  }
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
      if (sub) sub.textContent = 'Login failed \u2014 check Client ID and try again';
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

// ─── THEMES ───────────────────────────────────────────────────────
var THEMES = {
  default: { '--gold':'#c8972a','--gold2':'#e8b840','--gold-dim':'#7a5a10','--gold-glow':'rgba(200,151,42,0.15)','--cyan':'#2ecfcf','--cyan2':'#5ee8e8','--cyan-dim':'rgba(46,207,207,0.1)' },
  red:     { '--gold':'#e05252','--gold2':'#f07070','--gold-dim':'#a03030','--gold-glow':'rgba(224,82,82,0.15)', '--cyan':'#cf7a3e','--cyan2':'#e89060','--cyan-dim':'rgba(207,122,62,0.1)' },
  green:   { '--gold':'#4caf7d','--gold2':'#70d090','--gold-dim':'#2a7a50','--gold-glow':'rgba(76,175,125,0.15)','--cyan':'#a0cf3e','--cyan2':'#c0e060','--cyan-dim':'rgba(160,207,62,0.1)' },
  purple:  { '--gold':'#a855f7','--gold2':'#c080ff','--gold-dim':'#7a30c0','--gold-glow':'rgba(168,85,247,0.15)','--cyan':'#cf3ecf','--cyan2':'#e060e0','--cyan-dim':'rgba(207,62,207,0.1)' },
};
function applyTheme(name) {
  var t = THEMES[name] || THEMES.default;
  Object.entries(t).forEach(function(kv) { document.documentElement.style.setProperty(kv[0], kv[1]); });
  document.querySelectorAll('.opt-theme-swatch').forEach(function(el) { el.classList.toggle('active', el.dataset.theme === name); });
  localStorage.setItem('ee-theme', name);
}
document.querySelectorAll('.opt-theme-swatch').forEach(function(el) {
  el.addEventListener('click', function() { applyTheme(el.dataset.theme); });
});
applyTheme(localStorage.getItem('ee-theme') || 'default');

// ─── DISPLAY SLIDERS ──────────────────────────────────────────────
var SLIDER_DEFAULTS = { scale:100, font:18, density:3, left:250, right:320, bright:100, opacity:100, scan:1, glow:100, border:2 };
var DENSITY_LABELS  = ['Compact','Tight','Normal','Relaxed','Spacious'];
var SCAN_LABELS     = ['Off','Low','Medium','High','Intense','Max'];
var BORDER_LABELS   = ['None','Faint','Medium','Bold','Heavy'];

var scanlineStyle = document.createElement('style');
scanlineStyle.id = 'dynamic-scanlines';
document.head.appendChild(scanlineStyle);

var panelOpacityStyle = document.createElement('style');
panelOpacityStyle.id = 'dynamic-opacity';
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
      document.documentElement.style.fontSize = v + 'px';
      break;
    case 'density':
      var pad = [2,3,4,6,8][v-1] + 'px';
      root.style.setProperty('--row-pad', pad);
      var ds = document.getElementById('density-style') || document.createElement('style');
      ds.id = 'density-style';
      ds.textContent = '.stat-row { padding-top:' + pad + '; padding-bottom:' + pad + '; }' +
                       '.mini-stat { padding-top:' + pad + '; padding-bottom:' + pad + '; }' +
                       '.panel-body { padding:' + [6,8,10,14,18][v-1] + 'px; }';
      document.head.appendChild(ds);
      break;
    case 'left':   root.style.setProperty('--left-w',   v + 'px'); break;
    case 'right':  root.style.setProperty('--right-w',  v + 'px'); break;
    case 'bright':
      if (wrap) wrap.style.filter = 'brightness(' + (v/100) + ') saturate(' + (0.8 + (v/100)*0.4) + ')';
      break;
    case 'opacity':
      panelOpacityStyle.textContent =
        '.panel, #panel-summary, #panel-progress { background: rgba(9,14,24,' + (v/100) + ') !important; }' +
        '#options-panel { background: rgba(9,14,24,' + Math.min(1, v/100+0.1) + ') !important; }';
      break;
    case 'scan':
      if (v === 0) {
        scanlineStyle.textContent = 'body::after { display:none; }';
      } else {
        var opacity = [0.02, 0.04, 0.07, 0.11, 0.16][v-1];
        var gap     = [4, 4, 3, 3, 2][v-1];
        scanlineStyle.textContent =
          'body::after { background: repeating-linear-gradient(0deg, transparent, transparent ' + (gap-1) + 'px, rgba(0,0,0,' + opacity + ') ' + (gap-1) + 'px, rgba(0,0,0,' + opacity + ') ' + gap + 'px) !important; }';
      }
      break;
    case 'glow':
      var g = v / 100;
      root.style.setProperty('--gold-glow', 'rgba(200,151,42,' + (0.15*g) + ')');
      var gs = document.getElementById('glow-style') || document.createElement('style');
      gs.id = 'glow-style';
      gs.textContent =
        '.tb-logo { text-shadow: 0 0 ' + Math.round(16*g) + 'px var(--gold-glow) !important; }' +
        '.scan-total-val { text-shadow: 0 0 ' + Math.round(8*g) + 'px var(--gold-glow) !important; }' +
        '.body-icon.star { box-shadow: 0 0 ' + Math.round(8*g) + 'px rgba(245,166,35,' + (0.5*g) + ') !important; }' +
        '.body-icon.hmc  { box-shadow: 0 0 ' + Math.round(6*g) + 'px rgba(42,90,138,' + (0.4*g) + ') !important; }' +
        '.mapped-icon.yes { box-shadow: 0 0 ' + Math.round(4*g) + 'px var(--green) !important; }';
      document.head.appendChild(gs);
      break;
    case 'border':
      var bw = [0, 0.5, 1, 1.5, 2][v];
      root.style.setProperty('--border-w', bw + 'px');
      var bs = document.getElementById('border-style') || document.createElement('style');
      bs.id = 'border-style';
      bs.textContent =
        '.panel, .rank-card, .rep-card, .stat-block { border-width:' + bw + 'px !important; }' +
        '#topbar, .panel-header { border-bottom-width:' + bw + 'px !important; }' +
        '.stat-group-title { border-bottom-width:' + bw + 'px !important; }';
      document.head.appendChild(bs);
      break;
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
    case 'scale':   valEl.textContent = Math.round(v) + '%'; break;
    case 'font':    valEl.textContent = v + 'px'; break;
    case 'density': valEl.textContent = DENSITY_LABELS[v-1] || v; break;
    case 'left':
    case 'right':
    case 'bottom':
    case 'log':    valEl.textContent = v + 'px'; break;
    case 'bright':
    case 'opacity':
    case 'glow':    valEl.textContent = v + '%'; break;
    case 'scan':    valEl.textContent = SCAN_LABELS[v] || v; break;
    case 'border':  valEl.textContent = BORDER_LABELS[v] || v; break;
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

// ─── PANEL TOGGLES (live page only) ───────────────────────────────
var PANEL_MAP = {
  'tog-commander':'panel-commander',
  'tog-system':   'panel-system',
  'tog-scan':     'panel-scan',
  'tog-summary':  'panel-summary',
  'tog-progress': 'panel-progress',
  'tog-log':      'panel-log'
};
Object.entries(PANEL_MAP).forEach(function(kv) {
  var cb    = document.getElementById(kv[0]);
  var panel = document.getElementById(kv[1]);
  if (!cb || !panel) return;
  cb.addEventListener('change', function() {
    panel.style.visibility = cb.checked ? '' : 'hidden';
    panel.style.opacity    = cb.checked ? '' : '0';
  });
});

// ─── BOOT ─────────────────────────────────────────────────────────
populateBodies();
populateScans();
log('Elite Explorer initialised', 'good');
log('Journal watcher active', 'info');
log('API connected on :3721', 'info');
setInterval(refreshStats, 30000);

// ── Profile refresh poll (every 2 minutes) ─────────────────────────
// Keeps profile.html accurate without requiring a manual rescan.
// The main process re-reads journals and pushes fresh profile-data,
// which onProfileData above applies immediately.
if (window.electronAPI && window.electronAPI.triggerProfileRefresh) {
  setInterval(function() {
    window.electronAPI.triggerProfileRefresh();
  }, 2 * 60 * 1000);
}
