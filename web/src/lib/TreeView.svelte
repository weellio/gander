<script>
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import Avatar from './Avatar.svelte';

  let { agents = [] } = $props();

  // ── node geometry ──
  const NODE_W = 150;
  const NODE_H = 167;       // approx card height; row pitch = NODE_H + V_GAP
  const H_PITCH = NODE_W + 28; // horizontal pitch between leaf columns
  const ROW_H = 195;        // vertical distance between depth rows
  const TREE_GAP = 48;      // gap between separate root trees
  const PAD = 24;           // outer padding inside the canvas

  // Build a forest from the flat agent list and compute tidy-tree positions.
  let model = $derived.by(() => {
    const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
    const byId = new Map();
    for (const a of list) {
      const id = a && a.id != null ? String(a.id) : null;
      if (id == null) continue;
      byId.set(id, { agent: a, id, children: [], x: 0, y: 0, depth: 0 });
    }
    // Wire up parent/child. A node is a root if flagged or its parent is unknown.
    const roots = [];
    for (const node of byId.values()) {
      const pid = node.agent.parentId != null ? String(node.agent.parentId) : null;
      const parent = pid != null ? byId.get(pid) : null;
      if (node.agent.root === true || !parent || parent === node) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }
    // Guard against cycles by tracking visited; assign depth via DFS.
    let nextLeafX = 0; // running leaf column cursor (in pitch units)
    let maxDepth = 0;

    function layout(node, depth, seen) {
      if (seen.has(node)) { // cycle — treat as leaf
        node.x = nextLeafX * H_PITCH; nextLeafX++; node.depth = depth;
        return;
      }
      seen.add(node);
      node.depth = depth;
      if (depth > maxDepth) maxDepth = depth;
      if (!node.children.length) {
        node.x = nextLeafX * H_PITCH;
        nextLeafX++;
      } else {
        for (const c of node.children) layout(c, depth + 1, seen);
        // center parent over the span of its children
        const first = node.children[0].x;
        const last = node.children[node.children.length - 1].x;
        node.x = (first + last) / 2;
      }
    }

    for (const r of roots) {
      const startLeaf = nextLeafX;
      layout(r, 0, new Set());
      // leave a tree gap before the next root by bumping the leaf cursor
      if (nextLeafX > startLeaf) nextLeafX += TREE_GAP / H_PITCH;
    }

    // Flatten nodes with final pixel coords; collect parent→child links.
    const nodes = [];
    const links = [];
    const seenFlat = new Set();
    function collect(node) {
      if (seenFlat.has(node)) return;
      seenFlat.add(node);
      const px = node.x + PAD;
      const py = node.depth * ROW_H + PAD;
      node.px = px; node.py = py;
      nodes.push({ id: node.id, agent: node.agent, x: px, y: py });
      for (const c of node.children) {
        collect(c);
        const color = STATE_COLORS[c.agent.state] || 'var(--color-border-secondary)';
        links.push({
          x1: px + NODE_W / 2, y1: py + NODE_H,            // parent bottom-center
          x2: c.px + NODE_W / 2, y2: c.py,                 // child top-center
          color,
        });
      }
    }
    for (const r of roots) collect(r);

    let width = PAD * 2;
    let height = PAD * 2;
    for (const n of nodes) {
      width = Math.max(width, n.x + NODE_W + PAD);
      height = Math.max(height, n.y + NODE_H + PAD);
    }
    return { nodes, links, width, height };
  });

  // Build an orthogonal elbow path: down from parent, across, down into child.
  function elbow(l) {
    const midY = (l.y1 + l.y2) / 2;
    return `M ${l.x1} ${l.y1} V ${midY} H ${l.x2} V ${l.y2}`;
  }

  // ── root command row (mirrors AgentTile.svelte) ──
  let drafts = $state({});
  function draftFor(id) { return drafts[id] ?? ''; }
  async function send(agent, type) {
    const id = String(agent.id);
    const sessionId = agent.sessionId || id.replace(/^sess:/, '');
    const text = drafts[id] ?? '';
    try {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type, text }),
      });
      drafts = { ...drafts, [id]: '' };
    } catch (_) {}
  }

  // ── zoom / pan ──
  let viewport = $state(null);
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let drag = null;
  let fitted = false;
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));

  function doFit() {
    if (!viewport) return;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const tw = model.width, th = model.height;
    if (!tw || !th || !vw || !vh) return;
    zoom = clamp(0.15, 1.5, Math.min(vw / tw, vh / th) * 0.95);
    panX = Math.max(0, (vw - tw * zoom) / 2);
    panY = 14;
  }
  function zoomAt(cx, cy, nz) {
    nz = clamp(0.15, 2.5, nz);
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
    panX = cx - wx * nz; panY = cy - wy * nz; zoom = nz;
  }
  function zoomBy(f) { if (viewport) zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, zoom * f); }
  function onWheel(e) {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, zoom * (e.deltaY < 0 ? 1.12 : 0.89));
  }
  function onPointerDown(e) {
    if (e.target.closest && e.target.closest('.node')) return; // don't pan when using a card
    dragging = true;
    drag = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    viewport.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    if (!dragging || !drag) return;
    panX = drag.px + (e.clientX - drag.x);
    panY = drag.py + (e.clientY - drag.y);
  }
  function onPointerUp() { dragging = false; drag = null; }

  // Auto-fit once the viewport + model are ready.
  $effect(() => {
    if (!fitted && viewport && model.width > 0) { fitted = true; doFit(); }
  });
