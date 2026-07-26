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

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
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

  var t = 0;
  function tick() {
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
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(tick);
})();
