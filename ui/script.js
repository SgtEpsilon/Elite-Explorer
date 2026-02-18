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
  entriesEl.appendChild(e);
  entriesEl.scrollTop = entriesEl.scrollHeight;
}

// ─── MOCK BODIES (live page only) ─────────────────────────────────
const MOCK_BODIES = [
  { id:'HIP 39418',   cls:'White F class star',       iconType:'star',  dist:'Main Star',  isMoon:false, info:['Mass: 1.43 SM','Radius: 1.26 SR'],       tags:[],                              value:1225,  maxVal:1225  },
  { id:'HIP 39418 1', cls:'High metal content world', iconType:'hmc',   dist:'0.34 AU',    isMoon:false, info:['Radius: 11,260 km','Landable (G: 3.0)'],  tags:['Silicate Geysers','Volcanism'], value:18174, maxVal:98446 },
  { id:'HIP 39418 1a',cls:'Rocky body Moon',          iconType:'moon',  dist:'133,937 km', isMoon:true,  info:['Radius: 418 km','Landable'],              tags:['Carbon','Niobium'],             value:500,   maxVal:2777  },
  { id:'HIP 39418 1b',cls:'Rocky body Moon',          iconType:'moon',  dist:'162,869 km', isMoon:true,  info:['Radius: 415 km','Landable'],              tags:['Carbon','Germanium'],           value:500,   maxVal:2777  },
  { id:'HIP 39418 2', cls:'High metal content world', iconType:'hmc',   dist:'0.62 AU',    isMoon:false, info:['Radius: 9,953 km','Temp: 466 K'],         tags:['Silicate Geysers'],             value:17400, maxVal:94254 },
  { id:'HIP 39418 9', cls:'Class I gas giant',        iconType:'gas',   dist:'3.17 AU',    isMoon:false, info:['Ring system present'],                    tags:[],                               value:3336,  maxVal:14456 },
];
const MOCK_SCANS = [
  { body:'HIP 39418 6', type:'High metal content', mapped:true,  value:185702 },
  { body:'HIP 39418 1', type:'High metal content', mapped:false, value:18174  },
  { body:'HIP 39418 2', type:'High metal content', mapped:false, value:17400  },
  { body:'HIP 39418 9', type:'Class I gas giant',  mapped:false, value:3336   },
  { body:'HIP 39418',   type:'White F class star', mapped:false, value:1225   },
];