</script>

<div class="tree-scroll" class:dragging bind:this={viewport}
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointerleave={onPointerUp}
     onwheel={onWheel}>
  <div class="zoom">
    <button onclick={() => zoomBy(0.83)} title="Zoom out">−</button>
    <span>{Math.round(zoom * 100)}%</span>
    <button onclick={() => zoomBy(1.2)} title="Zoom in">+</button>
    <button class="fit" onclick={doFit} title="Fit to screen">Fit</button>
  </div>
  <div class="canvas" style="width:{model.width}px; height:{model.height}px; transform: translate({panX}px, {panY}px) scale({zoom});">
    <svg class="links" width={model.width} height={model.height} viewBox="0 0 {model.width} {model.height}" aria-hidden="true">
      {#each model.links as l, i (i)}
        <path class="elbow" d={elbow(l)} style="--lc:{l.color}" />
      {/each}
    </svg>

    {#each model.nodes as n (n.id)}
      {@const color = STATE_COLORS[n.agent.state] || '#6B7280'}
      <div class="node" class:idle={n.agent.state === 'idle'} style="left:{n.x}px; top:{n.y}px; width:{NODE_W}px; --c:{color}">
        <div class="head">
          <span class="name" title={n.agent.name}>{n.agent.name || n.id}</span>
        </div>
        <div class="av"><Avatar agent={n.agent} /></div>
        <div class="badge">{STATE_LABEL[n.agent.state] || n.agent.state}</div>
        {#if n.agent.root}
          <div class="ctl">
            <input
              value={draftFor(n.id)}
              oninput={(e) => (drafts = { ...drafts, [n.id]: e.target.value })}
              placeholder="message…"
              onkeydown={(e) => e.key === 'Enter' && send(n.agent, 'message')} />
            <div class="btns">
              <button onclick={() => send(n.agent, 'message')}>Send</button>
              <button class="stop" onclick={() => send(n.agent, 'stop')}>Stop</button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .tree-scroll {
    position: relative; width: 100%; height: 100%; min-height: 360px;
    overflow: hidden; cursor: grab; touch-action: none;
    background: var(--color-background-primary);
    border: 0.5px solid var(--color-border-tertiary);
    border-radius: var(--border-radius-lg);
  }
  .tree-scroll.dragging { cursor: grabbing; user-select: none; }
  .canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }

  .zoom {
    position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; align-items: center; gap: 4px;
    background: var(--color-background-secondary); border: 0.5px solid var(--color-border-secondary);
    border-radius: var(--border-radius-md); padding: 3px 5px;
  }
  .zoom button {
    width: 22px; height: 22px; font-size: 13px; line-height: 1; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); border-radius: 5px;
    background: var(--color-background-primary); color: var(--color-text-primary);
  }
  .zoom button.fit { width: auto; padding: 0 8px; font-size: 11px; }
  .zoom span { font-size: 11px; color: var(--color-text-secondary); min-width: 36px; text-align: center; }

  .links { position: absolute; inset: 0; pointer-events: none; z-index: 0; overflow: visible; }
  .elbow { fill: none; stroke: var(--lc, var(--color-border-secondary)); stroke-width: 1.5; opacity: 0.75; }

  .node {
    position: absolute; z-index: 1; box-sizing: border-box;
    background: var(--color-background-primary);
    border: 0.5px solid var(--color-border-tertiary);
    border-left: 3px solid var(--c);
    border-radius: var(--border-radius-lg);
    padding: 8px; display: flex; flex-direction: column; gap: 6px; align-items: stretch;
  }
  .node.idle { opacity: 0.7; }

  .head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .name { font-size: 12px; font-weight: 500; color: var(--color-text-primary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .av { align-self: center; display: flex; align-items: center; justify-content: center; }
  .badge { align-self: center; font-size: 9px; font-weight: 600; color: #fff; background: var(--c);
    padding: 2px 8px; border-radius: 99px; white-space: nowrap; }

  .ctl { display: flex; flex-direction: column; gap: 4px; }
  .ctl input {
    width: 100%; box-sizing: border-box; min-width: 0; font-size: 10px; padding: 4px 6px;
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md);
    background: var(--color-background-secondary); color: var(--color-text-primary);
  }
  .ctl .btns { display: flex; gap: 4px; }
  .ctl button {
    flex: 1 1 0; font-size: 10px; padding: 4px 7px; border-radius: var(--border-radius-md);
    border: 0.5px solid var(--color-border-secondary); cursor: pointer;
    background: var(--color-background-primary); color: var(--color-text-primary);
  }
  .ctl button.stop { color: #EF4444; border-color: #EF4444; }
</style>
