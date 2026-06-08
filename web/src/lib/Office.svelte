<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { paintFigure } from './avatars/desk.js';
  import { animations } from './stores.js';
  import AgentModal from './AgentModal.svelte';

  // Optional agents prop — if provided, we prefer it over self-polling.
  let { agents: agentsProp = null } = $props();

  let polled = $state([]); // self-polled agents
  let canvas; // bound <canvas>
  let wrap; // bound container

  // Live agent list: prefer the prop, else our poll.
  let agents = $derived(
    Array.isArray(agentsProp) && agentsProp.length >= 0 && agentsProp !== null
      ? agentsProp
      : polled
  );

  // ── self-poll /api/state every ~600ms (only matters when no prop given) ──
  async function poll() {
    if (Array.isArray(agentsProp)) return; // prop drives the scene
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      if (d && Array.isArray(d.agents)) polled = d.agents;
    } catch (_) {
      /* keep last scene on failure */
    }
  }

  // ── persistent per-desk visual state, keyed by agent id ──
  // { x,y (current), tx,ty (target), seed, walk:{...}|null, nextWalkAt }
  const desks = new Map();

  // deterministic pseudo-random from a string id (stable per id)
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296; // 0..1
  }

  function getDesk(id) {
    let d = desks.get(id);
    if (!d) {
      const s = hash(String(id));
      d = {
        x: null, y: null, tx: 0, ty: 0,
        seed: s, phase: s * Math.PI * 2,
        walk: null, nextWalkAt: 0,
      };
      desks.set(id, d);
    }
    return d;
  }

  // ── build the tree from the flat agent list ──
  function buildTree(list) {
    const byId = new Map(list.map((a) => [a.id, a]));
    // roots: agents flagged root, or with no resolvable parent in the set
    const roots = list.filter((a) => a.root || !a.parentId || !byId.has(a.parentId));
    const children = new Map(); // rootId -> [subagents]
    for (const a of list) {
      if (a.root || !a.parentId || !byId.has(a.parentId)) continue;
      // climb to the owning root
      let p = a, guard = 0;
      while (p && p.parentId && byId.has(p.parentId) && !p.root && guard++ < 32) {
        p = byId.get(p.parentId);
      }
      const rootId = p ? p.id : a.parentId;
      if (!children.has(rootId)) children.set(rootId, []);
      children.get(rootId).push(a);
    }
    return { roots, children };
  }

  const ACTIVE = new Set(['spawning', 'coding', 'reading', 'thinking', 'testing']);
  // hex (#rrggbb / #rgb) -> rgba string with alpha, for activity glows
  function hexA(hex, a) {
    const h = (hex || '#888888').replace('#', '');
    const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ── circuit-board (octilinear) routing ──
  // Parent→child trace runs in the empty lanes (hallways): down to a horizontal
  // trunk under the root, across to the gutter LEFT of the worker's cubicle, down
  // that gutter, then a short jog into the worker — never down through the column.
  const LANE = 35; // px left of a worker's centre → its column gutter
  function connRoute(px, py, cx, cy) {
    const trunkY = py + 46;
    const laneX = cx - LANE;
    const pts = [{ x: px, y: py }, { x: px, y: trunkY }];
    if (Math.abs(laneX - px) > 2) pts.push({ x: laneX, y: trunkY });
    pts.push({ x: laneX, y: cy });
    if (Math.abs(cx - laneX) > 1) pts.push({ x: cx, y: cy });
    return pts;
  }
  // Generic octilinear elbow between any two points: straight on the long axis, then 45°.
  function octElbow(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, adx = Math.abs(dx), ady = Math.abs(dy);
    const sx = Math.sign(dx), sy = Math.sign(dy), diag = Math.min(adx, ady);
    const pts = [{ x: x1, y: y1 }];
    if (adx > ady) pts.push({ x: x1 + sx * (adx - diag), y: y1 });
    else if (ady > adx) pts.push({ x: x1, y: y1 + sy * (ady - diag) });
    pts.push({ x: x2, y: y2 });
    return pts;
  }
  // Issue a path with 45° chamfered corners (no right angles) — the circuit look.
  function tracePath(ctx, pts, r) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], p = pts[i], b = pts[i + 1];
      const inLen = Math.hypot(p.x - a.x, p.y - a.y) || 1;
      const outLen = Math.hypot(b.x - p.x, b.y - p.y) || 1;
      const rr = Math.min(r, inLen / 2, outLen / 2);
      ctx.lineTo(p.x - (p.x - a.x) / inLen * rr, p.y - (p.y - a.y) / inLen * rr);
      ctx.lineTo(p.x + (b.x - p.x) / outLen * rr, p.y + (b.y - p.y) / outLen * rr);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  // Point at fraction [0..1] along a polyline.
  function polyPos(pts, frac) {
    const segs = []; let total = 0;
    for (let i = 0; i < pts.length - 1; i++) { const L = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); segs.push(L); total += L; }
    let d = Math.max(0, Math.min(1, frac)) * total;
    for (let i = 0; i < segs.length; i++) { if (d <= segs[i] || i === segs.length - 1) { const k = segs[i] ? d / segs[i] : 0; return { x: lerp(pts[i].x, pts[i + 1].x, k), y: lerp(pts[i].y, pts[i + 1].y, k) }; } d -= segs[i]; }
    return pts[pts.length - 1];
  }
  const PHRASES = ['hi', 'how are you?', 'gotta run', "where's the TPS report?", 'haha', 'coffee?', 'busy day',
    'nice work', 'ugh, bugs', 'lunch?', 'did you see that?', 'on it 👍', 'morning!', 'so close', 'standup?'];

  // ── layout: CUBICLES — each orchestrator leads a tidy grid of its sub-agents.
  // Team blocks flow left→right and wrap; everything is framed by Fit.
  function layout(tree, W, H) {
    const { roots, children } = tree;
    const CELLW = 92, CELLH = 84, ROOTH = 94, PADX = 46, PADY = 40, GAP = 38;
    const maxCols = Math.max(1, Math.floor((W - 2 * PADX) / CELLW));
    let curX = PADX, curY = PADY, bandH = 0;

    roots.forEach((root) => {
      const subs = children.get(root.id) || [];
      const m = subs.length;
      // a roughly-square grid, a touch wider than tall, capped to the viewport
      const cols = m ? Math.min(maxCols, Math.max(1, Math.round(Math.sqrt(m) * 1.3))) : 1;
      const rows = m ? Math.ceil(m / cols) : 0;
      const blockW = Math.max(CELLW, cols * CELLW);
      const blockH = ROOTH + rows * CELLH;

      // wrap to a new band when this team would overflow the row
      if (curX + blockW > W - PADX && curX > PADX) { curX = PADX; curY += bandH + GAP; bandH = 0; }

      // orchestrator centred above its cubicle grid
      const rd = getDesk(root.id);
      const rootX = curX + blockW / 2, rootY = curY + ROOTH / 2;
      rd.tx = rootX; rd.ty = rootY; rd.isRoot = true; rd.homeX = rootX; rd.homeY = rootY;

      subs.forEach((sub, j) => {
        const col = j % cols, row = Math.floor(j / cols);
        // centre the (possibly short) final row under the block
        const rowCount = (row === rows - 1) ? (m - row * cols) : cols;
        const x0 = curX + (blockW - rowCount * CELLW) / 2;
        const sd = getDesk(sub.id);
        sd.tx = x0 + col * CELLW + CELLW / 2;
        sd.ty = curY + ROOTH + row * CELLH + CELLH / 2;
        sd.isRoot = false; sd.homeX = sd.tx; sd.homeY = sd.ty; sd.parentDeskId = root.id;
      });

      curX += blockW + GAP;
      bandH = Math.max(bandH, blockH);
    });
  }

  // ── canvas sizing (DPR aware) ──
  let dpr = 1, cssW = 0, cssH = 0;
  function resize() {
    if (!canvas || !wrap) return;
    dpr = window.devicePixelRatio || 1;
    cssW = wrap.clientWidth || 800;
    cssH = wrap.clientHeight || 600;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
  }

  // ── drawing helpers ──
  function lerp(a, b, t) { return a + (b - a) * t; }

  // top-down person at a desk
  function drawPerson(ctx, x, y, scale, color, name, t, phase, walking) {
    const breathe = Math.sin(t * 1.6 + phase) * 1.2 * scale;
    const sway = walking ? Math.sin(t * 12) * 2.5 * scale : 0;
    ctx.save();
    ctx.translate(x, y + breathe);

    if (!walking) {
      // laptop in front of the person (top-down: a small rectangle)
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(-9 * scale, 8 * scale, 18 * scale, 9 * scale);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(-8 * scale, 9 * scale, 16 * scale, 7 * scale);
      ctx.globalAlpha = 1;
    }

    // shoulders (top-down ellipse)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(sway, 0, 11 * scale, 8 * scale, 0, 0, Math.PI * 2);
    ctx.fill();

    // arms reaching toward laptop (or swinging when walking)
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * scale;
    ctx.lineCap = 'round';
    const armSwing = walking ? Math.sin(t * 12) * 4 * scale : 0;
    ctx.beginPath();
    ctx.moveTo(-7 * scale + sway, 2 * scale);
    ctx.lineTo(-9 * scale + sway, (walking ? 6 : 11) * scale + armSwing);
    ctx.moveTo(7 * scale + sway, 2 * scale);
    ctx.lineTo(9 * scale + sway, (walking ? 6 : 11) * scale - armSwing);
    ctx.stroke();

    // head + hair (top-down circle)
    ctx.fillStyle = '#2b2b30';
    ctx.beginPath();
    ctx.arc(sway, -1 * scale, 7 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8c9a8';
    ctx.beginPath();
    ctx.arc(sway, -2 * scale, 4.5 * scale, 0, Math.PI * 2); // crown of head
    ctx.fill();

    // state ring
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * scale;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(sway, 0, 14 * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();

    // name label below
    ctx.fillStyle = 'rgba(120,120,130,0.95)';
    ctx.font = `${Math.round(10 * Math.max(0.85, scale))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const lbl = name && name.length > 16 ? name.slice(0, 15) + '…' : name || '';
    ctx.fillText(lbl, x, y + 30 * scale);
  }

  // Water cooler drawn UPRIGHT (front view) — bottle on a dispenser, like the
  // real thing. (x, y) is the bottom-centre of the base.
  function drawCooler(ctx, x, y) {
    const rr = (rx, ry, w, h, r) => { ctx.beginPath(); ctx.roundRect(rx, ry, w, h, r); ctx.fill(); };
    const baseW = 26, baseH = 20, bx = x - baseW / 2, by = y - baseH;
    // dispenser body
    ctx.fillStyle = '#cfd3da'; rr(bx, by, baseW, baseH, 4);
    ctx.fillStyle = '#e4e7ec'; rr(bx + 6, by, baseW - 12, baseH, 1);          // lighter centre panel
    ctx.fillStyle = '#9aa3af'; rr(bx + 4, by + 5, baseW - 8, baseH - 8, 3);   // recessed panel
    // taps (hot red / cold blue)
    ctx.fillStyle = '#ef4444'; rr(x - 6.2, by + 6, 2.4, 4, 1);
    ctx.fillStyle = '#f87171'; rr(x - 8, by + 9.5, 6, 4, 1.5);
    ctx.fillStyle = '#38bdf8'; rr(x + 3.8, by + 6, 2.4, 4, 1);
    ctx.fillStyle = '#7dd3fc'; rr(x + 2, by + 9.5, 6, 4, 1.5);
    // neck/cap
    ctx.fillStyle = '#aab1bc'; rr(x - 5, by - 4, 10, 5, 2);
    // bottle (upright, rounded top)
    const botW = 18, botH = 22, btx = x - botW / 2, bty = by - 4 - botH;
    ctx.fillStyle = '#9fe3fb'; rr(btx, bty, botW, botH, 7);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; rr(btx + 3, bty + 3, 4, botH - 8, 2); // water sheen
    ctx.fillStyle = 'rgba(56,189,248,0.35)'; rr(btx + botW - 6, bty + 4, 4, botH - 8, 2);
    // label
    ctx.fillStyle = 'rgba(130,130,140,0.85)';
    ctx.font = '8px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('water', x, y + 9);
  }

  // Potted plant (upright) with a gentle leaf sway. (x, y) = bottom of the pot.
  function drawPlant(ctx, x, y, t, seed) {
    ctx.fillStyle = '#b06a43';
    ctx.beginPath(); ctx.moveTo(x - 6, y - 9); ctx.lineTo(x + 6, y - 9); ctx.lineTo(x + 4.5, y); ctx.lineTo(x - 4.5, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#9c5b38'; ctx.beginPath(); ctx.roundRect(x - 7, y - 11.5, 14, 4, 1.5); ctx.fill();      // rim
    ctx.fillStyle = '#5b3a26'; ctx.beginPath(); ctx.ellipse(x, y - 9.5, 5.5, 1.8, 0, 0, Math.PI * 2); ctx.fill(); // soil
    const sway = Math.sin(t * 0.03 + seed * 6) * 1.5;
    const leaves = [[-5, -17, 5.5, '#2f8f4e'], [5, -16, 5.5, '#3aa55c'], [0, -23, 6.5, '#37a258'], [-2, -13, 4.5, '#2b7d45'], [3, -20, 4.5, '#46b766']];
    for (const [dx, dy, r, col] of leaves) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(x + dx + sway * (-dy / 23), y + dy, r * 0.82, r, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  // A few decorations around the floor edges (away from the desk cluster).
  function drawDecor(ctx, W, H, t) {
    drawPlant(ctx, W - 30, 44, t, 0.2);
    drawPlant(ctx, W - 38, H - 40, t, 0.7);
    drawPlant(ctx, W * 0.6, H - 34, t, 0.45);
  }

  // Small speech bubble with text (for casual peer chats).
  function drawTextBubble(ctx, x, y, text) {
    ctx.save();
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    const w = Math.max(22, ctx.measureText(text).width + 12), h = 15, bx = x - w / 2, by = y - 32;
    ctx.fillStyle = 'rgba(255,255,255,0.97)'; ctx.strokeStyle = 'rgba(0,0,0,0.14)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(bx, by, w, h, 6); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 3, by + h); ctx.lineTo(x, by + h + 5); ctx.lineTo(x + 3, by + h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#374151'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, by + h / 2 + 0.5);
    ctx.restore();
  }

  function drawBubble(ctx, x, y, scale) {
    ctx.save();
    ctx.translate(x + 16 * scale, y - 18 * scale);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    const w = 26 * scale, h = 16 * scale, r = 5 * scale;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + r, -h / 2);
    ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
    ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
    ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
    ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
    ctx.closePath();
    ctx.moveTo(-w / 4, h / 2);
    ctx.lineTo(-w / 4 - 4 * scale, h / 2 + 6 * scale);
    ctx.lineTo(-w / 8, h / 2);
    ctx.fill();
    ctx.stroke();
    // three dots
    ctx.fillStyle = '#555';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc((-7 + i * 7) * scale, 0, 1.6 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── animation loop ──
  let raf = 0;
  let frameN = 0;
  let walkStagger = 0; // global throttle so they don't all move at once

  // ── pan / zoom (applied to the canvas transform) ──
  let zoom = $state(1), panX = $state(0), panY = $state(0), dragging = $state(false);
  let autoFitted = false;
  let drag = null;
  let selectedId = $state(null);   // clicked agent → modal
  let hitTargets = [];             // {id,x,y,r} in world coords, rebuilt each frame
  let down = null;                 // pointerdown pos, to tell a click from a drag
  const zclamp = (v) => Math.max(0.3, Math.min(3, v));
  function zoomAt(sx, sy, nz) {
    nz = zclamp(nz);
    const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
    panX = sx - wx * nz; panY = sy - wy * nz; zoom = nz;
  }
  function zoomBy(f) { if (canvas) { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, zoom * f); } }
  function fitView() {
    const ds = Array.from(desks.values()).filter((d) => d.homeX != null);
    if (!ds.length || !cssW || !cssH) { zoom = 1; panX = 0; panY = 0; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of ds) { minX = Math.min(minX, d.homeX); maxX = Math.max(maxX, d.homeX); minY = Math.min(minY, d.homeY); maxY = Math.max(maxY, d.homeY); }
    const pad = 80;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const z = Math.min(cssW / bw, cssH / bh, 1.5);
    zoom = z; panX = (cssW - bw * z) / 2 - minX * z; panY = (cssH - bh * z) / 2 - minY * z;
  }
  function onWheel(e) { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, zoom * (e.deltaY < 0 ? 1.12 : 0.89)); }
  function onPointerDown(e) {
    if (e.target.closest && e.target.closest('.zoomctl')) return;
    dragging = true; down = { x: e.clientX, y: e.clientY };
    drag = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) { if (dragging && drag) { panX = drag.px + (e.clientX - drag.x); panY = drag.py + (e.clientY - drag.y); } }
  function onPointerUp(e) {
    if (down && e && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) handleClick(e); // a click, not a drag
    dragging = false; drag = null; down = null;
  }
  function handleClick(e) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const wx = (e.clientX - rect.left - panX) / zoom, wy = (e.clientY - rect.top - panY) / zoom;
    let best = null, bestD = Infinity;
    for (const h of hitTargets) { const dd = Math.hypot(h.x - wx, h.y - wy); if (dd < h.r && dd < bestD) { best = h; bestD = dd; } }
    if (best) selectedId = best.id;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    frameN++;
    const ctx = canvas && canvas.getContext('2d');
    if (!ctx) return;
    const t = now / 1000;
    const W = cssW, H = cssH;

    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
      hitTargets = [];

      // faint floor grid
      ctx.strokeStyle = 'rgba(140,140,150,0.07)';
      ctx.lineWidth = 1;
      const g = 60;
      for (let gx = 0; gx < W; gx += g) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      for (let gy = 0; gy < H; gy += g) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

      const list = agents || [];
      const tree = buildTree(list);
      layout(tree, W, H);
      // frame everything once on first population so a big team isn't off-screen
      if (!autoFitted && desks.size && Array.from(desks.values()).some((d) => d.homeX != null)) { fitView(); autoFitted = true; }
      const cooler = { x: 42, y: H - 44 }; // break destination (bottom-left)

      // prune desks for agents that vanished
      const live = new Set(list.map((a) => a.id));
      for (const k of desks.keys()) if (!live.has(k)) desks.delete(k);

      // ── circuit traces from each orchestrator to its sub-agents ──
      // Octilinear (H/V + 45° corners) routed through a horizontal trunk under the
      // root, so same-column workers share a vertical bus — like a PCB.
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const root of tree.roots) {
        const pd = desks.get(root.id);
        if (!pd || pd.homeX == null) continue;
        for (const sub of tree.children.get(root.id) || []) {
          const sd = desks.get(sub.id);
          if (!sd || sd.homeX == null) continue;
          const pts = connRoute(pd.homeX, pd.homeY, sd.homeX, sd.homeY);
          const col = STATE_COLORS[sub.state] || '#8891a0';
          // faint solder-mask under-trace
          tracePath(ctx, pts, 11);
          ctx.strokeStyle = 'rgba(150,160,185,0.10)'; ctx.lineWidth = 7; ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.stroke();
          // animated dashed trace, tinted by the sub's state, flowing parent→child
          tracePath(ctx, pts, 11);
          ctx.globalAlpha = 0.55; ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.setLineDash([5, 5]); ctx.lineDashOffset = -(frameN * 0.5) % 10; ctx.stroke();
          ctx.setLineDash([]);
          // solder pads (vias): at the child end and where the drop meets the trunk
          ctx.globalAlpha = 0.85; ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(sd.homeX, sd.homeY, 2.2, 0, Math.PI * 2); ctx.fill();
          if (pts.length >= 3) { const tap = pts[pts.length - 2]; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.arc(tap.x, tap.y, 1.8, 0, Math.PI * 2); ctx.fill(); }
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();

      drawDecor(ctx, W, H, frameN);
      drawCooler(ctx, cooler.x, cooler.y);

      // draw root desks first (under), then subs
      const drawList = [];
      for (const root of tree.roots) {
        drawList.push({ agent: root, isRoot: true });
        for (const sub of tree.children.get(root.id) || []) {
          drawList.push({ agent: sub, isRoot: false });
        }
      }

      for (const { agent, isRoot } of drawList) {
        const d = getDesk(agent.id);
        // init position on first sight (so it eases in from target, slight offset)
        if (d.x == null) { d.x = d.tx; d.y = d.ty - 40; }
        // ease toward target home position
        d.x = lerp(d.x, d.tx, 0.08);
        d.y = lerp(d.y, d.ty, 0.08);

        const color = STATE_COLORS[agent.state] || '#6B7280';
        const scale = isRoot ? 1.25 : 0.85;

        // Trips: active sub-agents walk to their parent to check in; idle/done
        // agents occasionally wander to the water cooler, hang out a few seconds,
        // then return. Both follow the curved walkways (around other desks).
        let drawX = d.x, drawY = d.y, walking = false, bubble = false, chat = null;
        if (!d.walk && t > walkStagger) {
          let tx = null, ty = null, kind = null, pause = 0.6, skipB = d.parentDeskId, phrase = null;
          if (agent.state === 'idle' || agent.state === 'done') {
            if (d.nextBreakAt == null) d.nextBreakAt = t + 90 + Math.random() * 240; // first wander: 1.5–5.5 min in
            if (t > d.nextBreakAt && $animations) {
              // casually visit a random idle peer (chat) OR the water cooler
              const peers = list.filter((a) => a.id !== agent.id && (a.state === 'idle' || a.state === 'done') && (desks.get(a.id) || {}).homeX != null);
              if (peers.length && Math.random() < 0.5) {
                const peer = peers[Math.floor(Math.random() * peers.length)];
                const pk = desks.get(peer.id);
                tx = pk.homeX + (d.seed < 0.5 ? -24 : 24); ty = pk.homeY;
                kind = 'social'; pause = 2.5 + Math.random() * 3; skipB = peer.id;
                phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
              } else {
                const ang = d.seed * Math.PI * 2;
                tx = cooler.x + Math.cos(ang) * 16; ty = cooler.y - 12 + Math.sin(ang) * 7;
                kind = 'break'; pause = 3 + Math.random() * 3;
              }
              d.nextBreakAt = t + 180 + Math.random() * 420;             // 3–10 min between wanders
              if (kind === 'break') d.nextBreakAt += 60 + Math.random() * 60; // cooler: a minute or two more on top
            }
          } else if (!isRoot && d.parentDeskId && ACTIVE.has(agent.state) && t > d.nextWalkAt) {
            const parent = desks.get(d.parentDeskId);
            if (parent) { tx = parent.x; ty = parent.y - 24; kind = 'report'; d.nextWalkAt = t + 6 + d.seed * 8; }
          }
          if (kind) {
            const route = octElbow(d.x, d.y, tx, ty);   // walk straight + 45°, circuit-style
            const dist = Math.hypot(tx - d.x, ty - d.y);
            const speed = kind === 'report' ? 95 : 46;          // px/s: hurried orders vs casual stroll
            const dur = Math.max(0.6, dist / speed);
            d.walk = { start: t, route, px: tx, py: ty, kind, pause, outDur: dur, backDur: dur, phrase };
            walkStagger = t + 0.7; // don't let two leave on the same frame
          }
        }
        if (d.walk) {
          const w = d.walk;
          const tt = t - w.start;
          if (tt < w.outDur) {                                   // walk out
            const q = polyPos(w.route, easeIO(tt / w.outDur));
            drawX = q.x; drawY = q.y; walking = true;
          } else if (tt < w.outDur + w.pause) {                  // hang out / chat
            drawX = w.px; drawY = w.py; bubble = true; chat = w.phrase || null;
          } else if (tt < w.outDur + w.pause + w.backDur) {      // walk back
            const k = (tt - w.outDur - w.pause) / w.backDur;
            const q = polyPos(w.route, 1 - easeIO(k));
            drawX = q.x; drawY = q.y; walking = true;
          } else {
            d.walk = null;
          }
        }

        // Render with the shared top-down vector figure (+ its desk objects).
        const fs = isRoot ? 0.58 : 0.44; // figure scale on the floor

        // ── activity highlight ─────────────────────────────────────────────
        // Working agents get a bold pulsing glow in their state colour; idle
        // agents get a pulsing amber "free — put me to work" ring so they pop.
        const haloR = Math.max(28, 64 * fs);
        if (agent.state !== 'idle' && agent.state !== 'done') {
          const pulse = 0.5 + 0.5 * Math.sin(t * 3 + (d.seed || 0) * 6.28);
          const g = ctx.createRadialGradient(drawX, drawY, 2, drawX, drawY, haloR);
          g.addColorStop(0, hexA(color, 0.45 + 0.25 * pulse));
          g.addColorStop(0.55, hexA(color, 0.16 + 0.12 * pulse));
          g.addColorStop(1, hexA(color, 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(drawX, drawY, haloR, 0, Math.PI * 2); ctx.fill();
        } else if (agent.state === 'idle') {
          const pulse = 0.5 + 0.5 * Math.sin(t * 2 + (d.seed || 0) * 6.28);
          ctx.save();
          ctx.strokeStyle = hexA('#F59E0B', 0.4 + 0.45 * pulse);
          ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.arc(drawX, drawY, haloR * 0.7, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }

        hitTargets.push({ id: agent.id, x: drawX, y: drawY, r: Math.max(30, 55 * fs) });
        ctx.save();
        ctx.translate(drawX, drawY);
        ctx.scale(fs, fs);
        ctx.translate(-60, -50);
        ctx.imageSmoothingEnabled = true;
        paintFigure(ctx, agent, frameN, { desk: false, walking });
        ctx.restore();
        if (bubble) { if (chat) drawTextBubble(ctx, drawX, drawY, chat); else drawBubble(ctx, drawX, drawY, 1); }
        // name label below the figure
        ctx.fillStyle = 'rgba(130,130,140,0.95)';
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        const lbl = agent.name && agent.name.length > 16 ? agent.name.slice(0, 15) + '…' : (agent.name || '');
        ctx.fillText(lbl, drawX, drawY + 50 * fs + 6);

        // small state badge for root desks
        if (isRoot) {
          ctx.fillStyle = color;
          ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(STATE_LABEL[agent.state] || agent.state, drawX, drawY - 24);
        }
      }
    } catch (_) {
      /* never throw out of rAF */
    }
  }

  function easeIO(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  // Point on a quadratic bezier at p∈[0,1].
  function qbez(p, x0, y0, cx, cy, x1, y1) {
    const u = 1 - p;
    return { x: u * u * x0 + 2 * u * p * cx + p * p * x1, y: u * u * y0 + 2 * u * p * cy + p * p * y1 };
  }

  onMount(() => {
    resize();
    poll();
    const pollId = setInterval(poll, 600);

    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => resize());
      if (wrap) ro.observe(wrap);
    }
    window.addEventListener('resize', resize);

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(pollId);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', resize);
    };
  });

  // keep canvas crisp if the element/DPR changes
  $effect(() => {
    if (canvas && wrap) resize();
  });
</script>

<div class="office" bind:this={wrap} class:dragging
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointerleave={onPointerUp} onwheel={onWheel}>
  <canvas bind:this={canvas}></canvas>
  <div class="zoomctl">
    <button onclick={() => zoomBy(0.83)} title="Zoom out">−</button>
    <span>{Math.round(zoom * 100)}%</span>
    <button onclick={() => zoomBy(1.2)} title="Zoom in">+</button>
    <button class="fit" onclick={fitView} title="Fit">Fit</button>
  </div>
</div>

{#if selectedId}
  <AgentModal id={selectedId} onClose={() => (selectedId = null)} />
{/if}

<style>
  .office {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 320px;
    overflow: hidden;
    background:
      radial-gradient(120% 80% at 50% 0%, rgba(99, 102, 241, 0.06), transparent 60%),
      var(--color-background-primary, #fafafa);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .office { cursor: grab; touch-action: none; }
  .office.dragging { cursor: grabbing; }
  .zoomctl {
    position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; align-items: center; gap: 4px;
    background: var(--color-background-secondary); border: 0.5px solid var(--color-border-secondary);
    border-radius: var(--border-radius-md); padding: 3px 5px;
  }
  .zoomctl button {
    width: 22px; height: 22px; font-size: 13px; line-height: 1; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); border-radius: 5px;
    background: var(--color-background-primary); color: var(--color-text-primary);
  }
  .zoomctl button.fit { width: auto; padding: 0 8px; font-size: 11px; }
  .zoomctl span { font-size: 11px; color: var(--color-text-secondary); min-width: 36px; text-align: center; }
</style>
