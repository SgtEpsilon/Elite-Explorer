// ─────────────────────────────────────────────────────────────────────────
// DEEP-FIELD STARFIELD — shared ambient backdrop for every page.
// Draws a slow-drifting, gently twinkling star layer on a fixed canvas
// behind #space-nebula (see styles.css). Purely decorative, pointer-events
// are disabled on the canvas so it never intercepts clicks.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  var canvas = document.getElementById('space-stars');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var stars = [];
  var W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);

  // Backing-store resize + reseed — the "real", slightly expensive resize.
  // Wipes the canvas bitmap and rebuilds the star field to match the new size.
  function commitResize() {
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    seed();
  }

  function seed() {
    var count = Math.round((W * H) / 2600);
    stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.2 + 0.25,
        base: Math.random() * 0.5 + 0.25,
        amp: Math.random() * 0.5,
        speed: Math.random() * 0.015 + 0.004,
        phase: Math.random() * Math.PI * 2,
        drift: Math.random() * 0.02 + 0.003,
        hue: Math.random() < 0.12 ? '138,180,255' : (Math.random() < 0.06 ? '155,139,255' : '211,230,255')
      });
    }
  }

  // PERF ROUND 2: throttling the resize handler to one rAF per frame still
  // left two things fighting the browser's own live-resize repaint for the
  // same ~16ms frame budget: (1) reallocating the canvas backing store every
  // frame while dragging, and (2) the twinkle loop still drawing every star
  // every frame throughout the drag. Now, while a resize is actively in
  // progress, we do neither:
  //   - 'resize' just updates the CSS width/height, which stretches the
  //     existing bitmap via the compositor — cheap, no bitmap wipe, no
  //     reflow-forcing reads.
  //   - the animation loop stops drawing entirely, freeing the main thread
  //     for the browser's own resize/layout/paint work.
  // ~150ms after the last resize event (i.e. once you actually stop
  // dragging), we do the one real backing-store resize + reseed, and the
  // twinkle animation picks back up.
  var _resizing = false;
  var _settleTimer = null;

  function onResize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    _resizing = true;
    clearTimeout(_settleTimer);
    _settleTimer = setTimeout(function () {
      _resizing = false;
      commitResize();
    }, 150);
  }

  var t = 0;
  function tick() {
    if (!_resizing) {
      t += 1;
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var a = s.base + Math.sin(t * s.speed + s.phase) * s.amp;
        if (a < 0) a = 0;
        s.y += s.drift;
        if (s.y > H) s.y = 0;
        ctx.beginPath();
        ctx.fillStyle = 'rgba(' + s.hue + ',' + a.toFixed(3) + ')';
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', onResize);
  W = window.innerWidth;
  H = window.innerHeight;
  commitResize();
  requestAnimationFrame(tick);
})();
