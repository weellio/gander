<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './lib/states.js';
  import { avatarMode, layout, images } from './lib/stores.js';
  import AgentTile from './lib/AgentTile.svelte';
  import ActionImages from './lib/ActionImages.svelte';
  import CopySkill from './lib/CopySkill.svelte';
  import Hierarchy from './lib/Hierarchy.svelte';
  import ThemeMenu from './lib/ThemeMenu.svelte';
  import Office from './lib/Office.svelte';
  import { theme, applyTheme } from './lib/theme.js';

  $effect(() => applyTheme($theme));
  // only Office + Mosaic remain; coerce any stale saved layout
  $effect(() => { if ($layout !== 'office' && $layout !== 'mosaic') $layout = 'office'; });

  let agents = $state([]);
  let projects = $state([]);
  let online = $state(false);
  let selectedProject = $state(localStorage.getItem('aoc-project') || '');
  let fileInput = $state();
  let license = $state({ licensed: true });

  async function poll() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      agents = d.agents || [];
      projects = d.projects || [];
      online = true;
    } catch (_) { online = false; }
  }
  onMount(() => {
    poll();
    fetch('/api/license').then((r) => r.json()).then((s) => (license = s)).catch(() => {});
    const id = setInterval(poll, 500);
    return () => clearInterval(id);
  });

  let shown = $derived(
    selectedProject ? agents.filter((a) => (a.project || 'unknown') === selectedProject) : agents
  );
  let counts = $derived.by(() => {
    const c = {}; for (const a of shown) c[a.state] = (c[a.state] || 0) + 1; return c;
  });
  let sessionCount = $derived(new Set(shown.map((a) => a.sessionId).filter(Boolean)).size);

  function pickProject(e) {
    selectedProject = e.target.value;
    localStorage.setItem('aoc-project', selectedProject);
  }

  // ── image import (downscaled into the shared pool) ──
  function downscale(dataUrl, max) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/png')); } catch (_) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }
  function readFile(file) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(file); });
  }
  async function onFiles(e) {
    const files = Array.from(e.target.files || []).filter((f) => /^image\//.test(f.type));
    const added = [];
    for (const f of files) {
      const raw = await readFile(f); if (!raw) continue;
      added.push(/gif|svg/i.test(f.type) ? raw : (await downscale(raw, 256)) || raw);
    }
    if (added.length) { images.update((p) => [...p, ...added]); $avatarMode = 'image'; }
    e.target.value = '';
  }
  function clearImages() { if (confirm('Clear all imported images?')) images.set([]); }
</script>

<div class="dashboard">
  {#if license.licensed === false}
    <div class="lic">⚠ Hivemind is unlicensed — {license.message || 'add your license key to bridge/aoc-config.json'}.
      <button onclick={() => (license = { licensed: true })}>Dismiss</button>
    </div>
  {/if}

  <header class="top-bar">
    <div class="title">
      <span class="dot" class:online></span>
      Hivemind · Agent NOC {online ? '— LIVE' : '— connecting…'}
    </div>

    <div class="controls">
      <select class="select" value={selectedProject} onchange={pickProject}>
        <option value="">All projects ({agents.length})</option>
        {#each projects as p (p.project)}
          <option value={p.project}>{p.project} ({p.total})</option>
        {/each}
      </select>

      <select class="select" bind:value={$layout}>
        <option value="office">Office (floor)</option>
        <option value="mosaic">Mosaic</option>
      </select>

      <select class="select" bind:value={$avatarMode}>
        <option value="pixel">Pixel art</option>
        <option value="abstract">Abstract</option>
        <option value="desk">Desk (top-down)</option>
        <option value="image">Your image</option>
        <option value="gif">Image (plain, no overlay)</option>
      </select>

      <button class="select" onclick={() => fileInput.click()} title="Import avatar images (PNG/JPG/GIF)">Images…</button>
      {#if $images.length}<button class="select" onclick={clearImages} title="Clear imported images">✕{$images.length}</button>{/if}
      <input bind:this={fileInput} type="file" accept="image/*" multiple style="display:none" onchange={onFiles} />
      <ActionImages />
      <CopySkill />
      <ThemeMenu />
    </div>
  </header>

  <div class="statusbar">
    <strong>{selectedProject || 'All projects'}</strong>
    <span>· {sessionCount} session{sessionCount === 1 ? '' : 's'} · {shown.length} agent{shown.length === 1 ? '' : 's'}</span>
    {#each Object.entries(counts) as [state, n] (state)}
      <span class="cnt"><i style="background:{STATE_COLORS[state] || '#888'}"></i>{STATE_LABEL[state] || state} {n}</span>
    {/each}
  </div>

  {#if shown.length === 0}
    <div class="empty">No agents reporting yet. Run <code>/hooks</code> in a Claude Code session (or start a new one) to begin.</div>
  {:else if $layout === 'office'}
    <div class="office-wrap"><Office agents={shown} /></div>
  {:else}
    <div class="grid">
      {#each shown as agent (agent.id)}
        <AgentTile {agent} />
      {/each}
    </div>
  {/if}

  {#if $layout !== 'office'}<Hierarchy agents={shown} />{/if}
</div>

<style>
  .dashboard { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 1500px; margin: 0 auto; }
  .lic { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 8px 14px;
    background: #FFFBEB; color: #92400E; border: 0.5px solid #F59E0B; border-radius: var(--border-radius-md); }
  .lic button { margin-left: auto; font-size: 11px; padding: 2px 8px; border-radius: var(--border-radius-md);
    border: 0.5px solid #F59E0B; background: transparent; color: #92400E; cursor: pointer; }
  .top-bar, .statusbar {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-lg);
  }
  .top-bar { justify-content: space-between; }
  .controls { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .title { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #9CA3AF; }
  .dot.online { background: #10B981; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  /* .select is styled globally in app.css for a consistent modern look */
  .statusbar { font-size: 11px; color: var(--color-text-secondary); flex-wrap: wrap; }
  .cnt { display: inline-flex; align-items: center; gap: 4px; }
  .cnt i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .empty { padding: 40px; text-align: center; color: var(--color-text-tertiary); font-size: 13px; }
  .office-wrap { position: relative; height: calc(100vh - 175px); min-height: 440px; border: 0.5px solid var(--color-border-tertiary);
    border-radius: var(--border-radius-lg); overflow: auto; background: var(--color-background-primary); }
  code { font-family: var(--font-mono); background: var(--color-background-primary); padding: 1px 5px; border-radius: 4px; }

  /* mosaic grid */
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
</style>
