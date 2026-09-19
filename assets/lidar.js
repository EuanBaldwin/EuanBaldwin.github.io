// A small rover drives one long, continuous loop around and through a hidden 3-4-3
// neural network, with a 2D lidar spinning on its back. Its route is a walk over
// the map's safe corridors (the strips between layers, the space outside them, and
// lanes above and below), passing square through the gaps in each layer. Nodes are solid: a beam stops at the
// first one it hits, so only the side facing the rover is seen at any moment,
// but because the rover keeps moving, the whole network gets mapped over time.
// Wires are thin: like a real lidar hitting a cable, the beam gets a faint
// return and carries on. Your cursor (or a finger) is solid too: the beam
// stops at it and casts a shadow. Each reading keeps the range error it was
// measured with until the next sweep replaces it, and fades slowly.
// The canvas is pinned to the viewport and everything is kept in the hero's own
// coordinates, so the rover can also be driven off the block and around the rest
// of the page (it never goes there by itself).
(function () {
  const canvas = document.getElementById('lidar');
  if (!canvas) return;
  const hero = canvas.closest('.hero') || canvas.parentElement;
  const band = document.querySelector('.art') || canvas.parentElement;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const showRoute = /[?&]route\b/.test(location.search);   // debug: draw the rover's route and the hidden nodes
  const cssVar = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;

  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, bandTop = 0, bandH = 0, nodeR = 12, span = 0;
  let VW = 0, VH = 0;                 // viewport size
  let ox = 0, oy = 0;                 // where the hero's origin sits in the viewport this frame
  const page = { x0: 0, y0: 0, x1: 0, y1: 0 };   // the whole page, in hero coordinates
  let mask = null, maskW = 0, maskH = 0;
  let nodeList = [], route = [], layout = null;
  const ROVER = { len: 22, wid: 15, r: 12, speed: 42 };  // px and px/s

  // ---- hidden scene: a 3-4-3 neural network, every node wired to the next layer ----
  function buildScene() {
    const off = document.createElement('canvas');
    off.width = maskW = W; off.height = maskH = H;
    const o = off.getContext('2d');
    const layers = [3, 4, 3];
    // network width: a share of the screen, but always leaving room for the rover to drive round the outside
    const roomOutside = ROVER.r + 30 + Math.min(15, bandH * 0.05) + ROVER.r + 14;
    const span = Math.max(120, Math.min(W * 0.62, bandH * 2.2, W - 2 * roomOutside));
    const x0 = cx - span / 2;
    const padY = Math.max(22, bandH * 0.12);
    const R = Math.max(9, Math.min(15, bandH * 0.05));
    nodeR = R;
    const nodes = layers.map((n, li) => {
      const x = x0 + (li / (layers.length - 1)) * span;
      return Array.from({ length: n }, (_, i) => [x, bandTop + padY + (i / (n - 1)) * (bandH - padY * 2)]);
    });
    nodeList = nodes.flat();
    layout = { nodes, R, span };
    o.strokeStyle = '#000'; o.lineWidth = 1.5;
    for (let li = 0; li < nodes.length - 1; li++) {
      for (const a of nodes[li]) for (const b of nodes[li + 1]) {
        const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
        o.beginPath(); o.moveTo(a[0] + dx / d * R, a[1] + dy / d * R); o.lineTo(b[0] - dx / d * R, b[1] - dy / d * R); o.stroke();
      }
    }
    o.fillStyle = '#f00';   // nodes are solid discs, marked in the red channel
    for (const [x, y] of nodeList) { o.beginPath(); o.arc(x, y, R, 0, Math.PI * 2); o.fill(); }
    mask = o.getImageData(0, 0, maskW, maskH).data;
    buildRoute();
  }

  // ---- route planning: a long closed walk over the map's corridors and doors ----
  // Corridors: L (outside the left layer), A (between left and middle), B (between middle
  // and right), R (outside the right layer). Doors: the gaps in each layer. Lanes above and
  // below the network join any two corridors, and the top lane sometimes goes up through
  // the header instead. A new seed each visit gives a different, but always sensible, loop.
  function buildRoute() {
    const { nodes, R } = layout;
    const [Ln, Mn, Rn] = nodes;
    const mid = (a, b) => (a + b) / 2;
    const xL = Ln[0][0], xM = Mn[0][0], xR = Rn[0][0];
    const edge = ROVER.r + 30, run = R * 3.2;
    // the outside corridors sit further out on wide screens, so the loop uses more of the width
    const out = Math.max(R * 5, Math.min(W * 0.12, (W - layout.span) / 2 - edge - R * 2));
    const X = { L: Math.max(edge, xL - out), A: mid(xL, xM), B: mid(xM, xR), R: Math.min(W - edge, xR + out) };
    const doors = {
      left:  { a: 'L', b: 'A', x: xL, ys: [mid(Ln[0][1], Ln[1][1]), mid(Ln[1][1], Ln[2][1])] },
      midl:  { a: 'A', b: 'B', x: xM, ys: [mid(Mn[0][1], Mn[1][1]), mid(Mn[1][1], Mn[2][1]), mid(Mn[2][1], Mn[3][1])] },
      right: { a: 'B', b: 'R', x: xR, ys: [mid(Rn[0][1], Rn[1][1]), mid(Rn[1][1], Rn[2][1])] },
    };
    const yTop = Math.max(edge, Ln[0][1] - R * 3.2), yBot = Math.min(H - edge, Ln[2][1] + R * 3.2);
    const yText = Math.max(edge, bandTop * 0.45);

    let seed = (Math.random() * 2 ** 32) >>> 0;
    const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = arr => arr[Math.floor(rnd() * arr.length)];

    const pts = [];
    // waypoints are kept well apart: a cluster of close points makes the spline wriggle and the rover twitch
    const add = (x, y) => { const l = pts[pts.length - 1]; if (!l || Math.hypot(l[0] - x, l[1] - y) > R * 2) pts.push([x, y]); };
    let cur = 'L', y = cy, lastDoor = null, lastLane = null;
    add(X.L, y);

    // how far a corridor's centre line can wander sideways without touching a layer
    const halfA = (xM - xL) / 2, slack = c => (c === 'A' || c === 'B') ? Math.max(0, halfA - (R + ROVER.r + 16)) : R * 1.5;
    const jitter = (v, a) => v + (rnd() * 2 - 1) * a;
    const through = (name, d) => {
      const to = d.a === cur ? d.b : d.a;
      let ys = d.ys; if (lastDoor && lastDoor.name === name && ys.length > 1) ys = ys.filter(v => v !== lastDoor.y);
      const dy = pick(ys);
      const r1 = run * (0.8 + rnd() * 0.6), r2 = run * (0.8 + rnd() * 0.6);
      add(jitter(X[cur], slack(cur) * 0.5), dy);                         // up or down the corridor to the door height
      const dir = X[to] > X[cur] ? 1 : -1;
      add(d.x - dir * r1, dy); add(d.x, dy); add(d.x + dir * r2, dy);    // square through the door
      cur = to; y = dy; lastDoor = { name, y: dy }; lastLane = null;
    };
    const meander = () => {                                            // sweep to a distant spot in this corridor
      const lo = yTop + R, hi = yBot - R, far = (hi - lo) * 0.4;
      let yy = lo + rnd() * (hi - lo);
      if (Math.abs(yy - y) < far) yy = y < (lo + hi) / 2 ? Math.min(hi, y + far + rnd() * Math.max(0, hi - y - far)) : Math.max(lo, y - far - rnd() * Math.max(0, y - far - lo));
      add(jitter(X[cur], slack(cur)), yy);
      y = yy; lastDoor = null;
    };
    const lane = (to, yy, header) => {
      if (header) {                                                     // over the icons and along the intro text
        const goingLeft = X[to] < X[cur];
        add(X[cur], yTop);
        add(goingLeft ? W - edge : edge, yText + 6);
        add(goingLeft ? W * 0.72 : W * 0.28, yText); add(W / 2, yText); add(goingLeft ? W * 0.28 : W * 0.72, yText);
        add(goingLeft ? edge : W - edge, yText + 6);
        add(X[to], yTop);
      } else {
        const yl = yy === yTop ? Math.max(edge, yy - rnd() * R) : Math.min(H - edge, yy + rnd() * R);
        add(X[cur], yl); add(mid(X[cur], X[to]), yl); add(X[to], yl);
      }
      cur = to; y = yy; lastLane = yy; lastDoor = null;
    };
    const doorsFrom = c => Object.entries(doors).filter(([, d]) => d.a === c || d.b === c);

    let sinceHeader = 0;
    while (pts.length < 170) {
      // never straight back through the layer just crossed: that is a tight about-turn
      const ds = doorsFrom(cur).filter(([name]) => !lastDoor || lastDoor.name !== name);
      const inside = cur === 'A' || cur === 'B';
      // every handful of moves, go up and drive across the header, coming back down anywhere
      if (++sinceHeader >= 6 + Math.floor(rnd() * 3)) {
        sinceHeader = 0;
        const to = pick(['L', 'A', 'B', 'R'].filter(c => c !== cur));
        lane(to, yTop, true); continue;
      }
      const roll = rnd();
      if (roll < (inside ? 0.3 : 0.12) || (!ds.length && roll < 0.5)) { meander(); continue; }
      if (ds.length && roll < (inside ? 0.88 : 0.72)) {
        // inside, lean towards the middle door (staying in the network) over the outer ones
        const weighted = inside ? ds.flatMap(([name, d]) => name === 'midl' ? [[name, d], [name, d]] : [[name, d]]) : ds;
        const [name, d] = pick(weighted); through(name, d); continue;
      }
      const to = pick(['L', 'A', 'B', 'R'].filter(c => c !== cur));
      const yy = pick([yTop, yBot].filter(v => v !== lastLane).concat(lastLane == null ? [] : []));
      const header = yy === yTop && rnd() < 0.5;
      lane(to, yy, header);
    }
    if (cur !== 'L') lane('L', Math.abs(y - yTop) < Math.abs(y - yBot) ? yTop : yBot, false);
    add(X.L, cy);
    if (Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 4) pts.pop();  // closed loop: last joins first
    route = pts.map(([x, yy]) => [Math.min(W - edge, Math.max(edge, x)), Math.min(H - edge, Math.max(edge, yy))]);
  }

  // where the hero sits in the viewport, and how far the page extends around it
  function syncFrame() {
    const r = hero.getBoundingClientRect(), de = document.documentElement;
    ox = r.left; oy = r.top;
    const ax = r.left + window.scrollX, ay = r.top + window.scrollY;
    page.x0 = -ax; page.y0 = -ay; page.x1 = de.clientWidth - ax; page.y1 = de.scrollHeight - ay;
    cursor.x = cursor.cx - ox; cursor.y = cursor.cy - oy;
  }
  const inPage = (x, y) => x >= page.x0 && y >= page.y0 && x < page.x1 && y < page.y1;

  const idx = (x, y) => ((y | 0) * maskW + (x | 0)) * 4;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < maskW && y < maskH;
  const solid = (x, y) => inBounds(x, y) && mask[idx(x, y) + 3] > 60 && mask[idx(x, y)] > 128;
  const wire = (x, y) => inBounds(x, y) && mask[idx(x, y) + 3] > 60 && mask[idx(x, y)] <= 128;

  // ---- the cursor: an arrow-pointer shape the beam cannot pass ----
  const CUR = 22;   // the standard arrow pointer is about 12 x 19 px
  const curMask = document.createElement('canvas');
  curMask.width = curMask.height = CUR;
  {
    const c = curMask.getContext('2d'), k = 1;
    c.fillStyle = '#000'; c.beginPath();
    [[0, 0], [0, 16.5], [4.2, 12.8], [7.2, 19], [9.6, 18], [6.7, 11.9], [12, 11.9]].forEach(([x, y], i) => i ? c.lineTo(x * k, y * k) : c.moveTo(x * k, y * k));
    c.closePath(); c.fill();
  }
  const curData = curMask.getContext('2d').getImageData(0, 0, CUR, CUR).data;
  const cursor = { x: 0, y: 0, cx: 0, cy: 0, on: false };   // cx, cy in viewport coordinates; x, y in hero coordinates
  const inCursor = (x, y) => {
    const u = x - cursor.x, v = y - cursor.y;
    return u >= 0 && v >= 0 && u < CUR && v < CUR && curData[((v | 0) * CUR + (u | 0)) * 4 + 3] > 60;
  };

  // ---- the rover ----
  const rover = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, u: 0, manual: false, lastInput: -1e9 };
  if (showRoute) window.lidarRover = rover;   // debug hook
  const keys = new Set();
  let armed = false;   // arrow keys only steer after a click on the block, so they do not stop the page scrolling
  // the route is followed as a smooth closed spline; u counts route segments
  const pathPoint = u => {
    const n = route.length; if (!n || !isFinite(u)) return [cx, cy];
    const f = Math.floor(u), i = ((f % n) + n) % n, t = u - f;   // wraps: the route is a closed loop
    const p0 = route[(i - 1 + n) % n], p1 = route[i], p2 = route[(i + 1) % n], p3 = route[(i + 2) % n];
    const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
  };

  function nearestU(x, y) {
    let best = 0, bd = Infinity;
    for (let u = 0; u < route.length; u += 0.1) { const [px, py] = pathPoint(u); const d = (px - x) ** 2 + (py - y) ** 2; if (d < bd) { bd = d; best = u; } }
    return best;
  }

  function keepOutOfNodes() {
    for (const [nx, ny] of nodeList) {
      const dx = rover.x - nx, dy = rover.y - ny, d = Math.hypot(dx, dy) || 1e-6, keep = nodeR + ROVER.r + 2;
      if (d < keep) { rover.x = nx + dx / d * keep; rover.y = ny + dy / d * keep; }
    }
    rover.x = Math.min(page.x1 - ROVER.r, Math.max(page.x0 + ROVER.r, rover.x));
    rover.y = Math.min(page.y1 - ROVER.r, Math.max(page.y0 + ROVER.r, rover.y));
  }

  function driveRover(dt, now) {
    const fwd = (keys.has('w') || keys.has('arrowup')) - (keys.has('s') || keys.has('arrowdown'));
    const turn = (keys.has('d') || keys.has('arrowright')) - (keys.has('a') || keys.has('arrowleft'));
    if (fwd || turn) { rover.lastInput = now; if (!rover.manual) rover.manual = true; }
    if (rover.manual && now - rover.lastInput > 4000) { rover.manual = false; rover.u = nearestU(rover.x, rover.y); }
    if (rover.manual) {
      // hand-driven: turn on the spot or on the move, and roll forwards or back
      rover.heading += turn * 2.6 * dt;
      const sp = fwd * ROVER.speed * 1.5;
      const k = 1 - Math.exp(-dt * 6);
      rover.vx += (Math.cos(rover.heading) * sp - rover.vx) * k;
      rover.vy += (Math.sin(rover.heading) * sp - rover.vy) * k;
      rover.x += rover.vx * dt; rover.y += rover.vy * dt;
      keepOutOfNodes();
      // keep a hand-driven rover in view: scroll the page along with it
      if (fwd || turn) {
        const vy = rover.y + oy, m = 90;
        const dyScroll = vy < m ? vy - m : vy > VH - m ? vy - (VH - m) : 0;
        if (dyScroll) window.scrollBy(0, dyScroll);
      }
      return;
    }
    // advance the waypoint along the curve at roughly constant speed
    const [px0, py0] = pathPoint(rover.u), [px1, py1] = pathPoint(rover.u + 1e-3);
    const dlen = Math.hypot(px1 - px0, py1 - py0) / 1e-3;
    rover.u += ROVER.speed * dt / Math.max(dlen, 1);
    if (rover.u >= route.length) rover.u -= route.length;
    if (rover.u < 0) rover.u += route.length;
    // steer towards a point about 30 px ahead along the route; the pull grows if it falls behind
    const ahead = u0 => { let u = u0; for (let i = 0; i < 30; i++) { const [x, y] = pathPoint(u); if (Math.hypot(x - rover.x, y - rover.y) >= 30) break; u += 0.1; } return pathPoint(u); };
    let [tx, ty] = ahead(rover.u);
    let ax = tx - rover.x, ay = ty - rover.y;
    let l = Math.hypot(ax, ay) || 1;
    if (l > 90) { rover.u = nearestU(rover.x, rover.y); [tx, ty] = ahead(rover.u); ax = tx - rover.x; ay = ty - rover.y; l = Math.hypot(ax, ay) || 1; }
    const k = 1 - Math.exp(-dt * 8);
    const sp = ROVER.speed * Math.min(1.6, Math.max(0.6, l / 20));   // catch up if it lags, ease off if it is ahead
    rover.vx += (ax / l * sp - rover.vx) * k;
    rover.vy += (ay / l * sp - rover.vy) * k;
    rover.x += rover.vx * dt; rover.y += rover.vy * dt;
    const target = Math.atan2(rover.vy, rover.vx);
    let dh = target - rover.heading;
    while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
    rover.heading += dh * (1 - Math.exp(-dt * 6));
    keepOutOfNodes();
  }

  // ---- points ----
  const N = 40000;
  const px = new Float32Array(N), py = new Float32Array(N), pt = new Float32Array(N);
  const kind = new Uint8Array(N);        // 0 node, 1 cursor, 2 wire
  let head = 0;
  const REV = 1900;                      // ms per revolution of the lidar
  const LIFE = REV * 1.6;                // a reading outlives a revolution and fades to almost nothing
  const RAYS = 8;
  let angle = 0, last = performance.now(), beamEnd = [0, 0];

  function push(x, y, k, now) { px[head] = x; py[head] = y; pt[head] = now; kind[head] = k; head = (head + 1) % N; }

  function cast(sx, sy, a, now) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let onWire = false, lastWire = -1e9, wireStart = 0, inside = solid(sx, sy);
    if (Math.random() < 0.003) { const t = ROVER.r + Math.random() * Math.min(W, H) * 0.4; push(sx + dx * t, sy + dy * t, 2, now); }  // the odd stray return
    const maxT = (page.x1 - page.x0) + (page.y1 - page.y0);   // a hard stop, so a bad number can never hang the page
    for (let t = ROVER.r; t < maxT; t += 1) {
      const x = sx + dx * t, y = sy + dy * t;
      if (!inPage(x, y)) return [x, y];
      if (cursor.on && inCursor(x, y)) { push(x, y, 1, now); return [x, y]; }
      const sN = solid(x, y);
      if (sN && !inside) { push(x + dx * (Math.random() - .5) * 1.6, y + dy * (Math.random() - .5) * 1.6, 0, now); return [x, y]; }
      inside = sN;
      const w = wire(x, y);
      if (w && !onWire) { wireStart = t; if (Math.random() < 0.45) { push(x + dx * (Math.random() - .5) * 2, y + dy * (Math.random() - .5) * 2, 2, now); lastWire = t; } }
      else if (w && t - wireStart >= 8 && t - lastWire >= 12 && Math.random() < 0.3) { push(x + dx * (Math.random() - .5) * 2, y + dy * (Math.random() - .5) * 2, 2, now); lastWire = t; }
      onWire = w;
    }
    return [sx + dx * maxT, sy + dy * maxT];
  }

  function step(now) {
    const dt = Math.max(0, Math.min(60, now - last)) / 1000; last = now;
    syncFrame();
    driveRover(dt, now);
    if (!isFinite(rover.x) || !isFinite(rover.y) || !isFinite(rover.heading)) {
      const [x, y] = pathPoint(rover.u); rover.x = x; rover.y = y; rover.vx = rover.vy = 0; rover.heading = 0;
    }
    const da = (Math.PI * 2) * (dt * 1000 / REV);
    for (let k = 0; k < RAYS; k++) beamEnd = cast(rover.x, rover.y, angle + (k / RAYS) * da, now);
    angle = (angle + da) % (Math.PI * 2);
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VW, VH);
    ctx.translate(ox, oy);   // everything below is in hero coordinates
    const fg = cssVar('--fg', '#111');
    const accent = cssVar('--accent', '#0c869b');
    const hit = cssVar('--hit', '#e8732a');

    // the beam, from the lidar window on the rover's back; drawn no longer than the block is wide
    const hx = rover.x + Math.cos(angle) * 4, hy = rover.y + Math.sin(angle) * 4;
    if (!reduced) {
      let ex = beamEnd[0], ey = beamEnd[1];
      const bl = Math.hypot(ex - hx, ey - hy);
      if (bl > W) { ex = hx + (ex - hx) * W / bl; ey = hy + (ey - hy) * W / bl; }
      const g = ctx.createLinearGradient(hx, hy, ex, ey);
      g.addColorStop(0, accent); g.addColorStop(1, 'rgba(12,134,155,0)');
      ctx.strokeStyle = g; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
    }

    // readings: nodes in the text colour, cursor hits in their own colour, wires weaker
    const vx0 = -ox - 2, vy0 = -oy - 2, vx1 = VW - ox + 2, vy1 = VH - oy + 2;   // only what is on screen
    for (let pass = 0; pass < 3; pass++) {
      ctx.fillStyle = pass === 1 ? hit : fg;
      const isWire = pass === 2;
      for (let i = 0; i < N; i++) {
        if (kind[i] !== pass || pt[i] === 0) continue;
        if (px[i] < vx0 || px[i] > vx1 || py[i] < vy0 || py[i] > vy1) continue;
        const age = (now - pt[i]) / LIFE;
        if (age >= 1) continue;
        const a = 1 - age;
        ctx.globalAlpha = (isWire ? 0.55 : 1) * (0.03 + 0.92 * a * a * a);
        const sz = isWire ? 1 + 0.4 * a : 1.3 + 0.9 * a;
        ctx.fillRect(px[i] - sz / 2, py[i] - sz / 2, sz, sz);
      }
    }

    if (showRoute) {
      ctx.globalAlpha = 0.35; ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      ctx.beginPath();
      for (let u = 0; u <= route.length; u += 0.1) { const [x, y] = pathPoint(u); u ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      ctx.fillStyle = accent; ctx.globalAlpha = 0.9;
      route.forEach(([x, y], i) => { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 0.25; ctx.strokeStyle = fg; ctx.lineWidth = 1;
      for (const [x, y] of nodeList) { ctx.beginPath(); ctx.arc(x, y, nodeR, 0, Math.PI * 2); ctx.stroke(); }
      ctx.font = '10px JetBrains Mono, monospace'; ctx.fillStyle = fg; ctx.globalAlpha = 0.7;
      const [sx, sy] = route[0]; ctx.fillText('start', sx + 6, sy - 6);
      ctx.globalAlpha = 1;
    }

    drawRover();
  }

  function drawRover() {
    const accent = cssVar('--accent', '#0c869b');
    // the rover, seen from above: four wheels, a body, and the lidar puck on its back
    ctx.save();
    ctx.translate(rover.x, rover.y); ctx.rotate(rover.heading);
    const L = ROVER.len, Wd = ROVER.wid;
    ctx.globalAlpha = 1; ctx.fillStyle = '#111';
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {           // wheels
      ctx.beginPath(); ctx.roundRect(sx * L * 0.3 - 3.5, sy * (Wd / 2 + 1) - 2.5, 7, 5, 1.5); ctx.fill();
    }
    let g = ctx.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
    g.addColorStop(0, '#d9d9d6'); g.addColorStop(1, '#9a9a97');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(-L / 2, -Wd / 2, L, Wd, 4); ctx.fill();   // body
    ctx.fillStyle = '#5c5f63';
    ctx.beginPath(); ctx.roundRect(L / 2 - 5, -Wd / 2 + 3, 3, Wd - 6, 1); ctx.fill();  // front sensor bar
    ctx.rotate(-rover.heading);                                              // the puck spins with the beam, not the rover
    g = ctx.createRadialGradient(-1.5, -1.5, 1, 0, 0, 6);
    g.addColorStop(0, '#3a3d40'); g.addColorStop(1, '#0d0e10');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();  // lidar housing
    ctx.rotate(angle);
    ctx.fillStyle = accent; ctx.fillRect(2.5, -1.5, 3, 3);                               // its window, facing the beam
    ctx.restore();
  }

  function resize() {
    const r = hero.getBoundingClientRect(), b = band.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    VW = window.innerWidth; VH = window.innerHeight;
    canvas.width = Math.round(VW * dpr); canvas.height = Math.round(VH * dpr);
    canvas.style.width = VW + 'px'; canvas.style.height = VH + 'px';
    const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
    const changed = nw !== W || nh !== H;   // only the block's own size matters to the scene (not, say, a phone's URL bar)
    W = nw; H = nh;
    bandTop = b.top - r.top; bandH = b.height;
    cx = W / 2; cy = bandTop + bandH / 2;
    if (changed) {
      buildScene(); pt.fill(0);
      if (!rover.x && !rover.y) { const [x, y] = pathPoint(0); rover.x = x; rover.y = y; }
      rover.u = nearestU(rover.x, rover.y);
    }
    syncFrame();
    if (reduced) drawStatic();
  }

  // reduced motion: the network as a still map, redrawn as the page scrolls
  let still = null;
  function drawStatic() {
    if (!still) { still = []; for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (solid(x, y) || wire(x, y)) still.push(x, y); }
    syncFrame();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, VW, VH); ctx.translate(ox, oy);
    ctx.globalAlpha = 0.4; ctx.fillStyle = cssVar('--fg', '#111');
    for (let i = 0; i < still.length; i += 2) ctx.fillRect(still[i], still[i + 1], 1, 1);
    ctx.globalAlpha = 1;
    drawRover();
  }

  function loop(now) { step(now); draw(now); requestAnimationFrame(loop); }

  // the cursor object follows the mouse, or a finger while it is touching the top block
  const place = e => { cursor.cx = e.clientX; cursor.cy = e.clientY; cursor.on = true; };
  window.addEventListener('pointermove', place);
  window.addEventListener('pointerdown', place);
  window.addEventListener('pointerup', e => { if (e.pointerType === 'touch') cursor.on = false; });
  window.addEventListener('pointercancel', () => { cursor.on = false; });
  window.addEventListener('pointerleave', () => { cursor.on = false; });
  document.addEventListener('mouseleave', () => { cursor.on = false; });
  window.addEventListener('resize', resize);

  // driving: WASD always; arrow keys once the block has been clicked (Escape hands them back)
  const keyName = e => e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = keyName(e);
    if (k === 'escape') { armed = false; keys.clear(); return; }
    const isArrow = k.startsWith('arrow');
    if (isArrow && !armed) return;
    if ('wasd'.includes(k) && k.length === 1 || isArrow) {
      if (document.activeElement && /^(input|textarea|select)$/i.test(document.activeElement.tagName)) return;
      keys.add(k); if (isArrow) e.preventDefault();
      hero.classList.add('driven');
    }
  });
  window.addEventListener('keyup', e => keys.delete(keyName(e)));
  window.addEventListener('blur', () => keys.clear());
  hero.addEventListener('pointerdown', () => { armed = true; });
  document.addEventListener('pointerdown', e => { if (!hero.contains(e.target)) armed = false; });

  resize();
  if (reduced) {
    window.addEventListener('scroll', drawStatic, { passive: true });
    document.addEventListener('themechange', drawStatic);
  } else {
    requestAnimationFrame(loop);
  }
})();
