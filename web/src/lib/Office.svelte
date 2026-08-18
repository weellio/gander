<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { paintFigure } from './avatars/desk.js';
  import { buildClusters, fmtUp, TONE_COL } from './procgroups.js';
  import { animations, costAlerts, floorSprites } from './stores.js';
  import { loadGooseSheet, loadOfficeSheet, loadGeneralSheet, drawGoose, drawItem, drawDroid, drawGeneral, carpetPattern, OFFICE, TICKETBOT } from './sprites.js';
  import AgentModal from './AgentModal.svelte';

  // Optional agents prop — if provided, we prefer it over self-polling.
  let { agents: agentsProp = null, focusReq = null, procs: procsProp = null, onDigest = null, onQueue = null, queueInfo = null } = $props();
  let _pendingFocus = null;   // {id} to centre on next frame
  let _flash = null;          // {id, until} highlight ring
  $effect(() => { if (focusReq && focusReq.id) _pendingFocus = focusReq; });

  let polled = $state([]); // self-polled agents
  let polledProcs = $state([]); // self-polled background processes (floor robots)
  let canvas; // bound <canvas>
  let wrap; // bound container

  // Live agent list: prefer the prop, else our poll.
  let agents = $derived(
    Array.isArray(agentsProp) && agentsProp.length >= 0 && agentsProp !== null
      ? agentsProp
      : polled
  );
  // Background processes for the floor's robots (same prefer-prop rule).
  let procs = $derived(Array.isArray(procsProp) ? procsProp : polledProcs);

  // ── self-poll /api/state every ~600ms (only matters when no prop given) ──
  async function poll() {
    if (Array.isArray(agentsProp)) return; // prop drives the scene
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      if (d && Array.isArray(d.agents)) polled = d.agents;
      if (d && Array.isArray(d.procs)) polledProcs = d.procs;
    } catch (_) {
      /* keep last scene on failure */
    }
  }

  // ── persistent per-desk visual state, keyed by agent id ──
  // { x,y (current), tx,ty (target), seed, walk:{...}|null, nextWalkAt }
  const desks = new Map();
  let rackAnchor = null;   // last server-room anchor — survives all tiles clocking out
  let serverRoomRect = null;   // last drawn server-room walls (nav-blocked; agents don't enter)
  let _dbgRoute = null;        // debug: window.__ganderRoute(sx,sy,tx,ty) draws a path for 8s

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
  const CELEB = ['#10B981', '#6366F1', '#F59E0B', '#EC4899', '#06B6D4', '#A855F7'];
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
  // one floor tile — rooms, walls and the background grid all snap to this,
  // which is what gives the floor its structured, everything-aligned look
  const TILE = 46;
  const snap = (v) => Math.ceil(v / TILE) * TILE;

  function layout(tree, W, H) {
    const { roots, children } = tree;
    // GAP must clear the room CHROME drawn around each block: walls (top band 12
    // + sides), title padding, and the bottom growth for parked bot rows — a
    // band that ignores it makes the next row of rooms overlap this one.
    const CELLW = 92, CELLH = 84, ROOTH = 94, PADX = 46, PADY = 40, GAP = 96;
    const maxCols = Math.max(1, Math.floor((W - 2 * PADX) / CELLW));
    let curX = PADX, curY = PADY, bandH = 0, prevSolo = true;

    // solo orchestrators first (sparse top), then teams with workers below (smallest first)
    const ordered = [...roots].sort((a, b) => (children.get(a.id)?.length || 0) - (children.get(b.id)?.length || 0));

    ordered.forEach((root) => {
      const subs = children.get(root.id) || [];
      const m = subs.length;
      const isSolo = m === 0;
      // a roughly-square grid, a touch wider than tall, capped to the viewport
      const cols = m ? Math.min(maxCols, Math.max(1, Math.round(Math.sqrt(m) * 1.3))) : 1;
      const rows = m ? Math.ceil(m / cols) : 0;
      const blockW = snap(Math.max(CELLW, cols * CELLW));
      const blockH = snap(ROOTH + rows * CELLH);

      // new band when leaving the solo cluster, or when this team would overflow the row
      if (((!isSolo && prevSolo) || (curX + blockW > W - PADX)) && curX > PADX) { curX = PADX; curY += bandH + GAP; bandH = 0; }

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

      rd.teamRect = { x: curX, y: curY, w: blockW, h: blockH, team: m > 0 };
      curX += blockW + GAP;
      // room chrome below the block: bottom wall + parked-bot rows (botRows is
      // last frame's count — stable, since bots only change on a proc rescan)
      bandH = Math.max(bandH, blockH + ((rd.botRows || 0) * 34 + 26));
      prevSolo = isSolo;
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

  // ── structured room: crisp two-tone walls + a doorway ────────────────────
  // Top-down wall reading like the office sheet: the top edge is a tall dark
  // band (the wall's "height"), sides/bottom are thin, and one edge carries a
  // doorway gap with a lighter threshold strip. Everything snaps to TILE.
  let carpet = null;   // low-alpha carpet pattern (built once the office sheet image lands)
  function drawRoom(ctx, bx, by, bw, bh, door /* {edge:'top'|'bottom', x} */, tone, opts = {}) {
    const TOP = 12, SIDE = 4, DOOR_W = opts.doorW || 30;
    const col = tone || 'rgba(150,162,190,';
    ctx.save();
    // interior floor — slightly lifted from the corridor, with a faint inner tile grid
    ctx.fillStyle = col + '0.07)';
    ctx.fillRect(bx, by, bw, bh);
    if (carpet && !opts.plain) {   // subtle carpet texture inside rooms (corridors stay bare)
      ctx.save(); ctx.globalAlpha = 0.09; ctx.fillStyle = carpet; ctx.fillRect(bx, by, bw, bh); ctx.restore();
    }
    if (!opts.plain) {
      ctx.strokeStyle = col + '0.10)'; ctx.lineWidth = 1;
      for (let gx = bx + TILE; gx < bx + bw; gx += TILE) { ctx.beginPath(); ctx.moveTo(gx, by); ctx.lineTo(gx, by + bh); ctx.stroke(); }
      for (let gy = by + TILE; gy < by + bh; gy += TILE) { ctx.beginPath(); ctx.moveTo(bx, gy); ctx.lineTo(bx + bw, gy); ctx.stroke(); }
    }
    // wall bands
    const seg = (x, y, w, h) => { ctx.fillRect(x, y, w, h); };
    const dx = door ? Math.max(bx + SIDE + 8, Math.min(bx + bw - SIDE - 8 - DOOR_W, (door.x || bx + bw / 2) - DOOR_W / 2)) : null;
    ctx.fillStyle = col + '0.5)';
    if (door && door.edge === 'top') {   // top band with a gap
      seg(bx, by - TOP, dx - bx, TOP);
      seg(dx + DOOR_W, by - TOP, bx + bw - (dx + DOOR_W), TOP);
    } else {
      seg(bx, by - TOP, bw, TOP);
    }
    ctx.fillStyle = col + '0.42)';
    seg(bx - SIDE, by - TOP, SIDE, bh + TOP + SIDE);                    // left
    seg(bx + bw, by - TOP, SIDE, bh + TOP + SIDE);                      // right
    if (door && door.edge !== 'top') {   // bottom band with a gap
      seg(bx - SIDE, by + bh, dx - (bx - SIDE), SIDE);
      seg(dx + DOOR_W, by + bh, bx + bw + SIDE - (dx + DOOR_W), SIDE);
    } else {
      seg(bx - SIDE, by + bh, bw + SIDE * 2, SIDE);
    }
    // top-edge highlight (the lit rim of the wall)
    ctx.fillStyle = 'rgba(210,220,240,0.28)';
    seg(bx - SIDE, by - TOP, bw + SIDE * 2, 1.5);
    // window insets on the top walls (solo offices are ~160 world px wide —
    // the threshold only needs to skip genuinely tiny rooms)
    if (bw >= 130) {
      for (const fx of bw >= 320 ? [0.38, 0.72] : [0.58]) {
        const wx = bx + bw * fx - 14;
        ctx.fillStyle = 'rgba(120,165,215,0.85)'; seg(wx, by - TOP + 2, 28, 8);          // glass
        ctx.fillStyle = 'rgba(235,245,255,0.65)'; seg(wx + 2, by - TOP + 3, 9, 2);        // sky glint
        ctx.fillStyle = 'rgba(70,80,105,0.9)';
        seg(wx - 1.5, by - TOP + 1, 1.5, 10); seg(wx + 28, by - TOP + 1, 1.5, 10); seg(wx + 13, by - TOP + 2, 1, 8);   // frame + mullion
      }
    }
    if (door) {
      const dy = door.edge === 'top' ? by - TOP : by + bh;
      const dh = door.edge === 'top' ? TOP : SIDE;
      ctx.fillStyle = col + '0.85)';                                    // door frame caps
      seg(dx - 2, dy, 2, dh); seg(dx + DOOR_W, dy, 2, dh);
      ctx.fillStyle = col + '0.16)';                                    // threshold strip
      seg(dx, door.edge === 'top' ? by - TOP - 3 : by + bh - 3, DOOR_W, dh + 6);
    }
    ctx.restore();
  }

  // ── background-process robot ─────────────────────────────────────────────
  // A little worker bot: boxy body, tread base, antenna with a blinking LED.
  // Colour says what it is (plugin / claude-child / session / other), amber +
  // pulsing dashed ring = orphaned (parent gone — the Kill candidates).
  const ROBOT_COLORS = { plugin: '#6366F1', claude: '#10B981', session: '#06B6D4', project: '#06B6D4', other: '#6B7280', orphan: '#F59E0B' };
  function drawRobot(ctx, x, y, t, p, showLabel = true) {
    const color = ROBOT_COLORS[p.attribution] || '#6B7280';
    const blink = 0.5 + 0.5 * Math.sin(t * 4 + (p.pid % 97));
    // sprite droids when available: the droid TYPE says what the process is
    // (Beeper=plugin · Helpdesk=claude · Printer=session work · Tea=not ours ·
    // red-eyed Security=orphan); ring/ports/label stay identical
    if ($floorSprites && generalOK && drawDroid(ctx, p.attribution, x, y + 9, 30)) {
      ctx.save();
      ctx.translate(x, y);
      if (p.attribution === 'orphan') {
        ctx.strokeStyle = hexA('#F59E0B', 0.25 + 0.45 * blink);
        ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(0, -3, 16, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (p.ports && p.ports.length) {
        ctx.fillStyle = 'rgba(16,185,129,0.9)';
        ctx.font = '6.5px ui-monospace, monospace'; ctx.textAlign = 'center';
        ctx.fillText(':' + p.ports[0], 0, 16.5);
      }
      ctx.restore();
      if (showLabel) {
        const lbl = p.plugin || String(p.name || '').replace(/\.exe$/i, '');
        ctx.fillStyle = 'rgba(130,132,142,0.9)';
        ctx.font = '7.5px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(lbl.length > 10 ? lbl.slice(0, 9) + '…' : lbl, x, y + (p.ports && p.ports.length ? 23 : 17));
      }
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    if (p.attribution === 'orphan') {                       // distress ring
      ctx.strokeStyle = hexA('#F59E0B', 0.25 + 0.45 * blink);
      ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = 'rgba(30,34,44,0.9)';                   // treads
    ctx.fillRect(-7, 5, 5, 3); ctx.fillRect(2, 5, 5, 3);
    ctx.fillStyle = hexA(color, 0.28);                      // body
    ctx.strokeStyle = color; ctx.lineWidth = 1.3;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-7, -4, 14, 10, 2.5); else ctx.rect(-7, -4, 14, 10);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color;                                  // eyes
    ctx.fillRect(-4, -1.5, 2.2, 2.2); ctx.fillRect(1.8, -1.5, 2.2, 2.2);
    ctx.strokeStyle = color; ctx.lineWidth = 1;             // antenna + LED
    ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, -8); ctx.stroke();
    ctx.fillStyle = hexA(color, 0.35 + 0.6 * blink);
    ctx.beginPath(); ctx.arc(0, -9, 1.8, 0, Math.PI * 2); ctx.fill();
    if (p.ports && p.ports.length) {                        // holding a port
      ctx.fillStyle = 'rgba(16,185,129,0.9)';
      ctx.font = '6.5px ui-monospace, monospace'; ctx.textAlign = 'center';
      ctx.fillText(':' + p.ports[0], 0, 14.5);
    }
    ctx.restore();
    if (showLabel) {
      const lbl = p.plugin || String(p.name || '').replace(/\.exe$/i, '');
      ctx.fillStyle = 'rgba(130,132,142,0.9)';
      ctx.font = '7.5px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(lbl.length > 10 ? lbl.slice(0, 9) + '…' : lbl, x, y + (p.ports && p.ports.length ? 21 : 15));
    }
  }
  // The server room: a rack cabinet with blinking status lights.
  function drawRack(ctx, x, y, t) {
    ctx.save();
    ctx.fillStyle = 'rgba(38,42,54,0.95)'; ctx.strokeStyle = 'rgba(150,160,185,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - 11, y - 16, 22, 32, 3); else ctx.rect(x - 11, y - 16, 22, 32);
    ctx.fill(); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = 'rgba(90,96,112,0.8)';
      ctx.fillRect(x - 8, y - 13 + i * 8, 16, 5);
      ctx.fillStyle = (Math.sin(t * 3 + i * 2.1) > 0) ? '#10B981' : 'rgba(16,185,129,0.2)';
      ctx.fillRect(x + 5, y - 12 + i * 8, 2, 2);
    }
    ctx.restore();
  }

  // Water cooler drawn UPRIGHT (front view) — bottle on a dispenser, like the
  // real thing. (x, y) is the bottom-centre of the base.
  // Punch clock — agents walk here to "clock out" before retiring.
  function drawClock(ctx, x, y) {
    ctx.save();
    const w = 24, h = 30, top = y - h;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, top, w, h, 5); else ctx.rect(x - w / 2, top, w, h);
    ctx.fillStyle = '#3a4452'; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    const cyf = top + 11;
    ctx.beginPath(); ctx.arc(x, cyf, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = '#e9eef3'; ctx.fill(); ctx.strokeStyle = '#222b36'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = '#222b36'; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    const a = frameN * 0.03;
    ctx.beginPath(); ctx.moveTo(x, cyf); ctx.lineTo(x + Math.cos(a) * 5, cyf + Math.sin(a) * 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, cyf); ctx.lineTo(x + Math.cos(a * 0.5 - 1.2) * 3.4, cyf + Math.sin(a * 0.5 - 1.2) * 3.4); ctx.stroke();
    ctx.fillStyle = '#1b2330'; ctx.fillRect(x - 7, top + h - 9, 14, 3); // card slot
    ctx.fillStyle = 'rgba(150,160,178,0.85)'; ctx.font = '7px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('TIME CLOCK', x, y + 8);
    ctx.restore();
  }

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
  // (Old scattered vector plants removed — the sheet's potted plant made them
  // read as clip-art, and viewport-pinned decor floats oddly when zoomed out.)
  function drawDecor() {}

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
  let procSel = $state(null);      // clicked robot → {p, sx, sy} popover
  let procKilling = $state(false);
  let procToast = $state('');
  // Kill + REPORT: the bridge busts its process cache after a kill, so the
  // robots vanish on the next scan (~5-10s). Failures are shown, never swallowed.
  async function doKill(pid, label) {
    procKilling = true;
    let r = null;
    try { r = await (await fetch('/api/kill-process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) })).json(); } catch (_) {}
    procKilling = false;
    procSel = null;
    if (r && r.ok) { procToast = `✓ killed ${label} — robots update in a few seconds`; setTimeout(() => (procToast = ''), 5000); }
    else { procToast = ''; alert(`Kill failed for ${label}:\n\n${(r && (r.output || r.error)) || 'no response from the bridge'}`); }
  }
  function killProc() {
    const p = procSel && procSel.p;
    if (!p) return;
    const where = p.ports && p.ports.length ? ` holding port ${p.ports.join(', ')}` : '';
    if (!confirm(`Kill ${p.name} (pid ${p.pid})${where}?\n\nForce-kills the process and its child tree.`)) return;
    doKill(p.pid, `${p.name} ${p.pid}`);
  }
  // Raise the process's window — or its owner's: many bots are windowless
  // (pythonw, bun sidecars), so the bridge falls back to the session's captured
  // window, then the owning claude.exe's window.
  async function focusProc() {
    const p = procSel && procSel.p;
    if (!p) return;
    let r = null;
    try { r = await (await fetch('/api/focus-pid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: p.pid }) })).json(); } catch (_) {}
    if (r && r.ok) { procSel = null; procToast = `🪟 raised the window for ${p.name}`; }
    else procToast = `no visible window for ${p.name} — background process (its owner has none either)`;
    setTimeout(() => (procToast = ''), 3600);
  }
  // End a whole parked session: kill its claude.exe (tree) — the session stays
  // resumable from History, and all its sidecar robots exit with it.
  function killSession() {
    const c = procSel && procSel.cluster;
    if (!c || !c.claudePid) return;
    const work = c.bots.filter((b) => b.attribution !== 'plugin');
    const warn = work.length ? `\n\nWARNING — it still has live work that dies with it:\n${work.map((b) => `  ${b.name}${b.ports?.length ? ' :' + b.ports.join(',') : ''}`).join('\n')}` : '';
    if (!confirm(`End this Claude session (kill claude.exe ${c.claudePid} and its ${c.bots.length} background process${c.bots.length === 1 ? '' : 'es'})?\n\nThe conversation stays resumable from Session history.${warn}`)) return;
    doKill(c.claudePid, `claude.exe ${c.claudePid}`);
  }
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
    if (!cssW || !cssH) { zoom = 1; panX = 0; panY = 0; return; }
    const ds = Array.from(desks.values()).filter((d) => d.homeX != null);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of ds) { minX = Math.min(minX, d.homeX); maxX = Math.max(maxX, d.homeX); minY = Math.min(minY, d.homeY); maxY = Math.max(maxY, d.homeY); }
    if (ds.length) {
      minY -= 136 + 70;   // the break-room / punch-clock band lives 136 above the topmost desk
      maxY += 96 + 70;    // rooms extend below their deepest desk, and the envelope wall sits below that
    }
    if (serverRoomRect) {   // the server room sits beside the floor and grows with its bot clusters
      minX = Math.min(minX, serverRoomRect.x - 20);
      maxX = Math.max(maxX, serverRoomRect.x + serverRoomRect.w + 20);
      minY = Math.min(minY, serverRoomRect.y - 60);
      maxY = Math.max(maxY, serverRoomRect.y + serverRoomRect.h + 96);
    }
    if (!ds.length && rackAnchor) {
      // no desks left — the break band is parked at its remembered spot; frame
      // it too instead of resetting to origin (the scene can live at negative
      // world coords, which a zoom-1/pan-0 reset would show none of)
      maxX = Math.max(maxX, (rackAnchor.midX || 0) + 330);
      minY = Math.min(minY, (rackAnchor.topY ?? 40) - 30);
    }
    if (minX === Infinity) { zoom = 1; panX = 0; panY = 0; return; }
    const pad = 80;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const z = Math.min(cssW / bw, cssH / bh, 1.5);
    zoom = z; panX = (cssW - bw * z) / 2 - minX * z; panY = (cssH - bh * z) / 2 - minY * z;
  }
  function onWheel(e) {
    if (e.target.closest && e.target.closest('.procpop')) return;   // scrolling over a popover shouldn't zoom the floor
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, zoom * (e.deltaY < 0 ? 1.12 : 0.89));
  }
  function onPointerDown(e) {
    // the robot/cluster popover is a child of this element: without this guard a
    // press on its buttons starts a canvas drag with POINTER CAPTURE — the
    // button's click never fires and the retargeted pointerup closes the popover
    if (e.target.closest && e.target.closest('.zoomctl, .procpop')) return;
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
    if (best && best.proc) { procSel = { p: best.proc, sx: e.clientX - rect.left, sy: e.clientY - rect.top }; }
    else if (best && best.cluster) { procSel = { cluster: best.cluster, sx: e.clientX - rect.left, sy: e.clientY - rect.top }; }
    else if (best && best.board) { onDigest?.(); procSel = null; }
    else if (best && best.queueSt) { onQueue?.(); procSel = null; }
    else if (best) { selectedId = best.id; procSel = null; }
    else procSel = null;
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
      // ambient office lighting by local time of day (subtle, under everything)
      const hr = new Date().getHours();
      const amb = (hr >= 22 || hr < 6) ? 'rgba(18,24,48,0.20)'
        : hr >= 19 ? 'rgba(255,150,70,0.05)'
        : hr < 8 ? 'rgba(150,180,255,0.05)' : null;
      if (amb) { ctx.fillStyle = amb; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
      hitTargets = [];

      // faint floor grid
      ctx.strokeStyle = 'rgba(140,140,150,0.07)';
      ctx.lineWidth = 1;
      const g = TILE;
      for (let gx = 0; gx < W; gx += g) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      for (let gy = 0; gy < H; gy += g) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

      const list = agents || [];
      const tree = buildTree(list);
      layout(tree, W, H);
      // frame everything once on first population so a big team isn't off-screen
      if (!autoFitted && desks.size && Array.from(desks.values()).some((d) => d.homeX != null)) { fitView(); autoFitted = true; }
      else if (!autoFitted && serverRoomRect && rackAnchor) { fitView(); autoFitted = true; }   // opened onto an empty floor — frame the server room + parked band

      // prune desks for agents that vanished
      const live = new Set(list.map((a) => a.id));
      for (const k of desks.keys()) if (!live.has(k)) desks.delete(k);

      // break area: park the water cooler at TOP-CENTRE, above all desks — the top
      // is sparse (just orchestrators) while workers pile up below, so it stays clear.
      let _minX = Infinity, _maxX = -Infinity, _minY = Infinity;
      for (const d of desks.values()) if (d.homeX != null) { if (d.homeX < _minX) _minX = d.homeX; if (d.homeX > _maxX) _maxX = d.homeX; if (d.homeY < _minY) _minY = d.homeY; }
      // with no desks on the floor, keep the break band where it LAST was (the
      // server-room anchor remembers it) — otherwise the fallback position can
      // land on top of the still-anchored server room
      const _midX = _minY === Infinity ? (rackAnchor ? rackAnchor.midX : W / 2) : (_minX + _maxX) / 2;
      const _topY = _minY === Infinity ? (rackAnchor ? rackAnchor.topY + 64 : 40) : _minY - 136;   // rugs + furniture fully clear of the rooms' top wall bands
      const cooler = { x: _midX - 122, y: _topY };  // break area, top-centre-left
      const clock = { x: _midX + 122, y: _topY };   // punch clock, top-centre-right (clear of the break rug)
      if (typeof window !== 'undefined') window.__officeDbg = { cooler, clock, minY: _minY, zoom, panX, panY, desks: desks.size, procs: (procs || []).length, rack: serverRoomRect, anchor: rackAnchor, sheetOK, officeOK, generalOK, floorSprites: $floorSprites };

      // command-palette "go to agent" — centre the view on it and flash a ring
      if (_pendingFocus) {
        const fd = desks.get(_pendingFocus.id);
        if (fd && fd.homeX != null) {
          if (zoom < 0.85) zoom = 1;
          panX = cssW / 2 - fd.homeX * zoom;
          panY = cssH / 2 - fd.homeY * zoom;
          _flash = { id: _pendingFocus.id, until: t + 2.4 };
        }
        _pendingFocus = null;
      }

      // group background processes EARLY so each room can grow its floor to fit
      // its bots (they park inside the back wall, never straddling it)
      const plist = procs || [];
      const roomBots = new Map();   // rootId -> [proc]
      const rackBots = [];
      for (const d of desks.values()) d.botRows = 0;
      if (plist.length) {
        const rootBySid = new Map(), rootByProj = new Map();
        for (const r of tree.roots) {
          if (r.sessionId) rootBySid.set(r.sessionId, r.id);
          if (r.project && !rootByProj.has(r.project)) rootByProj.set(r.project, r.id);
        }
        for (const p of plist) {
          // project-name mapping only for true session/project leftovers — a
          // claude/plugin proc belongs to ITS claude.exe, not to whichever live
          // tile happens to share the project name
          const byProj = (p.attribution === 'session' || p.attribution === 'project') && p.project && rootByProj.get(p.project);
          const rootId = (p.sessionId && rootBySid.get(p.sessionId)) || byProj;
          if (rootId && desks.get(rootId)?.teamRect) { if (!roomBots.has(rootId)) roomBots.set(rootId, []); roomBots.get(rootId).push(p); }
          else rackBots.push(p);
        }
        for (const [rootId, bots] of roomBots) {
          bots.sort((a, b) => a.pid - b.pid);
          desks.get(rootId).botRows = Math.ceil(bots.length / 6);
        }
      }

      // ── rooms: team rooms enclose the orchestrator + its cubicle floor; solo
      // orchestrators each get their own small private office. ──
      // ── building envelope: ONE outer wall around the whole floor, with a
      // main entrance at the bottom — rooms are offices inside a building,
      // and (someday) outdoor decor lives beyond these walls
      let envB = null;
      {
        let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
        const g2 = (x0, y0, x1, y1) => { ex0 = Math.min(ex0, x0); ey0 = Math.min(ey0, y0); ex1 = Math.max(ex1, x1); ey1 = Math.max(ey1, y1); };
        for (const root of tree.roots) {
          const rd = desks.get(root.id);
          if (rd && rd.teamRect) g2(rd.teamRect.x - 52, rd.teamRect.y - 36, rd.teamRect.x + rd.teamRect.w + 52, rd.teamRect.y + rd.teamRect.h + 96);
        }
        if (_minY !== Infinity) g2(cooler.x - 180, _topY - 64, clock.x + 130, _topY + 44);
        if (serverRoomRect) g2(serverRoomRect.x - 26, serverRoomRect.y - 36, serverRoomRect.x + serverRoomRect.w + 26, serverRoomRect.y + serverRoomRect.h + 28);
        if (ex0 !== Infinity) {
          envB = { x: ex0, y: ey0, w: ex1 - ex0, h: ey1 - ey0 };
          drawRoom(ctx, envB.x, envB.y, envB.w, envB.h, { edge: 'bottom', x: envB.x + envB.w / 2 }, 'rgba(110,122,155,', { plain: true, doorW: 46 });
        }
      }

      const roomsThisFrame = [];   // [{rd, bx, by, bw, bh, doorPt}] — for door-routed walking
      ctx.save();
      for (const root of tree.roots) {
        const rd = desks.get(root.id);
        if (!rd || !rd.teamRect) continue;
        const r = rd.teamRect, solo = !r.team;
        const pbBase = solo ? 20 : 14;
        const px = solo ? 34 : 12, pt = solo ? 13 : 16;   // solo rooms wide enough to read as square offices
        const pb = rd.botRows ? Math.max(pbBase, 14 + rd.botRows * 34) : pbBase;   // grow for parked bots
        const bx = r.x - px, by = r.y - pt, bw = r.w + px * 2, bh = r.h + pt + pb;
        const doorX = Math.max(bx + 24, Math.min(bx + bw - 24, rd.homeX));   // door under the orchestrator's desk
        drawRoom(ctx, bx, by, bw, bh, { edge: 'bottom', x: doorX }, solo ? 'rgba(150,162,190,' : 'rgba(140,152,178,');
        rd.doorPt = { x: doorX, y: by + bh };
        roomsThisFrame.push({ rd, bx, by, bw, bh, doorPt: rd.doorPt });
        // an IT-Crowd poster on some rooms' back wall (stable per room)
        if ($floorSprites && officeOK) {
          const pi = Math.floor((rd.seed || 0) * 4);
          if (pi < 3) drawItem(ctx, OFFICE.posters[pi], bx + 26, by + 13, 21);
        }
      }
      ctx.restore();
      // ── corridor navigation: BFS over a coarse grid where WALLS are blocked
      // and doorways are the only openings — walkers can never cross a wall.
      // (The old door-waypoint routing still cut corners through third rooms
      // and even back through the walker's own office.)
      const NAVCS = 23;   // half a floor tile per nav cell
      let navB = null, navOX = 0, navOY = 0, navW = 0, navH = 0;
      const buildNav = () => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const grow = (x0, y0, x1, y1) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };
        for (const r of roomsThisFrame) grow(r.bx - 40, r.by - 40, r.bx + r.bw + 40, r.by + r.bh + 40);
        grow(cooler.x - 160, cooler.y - 60, clock.x + 160, clock.y + 60);
        if (serverRoomRect) grow(serverRoomRect.x - 40, serverRoomRect.y - 40, serverRoomRect.x + serverRoomRect.w + 40, serverRoomRect.y + serverRoomRect.h + 40);
        if (envB) grow(envB.x - 40, envB.y - 40, envB.x + envB.w + 40, envB.y + envB.h + 40);
        if (minX === Infinity) return;
        navOX = minX - 60; navOY = minY - 60;
        navW = Math.ceil((maxX - navOX + 120) / NAVCS); navH = Math.ceil((maxY - navOY + 120) / NAVCS);
        if (navW * navH > 80000) { navB = null; return; }   // pathological zoom-out — fall back
        navB = new Uint8Array(navW * navH);
        const mark = (x0, y0, x1, y1, v) => {
          const cx0 = Math.max(0, Math.floor((x0 - navOX) / NAVCS)), cy0 = Math.max(0, Math.floor((y0 - navOY) / NAVCS));
          const cx1 = Math.min(navW - 1, Math.floor((x1 - navOX) / NAVCS)), cy1 = Math.min(navH - 1, Math.floor((y1 - navOY) / NAVCS));
          for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) navB[cy * navW + cx] = v;
        };
        const S = 4, T = 12, D = 30;
        for (const r of roomsThisFrame) {
          mark(r.bx - S, r.by - T, r.bx + r.bw + S, r.by, 1);                      // top wall band
          mark(r.bx - S, r.by - T, r.bx, r.by + r.bh + S, 1);                      // left wall
          mark(r.bx + r.bw, r.by - T, r.bx + r.bw + S, r.by + r.bh + S, 1);        // right wall
          mark(r.bx - S, r.by + r.bh, r.bx + r.bw + S, r.by + r.bh + S, 1);        // bottom wall
          mark(r.doorPt.x - D / 2 - 4, r.by + r.bh - NAVCS, r.doorPt.x + D / 2 + 4, r.by + r.bh + S + NAVCS, 0);   // the doorway
        }
        if (serverRoomRect) mark(serverRoomRect.x - S, serverRoomRect.y - T, serverRoomRect.x + serverRoomRect.w + S, serverRoomRect.y + serverRoomRect.h + S, 1);   // agents never enter the server room
        if (envB) {   // the building's outer walls (main entrance stays open)
          const D2 = 46;
          mark(envB.x - S, envB.y - T, envB.x + envB.w + S, envB.y, 1);
          mark(envB.x - S, envB.y - T, envB.x, envB.y + envB.h + S, 1);
          mark(envB.x + envB.w, envB.y - T, envB.x + envB.w + S, envB.y + envB.h + S, 1);
          mark(envB.x - S, envB.y + envB.h, envB.x + envB.w + S, envB.y + envB.h + S, 1);
          mark(envB.x + envB.w / 2 - D2 / 2 - 4, envB.y + envB.h - NAVCS, envB.x + envB.w / 2 + D2 / 2 + 4, envB.y + envB.h + S + NAVCS, 0);
        }
      };
      buildNav();
      const nearestOpen = (c) => {
        if (!navB) return c;
        if (!navB[c[1] * navW + c[0]]) return c;
        for (let rad = 1; rad <= 4; rad++) {
          for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
            const x = c[0] + dx, y = c[1] + dy;
            if (x >= 0 && y >= 0 && x < navW && y < navH && !navB[y * navW + x]) return [x, y];
          }
        }
        return c;
      };
      const routeVia = (sx, sy, tx, ty) => {
        if (!navB) return octElbow(sx, sy, tx, ty);
        const cell = (x, y) => [Math.max(0, Math.min(navW - 1, Math.floor((x - navOX) / NAVCS))), Math.max(0, Math.min(navH - 1, Math.floor((y - navOY) / NAVCS)))];
        const s = nearestOpen(cell(sx, sy)), t = nearestOpen(cell(tx, ty));
        const start = s[1] * navW + s[0], goal = t[1] * navW + t[0];
        if (start === goal) return octElbow(sx, sy, tx, ty);
        const prev = new Int32Array(navW * navH).fill(-1);
        prev[start] = start;
        const q = [start];
        let found = false;
        for (let qi = 0; qi < q.length && !found; qi++) {
          const n = q[qi], x = n % navW, y = (n / navW) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= navW || ny >= navH) continue;
            const m = ny * navW + nx;
            if (prev[m] !== -1 || navB[m]) continue;
            prev[m] = n; q.push(m);
            if (m === goal) { found = true; break; }
          }
        }
        if (!found) return octElbow(sx, sy, tx, ty);   // walled off entirely — old behavior beats freezing
        const cellsPath = [];
        for (let n = goal; n !== start; n = prev[n]) cellsPath.push(n);
        cellsPath.push(start); cellsPath.reverse();
        // compress runs into corner waypoints, in world coordinates
        const pts = [{ x: sx, y: sy }];
        for (let i = 1; i < cellsPath.length - 1; i++) {
          const a = cellsPath[i - 1], b = cellsPath[i], c = cellsPath[i + 1];
          const d1 = b - a, d2 = c - b;
          if (d1 !== d2) pts.push({ x: navOX + (b % navW) * NAVCS + NAVCS / 2, y: navOY + ((b / navW) | 0) * NAVCS + NAVCS / 2 });
        }
        pts.push({ x: tx, y: ty });
        return pts;
      };
      if (typeof window !== 'undefined') {
        window.__ganderRoute = (sx, sy, tx, ty) => { _dbgRoute = { pts: routeVia(sx, sy, tx, ty), until: t + 8 }; };
        window.__ganderRouteScreen = (sx, sy, tx, ty) => window.__ganderRoute((sx - panX) / zoom, (sy - panY) / zoom, (tx - panX) / zoom, (ty - panY) / zoom);
      }

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

      if ($floorSprites && officeOK && !carpet) carpet = carpetPattern(ctx);
      // zone rugs make the break area and time clock read as PLACES
      const rug = (cx, cy, w, h) => {
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 10); else ctx.rect(cx - w / 2, cy - h / 2, w, h);
        ctx.fillStyle = 'rgba(150,162,190,0.09)'; ctx.fill();
        if (carpet) { ctx.globalAlpha = 0.09; ctx.fillStyle = carpet; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.strokeStyle = 'rgba(150,162,190,0.28)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      };
      drawDecor(ctx, W, H, frameN);
      if ($floorSprites && officeOK) {
        // furnished break area from the office sheet: sofa · cooler · plant · bulletin board
        // all three station rugs share one height + baseline so the band reads
        // as a tidy row (break room · time clock · ticket bot)
        rug(cooler.x - 8, cooler.y - 16, 306, 96);
        rug(clock.x, clock.y - 16, 84, 96);
        drawItem(ctx, OFFICE.sofa, cooler.x - 118, cooler.y + 6, 44);
        drawItem(ctx, OFFICE.cooler, cooler.x, cooler.y + 6, 56);
        drawItem(ctx, OFFICE.plant, cooler.x + 54, cooler.y + 6, 46);
        drawItem(ctx, OFFICE.board, cooler.x + 116, cooler.y + 2, 42);
        hitTargets.push({ id: 'board', x: cooler.x + 116, y: cooler.y - 18, r: 24, board: true });
        ctx.fillStyle = 'rgba(120,120,130,0.95)';
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('break room', cooler.x - 40, cooler.y + 22);
        ctx.font = '8px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(130,135,148,0.75)';
        ctx.fillText('📌 digest', cooler.x + 116, cooler.y + 22);
      } else {
        drawCooler(ctx, cooler.x, cooler.y);
      }
      drawClock(ctx, clock.x, clock.y);
      // Ticket Bot — the task queue's front desk, right of the punch clock;
      // its badge is the queued count, clicking opens the 📋 queue panel
      if ($floorSprites && generalOK) {
        const tbx = clock.x + 88, tby = clock.y + 4;
        rug(tbx, clock.y - 16, 84, 96);
        drawGeneral(ctx, TICKETBOT, tbx, tby, 44);
        const q = queueInfo || {};
        if (q.queued > 0 || q.running > 0) {
          const txt = `${q.running || 0}▶ ${q.queued || 0}⏳`;
          ctx.font = 'bold 9px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          const tw = ctx.measureText(txt).width;
          ctx.fillStyle = 'rgba(99,102,241,0.9)';
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(tbx - tw / 2 - 5, tby - 58, tw + 10, 13, 6.5); else ctx.rect(tbx - tw / 2 - 5, tby - 58, tw + 10, 13);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(txt, tbx, tby - 48);
        }
        ctx.fillStyle = 'rgba(130,135,148,0.75)';
        ctx.font = '8px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🎫 task queue', tbx, tby + 14);
        hitTargets.push({ id: 'tickets', x: tbx, y: tby - 22, r: 26, queueSt: true });
      }

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
        let drawX = d.x, drawY = d.y, walking = false, bubble = false, chat = null, coffee = false;
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
                kind = 'break'; pause = 8 + Math.random() * 7;   // long enough to enjoy the coffee

              }
              d.nextBreakAt = t + 180 + Math.random() * 420;             // 3–10 min between wanders
              if (kind === 'break') d.nextBreakAt += 60 + Math.random() * 60; // cooler: a minute or two more on top
            }
          } else if (!isRoot && d.parentDeskId && ACTIVE.has(agent.state) && t > d.nextWalkAt) {
            const parent = desks.get(d.parentDeskId);
            if (parent) { tx = parent.x; ty = parent.y - 24; kind = 'report'; d.nextWalkAt = t + 6 + d.seed * 8; }
          }
          if (kind) {
            const route = routeVia(d.x, d.y, tx, ty);   // through doorways, straight + 45° in the corridor
            const dist = route.reduce((s, p, i) => i ? s + Math.hypot(p.x - route[i - 1].x, p.y - route[i - 1].y) : 0, 0);
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
            if (w.kind === 'break') coffee = true;               // grab a cup at the cooler
          } else if (tt < w.outDur + w.pause + w.backDur) {      // walk back
            const k = (tt - w.outDur - w.pause) / w.backDur;
            const q = polyPos(w.route, 1 - easeIO(k));
            drawX = q.x; drawY = q.y; walking = true;
          } else {
            d.walk = null;
          }
        }

        // ── clocking out: a retiring agent walks to the punch clock and fades ──
        let retireAlpha = 1;
        if (agent.retiring && clock) {
          if (!d.clockOut) d.clockOut = { start: t, route: routeVia(d.x, d.y, clock.x, clock.y + 6) };
          const co = d.clockOut, el = t - co.start;
          if (co._dur == null) co._dur = Math.max(0.7, Math.min(3, Math.hypot(clock.x - co.route[0].x, clock.y - co.route[0].y) / 120));
          if (el < co._dur) { const q = polyPos(co.route, easeIO(el / co._dur)); drawX = q.x; drawY = q.y; walking = true; bubble = false; chat = null; }
          else { drawX = clock.x; drawY = clock.y + 6; walking = false; bubble = true; chat = 'clocking out'; }
          retireAlpha = Math.max(0.1, 1 - Math.max(0, el - co._dur) / 2.2);
          d.walk = null;
        }

        // celebrate the moment an agent finishes (transition into 'done')
        if (agent.state === 'done' && d.prevState !== undefined && d.prevState !== 'done' && !d.celebrate && $animations) {
          d.celebrate = { start: t, parts: Array.from({ length: 16 }, () => ({ a: Math.random() * Math.PI * 2, v: 28 + Math.random() * 66, c: CELEB[(Math.random() * CELEB.length) | 0], s: 1.6 + Math.random() * 2.2 })) };
        }
        d.prevState = agent.state;

        // Render with the shared top-down vector figure (+ its desk objects).
        const fs = isRoot ? 0.58 : 0.44; // figure scale on the floor

        // every seat keeps its desk — the working poses carry their own desk
        // sprite, so the furniture desk is skipped only while one is drawn here;
        // a goose off wandering leaves an empty desk behind (as it should)
        const hasDeskPose = $floorSprites && sheetOK && !walking && !bubble && drawX === d.x && (agent.state === 'coding' || agent.state === 'testing' || agent.state === 'reading');
        // a goose at its seat in a STANDING pose (idle, thinking, awaiting,
        // celebrating…) stands BEHIND the desk: lift its feet above the desk
        // and paint the desk after it, so the furniture fronts the character
        // instead of becoming a pedestal it appears to stand on
        const standsBehindDesk = $floorSprites && sheetOK && officeOK && !hasDeskPose && !walking && !bubble && drawX === d.x && d.homeX != null;
        if ($floorSprites && officeOK && !hasDeskPose && !standsBehindDesk && d.homeX != null) {
          // subs get the same wide desk scaled down — the compact CRT desk is
          // front-view art and turns to nonsense when spun to face the goose
          drawItem(ctx, OFFICE.desk, d.homeX, d.homeY + (isRoot ? 34 : 26), isRoot ? 36 : 26, true);
        }

        // ── activity highlight ─────────────────────────────────────────────
        // Working agents get a bold pulsing glow in their state colour; idle
        // agents get a pulsing amber "free — put me to work" ring so they pop.
        // (haloY follows the goose when it's tucked in behind its desk)
        const haloR = Math.max(28, 64 * fs);
        const haloY = drawY - (standsBehindDesk ? 21 * fs : 0);
        if (agent.state !== 'idle' && agent.state !== 'done') {
          const pulse = 0.5 + 0.5 * Math.sin(t * 3 + (d.seed || 0) * 6.28);
          const g = ctx.createRadialGradient(drawX, haloY, 2, drawX, haloY, haloR);
          g.addColorStop(0, hexA(color, 0.45 + 0.25 * pulse));
          g.addColorStop(0.55, hexA(color, 0.16 + 0.12 * pulse));
          g.addColorStop(1, hexA(color, 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(drawX, haloY, haloR, 0, Math.PI * 2); ctx.fill();
        } else if (agent.state === 'idle' && !agent.retiring) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 2 + (d.seed || 0) * 6.28);
          ctx.save();
          ctx.strokeStyle = hexA('#F59E0B', 0.4 + 0.45 * pulse);
          ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.arc(drawX, haloY, haloR * 0.7, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
        // command-palette flash ring
        if (_flash && _flash.id === agent.id && t < _flash.until) {
          const k = (_flash.until - t) / 2.4;
          ctx.save();
          ctx.strokeStyle = hexA('#6366F1', 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(t * 9)));
          ctx.lineWidth = 3; ctx.setLineDash([]);
          ctx.beginPath(); ctx.arc(drawX, haloY, haloR * (0.85 + 0.7 * (1 - k)), 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }

        // runaway cost highlight — bold red pulsing ring behind the figure
        // (the $/min pill is drawn on TOP of the figure, further down).
        if (agent.runaway && $costAlerts) {
          const bp = 0.5 + 0.5 * Math.sin(t * 6 + (d.seed || 0) * 6.28);
          ctx.save();
          ctx.strokeStyle = hexA('#EF4444', 0.5 + 0.5 * bp);
          ctx.lineWidth = 3; ctx.setLineDash([]);
          ctx.beginPath(); ctx.arc(drawX, haloY, haloR * 0.92, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }

        // heading from the frame-to-frame movement (sticky: tiny deltas keep the
        // last heading, so the sprite doesn't flicker at waypoint corners)
        if (walking && d._hx != null) {
          const mdx = drawX - d._hx, mdy = drawY - d._hy;
          if (Math.hypot(mdx, mdy) > 0.35) d.heading = Math.abs(mdx) > Math.abs(mdy) ? (mdx > 0 ? 'right' : 'left') : (mdy < 0 ? 'up' : 'down');
        }
        d._hx = drawX; d._hy = drawY;

        hitTargets.push({ id: agent.id, x: drawX, y: drawY, r: Math.max(30, 55 * fs) });
        ctx.globalAlpha = retireAlpha;
        let drewSprite = false;
        if ($floorSprites && sheetOK) {
          // goose characters from the assets/ sheet — pose follows the state,
          // bottom-anchored where the vector figure's feet were (standing
          // poses tuck in behind the desk instead of on top of it)
          // roots sit higher behind their big desk; subs tuck in deeper so the
          // small desk covers their feet and lower legs
          const footY = drawY + 50 * fs - (standsBehindDesk ? (isRoot ? 42 : 22) * fs : 0);
          drewSprite = drawGoose(ctx, agent.id, agent.state, walking, t, drawX, footY, isRoot ? 66 : 52, !!agent.stalled, { heading: d.heading, coffee });
          if (standsBehindDesk) drawItem(ctx, OFFICE.desk, d.homeX, d.homeY + (isRoot ? 34 : 26), isRoot ? 36 : 26, true);
        }
        if (!drewSprite) {
          ctx.save();
          ctx.translate(drawX, drawY);
          ctx.scale(fs, fs);
          ctx.translate(-60, -50);
          ctx.imageSmoothingEnabled = true;
          paintFigure(ctx, agent, frameN, { desk: false, walking });
          ctx.restore();
        }
        if (d.celebrate) {
          const cel = t - d.celebrate.start;
          if (cel > 1.5) d.celebrate = null;
          else {
            ctx.save();
            ctx.globalAlpha = 1 - cel / 1.5;
            for (const p of d.celebrate.parts) {
              ctx.fillStyle = p.c;
              ctx.beginPath();
              ctx.arc(drawX + Math.cos(p.a) * p.v * cel, drawY + Math.sin(p.a) * p.v * cel + 46 * cel * cel, p.s, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }
        }
        if (bubble) { if (chat) drawTextBubble(ctx, drawX, drawY, chat); else drawBubble(ctx, drawX, drawY, 1); }
        // name label below the figure — pill backdrop for legibility over carpet;
        // sub-agent labels hide when zoomed out (roots always keep theirs)
        if (isRoot || zoom >= 0.7) {
          ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          const lbl = agent.name && agent.name.length > 16 ? agent.name.slice(0, 15) + '…' : (agent.name || '');
          const ly = drawY + 50 * fs + (drewSprite ? 14 : 6);   // sprites are taller — drop the label clear of the feet
          if (lbl) {
            const tw = ctx.measureText(lbl).width;
            ctx.fillStyle = 'rgba(128,133,150,0.14)';
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(drawX - tw / 2 - 5, ly - 9, tw + 10, 12.5, 6); else ctx.rect(drawX - tw / 2 - 5, ly - 9, tw + 10, 12.5);
            ctx.fill();
          }
          ctx.fillStyle = 'rgba(130,130,140,0.95)';
          ctx.fillText(lbl, drawX, ly);
        }
        // the agent's defined model (haiku/sonnet/opus), if any — small + dim under the name
        if (agent.model && agent.model !== 'inherit' && (isRoot || zoom >= 0.7)) {
          ctx.fillStyle = 'rgba(140,140,150,0.85)';
          ctx.font = '8px ui-sans-serif, system-ui, sans-serif';
          ctx.fillText(agent.model, drawX, drawY + 50 * fs + (drewSprite ? 24 : 16));
        }

        // runaway burn badge — a bold red pill centered over the figure's chest, drawn
        // on top so it stands out instead of blending into the name/state text.
        if (agent.runaway && $costAlerts) {
          const bp = 0.5 + 0.5 * Math.sin(t * 6 + (d.seed || 0) * 6.28);
          const txt = '💸 $' + (Number(agent.burnRate) || 0).toFixed(2) + '/min';
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.font = 'bold 13px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const tw = ctx.measureText(txt).width;
          const padX = 9, h = 22, w = tw + padX * 2;
          const cx = drawX, cy = drawY - 16 * fs;        // upper chest
          const bx = cx - w / 2, by = cy - h / 2, r = h / 2;
          ctx.shadowColor = hexA('#EF4444', 0.55 + 0.4 * bp); ctx.shadowBlur = 12;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(bx, by, w, h, r);
          else { ctx.moveTo(bx + r, by); ctx.arcTo(bx + w, by, bx + w, by + h, r); ctx.arcTo(bx + w, by + h, bx, by + h, r); ctx.arcTo(bx, by + h, bx, by, r); ctx.arcTo(bx, by, bx + w, by, r); }
          ctx.fillStyle = '#DC2626'; ctx.fill();
          ctx.shadowBlur = 0;
          ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.fillText(txt, cx, cy + 0.5);
          ctx.restore();
        }

        // small state badge for root desks (higher when the taller goose sprite is on)
        if (isRoot) {
          ctx.fillStyle = color;
          ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(STATE_LABEL[agent.state] || agent.state, drawX, drawY - (drewSprite ? 44 : 24));
        }
        ctx.globalAlpha = 1;
      }

      // ── background-process robots ─────────────────────────────────────────
      // Every long-running process a session left open gets a little robot:
      // parked at the back wall of its session's room when we know the owner,
      // otherwise in the SERVER ROOM below the floor (plugin runtimes + processes
      // of sessions opened outside Gander, grouped by their claude.exe).
      if (plist.length) {
        // in-room: rows of bots INSIDE the room's (grown) back-wall area
        for (const [rootId, bots] of roomBots) {
          const r = desks.get(rootId).teamRect;
          bots.forEach((p, i) => {
            const bx = r.x + 18 + (i % 6) * 34, by = r.y + r.h + 12 + Math.floor(i / 6) * 34;
            drawRobot(ctx, bx, by, t, p);
            hitTargets.push({ id: 'proc:' + p.pid, x: bx, y: by, r: 13, proc: p });
          });
        }
        // server room: everything we can't pin to a visible tile, grouped by
        // OWNER with a verdict on each group — the triage is in the picture:
        //   claude.exe cluster, only plugin sidecars → "idle — safe to close"
        //   claude.exe cluster with real children     → "has live work: …"
        //   no owner at all                           → "kill only what you recognize"
        if (rackBots.length) {
          // Park the server room to the LEFT of the floor, top-aligned with the
          // break-room band: screens are wider than tall, so growing sideways
          // (instead of stacking below) lets Fit zoom the whole floor larger.
          // REMEMBER the anchor, so when every tile clocks out (idle sessions
          // retire after ~25 min) the room stays put instead of jumping.
          let minX = Infinity;
          for (const d of desks.values()) if (d.homeY != null && d.homeX < minX) minX = d.homeX;
          for (const r of roomsThisFrame) if (r.bx < minX) minX = r.bx;
          if (_minY !== Infinity) minX = Math.min(minX, cooler.x - 190);   // the break band can stick out left of the rooms
          let topY = _minY === Infinity ? 60 : _topY - 64;   // wall top level with the station rugs
          if (minX === Infinity) {
            if (rackAnchor) { minX = rackAnchor.minX; topY = rackAnchor.topY; }
            else { minX = W / 2 - 160; topY = 60; }
          } else { rackAnchor = { minX, topY, midX: _midX }; }
          // shared grouping + verdicts (procgroups.js) — same truth as the Mosaic strip
          const clusters = buildClusters(rackBots);

          // pre-measure the clusters, then flow them into COLUMNS: screens are
          // wide, so a long list becomes 2–3 columns side by side instead of a
          // strip taller than the whole floor
          const dims = clusters.map((c) => {
            const cols = Math.min(7, Math.max(3, c.bots.length));
            const rows = Math.ceil(c.bots.length / cols);
            return { cols, boxW: Math.max(200, cols * 40 + 34), boxH: 62 + rows * 40 };
          });
          const totalH = dims.reduce((s, d) => s + d.boxH + 18, 0) - 18;
          const nCols = Math.min(3, Math.max(1, Math.ceil(totalH / 620)));
          const targetH = totalH / nCols;
          const colOf = []; let colI = 0, colRun = 0;   // greedy sequential fill
          for (const d of dims) {
            if (colRun > 0 && colRun + d.boxH / 2 > targetH && colI < nCols - 1) { colI++; colRun = 0; }
            colOf.push(colI); colRun += d.boxH + 18;
          }
          const usedCols = colI + 1;
          const colW = Array.from({ length: usedCols }, (_, i) => Math.max(...dims.filter((d, j) => colOf[j] === i).map((d) => d.boxW)));
          const colH = Array.from({ length: usedCols }, (_, i) => dims.filter((d, j) => colOf[j] === i).reduce((s, d) => s + d.boxH + 18, 0) - 18);
          // per-cluster positions, room-relative
          const colX = []; let xRun = 20;
          for (let i = 0; i < usedCols; i++) { colX.push(xRun); xRun += colW[i] + 18; }
          const yRun = Array.from({ length: usedCols }, () => 22);
          const pos = dims.map((d, j) => { const ci = colOf[j]; const p = { x: colX[ci], y: yRun[ci] }; yRun[ci] += d.boxH + 18; return p; });
          const orw = xRun + 2, orh = Math.max(...colH) + 22 + 20;
          const orx = minX - orw - 64, ory = topY;   // 64px corridor between it and the floor
          serverRoomRect = { x: orx, y: ory, w: orw, h: orh };
          drawRoom(ctx, orx, ory, orw, orh, { edge: 'top', x: orx + orw - 64 }, 'rgba(120,132,168,');
          ctx.save();
          ctx.fillStyle = 'rgba(140,145,160,0.85)';
          ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
          ctx.fillText('SERVER ROOM', orx + 6, ory - 18);
          ctx.font = '8px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = 'rgba(130,135,148,0.6)';
          ctx.fillText('background processes · click a bot or a group header', orx + 84, ory - 18);
          ctx.restore();
          if ($floorSprites && officeOK) {
            drawItem(ctx, OFFICE.posters[1], orx + 26, ory + 12, 20);           // "GO AWAY" on the server-room wall
          }
          clusters.forEach((c, j) => {
            const { cols, boxW, boxH } = dims[j];
            const px = orx + pos[j].x, py = ory + pos[j].y;
            const col = TONE_COL[c.tone];
            ctx.save();                                        // group box, tinted by verdict
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(px, py, boxW, boxH, 9); else ctx.rect(px, py, boxW, boxH);
            ctx.fillStyle = hexA(col, 0.045); ctx.fill();
            ctx.strokeStyle = hexA(col, c.tone === 'dim' ? 0.25 : 0.45); ctx.lineWidth = 1; ctx.stroke();
            ctx.textAlign = 'left';
            ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
            ctx.fillStyle = 'rgba(200,204,214,0.9)';
            ctx.fillText(c.title, px + 12, py + 15);
            if (c.sub) { ctx.font = '8px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = 'rgba(140,145,158,0.75)'; ctx.fillText(c.sub, px + 14 + ctx.measureText(c.title).width + 26, py + 15); }
            ctx.font = '600 8px ui-sans-serif, system-ui, sans-serif';   // the verdict pill
            const vw = ctx.measureText(c.verdict).width + 12;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(px + 10, py + 22, vw, 13, 6.5); else ctx.rect(px + 10, py + 22, vw, 13);
            ctx.fillStyle = hexA(col, 0.14); ctx.fill();
            ctx.fillStyle = col;
            ctx.fillText(c.verdict, px + 16, py + 31.5);
            ctx.restore();
            // clickable header/verdict area → cluster popover (End-session action)
            hitTargets.push({ id: 'cluster:' + c.key, x: px + Math.min(boxW, vw + 30) / 2, y: py + 24, r: 28, cluster: c });
            // one label per RUN of identical bots in a row (six "telegram"s → one),
            // so the words stop running together
            const lblOf = (p) => p.plugin || String(p.name || '').replace(/\.exe$/i, '');
            c.bots.forEach((p, i) => {
              const bx = px + 28 + (i % cols) * 40, by = py + 54 + Math.floor(i / cols) * 40;
              const first = i % cols === 0 || lblOf(p) !== lblOf(c.bots[i - 1]);
              drawRobot(ctx, bx, by, t, p, first || !!(p.ports && p.ports.length));
              hitTargets.push({ id: 'proc:' + p.pid, x: bx, y: by, r: 14, proc: p });
            });
          });
        }
      }
      // debug route overlay (window.__ganderRoute) — dev aid for pathfinding
      if (_dbgRoute && t < _dbgRoute.until) {
        ctx.save();
        ctx.strokeStyle = 'rgba(239,68,68,0.9)'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]);
        ctx.beginPath();
        _dbgRoute.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#EF4444';
        for (const p of [_dbgRoute.pts[0], _dbgRoute.pts[_dbgRoute.pts.length - 1]]) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      } else if (_dbgRoute) { _dbgRoute = null; }
    } catch (err) {
      /* never throw out of rAF — but say why the frame died, once per message */
      if (err && err.message !== _lastFrameErr) { _lastFrameErr = err.message; console.error('[office] frame aborted:', err); }
    }
  }
  let _lastFrameErr = null;

  function easeIO(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  // Point on a quadratic bezier at p∈[0,1].
  function qbez(p, x0, y0, cx, cy, x1, y1) {
    const u = 1 - p;
    return { x: u * u * x0 + 2 * u * p * cx + p * p * x1, y: u * u * y0 + 2 * u * p * cy + p * p * y1 };
  }

  let sheetOK = false;    // goose sheet loaded + keyed (falls back to vector figures until then)
  let officeOK = false;   // office decor sheet (cooler, sofa, plant, posters, printer)
  let generalOK = false;  // geese & robots sheet (process droids)
  onMount(() => {
    loadGooseSheet().then(() => (sheetOK = true)).catch(() => {});
    loadOfficeSheet().then(() => (officeOK = true)).catch(() => {});
    loadGeneralSheet().then(() => (generalOK = true)).catch(() => {});
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
  {#if procToast}<div class="floattoast">{procToast}</div>{/if}
  {#if procSel && procSel.cluster}
    <div class="procpop" style="left:{Math.min(Math.max(8, procSel.sx - 120), (cssW || 400) - 268)}px; top:{Math.min(Math.max(8, procSel.sy + 14), (cssH || 300) - 190)}px">
      <div class="pp-h">
        <b>{procSel.cluster.title}</b>
        <span class="pp-pid">{procSel.cluster.bots.length} process{procSel.cluster.bots.length === 1 ? '' : 'es'}</span>
        <button class="pp-x" onclick={() => (procSel = null)} aria-label="Close">✕</button>
      </div>
      {#if procSel.cluster.sub}<div class="pp-l">{procSel.cluster.sub}</div>{/if}
      <div class="pp-l" style="color:{procSel.cluster.tone === 'close' ? '#10B981' : procSel.cluster.tone === 'warn' ? '#F59E0B' : 'inherit'}">{procSel.cluster.verdict}</div>
      {#if procSel.cluster.claudePid}
        <div class="pp-hint">
          {#if procSel.cluster.tone === 'close'}This Claude session has been parked for days with nothing running but its plugin sidecars — probably a VS Code window you're done with. Ending it frees all {procSel.cluster.bots.length} processes; the conversation stays resumable from Session history.{:else if procSel.cluster.tone === 'work'}This session still has live work (listed above) that dies with it — check it before ending.{:else}This session started recently — it may be the window you're using right now. Its sidecars exit when you close that window.{/if}
        </div>
        <button class="pp-kill" disabled={procKilling} onclick={killSession}>{procKilling ? '…' : `End session — kill claude.exe ${procSel.cluster.claudePid}`}</button>
      {:else}
        <div class="pp-hint">{procSel.cluster.tone === 'warn' ? 'No owning session — click individual bots to inspect and kill only what you recognize.' : 'Not Claude-spawned — click individual bots for details.'}</div>
      {/if}
    </div>
  {:else if procSel}
    <div class="procpop" style="left:{Math.min(Math.max(8, procSel.sx - 120), (cssW || 400) - 248)}px; top:{Math.min(Math.max(8, procSel.sy + 14), (cssH || 300) - 170)}px">
      <div class="pp-h">
        <b>{procSel.p.name}</b>
        {#if procSel.p.plugin}<span class="pp-plug">{procSel.p.plugin}</span>{/if}
        <span class="pp-pid">pid {procSel.p.pid}</span>
        <button class="pp-x" onclick={() => (procSel = null)} aria-label="Close">✕</button>
      </div>
      {#if procSel.p.linked}<div class="pp-l">↳ {procSel.p.linked}</div>{/if}
      {#if procSel.p.project}<div class="pp-l">project: {procSel.p.project}</div>{/if}
      <div class="pp-l">up {fmtUp(procSel.p.uptimeMs)}{#if procSel.p.ports?.length} · {#each procSel.p.ports as port (port)}<a href="http://localhost:{port}" target="_blank" rel="noopener">:{port}</a>{' '}{/each}{/if}</div>
      <div class="pp-hint">
        {#if procSel.p.attribution === 'orphan'}Parent is gone — no session owns it. But orphaned ≠ useless: a long-lived one holding a port may be a service you rely on (a proxy, a local server). Kill it only if you recognize it and don't need it.{:else if procSel.p.attribution === 'plugin'}Plugin runtime — exits with its session; killing it breaks that plugin until it respawns.{:else if procSel.p.attribution === 'claude'}Belongs to a live Claude session — exits with it.{:else if procSel.p.attribution === 'other'}Not Claude-spawned — listed for its port.{:else}Spawned by this session.{/if}
      </div>
      <div class="pp-row">
        <button class="pp-focus" onclick={focusProc} title="Bring this process's window to the front — falls back to its session window or owning claude.exe">🪟 Focus window</button>
        <button class="pp-kill" disabled={procKilling} onclick={killProc}>{procKilling ? '…' : 'Kill'}</button>
      </div>
    </div>
  {/if}
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
  .floattoast { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); z-index: 45;
    font-size: 11.5px; color: #10B981; background: var(--color-background-primary);
    border: 0.5px solid #10B98155; border-radius: 999px; padding: 5px 14px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.3); pointer-events: none; white-space: nowrap; }
  .procpop { position: absolute; z-index: 40; width: 240px; padding: 9px 11px; border-radius: 9px;
    background: var(--color-background-primary); border: 0.5px solid var(--color-border-secondary);
    box-shadow: 0 14px 40px rgba(0,0,0,0.4); font-size: 11px; color: var(--color-text-primary); }
  .pp-h { display: flex; align-items: baseline; gap: 6px; }
  .pp-h b { font-size: 12px; }
  .pp-plug { font-size: 8.5px; padding: 1px 5px; border-radius: 999px; background: #6366F11f; color: var(--accent, #6366F1); }
  .pp-pid { font-family: var(--font-mono); font-size: 9.5px; color: var(--color-text-tertiary); }
  .pp-x { margin-left: auto; border: 0; background: none; color: var(--color-text-tertiary); cursor: pointer; font-size: 11px; }
  .pp-l { color: var(--color-text-secondary); margin-top: 3px; line-height: 1.4; word-break: break-word; }
  .pp-l a { color: #10B981; font-family: var(--font-mono); font-size: 10px; }
  .pp-hint { margin-top: 5px; font-size: 10px; color: var(--color-text-tertiary); line-height: 1.4; }
  .pp-row { display: flex; gap: 6px; margin-top: 7px; }
  .pp-focus { padding: 3px 10px; border-radius: 5px; cursor: pointer; font-size: 11px;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .pp-focus:hover { border-color: var(--accent, #6366F1); }
  .pp-kill { margin-top: 7px; padding: 3px 12px; border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 600;
    background: #EF44441a; border: 0.5px solid #EF444455; color: #EF4444; }
  .pp-row .pp-kill { margin-top: 0; }
  .pp-kill:hover:not(:disabled) { background: #EF4444; color: #fff; }
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
