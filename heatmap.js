/* ==========================================================================
 * Netscope — Wi-Fi Heatmap Planner
 * --------------------------------------------------------------------------
 * Interactive floor-plan simulator:
 *   - draw walls / glass / doors made of different materials
 *   - place access points (routers) and client devices (laptop / PC)
 *   - heatmap = best RSSI from any AP, using a log-distance path-loss model
 *     plus a fixed attenuation (dB) for every wall the straight line crosses
 *   - coverage contour per AP shows how walls shrink the ideal radius
 * Everything runs in the browser (canvas); the plan is saved in localStorage.
 * ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants & models
   * ------------------------------------------------------------------ */
  const PX = 30;                 // canvas pixels per metre
  const W = 1200, H = 720;       // canvas size  -> 40 m x 24 m
  const CELL = 8;                // heatmap cell size (px)
  const COLS = W / CELL, ROWS = H / CELL;
  const NOISE = -95;             // noise floor (dBm)
  const PL0 = { 2.4: 40, 5: 47 };// path loss at 1 m (dB) per band
  const STORE = 'netscope.heatmap.v1';

  const MATERIALS = {
    drywall:  { name: 'Drywall',             l24: 3,  l5: 4,  color: '#a8a29e', w: 5 },
    brick:    { name: 'Brick wall',          l24: 6,  l5: 9,  color: '#c2410c', w: 7 },
    concrete: { name: 'Concrete wall',       l24: 12, l5: 18, color: '#3f3f46', w: 9 },
    glass:    { name: 'Glass wall / window', l24: 2,  l5: 3,  color: '#38bdf8', w: 4 },
    gdoor:    { name: 'Glass door',          l24: 3,  l5: 4,  color: '#06b6d4', w: 6, door: true },
    wdoor:    { name: 'Wooden door',         l24: 4,  l5: 6,  color: '#b45309', w: 6, door: true },
    mdoor:    { name: 'Metal door',          l24: 15, l5: 22, color: '#475569', w: 6, door: true },
  };
  const AP_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6'];
  // [minimum RSSI, PHY rate Mbps] (approximate 2x2 client, 80 MHz on 5 GHz / 20 MHz on 2.4 GHz)
  const RATES = {
    5:   [[-50, 866], [-58, 650], [-63, 433], [-67, 325], [-72, 195], [-77, 117], [-82, 58], [-88, 13]],
    2.4: [[-50, 144], [-58, 130], [-63, 117], [-67, 86],  [-72, 58],  [-77, 29],  [-82, 13], [-88, 6.5]],
  };
  const QUALITY = [
    [-50, 'Excellent', '#059669'], [-60, 'Very good', '#10b981'], [-67, 'Good', '#65a30d'],
    [-72, 'Fair', '#d97706'], [-80, 'Weak', '#ea580c'], [-88, 'Very weak', '#dc2626'],
  ];
  const TOOLS = [
    { id: 'select', label: 'Select / Move', key: 'V', hint: 'Click to select, drag to move. Press Delete to remove the selected item.' },
    { id: 'wall',   label: 'Draw wall / door', key: 'W', hint: 'Drag to draw a segment (hold Shift for any angle). Draw a door on top of a wall to cut an opening in it.' },
    { id: 'ap',     label: 'Access point', key: 'A', hint: 'Click to place a Wi-Fi access point / router.' },
    { id: 'laptop', label: 'Laptop', key: 'L', hint: 'Click to place a laptop and see its signal status.' },
    { id: 'pc',     label: 'Desktop PC', key: 'P', hint: 'Click to place a desktop PC and see its signal status.' },
    { id: 'erase',  label: 'Eraser', key: 'E', hint: 'Click a wall, door, access point or device to delete it.' },
  ];

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const state = {
    walls: [], aps: [], devices: [],
    tool: 'select', mat: 'drywall', sel: null,
    n: 3.0, thr: -67, source: 'all',
    show: { heat: true, cover: true, labels: true, grid: true },
    seq: 1,
  };
  const nid = () => state.seq++;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lossOf = (w, band) => (band === 5 ? MATERIALS[w.mat].l5 : MATERIALS[w.mat].l24);
  const apColor = (ap) => AP_COLORS[(ap.ci || 0) % AP_COLORS.length];
  const hexA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  };
  const quality = (r) => {
    for (const [t, label, color] of QUALITY) if (r >= t) return { label, color };
    return { label: 'No signal', color: '#71717a' };
  };
  const phyRate = (r, band) => {
    for (const [t, v] of RATES[band]) if (r >= t) return v;
    return 0;
  };
  const nextName = (prefix, arr) => {
    let n = 1;
    while (arr.some((x) => x.name === `${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  };

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */
  function save() {
    try {
      const { walls, aps, devices, n, thr, source, show, seq } = state;
      localStorage.setItem(STORE, JSON.stringify({ walls, aps, devices, n, thr, source, show, seq }));
    } catch (e) { /* storage unavailable */ }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE));
      if (d && Array.isArray(d.walls)) {
        Object.assign(state, {
          walls: d.walls, aps: d.aps || [], devices: d.devices || [],
          n: d.n ?? 3, thr: d.thr ?? -67, source: d.source || 'all', seq: d.seq || 1,
        });
        Object.assign(state.show, d.show || {});
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Geometry & RF model
   * ------------------------------------------------------------------ */
  // Intersection of segment P->P+D (t in (0,1]) with wall w. Returns t or -1.
  function hitT(px, py, dx, dy, w) {
    const ex = w.b.x - w.a.x, ey = w.b.y - w.a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) return -1;
    const qx = w.a.x - px, qy = w.a.y - py;
    const t = (qx * ey - qy * ex) / den;
    const u = (qx * dy - qy * dx) / den;
    return (t > 1e-6 && t <= 1 && u >= 0 && u < 1) ? t : -1;
  }

  const baseLoss = (ap, d) => ap.power - PL0[ap.band] - 10 * state.n * Math.log10(Math.max(d, 1));

  // RSSI of `ap` at point (x,y) in metres. Optionally collects crossed walls.
  function rssi(ap, x, y, hits) {
    const dx = x - ap.x, dy = y - ap.y;
    const d = Math.hypot(dx, dy);
    let loss = 0;
    for (const w of state.walls) {
      const t = hitT(ap.x, ap.y, dx, dy, w);
      if (t > 0) {
        const L = lossOf(w, ap.band);
        loss += L;
        if (hits) hits.push({ w, t, x: ap.x + dx * t, y: ap.y + dy * t, loss: L });
      }
    }
    return baseLoss(ap, d) - loss;
  }

  // Ideal (free of walls) radius where RSSI == threshold
  const idealRadius = (ap) => Math.max(1, Math.pow(10, (ap.power - PL0[ap.band] - state.thr) / (10 * state.n)));

  // Cast rays around the AP: radius where RSSI drops below the threshold, with walls.
  function coverage(ap) {
    const RAYS = 180, MAXD = 80, STEP = 0.1;
    const pts = [];
    let sum = 0;
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      const hits = [];
      for (const w of state.walls) {
        const t = hitT(ap.x, ap.y, dx * MAXD, dy * MAXD, w);
        if (t > 0) hits.push([t * MAXD, lossOf(w, ap.band)]);
      }
      hits.sort((p, q) => p[0] - q[0]);
      let hi = 0, loss = 0, r = 0;
      for (let d = STEP; d <= MAXD; d += STEP) {
        while (hi < hits.length && hits[hi][0] <= d) loss += hits[hi++][1];
        if (baseLoss(ap, d) - loss < state.thr) break;
        r = d;
      }
      pts.push({ x: ap.x + dx * r, y: ap.y + dy * r });
      sum += r;
    }
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      area += p.x * q.y - q.x * p.y;
    }
    area = Math.abs(area) / 2;
    const R = idealRadius(ap);
    const ideal = Math.PI * R * R;
    return { pts, avg: sum / RAYS, area, R, ideal, cut: clamp(1 - area / ideal, 0, 1) };
  }

  function deviceStatus(dev) {
    let best = null;
    for (const ap of state.aps) {
      const hits = [];
      const r = rssi(ap, dev.x, dev.y, hits);
      if (!best || r > best.rssi) best = { ap, rssi: r, hits };
    }
    if (!best) return null;
    best.dist = Math.hypot(dev.x - best.ap.x, dev.y - best.ap.y);
    best.snr = best.rssi - NOISE;
    best.q = quality(best.rssi);
    best.phy = phyRate(best.rssi, best.ap.band);
    best.tput = Math.round(best.phy * 0.55);
    best.wallDb = best.hits.reduce((s, h) => s + h.loss, 0);
    return best;
  }

  function bestAt(x, y) {
    let best = null;
    for (const ap of state.aps) {
      const r = rssi(ap, x, y);
      if (best === null || r > best) best = r;
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * Editing helpers
   * ------------------------------------------------------------------ */
  // A door replaces the part of an existing collinear wall it covers.
  function trimUnder(a, b) {
    const eps = 0.12;
    const out = [];
    for (const w of state.walls) {
      if (MATERIALS[w.mat].door) { out.push(w); continue; }
      const ex = w.b.x - w.a.x, ey = w.b.y - w.a.y, len = Math.hypot(ex, ey);
      if (len < 1e-6) { out.push(w); continue; }
      const ux = ex / len, uy = ey / len;
      const da = Math.abs((a.x - w.a.x) * uy - (a.y - w.a.y) * ux);
      const db = Math.abs((b.x - w.a.x) * uy - (b.y - w.a.y) * ux);
      if (da > eps || db > eps) { out.push(w); continue; }
      let t1 = (a.x - w.a.x) * ux + (a.y - w.a.y) * uy;
      let t2 = (b.x - w.a.x) * ux + (b.y - w.a.y) * uy;
      if (t1 > t2) [t1, t2] = [t2, t1];
      const lo = Math.max(0, t1), hi = Math.min(len, t2);
      if (hi - lo < 0.05) { out.push(w); continue; }
      if (lo > 0.05) out.push({ ...w, id: nid(), a: { ...w.a }, b: { x: w.a.x + ux * lo, y: w.a.y + uy * lo } });
      if (len - hi > 0.05) out.push({ ...w, id: nid(), a: { x: w.a.x + ux * hi, y: w.a.y + uy * hi }, b: { ...w.b } });
    }
    state.walls = out;
  }

  function addWall(a, b, mat) {
    if (MATERIALS[mat].door) trimUnder(a, b);
    const w = { id: nid(), a: { ...a }, b: { ...b }, mat };
    state.walls.push(w);
    return w;
  }

  function snapPt(p, free, from) {
    let x = p.x, y = p.y;
    if (from && !free) {
      const dx = x - from.x, dy = y - from.y, t = Math.tan(12 * Math.PI / 180);
      if (Math.abs(dy) < Math.abs(dx) * t) y = from.y;
      else if (Math.abs(dx) < Math.abs(dy) * t) x = from.x;
    }
    x = Math.round(x * 4) / 4;
    y = Math.round(y * 4) / 4;
    let bd = 0.3, bp = null;
    for (const w of state.walls) {
      for (const pt of [w.a, w.b]) {
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < bd) { bd = d; bp = pt; }
      }
    }
    if (bp) { x = bp.x; y = bp.y; }
    return { x: clamp(x, 0, W / PX), y: clamp(y, 0, H / PX) };
  }

  function distPointSeg(p, a, b) {
    const ex = b.x - a.x, ey = b.y - a.y;
    const l2 = ex * ex + ey * ey;
    let t = l2 ? ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t));
  }

  function hitTest(p) {
    for (let i = state.devices.length - 1; i >= 0; i--) {
      const d = state.devices[i];
      if (Math.hypot((d.x - p.x) * PX, (d.y - p.y) * PX) <= 18) return { type: 'device', id: d.id };
    }
    for (let i = state.aps.length - 1; i >= 0; i--) {
      const a = state.aps[i];
      if (Math.hypot((a.x - p.x) * PX, (a.y - p.y) * PX) <= 16) return { type: 'ap', id: a.id };
    }
    let best = null, bd = 9;
    for (const w of state.walls) {
      const d = distPointSeg(p, w.a, w.b) * PX - (MATERIALS[w.mat].door ? 3 : 0);
      if (d < bd) { bd = d; best = w; }
    }
    return best ? { type: 'wall', id: best.id } : null;
  }

  const findItem = (s) => {
    if (!s) return null;
    const arr = s.type === 'wall' ? state.walls : s.type === 'ap' ? state.aps : state.devices;
    return arr.find((x) => x.id === s.id) || null;
  };

  function removeItem(s) {
    if (!s) return;
    if (s.type === 'wall') state.walls = state.walls.filter((x) => x.id !== s.id);
    if (s.type === 'ap') state.aps = state.aps.filter((x) => x.id !== s.id);
    if (s.type === 'device') state.devices = state.devices.filter((x) => x.id !== s.id);
    if (state.sel && state.sel.id === s.id && state.sel.type === s.type) setSel(null);
    dirtyGeo();
    save();
  }

  function loadSample() {
    state.walls = []; state.aps = []; state.devices = []; state.seq = 1; state.sel = null;
    const wl = (x1, y1, x2, y2, mat) => addWall({ x: x1, y: y1 }, { x: x2, y: y2 }, mat);
    // outer shell
    wl(3, 3, 37, 3, 'concrete'); wl(37, 3, 37, 21, 'concrete');
    wl(37, 21, 3, 21, 'concrete'); wl(3, 21, 3, 3, 'concrete');
    // corridor walls
    wl(3, 11, 37, 11, 'drywall'); wl(3, 13, 37, 13, 'drywall');
    // room dividers
    [13, 23].forEach((x) => { wl(x, 3, x, 11, 'drywall'); wl(x, 13, x, 21, 'drywall'); });
    wl(23, 3, 23, 11, 'brick'); wl(23, 13, 23, 21, 'brick');
    wl(30, 3, 30, 11, 'glass'); wl(30, 13, 30, 21, 'drywall');
    // doors (cut openings in the walls above)
    [[7, 8], [17, 18], [26, 27]].forEach(([a, b]) => {
      wl(a, 11, b, 11, 'wdoor'); wl(a, 13, b, 13, 'wdoor');
    });
    wl(33, 11, 34.5, 11, 'gdoor'); wl(33, 13, 34.5, 13, 'gdoor');
    wl(3, 11.25, 3, 12.75, 'gdoor');
    wl(37, 11.25, 37, 12.75, 'mdoor');
    state.aps.push({ id: nid(), x: 12, y: 12, name: 'AP-1', power: 20, band: 5, ci: 0 });
    state.aps.push({ id: nid(), x: 28, y: 12, name: 'AP-2', power: 20, band: 2.4, ci: 1 });
    state.devices.push({ id: nid(), x: 7, y: 6.5, name: 'Laptop-1', kind: 'laptop' });
    state.devices.push({ id: nid(), x: 33.5, y: 17, name: 'PC-1', kind: 'pc' });
    state.devices.push({ id: nid(), x: 18, y: 18, name: 'Laptop-2', kind: 'laptop' });
  }

  /* ------------------------------------------------------------------ *
   * DOM scaffolding
   * ------------------------------------------------------------------ */
  const css = `
    .tab-btn{padding:.4rem .95rem;border-radius:.6rem;font-size:.75rem;font-weight:600;color:#71717a;transition:all .2s ease}
    .tab-btn:hover{color:#18181b}
    .tab-btn[aria-selected="true"]{background:#fff;color:#18181b;box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px #e4e4e7}
    .hm-tool,.hm-mat{display:flex;align-items:center;gap:.5rem;width:100%;border:1px solid #e4e4e7;background:#fff;border-radius:.65rem;padding:.4rem .6rem;font-size:.75rem;font-weight:500;color:#3f3f46;transition:all .15s ease}
    .hm-tool:hover,.hm-mat:hover{background:#fafafa;border-color:#d4d4d8}
    .hm-tool[aria-pressed="true"]{background:#eef2ff;border-color:#c7d2fe;color:#4338ca}
    .hm-mat[aria-pressed="true"]{background:#f4f4f5;border-color:#a1a1aa;color:#18181b}
    .hm-input{width:100%;border:1px solid #e4e4e7;border-radius:.5rem;padding:.3rem .5rem;font-size:.75rem;background:#fff}
    .hm-label{display:block;margin:.55rem 0 .2rem;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#71717a}
    #hm-canvas{touch-action:none;display:block}
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const section = $('#view-heatmap');
  section.innerHTML = `
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 id="hm-title" class="text-lg font-semibold tracking-tight text-zinc-900">Wi-Fi Heatmap Planner</h2>
        <p class="text-xs text-zinc-500">Draw walls, glass and doors, place access points and devices, and see how the building changes the signal.</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button id="hm-sample" type="button" class="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">Load sample plan</button>
        <button id="hm-export" type="button" class="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">Export PNG</button>
        <button id="hm-clear" type="button" class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100">Clear all</button>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_320px]">
      <!-- LEFT: tools -->
      <aside class="space-y-4">
        <div class="card p-4">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Tools</h3>
          <div id="hm-tools" class="mt-3 grid gap-1.5"></div>
        </div>
        <div class="card p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Materials</h3>
            <span class="text-[10px] text-zinc-400">loss 2.4 / 5 GHz</span>
          </div>
          <div id="hm-materials" class="mt-3 grid gap-1.5"></div>
        </div>
        <div class="card p-4">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Model &amp; view</h3>
          <label class="hm-label" for="hm-n">Path-loss exponent <span id="hm-n-v" class="tabular text-zinc-800">3.0</span></label>
          <input id="hm-n" type="range" min="2" max="4" step="0.1" value="3" class="w-full accent-indigo-600" />
          <label class="hm-label" for="hm-thr">Coverage radius threshold</label>
          <select id="hm-thr" class="hm-input">
            <option value="-65">-65 dBm (excellent)</option>
            <option value="-67">-67 dBm (good, voice/video)</option>
            <option value="-70">-70 dBm (reliable data)</option>
            <option value="-75">-75 dBm (minimum)</option>
            <option value="-80">-80 dBm (edge)</option>
          </select>
          <label class="hm-label" for="hm-src">Heatmap source</label>
          <select id="hm-src" class="hm-input">
            <option value="all">All access points (best signal)</option>
            <option value="selected">Selected access point only</option>
          </select>
          <div class="mt-3 grid gap-1.5 text-xs text-zinc-700">
            <label class="flex items-center gap-2"><input id="hm-show-heat" type="checkbox" class="accent-indigo-600" /> Heatmap</label>
            <label class="flex items-center gap-2"><input id="hm-show-cover" type="checkbox" class="accent-indigo-600" /> Coverage radius (ideal vs real)</label>
            <label class="flex items-center gap-2"><input id="hm-show-labels" type="checkbox" class="accent-indigo-600" /> Labels &amp; wall losses</label>
            <label class="flex items-center gap-2"><input id="hm-show-grid" type="checkbox" class="accent-indigo-600" /> Grid</label>
          </div>
        </div>
      </aside>

      <!-- CENTER: canvas -->
      <div class="card p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-zinc-500">
          <span id="hm-hint"></span>
          <span id="hm-coords" class="font-mono tabular text-zinc-600">--</span>
        </div>
        <canvas id="hm-canvas" class="w-full rounded-xl border border-zinc-200 bg-white" aria-label="Floor plan canvas"></canvas>
        <div class="mt-3 flex flex-wrap items-center gap-3 px-1">
          <span class="text-[11px] font-medium text-zinc-500">Signal</span>
          <div class="flex-1 min-w-[200px]">
            <div id="hm-legend" class="h-2.5 rounded-full"></div>
            <div class="mt-1 flex justify-between font-mono text-[10px] text-zinc-400"><span>-90</span><span>-80</span><span>-70</span><span>-60</span><span>-50</span><span>-40</span><span>-30 dBm</span></div>
          </div>
          <span class="text-[10px] text-zinc-400">Dark = below -90 dBm (no usable signal)</span>
        </div>
      </div>

      <!-- RIGHT: info -->
      <aside class="space-y-4">
        <div class="card p-4">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Selected item</h3>
          <div id="hm-props" class="mt-3"></div>
        </div>
        <div class="card p-4">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Device status</h3>
          <div id="hm-devices" class="mt-3 space-y-3"></div>
        </div>
        <div class="card p-4">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Access point coverage</h3>
          <div id="hm-aps" class="mt-3 space-y-3"></div>
        </div>
        <div class="card p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Your real Wi-Fi</h3>
            <button id="hm-real-refresh" type="button" class="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 hover:bg-zinc-100">Refresh</button>
          </div>
          <div id="hm-real" class="mt-3 text-xs text-zinc-500">Loading...</div>
        </div>
      </aside>
    </div>`;

  const cv = $('#hm-canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.aspectRatio = `${W} / ${H}`;
  const ctx = cv.getContext('2d');

  /* ------------------------------------------------------------------ *
   * Heatmap rendering
   * ------------------------------------------------------------------ */
  const off = document.createElement('canvas');
  off.width = COLS; off.height = ROWS;
  const offCtx = off.getContext('2d');
  const img = offCtx.createImageData(COLS, ROWS);

  const hslToRgb = (h, s, l) => {
    h /= 360;
    const f = (n) => {
      const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const LUT = Array.from({ length: 61 }, (_, i) => hslToRgb((i / 60) * 125, 0.85, 0.5));
  const heatColor = (r) => {
    if (r < -90) return [30, 41, 59, 80];
    const v = clamp((r + 90) / 60, 0, 1);
    const c = LUT[Math.round(v * 60)];
    return [c[0], c[1], c[2], 150];
  };
  $('#hm-legend').style.background = 'linear-gradient(90deg,' +
    Array.from({ length: 7 }, (_, i) => `hsl(${(i / 6) * 125} 85% 50%)`).join(',') + ')';

  const heatAPs = () => {
    if (state.source === 'selected' && state.sel && state.sel.type === 'ap') {
      const a = findItem(state.sel);
      if (a) return [a];
    }
    return state.aps;
  };

  function buildHeat() {
    const aps = heatAPs();
    const data = img.data;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const x = (i + 0.5) * CELL / PX, y = (j + 0.5) * CELL / PX;
        let best = -200;
        for (const ap of aps) {
          const r = rssi(ap, x, y);
          if (r > best) best = r;
        }
        const c = heatColor(best), k = (j * COLS + i) * 4;
        data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = c[3];
      }
    }
    offCtx.putImageData(img, 0, 0);
  }

  /* ------------------------------------------------------------------ *
   * Canvas drawing
   * ------------------------------------------------------------------ */
  let geoDirty = true;
  let raf = 0;
  let covCache = new Map();
  let statuses = [];
  let drag = null;
  let hoverRssi = null;

  const dirtyGeo = () => { geoDirty = true; schedule(); };
  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  const rr = (x, y, w, h, r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  };

  function pill(lines, x, y, accent) {
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 12;
    const h = lines.length * 13 + 6;
    rr(x - w / 2, y, w, h, 6);
    ctx.fillStyle = 'rgba(255,255,255,.93)';
    ctx.fill();
    ctx.strokeStyle = accent || '#d4d4d8';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#27272a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((t, i) => {
      ctx.font = i === 0 ? '600 11px Inter, system-ui, sans-serif' : '500 10px Inter, system-ui, sans-serif';
      ctx.fillStyle = i === 0 ? '#27272a' : '#52525b';
      ctx.fillText(t, x, y + 4 + i * 13);
    });
  }

  function drawGrid() {
    ctx.lineWidth = 1;
    for (let m = 0; m <= W / PX; m++) {
      ctx.strokeStyle = m % 5 === 0 ? '#e4e4e7' : '#f4f4f5';
      ctx.beginPath(); ctx.moveTo(m * PX + 0.5, 0); ctx.lineTo(m * PX + 0.5, H); ctx.stroke();
    }
    for (let m = 0; m <= H / PX; m++) {
      ctx.strokeStyle = m % 5 === 0 ? '#e4e4e7' : '#f4f4f5';
      ctx.beginPath(); ctx.moveTo(0, m * PX + 0.5); ctx.lineTo(W, m * PX + 0.5); ctx.stroke();
    }
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '500 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let m = 5; m < W / PX; m += 5) ctx.fillText(`${m} m`, m * PX + 3, 2);
    for (let m = 5; m < H / PX; m += 5) ctx.fillText(`${m} m`, 3, m * PX + 2);
  }

  function strokeWall(w, extra) {
    const m = MATERIALS[w.mat];
    ctx.beginPath();
    ctx.moveTo(w.a.x * PX, w.a.y * PX);
    ctx.lineTo(w.b.x * PX, w.b.y * PX);
    ctx.lineCap = m.door ? 'butt' : 'round';
    ctx.setLineDash([]);
    if (extra) { ctx.strokeStyle = 'rgba(99,102,241,.35)'; ctx.lineWidth = m.w + 9; ctx.stroke(); }
    ctx.strokeStyle = m.color;
    ctx.lineWidth = m.w;
    ctx.stroke();
    if (m.door || w.mat === 'glass') {
      ctx.strokeStyle = m.door ? '#fff' : 'rgba(255,255,255,.75)';
      ctx.lineWidth = 1.5;
      if (m.door) ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawAP(ap) {
    const x = ap.x * PX, y = ap.y * PX, c = apColor(ap);
    const sel = state.sel && state.sel.type === 'ap' && state.sel.id === ap.id;
    if (sel) { ctx.beginPath(); ctx.arc(x, y, 21, 0, Math.PI * 2); ctx.fillStyle = hexA(c, 0.18); ctx.fill(); }
    ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = c; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(x, y + 5, 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.lineCap = 'round';
    [4.5, 8.5].forEach((r) => {
      ctx.beginPath(); ctx.arc(x, y + 5, r, -Math.PI * 0.8, -Math.PI * 0.2); ctx.stroke();
    });
    if (state.show.labels) pill([ap.name, `${ap.power} dBm · ${ap.band} GHz`], x, y + 17, c);
  }

  function drawDevice(dev, st) {
    const x = dev.x * PX, y = dev.y * PX;
    const q = st ? st.q : { label: 'No AP', color: '#71717a' };
    const sel = state.sel && state.sel.type === 'device' && state.sel.id === dev.id;
    ctx.beginPath(); ctx.arc(x, y, sel ? 21 : 18, 0, Math.PI * 2);
    ctx.fillStyle = hexA(q.color, sel ? 0.3 : 0.18); ctx.fill();
    ctx.strokeStyle = q.color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#1f2937';
    if (dev.kind === 'pc') {
      rr(x - 9, y - 10, 18, 13, 2); ctx.fill();
      ctx.fillStyle = q.color; ctx.fillRect(x - 7, y - 8, 14, 9);
      ctx.fillStyle = '#1f2937'; ctx.fillRect(x - 2, y + 3, 4, 4);
      rr(x - 6, y + 7, 12, 2.5, 1); ctx.fill();
    } else {
      rr(x - 8, y - 9, 16, 11, 2); ctx.fill();
      ctx.fillStyle = q.color; ctx.fillRect(x - 6, y - 7, 12, 7);
      ctx.fillStyle = '#6b7280'; rr(x - 11, y + 3, 22, 3.5, 1.5); ctx.fill();
    }
    if (state.show.labels) {
      pill([dev.name, st ? `${Math.round(st.rssi)} dBm · ${q.label}` : 'No access point'], x, y + 21, q.color);
    }
  }

  function draw() {
    raf = 0;
    if ($('#view-heatmap').classList.contains('hidden')) return;
    if (geoDirty) {
      if (state.aps.length) buildHeat();
      covCache = new Map();
      for (const ap of state.aps) covCache.set(ap.id, coverage(ap));
      geoDirty = false;
    }
    statuses = state.devices.map((d) => ({ d, s: deviceStatus(d) }));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    if (state.show.grid) drawGrid();

    if (state.show.heat && state.aps.length) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, 0, 0, W, H);
    }

    if (state.show.cover) {
      for (const ap of state.aps) {
        const cov = covCache.get(ap.id), c = apColor(ap);
        if (!cov) continue;
        // ideal radius (free space, no walls)
        ctx.beginPath(); ctx.arc(ap.x * PX, ap.y * PX, cov.R * PX, 0, Math.PI * 2);
        ctx.setLineDash([7, 6]); ctx.strokeStyle = hexA(c, 0.7); ctx.lineWidth = 1.5; ctx.stroke();
        ctx.setLineDash([]);
        // real coverage, after wall losses
        ctx.beginPath();
        cov.pts.forEach((p, i) => (i ? ctx.lineTo(p.x * PX, p.y * PX) : ctx.moveTo(p.x * PX, p.y * PX)));
        ctx.closePath();
        ctx.fillStyle = hexA(c, 0.07); ctx.fill();
        ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
      }
    }

    for (const w of state.walls) {
      strokeWall(w, state.sel && state.sel.type === 'wall' && state.sel.id === w.id);
    }
    ctx.lineCap = 'butt';

    // device -> AP links and the walls crossed on the way
    for (const { d, s } of statuses) {
      if (!s) continue;
      ctx.beginPath(); ctx.moveTo(d.x * PX, d.y * PX); ctx.lineTo(s.ap.x * PX, s.ap.y * PX);
      ctx.setLineDash([6, 5]); ctx.strokeStyle = s.q.color; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
      for (const h of s.hits) {
        ctx.beginPath(); ctx.arc(h.x * PX, h.y * PX, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = s.q.color; ctx.lineWidth = 2; ctx.stroke();
        if (state.show.labels) {
          ctx.font = '700 10px Inter, system-ui, sans-serif';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillStyle = '#18181b';
          ctx.fillText(`-${h.loss} dB`, h.x * PX + 7, h.y * PX - 8);
        }
      }
    }

    state.aps.forEach(drawAP);
    statuses.forEach(({ d, s }) => drawDevice(d, s));

    if (drag && drag.type === 'draw') {
      const m = MATERIALS[state.mat];
      ctx.beginPath(); ctx.moveTo(drag.a.x * PX, drag.a.y * PX); ctx.lineTo(drag.b.x * PX, drag.b.y * PX);
      ctx.strokeStyle = m.color; ctx.globalAlpha = 0.75; ctx.lineWidth = m.w; ctx.lineCap = 'round'; ctx.stroke();
      ctx.globalAlpha = 1;
      const len = Math.hypot(drag.b.x - drag.a.x, drag.b.y - drag.a.y);
      pill([`${len.toFixed(2)} m`], (drag.a.x + drag.b.x) / 2 * PX, (drag.a.y + drag.b.y) / 2 * PX + 10, m.color);
    }

    // scale bar
    ctx.strokeStyle = '#3f3f46'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(16, H - 16); ctx.lineTo(16 + 5 * PX, H - 16);
    ctx.moveTo(16, H - 21); ctx.lineTo(16, H - 11); ctx.moveTo(16 + 5 * PX, H - 21); ctx.lineTo(16 + 5 * PX, H - 11);
    ctx.stroke();
    ctx.fillStyle = '#3f3f46'; ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('5 m', 16 + 5 * PX + 6, H - 10);

    renderPanels();
  }

  /* ------------------------------------------------------------------ *
   * Side panels
   * ------------------------------------------------------------------ */
  const setHTML = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; } };

  function renderPanels() {
    // devices
    if (!statuses.length) {
      setHTML($('#hm-devices'), '<p class="text-xs text-zinc-400">Place a laptop or PC on the plan to see its signal status.</p>');
    } else {
      setHTML($('#hm-devices'), statuses.map(({ d, s }) => {
        const sel = state.sel && state.sel.type === 'device' && state.sel.id === d.id;
        const kind = d.kind === 'pc' ? 'Desktop PC' : 'Laptop';
        if (!s) {
          return `<div data-sel="device:${d.id}" class="cursor-pointer rounded-xl border ${sel ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-zinc-200'} p-3">
            <div class="text-sm font-semibold text-zinc-900">${esc(d.name)} <span class="text-[11px] font-normal text-zinc-400">${kind}</span></div>
            <p class="mt-1 text-xs text-zinc-500">No access point on the plan.</p></div>`;
        }
        const g = {};
        s.hits.forEach((h) => { const k = h.w.mat; g[k] = g[k] || { n: 0, db: 0 }; g[k].n++; g[k].db += h.loss; });
        const rows = Object.entries(g).map(([k, v]) =>
          `<li class="flex justify-between"><span>${v.n}× ${MATERIALS[k].name}</span><span class="tabular text-zinc-700">-${v.db} dB</span></li>`).join('');
        const pct = clamp(((s.rssi + 95) / 65) * 100, 2, 100);
        return `<div data-sel="device:${d.id}" class="cursor-pointer rounded-xl border ${sel ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-zinc-200'} p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-sm font-semibold text-zinc-900">${esc(d.name)} <span class="text-[11px] font-normal text-zinc-400">${kind}</span></span>
            <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold" style="background:${hexA(s.q.color, 0.14)};color:${s.q.color}">${s.q.label}</span>
          </div>
          <div class="mt-2 flex items-baseline gap-1"><span class="text-2xl font-semibold tabular text-zinc-900">${Math.round(s.rssi)}</span><span class="text-xs text-zinc-400">dBm</span></div>
          <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div class="h-full rounded-full" style="width:${pct}%;background:${s.q.color}"></div></div>
          <dl class="mt-3 grid grid-cols-2 gap-y-1 text-[11px]">
            <dt class="text-zinc-400">Connected to</dt><dd class="text-right font-medium text-zinc-700"><span class="mr-1 inline-block h-2 w-2 rounded-full" style="background:${apColor(s.ap)}"></span>${esc(s.ap.name)} · ${s.ap.band} GHz</dd>
            <dt class="text-zinc-400">SNR</dt><dd class="text-right tabular text-zinc-700">${Math.round(s.snr)} dB</dd>
            <dt class="text-zinc-400">Distance</dt><dd class="text-right tabular text-zinc-700">${s.dist.toFixed(1)} m</dd>
            <dt class="text-zinc-400">Walls crossed</dt><dd class="text-right tabular text-zinc-700">${s.hits.length} (-${s.wallDb} dB)</dd>
            <dt class="text-zinc-400">Link rate</dt><dd class="text-right tabular text-zinc-700">${s.phy ? s.phy + ' Mbps' : 'No link'}</dd>
            <dt class="text-zinc-400">Est. throughput</dt><dd class="text-right tabular text-zinc-700">${s.phy ? '~' + s.tput + ' Mbps' : '0 Mbps'}</dd>
          </dl>
          ${rows ? `<ul class="mt-2 space-y-0.5 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500">${rows}</ul>` : '<p class="mt-2 border-t border-zinc-100 pt-2 text-[11px] text-emerald-600">Clear line of sight, no walls in the way.</p>'}
        </div>`;
      }).join(''));
    }

    // access points
    if (!state.aps.length) {
      setHTML($('#hm-aps'), '<p class="text-xs text-zinc-400">Place an access point to see its radius and how walls affect it.</p>');
    } else {
      setHTML($('#hm-aps'), state.aps.map((ap) => {
        const c = covCache.get(ap.id);
        if (!c) return '';
        const sel = state.sel && state.sel.type === 'ap' && state.sel.id === ap.id;
        const keep = Math.round((1 - c.cut) * 100);
        return `<div data-sel="ap:${ap.id}" class="cursor-pointer rounded-xl border ${sel ? 'border-indigo-300 ring-2 ring-indigo-100' : 'border-zinc-200'} p-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold text-zinc-900"><span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-full" style="background:${apColor(ap)}"></span>${esc(ap.name)}</span>
            <span class="text-[11px] text-zinc-400">${ap.power} dBm · ${ap.band} GHz</span>
          </div>
          <dl class="mt-2 grid grid-cols-2 gap-y-1 text-[11px]">
            <dt class="text-zinc-400">Ideal radius (open space)</dt><dd class="text-right tabular text-zinc-700">${c.R.toFixed(1)} m</dd>
            <dt class="text-zinc-400">Real avg. radius</dt><dd class="text-right tabular font-semibold" style="color:${apColor(ap)}">${c.avg.toFixed(1)} m</dd>
            <dt class="text-zinc-400">Coverage kept</dt><dd class="text-right tabular text-zinc-700">${keep}%</dd>
          </dl>
          <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div class="h-full rounded-full" style="width:${keep}%;background:${apColor(ap)}"></div></div>
          <p class="mt-1.5 text-[10px] text-zinc-400">Walls &amp; doors remove ~${Math.round(c.cut * 100)}% of the ideal area at ${state.thr} dBm.</p>
        </div>`;
      }).join(''));
    }
  }

  function renderProps() {
    const el = $('#hm-props');
    const it = findItem(state.sel);
    if (!it) {
      el.innerHTML = '<p class="text-xs text-zinc-400">Click an item on the plan to edit it.</p>';
      return;
    }
    const del = '<button type="button" data-act="del" class="mt-3 w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100">Delete</button>';
    if (state.sel.type === 'ap') {
      el.innerHTML = `
        <div class="text-sm font-semibold text-zinc-900">Access point</div>
        <label class="hm-label" for="hm-p-name">Name</label>
        <input id="hm-p-name" data-f="name" class="hm-input" value="${esc(it.name)}" maxlength="24" />
        <label class="hm-label" for="hm-p-power">Transmit power <span id="hm-p-powerv" class="tabular text-zinc-800">${it.power} dBm</span></label>
        <input id="hm-p-power" data-f="power" type="range" min="5" max="30" step="1" value="${it.power}" class="w-full accent-indigo-600" />
        <label class="hm-label" for="hm-p-band">Band</label>
        <select id="hm-p-band" data-f="band" class="hm-input">
          <option value="2.4" ${it.band === 2.4 ? 'selected' : ''}>2.4 GHz (longer range, slower)</option>
          <option value="5" ${it.band === 5 ? 'selected' : ''}>5 GHz (faster, shorter range)</option>
        </select>${del}`;
    } else if (state.sel.type === 'device') {
      el.innerHTML = `
        <div class="text-sm font-semibold text-zinc-900">Device</div>
        <label class="hm-label" for="hm-p-name">Name</label>
        <input id="hm-p-name" data-f="name" class="hm-input" value="${esc(it.name)}" maxlength="24" />
        <label class="hm-label" for="hm-p-kind">Type</label>
        <select id="hm-p-kind" data-f="kind" class="hm-input">
          <option value="laptop" ${it.kind === 'laptop' ? 'selected' : ''}>Laptop</option>
          <option value="pc" ${it.kind === 'pc' ? 'selected' : ''}>Desktop PC</option>
        </select>${del}`;
    } else {
      const len = Math.hypot(it.b.x - it.a.x, it.b.y - it.a.y);
      el.innerHTML = `
        <div class="text-sm font-semibold text-zinc-900">${MATERIALS[it.mat].door ? 'Door' : 'Wall'} <span class="text-[11px] font-normal text-zinc-400">${len.toFixed(2)} m</span></div>
        <label class="hm-label" for="hm-p-mat">Material</label>
        <select id="hm-p-mat" data-f="mat" class="hm-input">
          ${Object.entries(MATERIALS).map(([k, m]) => `<option value="${k}" ${it.mat === k ? 'selected' : ''}>${m.name} (-${m.l24} / -${m.l5} dB)</option>`).join('')}
        </select>${del}`;
    }
  }

  function setSel(s) {
    state.sel = s;
    renderProps();
    if (state.source === 'selected') geoDirty = true;
    schedule();
  }

  /* ------------------------------------------------------------------ *
   * Toolbox
   * ------------------------------------------------------------------ */
  function renderTools() {
    $('#hm-tools').innerHTML = TOOLS.map((t) =>
      `<button type="button" class="hm-tool" data-tool="${t.id}" aria-pressed="${state.tool === t.id}">
         <span class="flex-1 text-left">${t.label}</span>
         <kbd class="rounded border border-zinc-200 bg-zinc-50 px-1.5 text-[10px] text-zinc-500">${t.key}</kbd>
       </button>`).join('');
    $('#hm-materials').innerHTML = Object.entries(MATERIALS).map(([k, m]) =>
      `<button type="button" class="hm-mat" data-mat="${k}" aria-pressed="${state.mat === k}">
         <span class="h-2.5 w-6 shrink-0 rounded-full" style="background:${m.color}"></span>
         <span class="flex-1 text-left">${m.name}</span>
         <span class="tabular text-[10px] text-zinc-400">-${m.l24}/-${m.l5}</span>
       </button>`).join('');
    $('#hm-hint').textContent = TOOLS.find((t) => t.id === state.tool).hint;
    cv.style.cursor = state.tool === 'select' ? 'default' : state.tool === 'erase' ? 'pointer' : 'crosshair';
  }

  function setTool(id) {
    state.tool = id;
    drag = null;
    renderTools();
    schedule();
  }

  /* ------------------------------------------------------------------ *
   * Pointer & keyboard interaction
   * ------------------------------------------------------------------ */
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width) / PX, y: (e.clientY - r.top) * (H / r.height) / PX };
  };
  const inPlan = (p) => ({ x: clamp(Math.round(p.x * 20) / 20, 0, W / PX), y: clamp(Math.round(p.y * 20) / 20, 0, H / PX) });

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = pos(e);
    cv.setPointerCapture(e.pointerId);
    const t = state.tool;

    if (t === 'wall') {
      const s = snapPt(p, true, null);
      drag = { type: 'draw', a: s, b: s };
    } else if (t === 'ap') {
      const q = inPlan(p);
      const ap = { id: nid(), x: q.x, y: q.y, name: nextName('AP', state.aps), power: 20, band: 5, ci: state.aps.length };
      state.aps.push(ap);
      setSel({ type: 'ap', id: ap.id });
      dirtyGeo(); save();
    } else if (t === 'laptop' || t === 'pc') {
      const q = inPlan(p);
      const dev = { id: nid(), x: q.x, y: q.y, kind: t, name: nextName(t === 'pc' ? 'PC' : 'Laptop', state.devices) };
      state.devices.push(dev);
      setSel({ type: 'device', id: dev.id });
      schedule(); save();
    } else if (t === 'erase') {
      const h = hitTest(p);
      if (h) removeItem(h);
    } else {
      const h = hitTest(p);
      setSel(h);
      if (h) {
        const it = findItem(h);
        if (h.type === 'wall') {
          drag = { type: 'wmove', w: it, start: snapPt(p, true, null), a0: { ...it.a }, b0: { ...it.b } };
        } else {
          drag = { type: 'move', item: it, kind: h.type, ox: it.x - p.x, oy: it.y - p.y };
        }
      }
    }
  });

  cv.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (!drag) {
      const r = state.aps.length ? bestAt(p.x, p.y) : null;
      hoverRssi = r;
      $('#hm-coords').textContent = `${p.x.toFixed(1)} m, ${p.y.toFixed(1)} m` + (r !== null ? ` · signal here ${Math.round(r)} dBm` : '');
      return;
    }
    if (drag.type === 'draw') {
      drag.b = snapPt(p, e.shiftKey, drag.a);
      schedule();
    } else if (drag.type === 'move') {
      const q = inPlan({ x: p.x + drag.ox, y: p.y + drag.oy });
      drag.item.x = q.x; drag.item.y = q.y;
      if (drag.kind === 'ap') geoDirty = true;
      schedule();
    } else if (drag.type === 'wmove') {
      const s = snapPt(p, true, null);
      const dx = s.x - drag.start.x, dy = s.y - drag.start.y;
      drag.w.a = { x: drag.a0.x + dx, y: drag.a0.y + dy };
      drag.w.b = { x: drag.b0.x + dx, y: drag.b0.y + dy };
      geoDirty = true;
      schedule();
    }
  });

  const endDrag = () => {
    if (!drag) return;
    if (drag.type === 'draw') {
      const len = Math.hypot(drag.b.x - drag.a.x, drag.b.y - drag.a.y);
      if (len >= 0.3) { addWall(drag.a, drag.b, state.mat); geoDirty = true; }
    }
    if (drag.type === 'wmove') renderProps();
    drag = null;
    save();
    schedule();
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', () => { drag = null; schedule(); });

  document.addEventListener('keydown', (e) => {
    if ($('#view-heatmap').classList.contains('hidden')) return;
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'delete' || k === 'backspace') { if (state.sel) { removeItem(state.sel); e.preventDefault(); } return; }
    if (k === 'escape') { drag = null; setSel(null); return; }
    const t = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (t && !e.ctrlKey && !e.metaKey) setTool(t.id);
  });

  /* ------------------------------------------------------------------ *
   * UI wiring
   * ------------------------------------------------------------------ */
  section.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-tool]');
    if (tool) { setTool(tool.dataset.tool); return; }
    const mat = e.target.closest('[data-mat]');
    if (mat) { state.mat = mat.dataset.mat; if (state.tool !== 'wall') state.tool = 'wall'; renderTools(); return; }
    const selEl = e.target.closest('[data-sel]');
    if (selEl) { const [type, id] = selEl.dataset.sel.split(':'); setSel({ type, id: +id }); return; }
    if (e.target.closest('[data-act="del"]')) removeItem(state.sel);
  });

  $('#hm-props').addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    const it = findItem(state.sel);
    if (!f || !it) return;
    if (f === 'name') it.name = e.target.value.slice(0, 24);
    if (f === 'power') { it.power = +e.target.value; $('#hm-p-powerv').textContent = `${it.power} dBm`; geoDirty = true; }
    if (f === 'band') { it.band = +e.target.value; geoDirty = true; }
    if (f === 'mat') { it.mat = e.target.value; geoDirty = true; }
    if (f === 'kind') it.kind = e.target.value;
    save();
    schedule();
  });

  $('#hm-n').addEventListener('input', (e) => {
    state.n = +e.target.value;
    $('#hm-n-v').textContent = state.n.toFixed(1);
    dirtyGeo(); save();
  });
  $('#hm-thr').addEventListener('change', (e) => { state.thr = +e.target.value; dirtyGeo(); save(); });
  $('#hm-src').addEventListener('change', (e) => { state.source = e.target.value; dirtyGeo(); save(); });
  ['heat', 'cover', 'labels', 'grid'].forEach((k) => {
    $(`#hm-show-${k}`).addEventListener('change', (e) => { state.show[k] = e.target.checked; schedule(); save(); });
  });

  $('#hm-sample').addEventListener('click', () => { loadSample(); syncControls(); renderProps(); dirtyGeo(); save(); });
  $('#hm-clear').addEventListener('click', () => {
    if (!confirm('Remove every wall, access point and device from the plan?')) return;
    state.walls = []; state.aps = []; state.devices = []; state.sel = null;
    renderProps(); dirtyGeo(); save();
  });
  $('#hm-export').addEventListener('click', () => {
    cv.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'netscope-heatmap.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  });

  function syncControls() {
    $('#hm-n').value = state.n;
    $('#hm-n-v').textContent = (+state.n).toFixed(1);
    $('#hm-thr').value = String(state.thr);
    $('#hm-src').value = state.source;
    ['heat', 'cover', 'labels', 'grid'].forEach((k) => { $(`#hm-show-${k}`).checked = !!state.show[k]; });
  }

  /* ------------------------------------------------------------------ *
   * Real Wi-Fi comparison (from the Flask backend)
   * ------------------------------------------------------------------ */
  async function fetchReal() {
    const el = $('#hm-real');
    const base = location.protocol === 'file:' ? 'http://127.0.0.1:5000' : '';
    try {
      const r = await fetch(`${base}/api/wifi/current`);
      const w = await r.json();
      if (!w.connected) { el.textContent = 'This computer is not connected to Wi-Fi.'; return; }
      const q = quality(w.signal_dbm);
      el.innerHTML = `
        <div class="flex items-baseline gap-1"><span class="text-2xl font-semibold tabular text-zinc-900">${w.signal_dbm}</span><span class="text-xs text-zinc-400">dBm</span>
          <span class="ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold" style="background:${hexA(q.color, 0.14)};color:${q.color}">${q.label}</span></div>
        <p class="mt-1 text-zinc-600">${esc(w.ssid)} · ${esc(w.band)} · channel ${w.channel} · ${w.signal_percent}%</p>
        <p class="mt-1 text-[10px] text-zinc-400">Place a device on the plan where you are sitting and compare its simulated dBm with this real value; adjust the path-loss exponent until they match.</p>`;
    } catch (err) {
      el.textContent = 'Backend not reachable. Start app.py to read your real signal.';
    }
  }
  $('#hm-real-refresh').addEventListener('click', fetchReal);

  /* ------------------------------------------------------------------ *
   * Tabs
   * ------------------------------------------------------------------ */
  function showTab(name) {
    const hm = name === 'heatmap';
    $('#view-dashboard').classList.toggle('hidden', hm);
    $('#view-heatmap').classList.toggle('hidden', !hm);
    $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    try { history.replaceState(null, '', hm ? '#heatmap' : '#dashboard'); } catch (e) { /* file:// */ }
    if (hm) { geoDirty = true; schedule(); fetchReal(); }
  }
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */
  function init() {
    if (!load()) loadSample();
    syncControls();
    renderTools();
    renderProps();
    showTab(location.hash === '#heatmap' ? 'heatmap' : 'dashboard');
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
