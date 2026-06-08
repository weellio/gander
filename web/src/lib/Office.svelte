<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { paintFigure } from './avatars/desk.js';

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

  // ── layout: deterministic target positions in normalized 0..1 space ──
  function layout(tree, W, H) {
    const { roots, children } = tree;
    const n = Math.max(1, roots.length);
    const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt(n * 1.4))));
    const margX = 0.10, topY = 0.18;

    roots.forEach((root, i) => {
      const col = i % cols;
      const colCount = Math.min(cols, n - (Math.floor(i / cols) * cols));
      const rowBlock = Math.floor(i / cols);
      const rootRows = Math.ceil(n / cols);
      const cx = margX + ((col + 0.5) / Math.max(1, colCount)) * (1 - 2 * margX);
      const cy = topY + (rootRows > 1 ? (rowBlock / (rootRows)) * 0.30 : 0);

      const rd = getDesk(root.id);
      rd.tx = cx * W;
      rd.ty = cy * H;
      rd.isRoot = true;
      rd.homeX = rd.tx; rd.homeY = rd.ty;

      // sub-agents cluster below/around their root
      const subs = children.get(root.id) || [];
      const radiusX = Math.min(0.14 * W, (0.9 * W) / (cols * 2.2));
      subs.forEach((sub, j) => {
        const sd = getDesk(sub.id);
        const m = subs.length;
        // arc fanned out below the root
        const t = m === 1 ? 0.5 : j / (m - 1); // 0..1
        const ang = Math.PI * (0.15 + 0.70 * t); // lower hemisphere-ish
        const rr = 1 + (j % 2) * 0.55; // two rings to avoid overlap
        sd.tx = rd.tx + Math.cos(ang) * radiusX * (0.9 + 0.5 * (rr - 1)) * 1.4;
        sd.ty = rd.ty + 130 + Math.sin(ang) * 70 * rr + (j > 6 ? 60 : 0);
        // clamp into view
        sd.tx = Math.max(40, Math.min(W - 40, sd.tx));
        sd.ty = Math.max(60, Math.min(H - 50, sd.ty));
        sd.isRoot = false;
        sd.homeX = sd.tx; sd.homeY = sd.ty;
        sd.parentDeskId = root.id;
      });
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

  function frame(now) {
    raf = requestAnimationFrame(frame);
    frameN++;
    const ctx = canvas && canvas.getContext('2d');
    if (!ctx) return;
    const t = now / 1000;
    const W = cssW, H = cssH;

    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // faint floor grid
      ctx.strokeStyle = 'rgba(140,140,150,0.07)';
      ctx.lineWidth = 1;
      const g = 60;
      for (let gx = 0; gx < W; gx += g) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      for (let gy = 0; gy < H; gy += g) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

      const list = agents || [];
      const tree = buildTree(list);
      layout(tree, W, H);

      // prune desks for agents that vanished
      const live = new Set(list.map((a) => a.id));
      for (const k of desks.keys()) if (!live.has(k)) desks.delete(k);

      // ── walkways from each root desk to its sub-agents (routed AROUND other desks) ──
      // Every other desk near a straight path pushes the path's control point
      // perpendicularly away, so the walkway bows around people instead of through.
      const obstacles = [];
      for (const a of list) { const dd = desks.get(a.id); if (dd && dd.homeX != null) obstacles.push({ id: a.id, x: dd.homeX, y: dd.homeY }); }
      function detour(x1, y1, x2, y2, aId, bId) {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len; // unit perpendicular
        let push = 0;
        for (const o of obstacles) {
          if (o.id === aId || o.id === bId) continue;
          const tt = ((o.x - x1) * dx + (o.y - y1) * dy) / (len * len);
          if (tt < 0.12 || tt > 0.88) continue;        // only obstacles between the desks
          const px = x1 + dx * tt, py = y1 + dy * tt;
          const op = (o.x - px) * nx + (o.y - py) * ny; // signed distance from the line
          const d = Math.abs(op), R = 38;               // clearance radius
          if (d < R) push += -Math.sign(op || 1) * (R - d) * 1.6;
        }
        push = Math.max(-80, Math.min(80, push));
        return { cx: mx + nx * push * 2, cy: my + ny * push * 2 }; // *2: control point overshoots the curve
      }

      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const root of tree.roots) {
        const pd = desks.get(root.id);
        if (!pd || pd.homeX == null) continue;
        for (const sub of tree.children.get(root.id) || []) {
          const sd = desks.get(sub.id);
          if (!sd || sd.homeX == null) continue;
          const x1 = pd.homeX, y1 = pd.homeY, x2 = sd.homeX, y2 = sd.homeY;
          const c = detour(x1, y1, x2, y2, root.id, sub.id);
          // soft walkway carpet
          ctx.strokeStyle = 'rgba(150,150,165,0.10)';
          ctx.lineWidth = 12; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(c.cx, c.cy, x2, y2); ctx.stroke();
          // animated dashed centre line, tinted by the sub's state, flowing parent→child
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = STATE_COLORS[sub.state] || '#8891a0';
          ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]); ctx.lineDashOffset = -(frameN * 0.5) % 9;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(c.cx, c.cy, x2, y2); ctx.stroke();
          ctx.globalAlpha = 1; ctx.setLineDash([]);
        }
      }
      ctx.restore();

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

        // walking decision for active sub-agents
        let drawX = d.x, drawY = d.y, walking = false, bubble = false;
        if (!isRoot && d.parentDeskId) {
          const parent = desks.get(d.parentDeskId);
          if (parent) {
            if (!d.walk && ACTIVE.has(agent.state) && t > d.nextWalkAt && t > walkStagger) {
              // start a trip to the parent's desk
              d.walk = { start: t, dur: 2.4, px: parent.x, py: parent.y };
              walkStagger = t + 0.8; // stagger global starts
              d.nextWalkAt = t + 6 + d.seed * 8; // cooldown
            }
            if (d.walk) {
              const w = d.walk;
              const p = (t - w.start) / w.dur; // 0..1 over whole trip
              // home -> parent (0..0.4), pause (0.4..0.6), parent -> home (0.6..1)
              const hx = d.x, hy = d.y; // current resting (eased home)
              if (p >= 1) {
                d.walk = null;
              } else if (p < 0.4) {
                const k = p / 0.4;
                drawX = lerp(hx, w.px, easeIO(k));
                drawY = lerp(hy, w.py - 24, easeIO(k));
                walking = true;
              } else if (p < 0.6) {
                drawX = w.px; drawY = w.py - 24;
                bubble = true;
              } else {
                const k = (p - 0.6) / 0.4;
                drawX = lerp(w.px, hx, easeIO(k));
                drawY = lerp(w.py - 24, hy, easeIO(k));
                walking = true;
              }
            }
          }
        }

        // Render with the shared top-down vector figure (+ its desk objects).
        const fs = isRoot ? 0.58 : 0.44; // figure scale on the floor
        ctx.save();
        ctx.translate(drawX, drawY);
        ctx.scale(fs, fs);
        ctx.translate(-60, -50);
        ctx.imageSmoothingEnabled = true;
        paintFigure(ctx, agent, frameN, { desk: false, walking });
        ctx.restore();
        if (bubble) drawBubble(ctx, drawX, drawY, 1);
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

<div class="office" bind:this={wrap}>
  <canvas bind:this={canvas}></canvas>
</div>

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
</style>
