// A lidar sensor in the middle of the band sweeps a single beam round.
// Hidden in the band is a small neural network, and the lidar is its centre
// node. Nodes are solid: a beam stops at the first one it hits, so only the
// side facing the sensor is ever seen. Wires are thin: like a real lidar
// hitting a cable, the beam gets a faint return and carries on. Your cursor is
// a second lidar, so between the two of you more of the network gets seen.
// Dots fade slowly, so the picture is always faintly there.
(function () {
  const canvas = document.getElementById('lidar');
  if (!canvas) return;
  const hero = canvas.closest('.hero') || canvas.parentElement;   // the canvas covers this whole block
  const band = document.querySelector('.art') || canvas.parentElement; // the network lives in this strip
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cssVar = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;

  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, bandTop = 0, bandH = 0;
  let mask = null, maskW = 0, maskH = 0;

  // ---- hidden scene: a 3-4-3 network, sensor sitting in the gap in the middle layer ----
  function buildScene() {
    const off = document.createElement('canvas');
    off.width = maskW = W; off.height = maskH = H;
    const o = off.getContext('2d');
    o.strokeStyle = '#000';
    const layers = [3, 5, 3];
    const span = Math.min(W * 0.62, bandH * 2.2);       // keep it compact and centred in the band
    const x0 = cx - span / 2;
    const padY = Math.max(22, bandH * 0.12);
    const R = Math.max(9, Math.min(15, bandH * 0.05));
    const nodes = layers.map((n, li) => {
      const x = x0 + (li / (layers.length - 1)) * span;
      return Array.from({ length: n }, (_, i) => [x, bandTop + padY + (i / (n - 1)) * (bandH - padY * 2)]);
    });
    const centre = nodes[1][2];                          // the middle node is the lidar itself
    o.lineWidth = 1.5;
    for (let li = 0; li < nodes.length - 1; li++) {
      for (const a of nodes[li]) for (const b of nodes[li + 1]) {
        const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
        o.beginPath();
        o.moveTo(a[0] + dx / d * R, a[1] + dy / d * R);
        o.lineTo(b[0] - dx / d * R, b[1] - dy / d * R);
        o.stroke();
      }
    }
    // nodes: solid discs, marked in the red channel so the ray can tell them from wires
    o.fillStyle = '#f00';
    for (const col of nodes) for (const [x, y] of col) {
      if (x === centre[0] && y === centre[1]) continue;  // no disc where the sensor sits
      o.beginPath(); o.arc(x, y, R, 0, Math.PI * 2); o.fill();
    }
    mask = o.getImageData(0, 0, maskW, maskH).data;
  }
  const idx = (x, y) => ((y | 0) * maskW + (x | 0)) * 4;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < maskW && y < maskH;
  const solid = (x, y) => inBounds(x, y) && mask[idx(x, y) + 3] > 60 && mask[idx(x, y)] > 128;   // a node
  const wire = (x, y) => inBounds(x, y) && mask[idx(x, y) + 3] > 60 && mask[idx(x, y)] <= 128;   // a connection

  // ---- sensors: the fixed one at the centre node, and one that rides on your cursor ----
  const cursor = { x: 0, y: 0, on: false, angle: 0 };

  // ---- points ----
  const N = 24000;
  const px = new Float32Array(N), py = new Float32Array(N), pt = new Float32Array(N);
  const kind = new Uint8Array(N);
  let head = 0;
  const REV = 2400;             // ms per revolution
  const LIFE = REV * 1.6;       // dots outlive a revolution and fade to almost nothing, so nothing ever blinks out
  const RAYS = 8;
  let angle = 0, last = performance.now(), beamEnd = [0, 0], cursorBeamEnd = null;

  function push(x, y, k, now) { px[head] = x; py[head] = y; pt[head] = now; kind[head] = k; head = (head + 1) % N; }

  // kind: 0 node hit from the fixed lidar, 1 node hit from the cursor lidar, 2/3 the same for wires
  function cast(sx, sy, a, who, now) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let onWire = false, inside = solid(sx, sy);
    for (let t = 4; ; t += 1) {
      const x = sx + dx * t, y = sy + dy * t;
      if (x < 0 || y < 0 || x >= W || y >= H) return [x, y];
      // a node is solid: the beam stops at its surface (unless the sensor started inside one)
      const sN = solid(x, y);
      if (sN && !inside) { push(x + (Math.random() - .5) * .8, y + (Math.random() - .5) * .8, who, now); return [x, y]; }
      inside = sN;
      // a wire is thin: a weak, patchy return, and the beam carries on
      const w = wire(x, y);
      if (w && !onWire && Math.random() < 0.45) push(x + (Math.random() - .5) * 1.2, y + (Math.random() - .5) * 1.2, 2 + who, now);
      onWire = w;
    }
  }

  function step(now) {
    const dt = Math.min(60, now - last) / 1000; last = now;
    const da = (Math.PI * 2) * (dt * 1000 / REV);
    for (let k = 0; k < RAYS; k++) beamEnd = cast(cx, cy, angle + (k / RAYS) * da, 0, now);
    angle = (angle + da) % (Math.PI * 2);
    if (cursor.on) {
      const dc = da;
      for (let k = 0; k < RAYS; k++) cursorBeamEnd = cast(cursor.x, cursor.y, cursor.angle + (k / RAYS) * dc, 1, now);
      cursor.angle = (cursor.angle + dc) % (Math.PI * 2);
    } else cursorBeamEnd = null;
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const fg = cssVar('--fg', '#111');
    const accent = cssVar('--accent', '#0c869b');

    const beam = (x, y, end) => {
      const g = ctx.createLinearGradient(x, y, end[0], end[1]);
      g.addColorStop(0, accent); g.addColorStop(1, 'rgba(12,134,155,0)');
      ctx.strokeStyle = g; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(end[0], end[1]); ctx.stroke();
    };
    if (!reduced) {
      beam(cx, cy, beamEnd);
      if (cursorBeamEnd) beam(cursor.x, cursor.y, cursorBeamEnd);
    }

    // fixed lidar draws in the text colour, the cursor lidar in the accent; wires are weaker
    for (let pass = 0; pass < 4; pass++) {
      ctx.fillStyle = pass % 2 ? accent : fg;
      const isWire = pass >= 2;
      for (let i = 0; i < N; i++) {
        if (kind[i] !== pass || pt[i] === 0) continue;
        const age = (now - pt[i]) / LIFE;
        if (age >= 1) continue;
        const a = 1 - age;
        ctx.globalAlpha = (isWire ? 0.55 : 1) * (0.03 + 0.92 * a * a * a);
        const s = isWire ? 1 + 0.4 * a : 1.3 + 0.9 * a;
        ctx.fillRect(px[i] - s / 2, py[i] - s / 2, s, s);
      }
    }

    const sensorIcon = (x, y) => {
      ctx.globalAlpha = 1; ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.35; ctx.strokeStyle = accent; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    };
    sensorIcon(cx, cy);
    if (cursor.on) sensorIcon(cursor.x, cursor.y);
  }

  function resize() {
    const r = hero.getBoundingClientRect(), b = band.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    bandTop = b.top - r.top; bandH = b.height;
    cx = W / 2; cy = bandTop + bandH / 2;   // the centre node of the network
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    buildScene(); pt.fill(0);
  }

  function loop(now) { step(now); draw(now); requestAnimationFrame(loop); }

  // the cursor is traced anywhere over the hero block, not just the band
  window.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    const r = hero.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    cursor.on = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
    cursor.x = x; cursor.y = y;
  });
  window.addEventListener('pointerleave', () => { cursor.on = false; });
  document.addEventListener('mouseleave', () => { cursor.on = false; });
  window.addEventListener('resize', resize);

  resize();
  if (reduced) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 0.4; ctx.fillStyle = cssVar('--fg', '#111');
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (solid(x, y) || wire(x, y)) ctx.fillRect(x, y, 1, 1);
    window.removeEventListener('pointermove', () => {});
  } else {
    requestAnimationFrame(loop);
  }
})();