function populateBodies() {
  const tbody = document.getElementById('bodies-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  let stars = 0, planets = 0, moons = 0;
  MOCK_BODIES.forEach(b => {
    const tr = document.createElement('tr');
    tr.className = b.isMoon ? 'body-moon' : 'body-main';
    tr.innerHTML =
      '<td style="text-align:center;padding:4px;"><div style="display:flex;justify-content:center;"><div class="body-icon ' + b.iconType + '"></div></div></td>' +
      '<td class="' + (b.isMoon ? 'body-indent' : '') + '">' +
        '<div class="body-name-cell">' + (b.isMoon ? '<span class="moon-indicator"></span>' : '') +
        '<span style="font-size:' + (b.isMoon ? '9' : '10') + 'px;color:' + (b.isMoon ? 'var(--text-dim)' : 'var(--text)') + '">' + b.id + '</span></div></td>' +
      '<td class="body-class">' + b.cls + '</td>' +
      '<td style="font-size:0.75em;color:var(--text-dim)">' + b.dist + '</td>' +
      '<td><div class="info-text">' + b.info.map(i => '<div>' + i + '</div>').join('') + '</div>' +
        '<div style="margin-top:3px">' + b.tags.map(t => '<span class="info-tag poi">' + t + '</span>').join('') + '</div></td>' +
      '<td class="val-cell">' + fmt(b.value) + '</td>' +
      '<td class="val-cell muted" style="font-size:0.75em">' + fmt(b.maxVal) + '</td>';
    tbody.appendChild(tr);
    if (b.iconType === 'star') stars++; else if (b.isMoon) moons++; else planets++;
  });
  set('body-count', MOCK_BODIES.length + ' bodies');
  set('sum-stars',   stars);
  set('sum-planets', planets);
  set('sum-moons',   moons);
  set('sum-total',   MOCK_BODIES.length);
}

function populateScans() {
  const tbody = document.getElementById('scan-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  let total = 0;
  MOCK_SCANS.forEach(s => {
    total += s.value;
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td style="font-size:0.75em">' + s.body + '</td>' +
      '<td style="font-size:0.6667em;color:var(--text-dim)">' + s.type + '</td>' +
      '<td style="text-align:center"><span class="mapped-icon ' + (s.mapped ? 'yes' : 'no') + '"></span></td>' +
      '<td class="scan-val">' + fmtNum(s.value) + '</td>';
    tbody.appendChild(tr);
  });
  const totalEl = document.getElementById('scan-total');
  if (totalEl) totalEl.textContent = total.toLocaleString() + ' cr';
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
    var fuelBar = document.getElementById('fuel-bar');
    if (fuelBar && d.fuelPct != null) fuelBar.style.width = d.fuelPct + '%';
    set('station-name',    d.dockedStation     || '\u2014');
    set('station-type',    d.dockedStationType || '\u2014');
    set('station-faction', d.dockedFaction     || '\u2014');

    // Discovery star in topbar
    var tbStar = document.getElementById('tb-discovery-star');
    if (tbStar) tbStar.style.display = d.lastJumpWasFirstDiscovery ? 'inline' : 'none';

    // Profile page: current system + jump range come from live data, not profile snapshot
    if (d.currentSystem) set('prof-system', d.currentSystem);
    if (d.maxJumpRange)  set('prof-jump',   d.maxJumpRange);
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

    // Identity card
    set('prof-name',       id.name      ? 'CMDR ' + id.name : '\u2014');
    set('prof-ship-type',  id.ship      || '\u2014');
    set('prof-ship-name',  id.shipName  || '\u2014');
    set('prof-ship-ident', id.shipIdent || '\u2014');
    set('prof-credits',    id.credits != null ? Number(id.credits).toLocaleString() + ' cr' : '\u2014');
    set('prof-mode',       id.gameMode  || '\u2014');

    // Ranks grid
    var ranksGrid = document.getElementById('prof-ranks-grid');
    if (ranksGrid) {
      var rankDefs = [
        { cls:'combat',  label:'Combat',      r:rk.combat,     p:pr.combat,     max:8  },
        { cls:'trade',   label:'Trade',       r:rk.trade,      p:pr.trade,      max:8  },
        { cls:'explore', label:'Exploration', r:rk.explore,    p:pr.explore,    max:8  },
        { cls:'exobio',  label:'Exobiology',  r:rk.exobiology, p:null,          max:8  },
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

  // ── REAL-TIME LOCATION (watcher fires on every FSDJump while game is live) ──
  window.electronAPI.onLocation(function(data) {
    if (data.system) {
      set('sys-name', data.system);
      set('tb-sys',   data.system);
      log('Jump: ' + data.system, 'info');
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
function openOptions() {
  document.getElementById('options-panel').classList.add('open');
  document.getElementById('options-overlay').classList.add('open');
  if (window.electronAPI && window.electronAPI.getJournalPath) {
    window.electronAPI.getJournalPath()
      .then(function(p) { if (p) document.getElementById('opt-journal-path').value = p; })
      .catch(function(){});
  }
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
var SLIDER_DEFAULTS = { scale:100, font:12, density:3, left:220, right:320, bottom:120, bright:100, opacity:100, scan:1, glow:100, border:2 };
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
      document.body.style.fontSize = v + 'px';
      var tb = document.getElementById('topbar');
      if (tb) tb.style.fontSize = v + 'px';
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
    case 'bottom': root.style.setProperty('--bottom-h', Math.max(105, v) + 'px'); break;
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
    case 'bottom':  valEl.textContent = v + 'px'; break;
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
