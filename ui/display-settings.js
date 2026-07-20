// ─────────────────────────────────────────────────────────────────────────
// SHARED DISPLAY SETTINGS — single template for every page
// ─────────────────────────────────────────────────────────────────────────
// This file is the ONE source of truth for the colour theme swatches and the
// "Font Size / Row Density / Brightness / Panel Opacity / Scanlines / Glow /
// Border Sharpness" sliders in the options panel. It is loaded by every
// page (index.html, history.html, profile.html, spansh.html, ship.html) so
// that the UI looks and behaves identically everywhere — no more per-page
// drift, and no more "UI Scale" option (removed).
// ─────────────────────────────────────────────────────────────────────────

// ─── COLOUR THEME ───────────────────────────────────────────────────────
// Each preset sets both the base hex colours AND their raw "R,G,B" values
// (the *-rgb tokens). The rgb tokens matter: a lot of glow/background CSS
// in styles.css is written as rgba(var(--cyan-rgb), 0.1) rather than a
// flat color, specifically so those effects re-tint correctly when a theme
// is applied instead of staying stuck on the default amber/gold hue.
var THEMES = {
  // Matches the :root defaults in styles.css exactly — selecting "Default"
  // should never look different from the page's own baseline styling.
  default: {
    '--gold':'#ff9d1f', '--gold2':'#ffc266', '--gold-dim':'#8a5a1a',
    '--gold-glow':'rgba(255,157,31,0.18)', '--gold-rgb':'255,157,31',
    '--cyan':'#ffd24d', '--cyan2':'#ffe08a',
    '--cyan-dim':'rgba(255,210,77,0.10)', '--cyan-rgb':'255,210,77',
  },
  red: {
    '--gold':'#ff4d3d', '--gold2':'#ff8a7a', '--gold-dim':'#8a221a',
    '--gold-glow':'rgba(255,77,61,0.18)', '--gold-rgb':'255,77,61',
    '--cyan':'#ffa53d', '--cyan2':'#ffc885',
    '--cyan-dim':'rgba(255,165,61,0.10)', '--cyan-rgb':'255,165,61',
  },
  green: {
    '--gold':'#39e07a', '--gold2':'#7cf0ad', '--gold-dim':'#1c7a42',
    '--gold-glow':'rgba(57,224,122,0.18)', '--gold-rgb':'57,224,122',
    '--cyan':'#a6e22e', '--cyan2':'#c8ee72',
    '--cyan-dim':'rgba(166,226,46,0.10)', '--cyan-rgb':'166,226,46',
  },
  purple: {
    '--gold':'#b26bff', '--gold2':'#d0a0ff', '--gold-dim':'#5c2f8a',
    '--gold-glow':'rgba(178,107,255,0.18)', '--gold-rgb':'178,107,255',
    '--cyan':'#ff6bcb', '--cyan2':'#ffa0dd',
    '--cyan-dim':'rgba(255,107,203,0.10)', '--cyan-rgb':'255,107,203',
  },
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

// ─── DISPLAY SLIDERS (UI Scale removed — every page now renders at 1:1) ──
var SLIDER_DEFAULTS = { font:14, density:3, bright:100, opacity:100, scan:1, glow:100, border:2 };
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
    case 'font':
      // Set on both <html> and <body> (and the topbar, which some pages
      // give its own font-size) so the slider has an identical, visible
      // effect on every page regardless of how that page's CSS is written.
      root.style.fontSize = v + 'px';
      document.body.style.fontSize = v + 'px';
      var tb = document.getElementById('topbar');
      if (tb) tb.style.fontSize = v + 'px';
      break;
    case 'density': {
      var di = Math.max(0, Math.min(4, Math.round(v) - 1));
      var pad = [2,3,4,6,8][di] + 'px';
      root.style.setProperty('--row-pad', pad);
      var ds = document.getElementById('density-style') || document.createElement('style');
      ds.id = 'density-style';
      ds.textContent =
        '.stat-row, .mini-stat, .hist-row td { padding-top:' + pad + '; padding-bottom:' + pad + '; }' +
        '.panel-body { padding:' + [6,8,10,14,18][di] + 'px; }';
      document.head.appendChild(ds);
      break;
    }
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
    case 'font':    valEl.textContent = v + 'px'; break;
    case 'density': valEl.textContent = DENSITY_LABELS[v-1] || v; break;
    case 'bright':
    case 'opacity':
    case 'glow':    valEl.textContent = v + '%'; break;
    case 'scan':    valEl.textContent = SCAN_LABELS[v] || v; break;
    case 'border':  valEl.textContent = BORDER_LABELS[v] || v; break;
  }
}

function loadDisplaySettings() {
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('ee-display') || '{}'); } catch (e) {}
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

// Drop any UI Scale value left over from before this option existed, so old
// installs don't carry a stale, no-longer-applied 'scale' key around.
(function migrateAwayFromScale() {
  try {
    var saved = JSON.parse(localStorage.getItem('ee-display') || '{}');
    if (saved && Object.prototype.hasOwnProperty.call(saved, 'scale')) {
      delete saved.scale;
      localStorage.setItem('ee-display', JSON.stringify(saved));
    }
  } catch (e) {}
})();

loadDisplaySettings();
