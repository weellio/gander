<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './lib/states.js';
  import { avatarMode, layout, images, soundOn, autoUsage, fastPoll, animations, desktopNotify } from './lib/stores.js';
  import AgentTile from './lib/AgentTile.svelte';
  import ActionImages from './lib/ActionImages.svelte';
  import ProjectsSidebar from './lib/ProjectsSidebar.svelte';
  import CostPanel from './lib/CostPanel.svelte';
  import GithubPanel from './lib/GithubPanel.svelte';
  import SettingsPanel from './lib/SettingsPanel.svelte';
  import HistoryPanel from './lib/HistoryPanel.svelte';
  import HealthPanel from './lib/HealthPanel.svelte';
  import TranscriptPanel from './lib/TranscriptPanel.svelte';
  import HelpPanel from './lib/HelpPanel.svelte';
  import FeedPanel from './lib/FeedPanel.svelte';
  import SearchPanel from './lib/SearchPanel.svelte';
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

  // chime when an agent newly needs input / errors
  let prevAwaiting = new Set();
  let prevErrors = new Set();
  let healthInfo = $state(null);
  let firstPoll = true;
  let audioCtx = null;
  function playChime() {
    if (!$soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      [880, 1175].forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const ts = now + i * 0.12;
        g.gain.setValueAtTime(0.0001, ts);
        g.gain.linearRampToValueAtTime(0.18, ts + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0008, ts + 0.26);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(ts); o.stop(ts + 0.28);
      });
    } catch (_) {}
  }

  function notifyDesktop(agent) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const n = new Notification('Hivemind — agent needs you', {
        body: `${agent.name || agent.project || 'An agent'} is waiting for input`,
        tag: agent.id,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (_) {}
  }
  async function toggleNotify(e) {
    const want = e.target.checked;
    if (want && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { $desktopNotify = false; return; }
    }
    $desktopNotify = want;
  }

  async function poll() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      agents = d.agents || [];
      projects = d.projects || [];
      const nowAwaiting = new Set(agents.filter((a) => a.state === 'awaiting').map((a) => a.id));
      if (!firstPoll) {
        const fresh = agents.filter((a) => a.state === 'awaiting' && !prevAwaiting.has(a.id));
        if (fresh.length) { playChime(); if ($desktopNotify) fresh.forEach(notifyDesktop); }
      }
      const nowErrors = new Set(agents.filter((a) => a.state === 'error').map((a) => a.id));
      if (!firstPoll) {
        const freshE = agents.filter((a) => a.state === 'error' && !prevErrors.has(a.id));
        if (freshE.length) { playChime(); if ($desktopNotify) freshE.forEach((a) => notifyDesktop({ name: a.name, project: (a.project || '') + ' — error' })); }
      }
      prevErrors = nowErrors;
      budget = d.budget || null;
      if (!firstPoll && budget?.overDaily && !prevOverBudget) { playChime(); if ($desktopNotify) notifyDesktop({ name: 'Cost budget', project: `today $${budget.dailyCost.toFixed(2)} (cap $${budget.daily})` }); }
      if (budget && !budget.overDaily) budgetDismissed = false;
      prevOverBudget = !!budget?.overDaily;
      prevAwaiting = nowAwaiting; firstPoll = false;
      online = true;
    } catch (_) { online = false; }
  }
  let usage = $state(null);
  let budget = $state(null);
  let prevOverBudget = false;
  let budgetDismissed = $state(false);
  async function pollUsage() { try { const r = await fetch('/api/usage'); usage = await r.json(); } catch (_) {} }
  let todayCost = $derived.by(() => {
    if (!usage?.byDay?.length) return null;
    const t = new Date();
    const k = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const d = usage.byDay.find((x) => x.date === k);
    return d ? d.costUSD : 0;
  });

  // Manage / Options menus + the panels they control
  let menuOpen = $state(false);
  let optsOpen = $state(false);
  let panels = $state({ projects: false, usage: false, github: false, config: false, history: false, health: false, feed: false, search: false });
  function openP(k) { panels[k] = true; menuOpen = false; }
  let transcriptId = $state(null);

  onMount(() => {
    poll();
    pollUsage();
    fetch('/api/license').then((r) => r.json()).then((s) => (license = s)).catch(() => {});
    fetch('/api/health').then((r) => r.json()).then((s) => (healthInfo = s)).catch(() => {});
    // auto-refresh cost only when enabled (re-parsing transcripts is disk-heavy)
    const uid = setInterval(() => { if ($autoUsage) pollUsage(); }, 60000);
    return () => clearInterval(uid);
  });

  // agent-state polling — cadence follows the "fast updates" option
  $effect(() => {
    const id = setInterval(poll, $fastPoll ? 500 : 2000);
    return () => clearInterval(id);
  });

  let shown = $derived(
    selectedProject ? agents.filter((a) => (a.project || 'unknown') === selectedProject) : agents
  );
  let counts = $derived.by(() => {
    const c = {}; for (const a of shown) c[a.state] = (c[a.state] || 0) + 1; return c;
  });
  let sessionCount = $derived(new Set(shown.map((a) => a.sessionId).filter(Boolean)).size);
  let errorCount = $derived(shown.filter((a) => a.state === 'error').length);

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
  {#if budget?.overDaily && !budgetDismissed}
    <div class="lic">💸 Daily spend ${budget.dailyCost.toFixed(2)} crossed your ${budget.daily} cap.
      <button onclick={() => (budgetDismissed = true)}>Dismiss</button>
    </div>
  {/if}
  {#if healthInfo && healthInfo.hooks && healthInfo.hooks.installed === false}
    <div class="lic">⚙ Hivemind hooks aren't installed yet — sessions won't report in. Run <code>node install.js</code>, then <code>/hooks</code> (or restart).
      <button onclick={() => (panels.health = true)}>Check status</button>
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

      {#if $layout !== 'office'}
        <select class="select" bind:value={$avatarMode}>
          <option value="pixel">Pixel art</option>
          <option value="abstract">Abstract</option>
          <option value="desk">Desk (top-down)</option>
          <option value="image">Your image</option>
          <option value="gif">Image (plain, no overlay)</option>
        </select>

        <button class="select" onclick={() => fileInput.click()} title="Import avatar images (PNG/JPG/GIF)">Images…</button>
        {#if $images.length}<button class="select" onclick={clearImages} title="Clear imported images">✕{$images.length}</button>{/if}
        <ActionImages />
      {/if}
      <input bind:this={fileInput} type="file" accept="image/*" multiple style="display:none" onchange={onFiles} />

      <div class="menu-wrap">
        <button class="select" onclick={() => { menuOpen = !menuOpen; optsOpen = false; }} title="Manage your Claude Code projects & sessions">⚙ Manage ▾</button>
        {#if menuOpen}
          <div class="dropdown" role="menu">
            <button class="select" onclick={() => openP('projects')}>Projects &amp; components</button>
            <button class="select" onclick={() => openP('usage')}>Usage / cost</button>
            <button class="select" onclick={() => openP('github')}>GitHub</button>
            <button class="select" onclick={() => openP('config')}>Config (hooks · MCP)</button>
            <button class="select" onclick={() => openP('history')}>Session history</button>
            <button class="select" onclick={() => openP('search')}>Search</button>
            <button class="select" onclick={() => openP('feed')}>Activity feed</button>
            <button class="select" onclick={() => openP('health')}>Health / status</button>
          </div>
        {/if}
      </div>

      <div class="menu-wrap">
        <button class="select" onclick={() => { optsOpen = !optsOpen; menuOpen = false; }} title="Options & token conservation">Options</button>
        {#if optsOpen}
          <div class="dropdown opts" role="menu">
            <div class="opt-sec">Conserve Claude tokens</div>
            <p class="opt-note">Hivemind sends almost nothing to the model on its own. The real per-turn cost is the <b>MCP servers, skills &amp; agents</b> each project loads — trim ones you don't need.</p>
            <button class="select" onclick={() => { openP('config'); optsOpen = false; }}>Manage MCP &amp; skills →</button>
            <div class="opt-sec">Dashboard performance</div>
            <label class="opt"><input type="checkbox" bind:checked={$soundOn} /> Alert sound</label>
            <label class="opt"><input type="checkbox" checked={$desktopNotify} onchange={toggleNotify} /> Desktop notifications <span class="dim">(when waiting)</span></label>
            <label class="opt"><input type="checkbox" bind:checked={$autoUsage} /> Auto-refresh cost <span class="dim">(re-reads transcripts)</span></label>
            <label class="opt"><input type="checkbox" bind:checked={$fastPoll} /> Fast agent updates <span class="dim">(0.5s vs 2s)</span></label>
            <label class="opt"><input type="checkbox" bind:checked={$animations} /> Office animations <span class="dim">(CPU)</span></label>
          </div>
        {/if}
      </div>

      <ThemeMenu />
      <HelpPanel />
    </div>
  </header>

  {#if menuOpen || optsOpen}<div class="menu-backdrop" onclick={() => { menuOpen = false; optsOpen = false; }} role="presentation"></div>{/if}

  <!-- always-mounted panels, opened from the Manage menu (drawers are position:fixed) -->
  <ProjectsSidebar bind:open={panels.projects} />
  <CostPanel bind:open={panels.usage} />
  <GithubPanel bind:open={panels.github} />
  <SettingsPanel bind:open={panels.config} />
  <HistoryPanel bind:open={panels.history} onView={(sid) => (transcriptId = sid)} />
  <HealthPanel bind:open={panels.health} />
  <FeedPanel bind:open={panels.feed} onView={(sid) => (transcriptId = sid)} />
  <SearchPanel bind:open={panels.search} onView={(sid) => (transcriptId = sid)} />
  <TranscriptPanel bind:sessionId={transcriptId} />

  <div class="statusbar">
    <strong>{selectedProject || 'All projects'}</strong>
    <span>· {sessionCount} session{sessionCount === 1 ? '' : 's'} · {shown.length} agent{shown.length === 1 ? '' : 's'}</span>
    {#if usage?.totals}<span class="cost" title="Estimated from ~/.claude transcripts">💰 today ${todayCost?.toFixed(2) ?? '0.00'} · total ${usage.totals.costUSD.toFixed(0)}</span>{/if}
    {#if errorCount > 0}<button class="errchip" onclick={() => openP('feed')} title="Open the activity feed">⚠ {errorCount} error{errorCount === 1 ? '' : 's'}</button>{/if}
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
  .menu-wrap { position: relative; display: inline-flex; }
  .dropdown { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; display: flex; flex-direction: column; gap: 4px;
    min-width: 190px; padding: 6px; background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-lg); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); }
  .dropdown button.select { width: 100%; justify-content: flex-start; text-align: left; }
  .dropdown.opts { width: 256px; }
  .opt-sec { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); padding: 5px 4px 2px; }
  .opt-note { font-size: 10px; color: var(--color-text-secondary); line-height: 1.45; margin: 0 4px 5px; }
  .opt { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--color-text-primary); padding: 3px 4px; cursor: pointer; }
  .opt .dim { color: var(--color-text-tertiary); font-size: 10px; }
  .menu-backdrop { position: fixed; inset: 0; z-index: 55; }
  .title { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #9CA3AF; }
  .dot.online { background: #10B981; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  /* .select is styled globally in app.css for a consistent modern look */
  .statusbar { font-size: 11px; color: var(--color-text-secondary); flex-wrap: wrap; }
  .cnt { display: inline-flex; align-items: center; gap: 4px; }
  .cost { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-secondary); }
  .errchip { font-size: 11px; padding: 2px 9px; border-radius: 99px; cursor: pointer; border: 0.5px solid #EF4444;
    background: rgba(239, 68, 68, 0.12); color: #EF4444; font-weight: 600; animation: errpulse 1.6s ease-in-out infinite; }
  @keyframes errpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
  .cnt i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .empty { padding: 40px; text-align: center; color: var(--color-text-tertiary); font-size: 13px; }
  .office-wrap { position: relative; height: calc(100vh - 175px); min-height: 440px; border: 0.5px solid var(--color-border-tertiary);
    border-radius: var(--border-radius-lg); overflow: auto; background: var(--color-background-primary); }
  code { font-family: var(--font-mono); background: var(--color-background-primary); padding: 1px 5px; border-radius: 4px; }

  /* mosaic grid */
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
</style>
