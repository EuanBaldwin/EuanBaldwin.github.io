// A small rover drives around and through a hidden neural network (3-4-4-2 on wide screens,
// 3-4-2 on narrow ones) with a 2D lidar on its back, modelled on an RPLIDAR A2M12: 16,000
// readings a second, ten turns a second once its motor is up to speed, 12 m range, drawn to
// scale with the rover (22 px = 45 cm). Nodes are solid, so only the side facing the rover
// returns; wires are thin, so a beam sometimes gets a weak return off one and stops there.
// Readings carry range noise that grows with distance, glancing hits drop out, and a beam
// that clips the edge of a node can land between it and whatever is behind (a "ghost").
// Your cursor (or a finger) is solid too: the beam stops at it and casts a shadow.
//
// On load the head turns slowly and the beam is drawn, then it spins up to 10 Hz and the beam
// blurs out, as the real sensor's does. Under the points, a faint occupancy map remembers what
// the lidar has seen and forgets it again after about half a minute.
//
// The rover works through a fixed list of goals that sweep back and forth across the network.
// For each one it plans the shortest route on a costmap that keeps it clear of the nodes (A*,
// straightened across open space, corners rounded), and follows it with regulated pure pursuit,
// which slows it on tight curves so it sweeps round them. The dashed line is that plan.
//
// The canvas is pinned to the viewport (or, on touch devices, covers the whole page) and
// everything is kept in the hero's own coordinates, so the rover can also be driven off the
// block and around the rest of the page (it never goes there by itself).
(function () {
  const canvas = document.getElementById('lidar');
  if (!canvas) return;
  const hero = canvas.closest('.hero') || canvas.parentElement;
  const band = document.querySelector('.art') || canvas.parentElement;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const showRoute = /[?&]route\b/.test(location.search);   // debug: draw the goals, the plan and the hidden nodes
  // Two ways to place the canvas. On mouse devices it is pinned to the viewport and redrawn with the
  // scroll offset each frame. On touch devices frames lag the compositor's scrolling, which makes a
  // pinned canvas jitter, so there the canvas covers the whole page and scrolls with it natively.
  const pageMode = window.matchMedia('(pointer: coarse)').matches;

  // ---- the sensor ----
  const BEAMS = 1600, STEP = 2 * Math.PI / BEAMS;   // readings per turn: 16 kHz at 10 Hz, so 0.225° apart
  const MAP_RATE = 8000;                            // the map uses every other reading of the real-time stream
  const SLOW = 1.9, FAST = 0.1, HOLD = 2.4, RAMP = 4;   // start-up: 1.9 s a turn for 2.4 s, then 4 s to reach 10 Hz

  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, bandTop = 0, bandH = 0, VW = 0, VH = 0;
  let ox = 0, oy = 0;                 // canvas offset of the hero's origin this frame (0,0 in page mode)
  let sc = 1, R = 12, PX_PER_M = 49, RANGE = 590, MAXU = 295, SPEED = 42;
  const ROVER = { len: 22, wid: 15, r: 12 };
  const view = { x0: 0, y0: 0, x1: 0, y1: 0 };   // the visible part of the page, in hero coordinates
  const page = { x0: 0, y0: 0, x1: 0, y1: 0 };   // the whole page, in hero coordinates
  let nodes = [], wires = [], goals = [], openN = 0, start = { x: 0, y: 0 };

  // ---- hidden scene: a small fully connected network, layers centred like a textbook diagram ----
  function buildScene() {
    const layers = W >= 700 ? [3, 4, 4, 2] : [3, 4, 2];
    const n = layers.length, maxN = Math.max(...layers);
    const edge = 42 * sc, room = edge + R + 26 * sc;
    const span = Math.max(120 * sc, Math.min(W * 0.72, bandH * 3, 1150, W - 2 * room));
    const x0 = cx - span / 2, padY = Math.max(22, bandH * 0.12), pitch = (bandH - 2 * padY) / (maxN - 1);
    const cols = layers.map((k, li) => Array.from({ length: k }, (_, i) => ({ x: x0 + li / (n - 1) * span, y: cy + (i - (k - 1) / 2) * pitch })));
    nodes = cols.flat();
    wires = [];
    for (let li = 0; li < n - 1; li++) for (const a of cols[li]) for (const b of cols[li + 1]) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d;
      wires.push({ x1: a.x + ux * R, y1: a.y + uy * R, x2: b.x - ux * R, y2: b.y - uy * R, len: d - 2 * R });
    }

    // goals: a fixed opening, then a loop that sweeps back and forth between the layers
    const gTop = Math.min(...nodes.map(q => q.y)), gBot = Math.max(...nodes.map(q => q.y));
    const lvl = f => gTop + (gBot - gTop) * f;
    const xs = cols.map(c => c[0].x);
    const yTop = Math.max(edge, gTop - R * 3.2), yBot = Math.min(H - edge, gBot + R * 3.6);
    const out = Math.max(R * 5, Math.min(W * 0.12, (W - span) / 2 - edge - R * 2));
    const C = [Math.max(edge, xs[0] - out)];
    for (let i = 1; i < n; i++) C.push((xs[i - 1] + xs[i]) / 2);
    C.push(Math.min(W - edge, xs[n - 1] + out));
    let seed = (Math.random() * 2 ** 32) >>> 0;   // a little variety each visit in how high or low each goal sits
    const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const jig = f => lvl(Math.min(0.95, Math.max(0.05, f + (rnd() - 0.5) * 0.12)));

    // the opening: through the network low down, back along the top, then over the left part of the intro text
    const open = [];
    for (let i = 1; i <= n; i++) open.push([C[i], lvl(0.8)]);
    for (let i = n - 1; i >= 0; i--) open.push([C[i], lvl(0.2)]);
    const blurb = document.querySelector('.blurb');
    if (blurb) {
      const hr = hero.getBoundingClientRect(), br = blurb.getBoundingClientRect();
      const yText = Math.max(edge, (br.top + br.bottom) / 2 - hr.top), textEnd = br.right - hr.left;
      open.push([edge + R, yText], [Math.min(C[1], textEnd * 0.6), yText]);
    }
    const loop = [];
    for (let i = 0; i <= n; i++) loop.push([C[i], i % 2 ? jig(0.86) : jig(0.14)]);
    loop.push([C[n], yBot]);
    for (let i = n - 1; i >= 1; i--) loop.push([C[i], (n - i) % 2 ? jig(0.35) : jig(0.68)]);
    loop.push([C[0], jig(0.55)], [C[0], yTop]);
    for (let i = 1; i <= n; i++) loop.push([C[i], i % 2 ? jig(0.5) : jig(0.22)]);
    loop.push([C[n], jig(0.92)], [cx, yBot], [C[0], jig(0.9)]);
    goals = open.concat(loop); openN = open.length; start = { x: C[0], y: yTop };
    buildCostmap(yTop);
    buildMap();
  }

  // ---- planning: a costmap, A*, then straighten and smooth ----
  let PC = 4, PW = 0, PH = 0, pcost = new Float32Array(0);
  function buildCostmap(yTop) {
    PC = Math.max(4 * sc, W / 260); PW = Math.ceil(W / PC); PH = Math.ceil(H / PC); pcost = new Float32Array(PW * PH);
    const lethal = R + ROVER.r + 3 * sc, decay = 12 * sc, edge = 24 * sc;
    for (let gy = 0; gy < PH; gy++) for (let gx = 0; gx < PW; gx++) {
      const x = (gx + 0.5) * PC, y = (gy + 0.5) * PC, c = gy * PW + gx;
      if (x < edge || x > W - edge || y < edge || y > H - edge) { pcost[c] = Infinity; continue; }
      let d = Infinity; for (const q of nodes) d = Math.min(d, Math.hypot(x - q.x, y - q.y) - lethal);
      // expensive close to a node, free in open space, and a little dearer over the intro text so routes only cross it on purpose
      pcost[c] = d <= 0 ? Infinity : 40 * Math.exp(-d / decay) + (y < yTop - 20 * sc ? 6 : 0);
    }
  }
  const costAt = (x, y) => { const gx = Math.floor(x / PC), gy = Math.floor(y / PC); return gx < 0 || gy < 0 || gx >= PW || gy >= PH ? Infinity : pcost[gy * PW + gx]; };
  function nearestFree(gx, gy) {
    gx = Math.max(0, Math.min(PW - 1, gx)); gy = Math.max(0, Math.min(PH - 1, gy));
    if (pcost[gy * PW + gx] !== Infinity) return [gx, gy];
    for (let r = 1; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = gx + dx, y = gy + dy;
      if (x >= 0 && y >= 0 && x < PW && y < PH && pcost[y * PW + x] !== Infinity) return [x, y];
    }
    return [gx, gy];
  }
  const hA = [], hF = [];   // a binary heap for the open set
  function hpush(i, f) { hA.push(i); hF.push(f); let k = hA.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (hF[p] <= hF[k]) break; [hA[p], hA[k]] = [hA[k], hA[p]]; [hF[p], hF[k]] = [hF[k], hF[p]]; k = p; } }
  function hpop() { const top = hA[0], la = hA.pop(), lf = hF.pop(); if (hA.length) { hA[0] = la; hF[0] = lf; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < hA.length && hF[l] < hF[m]) m = l; if (r < hA.length && hF[r] < hF[m]) m = r; if (m === k) break; [hA[m], hA[k]] = [hA[k], hA[m]]; [hF[m], hF[k]] = [hF[k], hF[m]]; k = m; } } return top; }
  let gScore = null, came = null, closed = null;
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  function astar(sx, sy, tx, ty) {
    const N = PW * PH;
    if (!gScore || gScore.length !== N) { gScore = new Float32Array(N); came = new Int32Array(N); closed = new Uint8Array(N); }
    gScore.fill(Infinity); closed.fill(0); hA.length = 0; hF.length = 0;
    const [ax, ay] = nearestFree(Math.floor(sx / PC), Math.floor(sy / PC)), [bx, by] = nearestFree(Math.floor(tx / PC), Math.floor(ty / PC));
    const s = ay * PW + ax, t = by * PW + bx;
    gScore[s] = 0; came[s] = -1; hpush(s, 0);
    while (hA.length) {
      const c = hpop();
      if (closed[c]) continue;
      if (c === t) break;
      closed[c] = 1;
      const x = c % PW, y = (c - x) / PW;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= PW || ny >= PH) continue;
        const nb = ny * PW + nx, cost = pcost[nb];
        if (cost === Infinity || closed[nb]) continue;
        const g = gScore[c] + DL[d] * (1 + cost / 12);
        if (g < gScore[nb]) { gScore[nb] = g; came[nb] = c; hpush(nb, g + Math.hypot(nx - bx, ny - by)); }
      }
    }
    if (gScore[t] === Infinity) return null;
    const out = [];
    for (let c = t; c !== -1; c = came[c]) { const x = c % PW, y = (c - x) / PW; out.push([(x + 0.5) * PC, (y + 0.5) * PC]); }
    return out.reverse();
  }
  function lineOK(a, b, max) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / (PC * 0.5)));
    for (let i = 0; i <= n; i++) if (costAt(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) > max) return false;
    return true;
  }
  const chaikinOpen = p => { if (p.length < 3) return p; const o = [p[0]]; for (let i = 0; i < p.length - 1; i++) { const a = p[i], b = p[i + 1]; o.push([a[0] * .75 + b[0] * .25, a[1] * .75 + b[1] * .25], [a[0] * .25 + b[0] * .75, a[1] * .25 + b[1] * .75]); } o.push(p[p.length - 1]); return o; };
  function plan(goal) {
    let fx = rover.x, fy = rover.y;
    const pre = [[fx, fy]];
    // off the block (hand-driven down the page), head straight back to the nearest free spot on it first
    if (costAt(fx, fy) === Infinity) {
      const [gx, gy] = nearestFree(Math.floor(fx / PC), Math.floor(fy / PC));
      fx = (gx + 0.5) * PC; fy = (gy + 0.5) * PC; pre.push([fx, fy]);
    }
    // start a little ahead along the heading, so the plan leaves the way the rover is already facing
    const lx = fx + Math.cos(rover.heading) * 18 * sc, ly = fy + Math.sin(rover.heading) * 18 * sc;
    const lead = pre.length === 1 && costAt(lx, ly) !== Infinity && lineOK([fx, fy], [lx, ly], 1e9);
    const raw = astar(lead ? lx : fx, lead ? ly : fy, goal[0], goal[1]);
    if (!raw) return null;
    raw[raw.length - 1] = [goal[0], goal[1]];
    const pulled = [raw[0]];                        // straighten: jump to the furthest point in clear sight through cheap space
    for (let i = 0; i < raw.length - 1;) {
      let j = raw.length - 1;
      while (j > i + 1 && !lineOK(raw[i], raw[j], 9)) j--;
      pulled.push(raw[j]); i = j;
    }
    let pts = pre.concat(lead ? pulled : pulled.slice(1));
    for (let k = 0; k < 3; k++) { const s = chaikinOpen(pts); if (s.every(p => costAt(p[0], p[1]) !== Infinity || p === s[0])) pts = s; else break; }
    const outp = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = outp[outp.length - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 2) continue;
      const m = Math.floor(L / 2); for (let s = 1; s <= m; s++) outp.push([a[0] + (b[0] - a[0]) * s / m, a[1] + (b[1] - a[1]) * s / m]);
    }
    return outp;
  }

  // ---- the live occupancy map (10 cm cells, drawn faintly under the points) ----
  let CELL = 5, GW = 0, GH = 0, lo = new Float32Array(0), edgeFade = new Float32Array(0), offW = null, owc = null, offF = null, ofc = null, imgW = null, imgF = null;
  function buildMap() {
    CELL = sc < 1 ? 4 : 5; GW = Math.ceil(W / CELL); GH = Math.ceil(H / CELL); lo = new Float32Array(GW * GH);
    edgeFade = new Float32Array(GW * GH);   // the map fades out towards the edges of the block instead of stopping in a line
    const ramp = d => { const u = Math.max(0, Math.min(1, d)); return u * u * (3 - 2 * u); };
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const x = (gx + 0.5) * CELL, y = (gy + 0.5) * CELL;
      edgeFade[gy * GW + gx] = ramp(x / 40) * ramp((W - x) / 40) * ramp(y / 30) * ramp((H - y) / 90);
    }
    offW = document.createElement('canvas'); offW.width = GW; offW.height = GH; owc = offW.getContext('2d'); imgW = owc.createImageData(GW, GH);
    offF = document.createElement('canvas'); offF.width = GW; offF.height = GH; ofc = offF.getContext('2d'); imgF = ofc.createImageData(GW, GH);
  }
  function mapBeam(sx, sy, a, hit, t) {
    const tEnd = hit && t <= MAXU ? t : MAXU, dx = Math.cos(a), dy = Math.sin(a);
    let last = -1;
    for (let s = 6 * sc; s < tEnd - CELL * 0.6; s += CELL * 0.5) {   // every cell the beam crossed is free
      const gx = Math.floor((sx + dx * s) / CELL), gy = Math.floor((sy + dy * s) / CELL);
      if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) break;
      const c = gy * GW + gx;
      if (c !== last) { lo[c] = Math.max(-2.5, lo[c] - 0.24); last = c; }
    }
    if (hit && t <= MAXU) {                                           // and the one where it stopped is occupied
      const gx = Math.floor((sx + dx * t) / CELL), gy = Math.floor((sy + dy * t) / CELL);
      if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) { const c = gy * GW + gx; lo[c] = Math.min(3.5, lo[c] + 1.1); }
    }
  }

  // where the hero sits in the viewport, and how far the page extends around it
  let heroAbs = { x: 0, y: 0 }, pageSize = { w: 0, h: 0 };
  function measure() {   // read on resize and after loads, not every frame
    const r = hero.getBoundingClientRect(), de = document.documentElement;
    heroAbs = { x: r.left + window.scrollX, y: r.top + window.scrollY }; pageSize = { w: de.clientWidth, h: de.scrollHeight };
  }
  function syncFrame() {
    const ax = heroAbs.x, ay = heroAbs.y;
    const r = { left: ax - window.scrollX, top: ay - window.scrollY }, de = pageSize;
    page.x0 = -ax; page.y0 = -ay; page.x1 = de.w - ax; page.y1 = de.h - ay;
    if (pageMode) { ox = 0; oy = 0; } else { ox = r.left; oy = r.top; }
    view.x0 = -r.left; view.y0 = -r.top; view.x1 = view.x0 + VW; view.y1 = view.y0 + VH;
    cursor.x = cursor.cx - r.left; cursor.y = cursor.cy - r.top;
  }

  // ---- an easter egg at the foot of the page: a line of text only the lidar can reveal ----
  const egg = { x: 0, y: 0, w: 0, h: 0, data: null };
  function placeEgg() {
    const foot = document.querySelector('.foot');
    if (!foot) return;
    const hr = hero.getBoundingClientRect(), fr = foot.getBoundingClientRect();
    const text = 'you drove all the way down here. nice.';
    const off = document.createElement('canvas'), o = off.getContext('2d');
    const size = Math.min(30, Math.max(18, Math.round(hr.width / 26)));
    o.font = `600 ${size}px "Inter Tight", system-ui, sans-serif`;
    egg.w = Math.ceil(o.measureText(text).width) + 8; egg.h = Math.ceil(size * 1.3);
    off.width = egg.w; off.height = egg.h;
    o.font = `600 ${size}px "Inter Tight", system-ui, sans-serif`; o.textBaseline = 'middle'; o.fillStyle = '#000';
    o.fillText(text, 4, egg.h / 2);
    egg.data = o.getImageData(0, 0, egg.w, egg.h).data;
    egg.x = (fr.left + fr.width / 2) - hr.left - egg.w / 2;
    egg.y = fr.top - hr.top - egg.h - 14;
  }
  let eggNear = false, eggCount = 0;
  function eggRay(sx, sy, dx, dy, tMax, time) {      // the letters don't block the beam: every stroke it crosses returns
    let t0 = 0, t1 = tMax;
    for (const [o, d, lo0, hi0] of [[sx, dx, egg.x, egg.x + egg.w], [sy, dy, egg.y, egg.y + egg.h]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo0 || o > hi0) return; continue; }
      let a = (lo0 - o) / d, b = (hi0 - o) / d; if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 >= t1) return;
    }
    for (let t = Math.ceil(t0); t < t1; t += 2) {
      const u = (sx + dx * t - egg.x) | 0, v = (sy + dy * t - egg.y) | 0;
      if (egg.data[(v * egg.w + u) * 4 + 3] > 100) pushEgg(sx + dx * t, sy + dy * t, time);
    }
  }

  // ---- the cursor: an arrow-pointer shape (about 12 x 19 px) the beam cannot pass ----
  const ARROW = [[0, 0], [0, 16.5], [4.2, 12.8], [7.2, 19], [9.6, 18], [6.7, 11.9], [12, 11.9]];
  const cursor = { x: 0, y: 0, cx: 0, cy: 0, on: false };   // cx, cy in viewport coordinates; x, y in hero coordinates
  function castCursor(sx, sy, dx, dy) {
    let best = Infinity;
    for (let i = 0; i < ARROW.length; i++) {
      const a = ARROW[i], b = ARROW[(i + 1) % ARROW.length];
      const x1 = cursor.x + a[0], y1 = cursor.y + a[1], ex = b[0] - a[0], ey = b[1] - a[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const qx = x1 - sx, qy = y1 - sy, t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
      if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
    return best;
  }

  // ---- ray casting and the sensor model ----
  const hit = { tN: Infinity, pN: 0, tN2: Infinity, nw: 0 };
  const WT = new Float32Array(128), WC = new Float32Array(128);
  function castAll(sx, sy, dx, dy) {
    hit.tN = Infinity; hit.pN = 0; hit.tN2 = Infinity;
    for (const q of nodes) {
      const ex = q.x - sx, ey = q.y - sy, b = ex * dx + ey * dy;
      if (b <= 0) continue;
      const c2 = ex * ex + ey * ey - b * b;
      if (c2 >= R * R) continue;
      const t = b - Math.sqrt(R * R - c2);
      if (t <= 0) continue;
      if (t < hit.tN) { hit.tN2 = hit.tN; hit.tN = t; hit.pN = Math.sqrt(c2); } else if (t < hit.tN2) hit.tN2 = t;
    }
    const lim = Math.min(hit.tN, RANGE);
    let k = 0;
    for (const w of wires) {
      const ex = w.x2 - w.x1, ey = w.y2 - w.y1, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const qx = w.x1 - sx, qy = w.y1 - sy, t = (qx * ey - qy * ex) / den;
      if (t <= 4 || t >= lim) continue;
      const u = (qx * dy - qy * dx) / den;
      if (u < 0 || u > 1 || k >= 128) continue;
      WT[k] = t; WC[k] = Math.abs(den) / w.len; k++;
    }
    for (let i = 1; i < k; i++) { const t = WT[i], c = WC[i]; let j = i - 1; while (j >= 0 && WT[j] > t) { WT[j + 1] = WT[j]; WC[j + 1] = WC[j]; j--; } WT[j + 1] = t; WC[j + 1] = c; }
    hit.nw = k;
  }
  let spare = null;
  function gauss() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u, v, s; do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s); spare = v * m; return u * m;
  }
  const sig = t => 0.5 + 0.005 * t;            // range noise: about 1% of the distance, plus a floor
  const ev = { kind: -1, t: 0, x: 0, y: 0, v: 0 };   // kinds: 0 node, 1 cursor, 2 wire, 4 ghost, 5 dust; -1 no return (the egg keeps its own)
  function sense(sx, sy, a, rate) {
    const dx = Math.cos(a), dy = Math.sin(a);
    ev.kind = -1;
    castAll(sx, sy, dx, dy);
    const tc = cursor.on ? castCursor(sx, sy, dx, dy) : Infinity;
    for (let j = 0; j < hit.nw && WT[j] < tc; j++) {           // a thin wire: a partial hit sometimes returns, and a return ends the beam
      if (Math.random() < 0.12 * Math.sqrt(WC[j])) { ev.kind = 2; ev.t = WT[j] + gauss() * sig(WT[j]); ev.v = 0.3; break; }
    }
    if (ev.kind < 0 && tc < hit.tN && tc < RANGE) { ev.kind = 1; ev.t = tc + gauss() * sig(tc) * 0.6; ev.v = 0.9; }
    else if (ev.kind < 0 && hit.tN < RANGE) {
      const e = hit.pN / R, cosI = Math.sqrt(Math.max(0, 1 - e * e));
      const p = 0.995 * Math.min(1, cosI / 0.18) * (1 - 0.7 * (hit.tN / RANGE) ** 4);   // glancing and far hits drop out
      if (Math.random() < p) {
        ev.kind = 0; ev.t = hit.tN + gauss() * sig(hit.tN); ev.v = 0.55 + 0.45 * cosI;
        if (e > 0.86 && Math.random() < 0.4) {                   // the spot straddles the edge: the range lands in between
          ev.kind = 4; ev.v = 0.35;
          ev.t = hit.tN2 < hit.tN + 150 ? hit.tN + Math.random() * (hit.tN2 - hit.tN) : hit.tN + 3 + Math.random() * 18;
        }
      }
    }
    if (Math.random() < 1.2 / rate) {                            // about one dust return a second, near the sensor
      const t = (16 + Math.random() * 110) * sc;
      if (ev.kind < 0 || t < ev.t) { ev.kind = 5; ev.t = t; ev.v = 0.3; }
    }
    if (ev.kind >= 0) { ev.x = sx + dx * ev.t; ev.y = sy + dy * ev.t; }
  }

  // ---- readings: a ring buffer in time order, so the live ones sit between tail and head ----
  const N = 30000;
  const px = new Float32Array(N), py = new Float32Array(N), pt = new Float64Array(N), pv = new Float32Array(N), kind = new Uint8Array(N);
  let head = 0, tail = 0;
  function push(x, y, t, v, k) { px[head] = x; py[head] = y; pt[head] = t; pv[head] = v; kind[head] = k; head = (head + 1) % N; if (head === tail) tail = (tail + 1) % N; }
  const EN = 12000, ex = new Float32Array(EN), ey = new Float32Array(EN), et = new Float64Array(EN);   // the easter egg's own, longer-lived readings
  let eHead = 0, eTail = 0;
  function pushEgg(x, y, t) { ex[eHead] = x; ey[eHead] = y; et[eHead] = t; eHead = (eHead + 1) % EN; if (eHead === eTail) eTail = (eTail + 1) % EN; }

  // ---- the rover ----
  const rover = { x: 0, y: 0, vx: 0, vy: 0, heading: Math.PI / 2, manual: false, lastInput: -1e9 };
  let goalI = 0, route = null, routeI = 0, replanT = 0;
  const keys = new Set();
  const stick = { x: 0, y: 0, on: false };   // thumbstick vector, unit-ish, for touch driving
  let scrollCarry = 0;                        // sub-pixel remainder of the page-follow scroll
  let armed = false;   // arrow keys only steer after a click on the block, so they do not stop the page scrolling
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const nextGoal = i => i + 1 < goals.length ? i + 1 : openN;
  if (showRoute) { window.lidarRover = rover; window.lidarGoals = () => goals; window.lidarPlan = () => route; }

  function keepOutOfNodes() {
    for (const q of nodes) {
      const dx = rover.x - q.x, dy = rover.y - q.y, d = Math.hypot(dx, dy) || 1e-6, keep = R + ROVER.r + 2;
      if (d < keep) { rover.x = q.x + dx / d * keep; rover.y = q.y + dy / d * keep; }
    }
    rover.x = Math.min(page.x1 - ROVER.r, Math.max(page.x0 + ROVER.r, rover.x));
    rover.y = Math.min(page.y1 - ROVER.r, Math.max(page.y0 + ROVER.r, rover.y));
  }

  function driveRover(dt) {
    const fwd = (keys.has('w') || keys.has('arrowup')) - (keys.has('s') || keys.has('arrowdown'));
    const turn = (keys.has('d') || keys.has('arrowright')) - (keys.has('a') || keys.has('arrowleft'));
    if (fwd || turn || stick.on) { rover.lastInput = simT; rover.manual = true; }
    if (rover.manual && simT - rover.lastInput > 4) {
      // hands off for four seconds: carry on with the tour from the goal after the nearest one
      rover.manual = false;
      let best = openN, bd = Infinity;
      for (let i = openN; i < goals.length; i++) { const d = Math.hypot(goals[i][0] - rover.x, goals[i][1] - rover.y); if (d < bd) { bd = d; best = i; } }
      goalI = nextGoal(best); route = null;
    }
    if (rover.manual) {
      let sp = fwd * SPEED * 1.5;
      rover.heading += turn * 2.6 * dt;
      if (stick.on) {   // thumbstick: swing towards the direction of the thumb, speed from how far it is pushed
        const mag = Math.min(1, Math.hypot(stick.x, stick.y));
        if (mag > 0.15) {
          const dh = wrap(Math.atan2(stick.y, stick.x) - rover.heading);
          rover.heading += Math.max(-3.2 * dt, Math.min(3.2 * dt, dh));
          sp = SPEED * 1.5 * mag * Math.max(0.25, Math.cos(dh));
        }
      }
      const k = 1 - Math.exp(-dt * 6);
      rover.vx += (Math.cos(rover.heading) * sp - rover.vx) * k;
      rover.vy += (Math.sin(rover.heading) * sp - rover.vy) * k;
      rover.x += rover.vx * dt; rover.y += rover.vy * dt;
      keepOutOfNodes();
      if (fwd || turn || stick.on) {   // keep a hand-driven rover in view: scroll the page along with it
        const vy = rover.y - view.y0, m = 90;
        scrollCarry += vy < m ? vy - m : vy > VH - m ? vy - (VH - m) : 0;
        const whole = Math.trunc(scrollCarry);   // whole pixels only: fractional scrolls round unevenly and stutter
        if (whole) { window.scrollBy(0, whole); scrollCarry -= whole; }
      }
      return;
    }
    // autopilot: take up the next goal just before arriving, and replan once a second from wherever it is
    const g = goals[goalI];
    if (Math.hypot(g[0] - rover.x, g[1] - rover.y) < 42 * sc) { goalI = nextGoal(goalI); route = null; }
    replanT -= dt;
    if (!route || replanT <= 0) { route = plan(goals[goalI]) || route; routeI = 0; replanT = 1; }
    if (!route) return;
    let best = routeI, bd = Infinity;
    for (let i = routeI; i < Math.min(route.length, routeI + 60); i++) { const d = Math.hypot(route[i][0] - rover.x, route[i][1] - rover.y); if (d < bd) { bd = d; best = i; } }
    routeI = best;
    // regulated pure pursuit: steer along the arc to a point about 30 px ahead, slower when that arc is tight
    const tgt = route[Math.min(route.length - 1, routeI + Math.round(15 * sc))];
    const Ld = Math.max(8 * sc, Math.hypot(tgt[0] - rover.x, tgt[1] - rover.y));
    const alpha = wrap(Math.atan2(tgt[1] - rover.y, tgt[0] - rover.x) - rover.heading);
    const kappa = 2 * Math.sin(alpha) / Ld;
    const off = rover.y > H || rover.y < 0 || rover.x < 0 || rover.x > W;   // hurry only when coming home from off the block
    const v = off ? SPEED * 1.6 : Math.max(SPEED * 0.28, SPEED * Math.min(1, 1 / (Math.abs(kappa) * 44 * sc + 1e-9)));
    rover.heading = wrap(rover.heading + Math.max(-1.6, Math.min(1.6, v * kappa)) * dt);
    rover.vx = Math.cos(rover.heading) * v; rover.vy = Math.sin(rover.heading) * v;
    rover.x += rover.vx * dt; rover.y += rover.vy * dt;
    keepOutOfNodes();
  }

  // ---- one step of the simulation ----
  let simT = 0, spinT = 0, spin = 0, beamCarry = 0, mapCarry = 0, beamCount = 0, beamEnd = null;
  const particles = Array.from({ length: 36 }, () => ({ dx: gauss() * 3, dy: gauss() * 3, dh: gauss() * 0.06 }));
  function period() {   // seconds per turn of the head: slow at first, then up to 10 Hz
    const t = spinT - HOLD;
    if (t <= 0) return SLOW;
    if (t >= RAMP) return FAST;
    const u = t / RAMP;
    return SLOW * Math.pow(FAST / SLOW, u * u * (3 - 2 * u));
  }
  function step(dt) {
    syncFrame();
    eggNear = egg.data !== null && Math.abs(rover.y - (egg.y + egg.h / 2)) < VH * 0.85 && Math.abs(rover.x - (egg.x + egg.w / 2)) < VW;
    const x0 = rover.x, y0 = rover.y, h0 = rover.heading;
    driveRover(dt);
    if (!isFinite(rover.x) || !isFinite(rover.y) || !isFinite(rover.heading)) { rover.x = x0; rover.y = y0; rover.heading = 0; rover.vx = rover.vy = 0; route = null; }
    const dh = wrap(rover.heading - h0);
    spinT += dt;
    const P = period(), rate = BEAMS / P, full = P <= FAST * 1.001;
    beamCarry += dt * rate;
    const n = Math.min(4000, Math.floor(beamCarry)); beamCarry -= Math.floor(beamCarry);
    const spin0 = spin;
    for (let k = 0; k < n; k++) {             // each reading is taken from where the rover is at that instant
      const f = (k + 1) / n, x = x0 + (rover.x - x0) * f, y = y0 + (rover.y - y0) * f, h = h0 + dh * f;
      spin = (spin + STEP) % (Math.PI * 2);
      const a = h + spin, time = simT + dt * f;
      sense(x, y, a, rate);
      if (ev.kind >= 0) push(ev.x, ev.y, time, ev.v, ev.kind);
      if (eggNear && (++eggCount % 24) === 0) eggRay(x, y, Math.cos(a), Math.sin(a), ev.kind >= 0 ? ev.t : RANGE, time);
      if (full && (beamCount++ & 1) === 0) mapBeam(x, y, a, ev.kind >= 0 && ev.kind !== 1, ev.t);
      if (k === n - 1) beamEnd = { x, y, a, t: ev.kind >= 0 ? ev.t : RANGE };
    }
    if (!full) {       // the sensor keeps sampling at full rate while its head turns slowly, so the map fills in right behind the beam
      mapCarry += dt * MAP_RATE;
      const m = Math.floor(mapCarry); mapCarry -= m;
      for (let j = 0; j < m; j++) {
        const f = (j + 1) / m, x = x0 + (rover.x - x0) * f, y = y0 + (rover.y - y0) * f;
        const a = h0 + dh * f + spin0 + n * STEP * f;
        sense(x, y, a, 16000);
        mapBeam(x, y, a, ev.kind >= 0 && ev.kind !== 1, ev.t);
      }
    }
    simT += dt;
    const fade = Math.exp(-dt / 32);         // the map forgets in about half a minute
    for (let i = 0; i < lo.length; i++) lo[i] *= fade;
    for (const p of particles) { p.dx = p.dx * 0.97 + gauss() * 0.35; p.dy = p.dy * 0.97 + gauss() * 0.35; p.dh = p.dh * 0.97 + gauss() * 0.01; }
  }

  // ---- drawing ----
  const col = {};
  const hex = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const v = parseInt(h, 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  function readColours() {
    const cs = getComputedStyle(document.documentElement);
    col.fg = cs.getPropertyValue('--fg').trim() || '#111'; col.accent = cs.getPropertyValue('--accent').trim() || '#0c869b'; col.muted = cs.getPropertyValue('--muted').trim() || '#737373';
    col.fgRGB = hex(col.fg); col.accRGB = hex(col.accent);
    col.acc0 = `rgba(${col.accRGB.join(',')},0)`;
    col.dark = (col.fgRGB[0] + col.fgRGB[1] + col.fgRGB[2]) > 382;
  }
  let mapDrawnAt = -1;
  function drawMap() {
    if (simT - mapDrawnAt >= 0.1 || mapDrawnAt < 0) {   // the map changes slowly: rebuild its image ten times a second
      mapDrawnAt = simT;
      const dw = imgW.data, df = imgF.data, [r, g, b] = col.fgRGB, floor = col.dark ? 15 : 12;
      for (let i = 0; i < lo.length; i++) {
        const v = lo[i], o = i * 4;
        const e = edgeFade[i];
        df[o] = r; df[o + 1] = g; df[o + 2] = b; df[o + 3] = v < -0.4 ? Math.min(1, (-v - 0.4) / 1.8) * floor * e : 0;       // seen floor, soft
        dw[o] = r; dw[o + 1] = g; dw[o + 2] = b; dw[o + 3] = v > 0.5 ? (0.08 + 0.26 * Math.min(1, (v - 0.5) / 2.5)) * 255 * e : 0;   // walls, crisp
      }
      ofc.putImageData(imgF, 0, 0); owc.putImageData(imgW, 0, 0);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offF, 0, 0, GW * CELL, GH * CELL);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offW, 0, 0, GW * CELL, GH * CELL);
    ctx.imageSmoothingEnabled = true;
  }
  function drawPath() {
    if (!route || rover.manual) return;
    ctx.strokeStyle = col.accent; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.1; ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const s0 = Math.min(route.length - 1, routeI + Math.round(5 * sc));
    for (let i = s0; i < route.length; i += 2) i === s0 ? ctx.moveTo(route[i][0], route[i][1]) : ctx.lineTo(route[i][0], route[i][1]);
    ctx.stroke(); ctx.setLineDash([]);
    const g = goals[goalI], nx = goals[nextGoal(goalI)], h = Math.atan2(nx[1] - g[1], nx[0] - g[0]), L = 13 * sc;   // the goal pose, as a planner draws it
    ctx.save(); ctx.translate(g[0], g[1]); ctx.rotate(h);
    ctx.globalAlpha = 0.9; ctx.fillStyle = col.accent; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-L / 2, 0); ctx.lineTo(L / 2 - 3, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(L / 2, 0); ctx.lineTo(L / 2 - 5, -3); ctx.lineTo(L / 2 - 5, 3); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(-L / 2, 0, 2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
  }
  const beamAlpha = () => { const P = period(); return P >= 0.7 ? 1 : P <= 0.22 ? 0 : (P - 0.22) / 0.48; };
  function drawBeam() {
    const a0 = beamAlpha();
    if (a0 <= 0 || !beamEnd || reduced) return;
    const hx = beamEnd.x + Math.cos(beamEnd.a) * 4 * sc, hy = beamEnd.y + Math.sin(beamEnd.a) * 4 * sc;
    const ex = beamEnd.x + Math.cos(beamEnd.a) * beamEnd.t, ey = beamEnd.y + Math.sin(beamEnd.a) * beamEnd.t;
    const g = ctx.createLinearGradient(hx, hy, ex, ey);
    g.addColorStop(0, col.accent); g.addColorStop(1, col.acc0);
    ctx.strokeStyle = g; ctx.globalAlpha = 0.5 * a0; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // points are grouped into a dozen steps of opacity and each group is drawn as one path: thousands of
  // separate fillRect calls, each with its own opacity, were most of the hero's cost per frame
  const BINS = 12, binN = new Int32Array(BINS * 2), binXY = Array.from({ length: BINS * 2 }, () => new Float32Array(N * 2 / 4));
  function binPoint(b, x, y) { const n = binN[b], arr = binXY[b]; if (n * 2 + 1 < arr.length) { arr[n * 2] = x; arr[n * 2 + 1] = y; binN[b] = n + 1; } }
  function flushBins(offset, colour, s) {
    ctx.fillStyle = colour;
    for (let b = 0; b < BINS; b++) {
      const n = binN[offset + b]; if (!n) continue;
      const arr = binXY[offset + b];
      ctx.globalAlpha = (b + 0.5) / BINS;
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.rect(arr[i * 2] - s / 2, arr[i * 2 + 1] - s / 2, s, s);
      ctx.fill();
    }
  }
  function drawPoints() {
    const P = period(), life = Math.max(1.5, 2.2 * P), fresh = Math.max(0.1, 0.1 * P), eggLife = 12;
    while (tail !== head && simT - pt[tail] > life) tail = (tail + 1) % N;
    while (eTail !== eHead && simT - et[eTail] > eggLife) eTail = (eTail + 1) % EN;
    const vx0 = view.x0 - 2, vy0 = view.y0 - 2, vx1 = view.x1 + 2, vy1 = view.y1 + 2;   // only what is on screen
    const s1 = 1.5 * Math.max(0.85, sc), s2 = 1.8 * Math.max(0.85, sc);
    binN.fill(0);
    const every = sc < 1 ? 2 : 1;   // phones draw everything smaller, so every other reading gives the same density as a laptop
    for (let i = tail; i !== head; i = (i + 1) % N) {
      if (every > 1 && (i & 1)) continue;
      const x = px[i], y = py[i];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      const age = simT - pt[i];
      let a, off = 0;
      if (age < fresh) { a = Math.min(1, 0.25 + pv[i]) * (1 - 0.4 * age / fresh); off = BINS; }   // the newest turn, in the accent colour
      else { const u = 1 - (age - fresh) / (life - fresh); if (u <= 0) continue; a = 0.9 * u * u * (3 - 2 * u) * pv[i]; }   // older, fading to nothing
      const b = Math.min(BINS - 1, (a * BINS) | 0);
      if (a * BINS >= 0.35) binPoint(off + b, x, y);
    }
    flushBins(0, col.fg, s1);
    flushBins(BINS, col.accent, s2);
    binN.fill(0);
    for (let i = eTail; i !== eHead; i = (i + 1) % EN) {         // the message lingers, so a pass leaves it readable
      const x = ex[i], y = ey[i];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      const u = 1 - (simT - et[i]) / eggLife, a = 0.95 * u * u * (3 - 2 * u);
      binPoint(Math.min(BINS - 1, (a * BINS) | 0), x, y);
    }
    flushBins(0, col.fg, 2);
    ctx.globalAlpha = 1;
  }
  function drawParticles() {   // the localiser's guesses at the rover's pose
    ctx.strokeStyle = col.muted; ctx.lineWidth = 0.8; ctx.globalAlpha = 0.7;
    const L = 5 * sc;
    ctx.beginPath();
    for (const p of particles) {
      const x = rover.x + p.dx * sc, y = rover.y + p.dy * sc, h = rover.heading + p.dh;
      const ex = x + Math.cos(h) * L, ey = y + Math.sin(h) * L;
      ctx.moveTo(x, y); ctx.lineTo(ex, ey);
      ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.cos(h - 0.5) * 1.8, ey - Math.sin(h - 0.5) * 1.8);
      ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.cos(h + 0.5) * 1.8, ey - Math.sin(h + 0.5) * 1.8);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  function drawRover() {
    // the rover, seen from above: four wheels, a body, and the lidar puck on its back
    ctx.save();
    ctx.translate(rover.x, rover.y); ctx.rotate(rover.heading); ctx.scale(sc, sc);
    const L = ROVER.len / sc, Wd = ROVER.wid / sc;
    ctx.globalAlpha = 1; ctx.fillStyle = '#111';
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) { ctx.beginPath(); ctx.roundRect(sx * L * 0.3 - 3.5, sy * (Wd / 2 + 1) - 2.5, 7, 5, 1.5); ctx.fill(); }
    let g = ctx.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
    g.addColorStop(0, '#d9d9d6'); g.addColorStop(1, '#9a9a97');
    ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(-L / 2, -Wd / 2, L, Wd, 4); ctx.fill();
    ctx.fillStyle = '#5c5f63'; ctx.beginPath(); ctx.roundRect(L / 2 - 5, -Wd / 2 + 3, 3, Wd - 6, 1); ctx.fill();
    ctx.rotate(-rover.heading);
    g = ctx.createRadialGradient(-1.5, -1.5, 1, 0, 0, 6);
    g.addColorStop(0, '#3a3d40'); g.addColorStop(1, '#0d0e10');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
    // the head: its window while it turns slowly, a faint blur once it is at speed
    const a0 = reduced ? 1 : beamAlpha();
    if (a0 > 0) { ctx.save(); ctx.rotate(rover.heading + spin); ctx.globalAlpha = a0; ctx.fillStyle = col.accent; ctx.fillRect(2.2, -1.1, 2.2, 2.2); ctx.restore(); }
    if (a0 < 1) { ctx.strokeStyle = col.accent; ctx.globalAlpha = 0.5 * (1 - a0); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1;
  }
  function drawDebug() {
    ctx.globalAlpha = 0.25; ctx.strokeStyle = col.fg; ctx.lineWidth = 1;
    for (const q of nodes) { ctx.beginPath(); ctx.arc(q.x, q.y, R, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); for (const w of wires) { ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); } ctx.globalAlpha = 0.1; ctx.stroke();
    ctx.font = '10px JetBrains Mono, monospace'; ctx.fillStyle = col.fg; ctx.globalAlpha = 0.8;
    goals.forEach((g, i) => { ctx.beginPath(); ctx.arc(g[0], g[1], 2.5, 0, Math.PI * 2); ctx.fill(); ctx.fillText(String(i), g[0] + 5, g[1] - 5); });
    ctx.globalAlpha = 1;
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.translate(ox, oy);   // everything below is in hero coordinates
    if (view.y1 > 0 && view.y0 < H) drawMap();   // the map covers the block only
    if (showRoute) drawDebug();
    drawPath(); drawBeam(); drawPoints(); drawParticles(); drawRover();
  }

  function resize() {
    const r = hero.getBoundingClientRect(), b = band.getBoundingClientRect();
    VW = window.innerWidth; VH = window.innerHeight;
    if (pageMode) {   // one canvas over the whole page, its resolution capped so it never gets huge
      const de = document.documentElement, pw = de.clientWidth, ph = de.scrollHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(9e6 / (pw * ph)));
      canvas.classList.add('page');
      canvas.style.left = -(r.left + window.scrollX) + 'px'; canvas.style.top = -(r.top + window.scrollY) + 'px';
      canvas.width = Math.round(pw * dpr); canvas.height = Math.round(ph * dpr);
      canvas.style.width = pw + 'px'; canvas.style.height = ph + 'px';
    } else {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(VW * dpr); canvas.height = Math.round(VH * dpr);
      canvas.style.width = VW + 'px'; canvas.style.height = VH + 'px';
    }
    const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
    const changed = nw !== W || nh !== H;   // only the block's own size matters to the scene (not, say, a phone's URL bar)
    W = nw; H = nh;
    bandTop = b.top - r.top; bandH = b.height;
    cx = W / 2; cy = bandTop + bandH / 2;
    if (changed) {
      sc = W < 600 ? 0.72 : 1;              // phones: a smaller rover and nodes, so the network fits
      R = Math.max(9, Math.min(15, bandH * 0.05)) * (sc < 1 ? 0.75 : 1);
      ROVER.len = 22 * sc; ROVER.wid = 15 * sc; ROVER.r = 12 * sc;
      PX_PER_M = ROVER.len / 0.447; RANGE = 12 * PX_PER_M; MAXU = 6 * PX_PER_M; SPEED = 42 * sc;
      const first = !goals.length;
      buildScene(); head = tail = 0; eHead = eTail = 0; route = null;
      if (first) { rover.x = start.x; rover.y = start.y; rover.heading = Math.PI / 2; goalI = 0; }
      else { let best = openN, bd = Infinity; for (let i = openN; i < goals.length; i++) { const d = Math.hypot(goals[i][0] - rover.x, goals[i][1] - rover.y); if (d < bd) { bd = d; best = i; } } goalI = nextGoal(best); }
    }
    measure(); syncFrame(); placeEgg();
    if (reduced) drawStatic();
  }

  // reduced motion: the network as a still outline, redrawn as the page scrolls
  function drawStatic() {
    syncFrame();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr); ctx.translate(ox, oy);
    ctx.strokeStyle = col.fg; ctx.lineWidth = 1;
    ctx.globalAlpha = 0.14; ctx.beginPath(); for (const w of wires) { ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); } ctx.stroke();
    ctx.globalAlpha = 0.4; for (const q of nodes) { ctx.beginPath(); ctx.arc(q.x, q.y, R, 0, Math.PI * 2); ctx.stroke(); }
    ctx.globalAlpha = 1;
    drawRover();
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.max(0, Math.min(0.06, (now - last) / 1000)); last = now;
    step(dt); draw();
    requestAnimationFrame(loop);
  }

  // the cursor object follows the mouse, or a finger while it is touching the top block
  const stickEl = document.querySelector('.stick');
  const place = e => {
    if (stickEl && stickEl.contains(e.target)) return;
    const r = hero.getBoundingClientRect();   // only over the block: elsewhere the cursor is a hand, not the arrow we model
    cursor.cx = e.clientX; cursor.cy = e.clientY;
    cursor.on = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  if (stickEl) {   // the thumbstick: drag the knob, the rover follows; the thumb on it is not a lidar obstacle
    const knob = stickEl.querySelector('.knob');
    const move = e => {
      const r = stickEl.getBoundingClientRect(), kx = r.left + r.width / 2, ky = r.top + r.height / 2, lim = r.width / 2 - 12;
      let dx = e.clientX - kx, dy = e.clientY - ky; const d = Math.hypot(dx, dy);
      if (d > lim) { dx *= lim / d; dy *= lim / d; }
      stick.x = dx / lim; stick.y = dy / lim;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    let hideTimer = 0;
    const hideLater = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => stickEl.classList.remove('show'), 4000); };   // same pause as the autopilot
    const showAt = (x, y) => {   // under the finger, kept clear of the screen edges
      stickEl.style.left = Math.max(52, Math.min(window.innerWidth - 52, x)) + 'px';
      stickEl.style.top = Math.max(60, Math.min(window.innerHeight - 60, y)) + 'px';
      stickEl.classList.add('show'); hideLater();
    };
    stickEl.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); clearTimeout(hideTimer); stickEl.setPointerCapture(e.pointerId); stick.on = true; stickEl.classList.add('active'); hero.classList.add('driven'); cursor.on = false; move(e); });
    stickEl.addEventListener('pointermove', e => { if (stick.on) { e.stopPropagation(); move(e); } });
    const release = () => { stick.on = false; stick.x = stick.y = 0; stickEl.classList.remove('active'); knob.style.transform = ''; hideLater(); };
    stickEl.addEventListener('pointerup', release); stickEl.addEventListener('pointercancel', release);
    // a tap on the block (a touch that does not move, so scrolling is unaffected) summons the stick
    let tap = null;
    const onBand = e => { const b = band.getBoundingClientRect(); return e.clientY >= b.top && e.clientY <= b.bottom && !e.target.closest('a, button, .stick'); };
    hero.addEventListener('pointerdown', e => { tap = (e.pointerType === 'touch' && onBand(e)) ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
    hero.addEventListener('pointerup', e => {
      if (!tap || e.pointerType !== 'touch') return;
      if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 12 && performance.now() - tap.t < 500) showAt(e.clientX, e.clientY);
      tap = null;
    });
  }
  window.addEventListener('pointermove', place);
  window.addEventListener('pointerdown', place);
  window.addEventListener('pointerup', e => { if (e.pointerType === 'touch') cursor.on = false; });
  window.addEventListener('pointercancel', () => { cursor.on = false; });
  window.addEventListener('pointerleave', () => { cursor.on = false; });
  document.addEventListener('mouseleave', () => { cursor.on = false; });
  window.addEventListener('resize', resize);
  const settle = () => { measure(); placeEgg(); if (pageMode) resize(); };
  window.addEventListener('load', settle);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
  document.addEventListener('themechange', () => { readColours(); mapDrawnAt = -1; if (reduced) drawStatic(); });

  // driving: WASD always; arrow keys once the block has been clicked (Escape hands them back)
  const keyName = e => e.key.toLowerCase();
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = keyName(e);
    if (k === 'escape') { armed = false; keys.clear(); return; }
    const isArrow = k.startsWith('arrow');
    if (isArrow && !armed) return;
    if ((k.length === 1 && 'wasd'.includes(k)) || isArrow) {
      if (document.activeElement && /^(input|textarea|select)$/i.test(document.activeElement.tagName)) return;
      keys.add(k); if (isArrow) e.preventDefault();
      hero.classList.add('driven');
    }
  });
  window.addEventListener('keyup', e => keys.delete(keyName(e)));
  window.addEventListener('blur', () => keys.clear());
  hero.addEventListener('pointerdown', () => { armed = true; });
  document.addEventListener('pointerdown', e => { if (!hero.contains(e.target)) armed = false; });

  readColours();
  resize();
  if (showRoute) {   // debug: run the autopilot for a while and report how it drove
    window.lidarSim = sec => {
      let worst = Infinity, maxW = 0, prev = rover.heading;
      for (let t = 0; t < sec; t += 1 / 60) {
        step(1 / 60);
        for (const q of nodes) worst = Math.min(worst, Math.hypot(q.x - rover.x, q.y - rover.y) - R);
        maxW = Math.max(maxW, Math.abs(wrap(rover.heading - prev)) * 60); prev = rover.heading;
      }
      return { worstClearance: +worst.toFixed(1), maxTurnRate: +maxW.toFixed(2), goal: goalI };
    };
  }
  if (reduced) {
    spinT = HOLD + RAMP;
    window.addEventListener('scroll', drawStatic, { passive: true });
  } else {
    requestAnimationFrame(loop);
  }
})();
