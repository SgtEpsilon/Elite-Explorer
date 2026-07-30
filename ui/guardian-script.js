/**
 * guardian-script.js — Guardian Sites map view.
 *
 * Original canvas renderer: no code, layout logic, or assets from
 * SrvSurvey or any other GPL project were consulted. Background is a
 * procedurally-drawn schematic (range rings + compass ticks) generated
 * purely from the POI coordinates we already have — no photo/art asset
 * is used or required.
 */
(function () {
  'use strict';

  var DEG2RAD = Math.PI / 180;

  // ── Shared topbar / options boilerplate (same pattern as every other page) ──
  function set(id, text, color) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  }

  if (window.electronAPI) {
    window.electronAPI.onLiveData(function (d) {
      if (d.name)            set('tb-cmdr', 'CMDR ' + d.name);
      if (d.credits != null) set('tb-credits', Number(d.credits).toLocaleString() + ' CR');
      if (d.currentSystem)   set('tb-sys', d.currentSystem);
      var star = document.getElementById('tb-discovery-star');
      if (star) star.style.display = d.lastJumpWasFirstDiscovery ? 'inline' : 'none';
    });
  }

  function openOptions() {
    document.getElementById('options-panel').classList.add('open');
    document.getElementById('options-overlay').classList.add('open');
  }
  function closeOptions() {
    document.getElementById('options-panel').classList.remove('open');
    document.getElementById('options-overlay').classList.remove('open');
  }
  document.getElementById('options-btn').addEventListener('click', openOptions);
  document.getElementById('options-close').addEventListener('click', closeOptions);
  document.getElementById('options-overlay').addEventListener('click', closeOptions);

  var canonnLink = document.getElementById('gdn-canonn-link');
  if (canonnLink) {
    canonnLink.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.electronAPI && window.electronAPI.openExternal) {
        window.electronAPI.openExternal('https://docs.canonn.tech');
      }
    });
  }

  // ── POI styling ─────────────────────────────────────────────────────────
  var POI_STYLE = {
    'relic-tower': { color: 'var(--gold)',   shape: 'circle', r: 6 },
    'obelisk':     { color: 'var(--cyan)',   shape: 'circle', r: 5 },
    'casket':      { color: 'var(--purple)', shape: 'circle', r: 4 },
    'tablet':      { color: 'var(--purple)', shape: 'circle', r: 4 },
    'orb':         { color: 'var(--purple)', shape: 'circle', r: 4 },
    'urn':         { color: 'var(--purple)', shape: 'circle', r: 4 },
    'totem':       { color: 'var(--purple)', shape: 'circle', r: 4 },
    'pylon':       { color: 'var(--text-dim)', shape: 'square', r: 5 },
    'unknown':     { color: 'var(--text-mute)', shape: 'circle', r: 4 },
  };
  function styleFor(type) { return POI_STYLE[type] || POI_STYLE.unknown; }

  // Reads a CSS custom-property color value (e.g. "var(--gold)") resolved
  // against the live document, so markers automatically follow whichever
  // theme swatch the commander picked on another page.
  var _cssVarCache = {};
  function resolveColor(v) {
    if (v.indexOf('var(') !== 0) return v;
    if (_cssVarCache[v]) return _cssVarCache[v];
    var name = v.slice(4, -1).trim();
    var resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#8ab4ff';
    _cssVarCache[v] = resolved;
    return resolved;
  }

  // ── Bearing/distance -> local xy (meters, x=east, y=north) ───────────────
  // Deliberately duplicated (not required()'d) from engine/core/geo.js:
  // this file runs in the sandboxed renderer with no Node access, so the
  // handful of lines of trig are copied by hand rather than sharing a module.
  function bearingDistanceToXY(bearingDeg, distanceM) {
    var rad = bearingDeg * DEG2RAD;
    return { x: Math.sin(rad) * distanceM, y: -Math.cos(rad) * distanceM }; // -cos: canvas y grows downward, north is "up"
  }

  // ── State ─────────────────────────────────────────────────────────────
  var state = {
    site: null,            // current site record (or null)
    live: null,             // { bearingDeg, distanceM, headingDeg, timestamp } or null
    liveStale: false,
    zoom: 4,                // px per meter
    panX: 0, panY: 0,       // screen-space pan offset, px
    rotateToHeading: false,
    allSites: [],
  };

  var canvas = document.getElementById('gdn-canvas');
  var ctx = canvas.getContext('2d');
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  function resizeCanvas() {
    var rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * DPR;
    canvas.height = rect.height * DPR;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  // ── Pan / zoom / drag ─────────────────────────────────────────────────
  var dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
  canvas.addEventListener('mousedown', function (e) {
    dragging = true; dragStartX = e.clientX; dragStartY = e.clientY;
    panStartX = state.panX; panStartY = state.panY;
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    state.panX = panStartX + (e.clientX - dragStartX);
    state.panY = panStartY + (e.clientY - dragStartY);
    draw();
  });
  window.addEventListener('mouseup', function () { dragging = false; });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.zoom = Math.max(0.3, Math.min(60, state.zoom * factor));
    draw();
  }, { passive: false });

  document.getElementById('gdn-recenter-btn').addEventListener('click', function () {
    state.panX = 0; state.panY = 0; state.zoom = 4;
    draw();
  });

  var legendPanel = document.getElementById('gdn-legend');
  document.getElementById('gdn-legend-btn').addEventListener('click', function () {
    legendPanel.hidden = !legendPanel.hidden;
  });

  // ── Drawing ───────────────────────────────────────────────────────────
  function draw() {
    var W = canvas.width / DPR, H = canvas.height / DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var empty = document.getElementById('gdn-empty');
    var info  = document.getElementById('gdn-info');

    if (!state.site) {
      empty.style.display = 'flex';
      info.hidden = true;
      return;
    }
    empty.style.display = 'none';

    var cx = W / 2 + state.panX;
    var cy = H / 2 + state.panY;
    var rotationDeg = (state.rotateToHeading && state.live && state.live.headingDeg != null) ? -state.live.headingDeg : 0;
    var rotationRad = rotationDeg * DEG2RAD;

    function project(xM, yM) {
      // apply rotate-to-heading (rotate the whole scene so heading points up)
      var x = xM, y = yM;
      if (rotationRad) {
        var cos = Math.cos(rotationRad), sin = Math.sin(rotationRad);
        var rx = x * cos - y * sin;
        var ry = x * sin + y * cos;
        x = rx; y = ry;
      }
      return { x: cx + x * state.zoom, y: cy + y * state.zoom };
    }

    drawSchematicBackground(project, rotationRad);

    // POIs
    var pois = state.site.pois || [];
    for (var i = 0; i < pois.length; i++) {
      var poi = pois[i];
      var xy = bearingDistanceToXY(poi.bearingDeg, poi.distanceM);
      var p = project(xy.x, xy.y);
      var style = styleFor(poi.type);
      drawMarker(p.x, p.y, style, poi.label);
    }

    // Obelisk groups (rings)
    var groups = state.site.obeliskGroups || [];
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var gxy = bearingDistanceToXY(grp.bearingDeg, grp.distanceM);
      var gp = project(gxy.x, gxy.y);
      ctx.beginPath();
      ctx.arc(gp.x, gp.y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = resolveColor('var(--cyan)');
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (grp.label) drawLabel(gp.x, gp.y + 16, grp.label + (grp.obeliskCount ? ' (' + grp.obeliskCount + ')' : ''));
    }

    // Origin marker
    var origin = project(0, 0);
    drawMarker(origin.x, origin.y, { color: 'var(--text)', shape: 'diamond', r: 5 }, null);

    // Live commander marker
    if (state.live) {
      var lxy = bearingDistanceToXY(state.live.bearingDeg, state.live.distanceM);
      var lp = project(lxy.x, lxy.y);
      drawLiveMarker(lp.x, lp.y, state.live.headingDeg, rotationDeg);
    }

    updateInfoCard();
  }

  function drawSchematicBackground(project, rotationRad) {
    // Range rings every 25m out to a radius that comfortably covers the
    // furthest known POI (min 75m so small/empty sites still get context).
    var maxDist = 75;
    var pois = (state.site.pois || []).concat(state.site.obeliskGroups || []);
    for (var i = 0; i < pois.length; i++) {
      if (pois[i].distanceM > maxDist) maxDist = pois[i].distanceM;
    }
    var ringStep = maxDist > 300 ? 100 : (maxDist > 120 ? 50 : 25);
    var ringColor = resolveColor('var(--border2)');
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1;
    for (var d = ringStep; d <= maxDist + ringStep; d += ringStep) {
      ctx.beginPath();
      ctx.arc(project(0, 0).x, project(0, 0).y, d * state.zoom, 0, Math.PI * 2);
      ctx.globalAlpha = 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Compass ticks (N/E/S/W), rotated with the scene when rotate-to-heading is on
    var labels = [{ t: 'N', b: 0 }, { t: 'E', b: 90 }, { t: 'S', b: 180 }, { t: 'W', b: 270 }];
    ctx.font = '11px var(--mono, monospace)';
    ctx.fillStyle = resolveColor('var(--text-mute)');
    ctx.textAlign = 'center';
    for (var j = 0; j < labels.length; j++) {
      var xy = bearingDistanceToXY(labels[j].b, maxDist + ringStep * 1.4);
      var p = project(xy.x, xy.y);
      ctx.fillText(labels[j].t, p.x, p.y);
    }
  }

  function drawMarker(x, y, style, label) {
    var color = resolveColor(style.color);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (style.shape === 'square') {
      ctx.fillRect(x - style.r, y - style.r, style.r * 2, style.r * 2);
    } else if (style.shape === 'diamond') {
      ctx.beginPath();
      ctx.moveTo(x, y - style.r); ctx.lineTo(x + style.r, y);
      ctx.lineTo(x, y + style.r); ctx.lineTo(x - style.r, y);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, style.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (label) drawLabel(x, y + style.r + 12, label);
  }

  function drawLabel(x, y, text) {
    ctx.font = '10px var(--mono, monospace)';
    ctx.fillStyle = resolveColor('var(--text-dim)');
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
  }

  function drawLiveMarker(x, y, headingDeg, rotationDeg) {
    var color = resolveColor('var(--text)');
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
    if (headingDeg != null) {
      var effectiveHeading = headingDeg + (rotationDeg || 0);
      ctx.rotate(effectiveHeading * DEG2RAD);
      ctx.beginPath();
      ctx.moveTo(0, -22);
      ctx.lineTo(-5, -8);
      ctx.lineTo(5, -8);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  }

  function updateInfoCard() {
    var info = document.getElementById('gdn-info');
    if (!state.site) { info.hidden = true; return; }
    info.hidden = false;
    var title = (state.site.bodyName || 'Unknown body') + ' \u2014 ' + labelForSite(state.site);
    set('gdn-info-title', title);
    set('gdn-info-sub', state.live ? ('Live \u00B7 ' + Math.round(state.live.distanceM) + 'm from origin') : 'Not currently on site');
    var poiCount = (state.site.pois || []).length;
    set('gdn-info-poi-count', poiCount ? (poiCount + ' known POI' + (poiCount === 1 ? '' : 's')) : 'No POI data yet');
  }

  function labelForSite(site) {
    if (site.siteType === 'structure') return 'Guardian Structure' + (site.variant ? ' (' + site.variant + ')' : '');
    if (site.siteType === 'ruins')     return 'Guardian Ruins';
    return 'Guardian Site';
  }

  // ── Live badge / nav dot ─────────────────────────────────────────────
  function setLiveIndicator(on) {
    var badge = document.getElementById('gdn-live-badge');
    var dot   = document.getElementById('gdn-live-dot');
    if (badge) badge.hidden = !on;
    if (dot)   dot.hidden   = !on;
  }

  // ── Site picker ───────────────────────────────────────────────────────
  function keyFor(site) { return site.systemAddress + ':' + site.bodyId + ':' + site.siteType; }

  function populatePicker(sites) {
    var sel = document.getElementById('gdn-site-picker');
    while (sel.options.length > 1) sel.remove(1);
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      var opt = document.createElement('option');
      opt.value = keyFor(s);
      opt.textContent = (s.bodyName || '?') + ' \u2014 ' + labelForSite(s) +
        (s.pois && s.pois.length ? '' : ' (no POI data)');
      sel.appendChild(opt);
    }
  }

  document.getElementById('gdn-site-picker').addEventListener('change', function (e) {
    var val = e.target.value;
    if (!val) return;
    var match = state.allSites.filter(function (s) { return keyFor(s) === val; })[0];
    if (match) {
      state.site = match;
      state.live = null; // browsing a picked site is never "live" unless it's the active one
      setLiveIndicator(false);
      draw();
    }
  });

  function refreshSitePicker() {
    if (!window.electronAPI || !window.electronAPI.getGuardianSites) return;
    window.electronAPI.getGuardianSites().then(function (sites) {
      state.allSites = sites || [];
      populatePicker(state.allSites);
    }).catch(function () { /* main process not reachable — leave picker as-is */ });
  }

  // ── Rotate-to-heading toggle (repurpose recenter's neighbor via legend btn area) ──
  // Kept simple: clicking the live badge toggles rotate-to-heading, since
  // it's only meaningful while live anyway.
  document.getElementById('gdn-live-badge').addEventListener('click', function () {
    state.rotateToHeading = !state.rotateToHeading;
    this.style.opacity = state.rotateToHeading ? '1' : '';
    this.title = state.rotateToHeading ? 'Rotate-to-heading: ON (click to disable)' : 'Click to rotate map to heading';
    draw();
  });

  // ── IPC wiring ────────────────────────────────────────────────────────
  if (window.electronAPI) {
    window.electronAPI.onGuardianSiteActive(function (site) {
      state.site = site;
      state.live = null; // fresh site, wait for the next position push
      setLiveIndicator(!!site);
      refreshSitePicker();
      draw();
    });

    window.electronAPI.onGuardianLivePosition(function (pos) {
      // Ignore stray pushes if we're currently browsing a different
      // (non-active) site from the picker.
      state.live = pos;
      draw();
    });
  }

  // Initial state
  refreshSitePicker();
  resizeCanvas();
})();
