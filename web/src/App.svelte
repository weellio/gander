<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './lib/states.js';
  import { avatarMode, layout, images, soundOn, autoUsage, fastPoll, animations, desktopNotify, costAlerts, briefAloud, ttsVoice, ttsRate } from './lib/stores.js';
  import { speak as ttsSpeak, ttsAvailable, getVoices } from './lib/tts.js';
  import AgentTile from './lib/AgentTile.svelte';
  import AgentModal from './lib/AgentModal.svelte';
  import NewTask from './lib/NewTask.svelte';
  import Tour from './lib/Tour.svelte';
  import RoutinesPanel from './lib/RoutinesPanel.svelte';
  import ActionImages from './lib/ActionImages.svelte';
  import ProjectsSidebar from './lib/ProjectsSidebar.svelte';
  import CostPanel from './lib/CostPanel.svelte';
  import GithubPanel from './lib/GithubPanel.svelte';
  import SettingsPanel from './lib/SettingsPanel.svelte';
  import HistoryPanel from './lib/HistoryPanel.svelte';
  import HealthPanel from './lib/HealthPanel.svelte';
  import ProcessesPanel from './lib/ProcessesPanel.svelte';
  import MemoryPanel from './lib/MemoryPanel.svelte';
  import TranscriptPanel from './lib/TranscriptPanel.svelte';
  import HelpPanel from './lib/HelpPanel.svelte';
  import FeedPanel from './lib/FeedPanel.svelte';
  import SearchPanel from './lib/SearchPanel.svelte';
  import CommandPalette from './lib/CommandPalette.svelte';
  import Hierarchy from './lib/Hierarchy.svelte';
  import Office from './lib/Office.svelte';
  import { theme, applyTheme, PRESETS, BACKGROUNDS } from './lib/theme.js';

  // appearance controls (merged in from the old Theme menu)
  let bgFileInput = $state();
  function setPreset(e) { theme.update((t) => ({ ...t, preset: e.target.value })); }
  function setAccent(e) { theme.update((t) => ({ ...t, accent: e.target.value })); }
  function setBg(e) { theme.update((t) => ({ ...t, bg: e.target.value, bgImage: '' })); }
  async function onBgImage(e) {
    const f = (e.target.files || [])[0];
    if (f && /^image\//.test(f.type)) { const raw = await readFile(f); const ds = (await downscale(raw, 1600)) || raw; if (ds) theme.update((t) => ({ ...t, bgImage: ds, bg: 'none' })); }
    e.target.value = '';
  }
  function clearBgImage() { theme.update((t) => ({ ...t, bgImage: '' })); }

  $effect(() => applyTheme($theme));
  // only Office + Mosaic remain; coerce any stale saved layout
  $effect(() => { if ($layout !== 'office' && $layout !== 'mosaic') $layout = 'office'; });

  let agents = $state([]);
  let projects = $state([]);
  let online = $state(false);
  let selectedProject = $state(localStorage.getItem('aoc-project') || '');
  let fileInput = $state();

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
      const n = new Notification('Gander — agent needs you', {
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
  let panels = $state({ projects: false, usage: false, github: false, config: false, history: false, health: false, feed: false, search: false, routines: false, procs: false, memory: false });
  function openP(k) { panels[k] = true; menuOpen = false; }
  // Settings/Config is one drawer with two scopes: 'app' (global: Telegram, budget,
  // sessions, nudge, editor) opened from Settings ▾, and 'project' (this project's
  // hooks/MCP/settings.json) opened from Manage → Project config.
  // Settings drawer is app-wide only now (Telegram, budget, sessions, nudge, editor).
  // Per-project config (hooks/MCP/settings.json) lives inline in the Projects panel.
  function openAppSettings() { panels.config = true; menuOpen = false; optsOpen = false; }
  // Memory: CLAUDE.md + .claude/memory facts. Global from the Manage menu, or
  // targeted to a project from the Projects panel's 📝 Memory button.
  let memScope = $state('global');
  let memCwd = $state('');
  function openMemory(cwd) { if (cwd) { memScope = 'project'; memCwd = cwd; panels.projects = false; } else { memScope = 'global'; memCwd = ''; } panels.memory = true; menuOpen = false; }
  let transcriptId = $state(null);
  let tileModalId = $state(null);   // mosaic tile → full agent modal
  let newTaskOpen = $state(false);  // ＋ New task launcher
  let tourOpen = $state(false);     // first-run guided tour
  let latestBrief = $state(null);   // newest routine briefing, for the "new briefing" card
  let briefSeen = $state(Number(localStorage.getItem('aoc-briefseen')) || 0);
  async function pollBriefings() { try { const r = await fetch('/api/briefings'); const j = await r.json(); latestBrief = (j.briefings || [])[0] || null; } catch (_) {} }
  let freshBrief = $derived(latestBrief && latestBrief.ok && latestBrief.ts > briefSeen && (Date.now() - latestBrief.ts) < 14 * 3600 * 1000 ? latestBrief : null);
  function seenBrief() { briefSeen = latestBrief ? latestBrief.ts : Date.now(); try { localStorage.setItem('aoc-briefseen', String(briefSeen)); } catch (_) {} }
  function openBrief() { seenBrief(); openP('routines'); }
  let voices = $state([]);
  function loadVoices() { voices = getVoices(); }
  function testVoice() { ttsSpeak('This is how your briefings will sound.', { voiceName: $ttsVoice, rate: $ttsRate }); }
  let _briefTs = 0;
  $effect(() => {
    if (latestBrief && latestBrief.ts > _briefTs) {
      const first = _briefTs === 0; _briefTs = latestBrief.ts;
      if (!first && latestBrief.ok && $desktopNotify) notifyDesktop({ name: '📋 ' + latestBrief.name, project: 'briefing ready' });
      if (!first && latestBrief.ok && $briefAloud) ttsSpeak((latestBrief.name + '. ') + latestBrief.output, { voiceName: $ttsVoice, rate: $ttsRate });
    }
  });
  const tourSteps = [
    { title: '👋 Welcome to Gander', body: "Live mission control for your Claude Code agents. Quick hands-on tour — you'll click a couple of things. (Skip anytime.)" },
    { sel: '[data-tour="newtask"]', title: '＋ New task', body: 'Kick off a goal from here: type what you want, pick a project, and it launches a fresh Claude session working on it.' },
    { sel: '[data-tour="layout"]', title: 'Two views', body: 'Office floor (agents walk around, gather at the cooler) or Mosaic (a tile per agent). Switch anytime.' },
    { sel: '[data-tour="manage"]', title: 'Open the control center', body: 'Go ahead — click ⚙ Manage to open it.', click: true },
    { free: true, title: 'The control center', body: 'Projects · Usage & cost · GitHub · Session history · Telegram. This is where you manage Claude Code, not just watch it — open any of these later. Next →' },
    { sel: '[data-tour="settings"]', title: 'Make it yours', body: 'Now click ⚙ Settings to open your options.', click: true },
    { free: true, title: 'Personalize', body: 'Avatars, cost alerts, and New session options — e.g. skip permission prompts so you don\'t babysit launches, and set up Telegram to get pinged on your phone. Tweak what you like, then Next →' },
    { sel: '[data-tour="status"]', title: 'Live pulse', body: "Today's and total spend, plus a live count of what every agent is doing." },
    { title: "You're set 🎉", body: 'Click any agent to read its task, reply, stop it, or drop an image to ask about. Replay this tour anytime: press / → “Take the tour”.' },
  ];
  let paletteOpen = $state(false);
  let focusReq = $state(null);
  function onGlobalKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
    if (e.metaKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); paletteOpen = true; return; } // ⌘K (Mac)
    if (e.key === '/' && !inField && !paletteOpen) { e.preventDefault(); paletteOpen = true; }              // "/" (avoids Ctrl-K → browser)
  }
  let paletteItems = $derived.by(() => {
    const cmds = [
      { label: 'Projects & components', sub: 'panel', action: () => openP('projects') },
      { label: 'Usage / cost', sub: 'panel', action: () => openP('usage') },
      { label: 'GitHub', sub: 'panel', action: () => openP('github') },
      { label: 'Config · hooks · MCP · Telegram · budget', sub: 'panel', action: () => openP('config') },
      { label: 'Session history', sub: 'panel', action: () => openP('history') },
      { label: 'Search', sub: 'panel', action: () => openP('search') },
      { label: 'Activity feed', sub: 'panel', action: () => openP('feed') },
      { label: 'Health / status', sub: 'panel', action: () => openP('health') },
      { label: 'New task — start a session on a goal', sub: 'launch', action: () => (newTaskOpen = true) },
      { label: 'Routines & briefings', sub: 'panel', action: () => openP('routines') },
      { label: 'Take the tour', sub: 'walkthrough', action: () => (tourOpen = true) },
      { label: 'Export swarm snapshot', sub: 'Mermaid + PNG', action: exportSnapshot },
      { label: $soundOn ? 'Mute alert sound' : 'Unmute alert sound', sub: 'toggle', action: () => ($soundOn = !$soundOn) },
      { label: 'Office floor view', sub: 'view', action: () => ($layout = 'office') },
      { label: 'Mosaic view', sub: 'view', action: () => ($layout = 'mosaic') },
    ];
    for (const a of shown) cmds.push({ label: 'Go to ' + (a.name || a.id), sub: (a.project || '') + ' · ' + (a.state || ''), action: () => { $layout = 'office'; focusReq = { id: a.id, t: Date.now() }; } });
    return cmds;
  });

  let bellOpen = $state(false);
  function flyTo(a) { $layout = 'office'; focusReq = { id: a.id, t: Date.now() }; bellOpen = false; }
  let attention = $derived.by(() => {
    const items = [];
    for (const a of shown) if (a.state === 'awaiting') items.push({ kind: 'awaiting', icon: '🔔', label: a.name, sub: 'needs input · ' + (a.project || ''), action: () => flyTo(a) });
    for (const a of shown) if (a.state === 'error') items.push({ kind: 'error', icon: '⚠', label: a.name, sub: 'error · ' + (a.project || ''), action: () => flyTo(a) });
    if (budget?.overDaily) items.push({ kind: 'budget', icon: '💸', label: 'Daily budget exceeded', sub: `$${budget.dailyCost.toFixed(2)} / $${budget.daily}`, action: () => { openP('config'); bellOpen = false; } });
    return items;
  });

  onMount(() => {
    poll();
    pollUsage();
    fetch('/api/health').then((r) => r.json()).then((s) => (healthInfo = s)).catch(() => {});
    // first-run guided tour (once per browser; replay from the command palette)
    try { if (!localStorage.getItem('aoc-toured')) setTimeout(() => (tourOpen = true), 800); } catch (_) {}
    // auto-refresh cost only when enabled (re-parsing transcripts is disk-heavy)
    pollBriefings();
    if (ttsAvailable) { loadVoices(); try { window.speechSynthesis.onvoiceschanged = loadVoices; } catch (_) {} }
    const uid = setInterval(() => { if ($autoUsage) pollUsage(); }, 60000);
    const bid = setInterval(pollBriefings, 60000);
    return () => { clearInterval(uid); clearInterval(bid); };
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
  let latest = $derived.by(() => { let b = null; for (const a of shown) if (!b || (a.updatedAt || 0) > (b.updatedAt || 0)) b = a; return b; });

  // ── Export the current swarm as a shareable snapshot (Mermaid diagram + PNG) ──
  let exportMsg = $state('');
  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function mermaidFromAgents(list) {
    const idMap = new Map(); list.forEach((a, i) => idMap.set(a.id, 'n' + i));
    const esc = (s) => String(s || '').replace(/["[\]{}|<>]/g, ' ').replace(/\s+/g, ' ').trim();
    let out = 'flowchart TD\n';
    for (const a of list) out += `  ${idMap.get(a.id)}["${esc(a.name || a.id)}<br/>${esc(a.state || '')}"]\n`;
    for (const a of list) if (a.parentId && idMap.has(a.parentId)) out += `  ${idMap.get(a.parentId)} --> ${idMap.get(a.id)}\n`;
    return out;
  }
  async function exportSnapshot() {
    const list = shown;
    if (!list.length) { exportMsg = 'Nothing to export yet'; setTimeout(() => (exportMsg = ''), 2500); return; }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const mer = mermaidFromAgents(list);
    const md = `# Gander swarm — ${new Date().toLocaleString()}\n\n${list.length} agents · ${sessionCount} sessions\n\n\`\`\`mermaid\n${mer}\`\`\`\n`;
    downloadBlob(`gander-swarm-${stamp}.md`, new Blob([md], { type: 'text/markdown' }));
    let copied = false;
    try { await navigator.clipboard.writeText(mer); copied = true; } catch (_) {}
    // PNG of the office floor canvas, if that view is up
    const cv = document.querySelector('canvas');
    let png = false;
    if (cv && cv.toBlob) { try { cv.toBlob((b) => { if (b) downloadBlob(`gander-floor-${stamp}.png`, b); }); png = true; } catch (_) {} }
    exportMsg = `Exported ${png ? 'Mermaid + PNG' : 'Mermaid'}${copied ? ' · copied to clipboard' : ''} ✓`;
    setTimeout(() => (exportMsg = ''), 3000);
  }

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

<svelte:window onkeydown={onGlobalKey} />
<CommandPalette bind:open={paletteOpen} items={paletteItems} />

<div class="dashboard">
  {#if budget?.overDaily && !budgetDismissed}
    <div class="lic">💸 Daily spend ${budget.dailyCost.toFixed(2)} crossed your ${budget.daily} cap.
      <button onclick={() => (budgetDismissed = true)}>Dismiss</button>
    </div>
  {/if}
  {#if healthInfo && healthInfo.hooks && healthInfo.hooks.installed === false}
    <div class="lic">⚙ Gander hooks aren't installed yet — sessions won't report in. Run <code>node install.js</code>, then <code>/hooks</code> (or restart).
      <button onclick={() => (panels.health = true)}>Check status</button>
    </div>
  {/if}

  <header class="top-bar">
    <div class="title">
      <img src="/goose.png" class="logo" alt="Gander" />
      <span class="dot" class:online></span>
      Gander · Agent NOC {online ? '— LIVE' : '— connecting…'}
    </div>

    <div class="controls">
      <button class="newtask" data-tour="newtask" onclick={() => (newTaskOpen = true)} title="Start a new Claude session on a goal">＋ New task</button>

      <select class="select" value={selectedProject} onchange={pickProject} title="Projects with a live or recently-active session. To browse every project on disk, use Manage → Projects.">
        <option value="">All open projects ({agents.length})</option>
        {#each projects as p (p.project)}
          <option value={p.project}>{p.project} ({p.total})</option>
        {/each}
      </select>

      <select class="select" data-tour="layout" bind:value={$layout}>
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

      <button class="select" onclick={() => (paletteOpen = true)} title="Command palette — jump to a panel or agent (press /)">🔍 Jump</button>

      <div class="menu-wrap">
        <button class="select" data-tour="manage" onclick={() => { menuOpen = !menuOpen; optsOpen = false; }} title="Manage your Claude Code projects & sessions">⚙ Manage ▾</button>
        {#if menuOpen}
          <div class="dropdown" role="menu">
            <button class="select" onclick={() => openP('projects')}>Projects · components · config</button>
            <button class="select" onclick={() => openP('usage')}>Usage / cost</button>
            <button class="select" onclick={() => openP('github')}>GitHub</button>
            <button class="select" onclick={() => openMemory()}>Memory (CLAUDE.md · facts)</button>
            <button class="select" onclick={() => openP('routines')}>Routines &amp; briefings</button>
            <button class="select" onclick={() => openP('history')}>Session history</button>
            <button class="select" onclick={() => openP('search')}>Search</button>
            <button class="select" onclick={() => openP('feed')}>Activity feed</button>
            <button class="select" onclick={() => openP('procs')}>Processes (stuck open?)</button>
            <button class="select" onclick={() => openP('health')}>Health / status</button>
          </div>
        {/if}
      </div>

      <div class="menu-wrap">
        <button class="select" data-tour="settings" onclick={() => { optsOpen = !optsOpen; menuOpen = false; bellOpen = false; }} title="Settings, appearance & token conservation">⚙ Settings ▾</button>
        {#if optsOpen}
          <div class="dropdown opts" role="menu">
            <div class="opt-sec">Appearance</div>
            <label class="opt apr"><span>Theme</span>
              <select class="aprsel" value={$theme.preset} onchange={setPreset}>
                {#each Object.entries(PRESETS) as [k, p] (k)}<option value={k}>{p.label}</option>{/each}
              </select>
            </label>
            <label class="opt apr"><span>Accent</span><input class="aprcolor" type="color" value={$theme.accent} oninput={setAccent} /></label>
            <label class="opt apr"><span>Background</span>
              <select class="aprsel" value={$theme.bgImage ? '__img' : $theme.bg} onchange={setBg} disabled={!!$theme.bgImage}>
                {#each Object.entries(BACKGROUNDS) as [k, b] (k)}<option value={k}>{b.label}</option>{/each}
                {#if $theme.bgImage}<option value="__img">Custom image</option>{/if}
              </select>
            </label>
            <div class="opt apr"><span>Background image</span>
              <span class="aprimg"><button class="mini" onclick={() => bgFileInput.click()}>Upload…</button>{#if $theme.bgImage}<button class="mini" onclick={clearBgImage}>✕</button>{/if}</span>
            </div>
            <input bind:this={bgFileInput} type="file" accept="image/*" style="display:none" onchange={onBgImage} />

            <div class="opt-sec">App configuration</div>
            <button class="select" onclick={openAppSettings}>Telegram · cost budget · sessions · nudge →</button>

            <div class="opt-sec">Conserve Claude tokens</div>
            <p class="opt-note">Gander sends almost nothing to the model on its own. The real per-turn cost is the <b>MCP servers, skills &amp; agents</b> each project loads — trim ones you don't need.</p>
            <button class="select" onclick={() => { openP('projects'); optsOpen = false; }}>Trim MCP &amp; skills (in Projects) →</button>
            <div class="opt-sec">Share</div>
            <button class="select" onclick={() => { exportSnapshot(); optsOpen = false; }}>📷 Export swarm snapshot <span class="dim">(Mermaid + PNG of the floor)</span></button>

            <div class="opt-sec">Dashboard performance</div>
            <label class="opt"><input type="checkbox" bind:checked={$soundOn} /> Alert sound</label>
            <label class="opt"><input type="checkbox" checked={$desktopNotify} onchange={toggleNotify} /> Desktop notifications <span class="dim">(when waiting)</span></label>
            <label class="opt"><input type="checkbox" bind:checked={$autoUsage} /> Auto-refresh cost <span class="dim">(re-reads transcripts)</span></label>
            <label class="opt"><input type="checkbox" bind:checked={$costAlerts} /> Cost &amp; burn alerts <span class="dim">(tile $ + runaway flag)</span></label>
            <label class="opt"><input type="checkbox" bind:checked={$briefAloud} /> Read new briefings aloud <span class="dim">(🔊 text-to-speech)</span></label>
            {#if ttsAvailable}
              <label class="opt apr"><span>Voice</span>
                <select class="aprsel" bind:value={$ttsVoice}>
                  <option value="">Default ({voices.length} available)</option>
                  {#each voices as v (v.name)}<option value={v.name}>{v.name}{v.lang ? ' · ' + v.lang : ''}</option>{/each}
                </select>
              </label>
              <label class="opt apr"><span>Speed {Number($ttsRate).toFixed(1)}×</span><input type="range" min="0.6" max="1.6" step="0.1" bind:value={$ttsRate} /></label>
              <button class="select" onclick={testVoice}>🔊 Test voice</button>
            {/if}
            <label class="opt"><input type="checkbox" bind:checked={$fastPoll} /> Fast agent updates <span class="dim">(0.5s vs 2s)</span></label>
            <label class="opt"><input type="checkbox" bind:checked={$animations} /> Office animations <span class="dim">(CPU)</span></label>
          </div>
        {/if}
      </div>

      <div class="menu-wrap">
        <button class="select bell" onclick={() => { bellOpen = !bellOpen; menuOpen = false; optsOpen = false; }} title="What needs you">🔔{#if attention.length}<span class="bellbadge">{attention.length}</span>{/if}</button>
        {#if bellOpen}
          <div class="dropdown" role="menu">
            {#if attention.length === 0}
              <div class="opt-note">All clear — nothing needs you. ✨</div>
            {:else}
              {#each attention as it (it.kind + it.label)}
                <button class="select" onclick={it.action}>{it.icon} {it.label} <span class="dim">{it.sub}</span></button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>

      <HelpPanel />
    </div>
  </header>

  {#if menuOpen || optsOpen || bellOpen}<div class="menu-backdrop" onclick={() => { menuOpen = false; optsOpen = false; bellOpen = false; }} role="presentation"></div>{/if}

  {#if exportMsg}<div class="toast">{exportMsg}</div>{/if}

  <!-- always-mounted panels, opened from the Manage menu (drawers are position:fixed) -->
  <ProjectsSidebar bind:open={panels.projects} onMemory={openMemory} />
  <CostPanel bind:open={panels.usage} />
  <GithubPanel bind:open={panels.github} />
  <SettingsPanel bind:open={panels.config} scope="app" />
  <HistoryPanel bind:open={panels.history} onView={(sid) => (transcriptId = sid)} />
  <RoutinesPanel bind:open={panels.routines} />
  <HealthPanel bind:open={panels.health} />
  <ProcessesPanel bind:open={panels.procs} />
  <MemoryPanel bind:open={panels.memory} initialScope={memScope} initialCwd={memCwd} />
  <FeedPanel bind:open={panels.feed} onView={(sid) => (transcriptId = sid)} />
  <SearchPanel bind:open={panels.search} onView={(sid) => (transcriptId = sid)} />
  <TranscriptPanel bind:sessionId={transcriptId} />
  {#if tileModalId}<AgentModal id={tileModalId} onClose={() => (tileModalId = null)} />{/if}
  <NewTask bind:open={newTaskOpen} />
  <Tour bind:open={tourOpen} steps={tourSteps} />

  <div class="statusbar" data-tour="status">
    <strong>{selectedProject || 'All open projects'}</strong>
    <span>· {sessionCount} session{sessionCount === 1 ? '' : 's'} · {shown.length} agent{shown.length === 1 ? '' : 's'}</span>
    {#if usage?.totals}<span class="cost" title="Estimated from ~/.claude transcripts">💰 today ${todayCost?.toFixed(2) ?? '0.00'} · total ${usage.totals.costUSD.toFixed(0)}</span>{/if}
    {#if errorCount > 0}<button class="errchip" onclick={() => openP('feed')} title="Open the activity feed">⚠ {errorCount} error{errorCount === 1 ? '' : 's'}</button>{/if}
    {#each Object.entries(counts) as [state, n] (state)}
      <span class="cnt"><i style="background:{STATE_COLORS[state] || '#888'}"></i>{STATE_LABEL[state] || state} {n}</span>
    {/each}
  </div>

  {#if freshBrief}
    <div class="briefcard" onclick={openBrief} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && openBrief()}>
      <span>📋 New briefing ready — <b>{freshBrief.name}</b> <span class="bc-dim">· click to read</span></span>
      <span class="bc-x" onclick={(e) => { e.stopPropagation(); seenBrief(); }} role="button" tabindex="-1" aria-label="Dismiss">✕</span>
    </div>
  {/if}

  {#if latest && shown.length}
    <div class="ticker" title="Most recent activity">
      <span class="tdot" style="background:{STATE_COLORS[latest.state] || '#888'}"></span>
      <b>{latest.name}</b>
      <span class="tstate">{STATE_LABEL[latest.state] || latest.state}</span>
      {#if latest.logLines?.[0]}<span class="tlog">{latest.logLines[0]}</span>{/if}
      {#if latest.project}<span class="tproj">· {latest.project}</span>{/if}
    </div>
  {/if}

  {#if shown.length === 0}
    <div class="empty">No agents reporting yet. Run <code>/hooks</code> in a Claude Code session (or start a new one) to begin.</div>
  {:else if $layout === 'office'}
    <div class="office-wrap"><Office agents={shown} {focusReq} /></div>
  {:else}
    <div class="grid">
      {#each shown as agent (agent.id)}
        <AgentTile {agent} onOpen={(id) => (tileModalId = id)} />
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
  .newtask { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: var(--border-radius-md); cursor: pointer;
    border: none; background: var(--accent, #6366F1); color: #fff; white-space: nowrap; }
  .newtask:hover { filter: brightness(1.08); }
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
  .opt.apr { justify-content: space-between; cursor: default; }
  .aprsel { font-size: 11px; max-width: 140px; }
  .aprcolor { width: 34px; height: 20px; padding: 0; border: 0.5px solid var(--color-border-secondary); border-radius: 4px; background: none; cursor: pointer; }
  .aprimg { display: flex; gap: 4px; }
  .opts .mini { font-size: 10px; padding: 2px 7px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .menu-backdrop { position: fixed; inset: 0; z-index: 55; }
  .briefcard { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 6px 12px 0;
    padding: 8px 12px; border-radius: var(--border-radius-md); cursor: pointer; font-size: 12px;
    background: color-mix(in srgb, var(--accent, #6366F1) 14%, var(--color-background-primary));
    border: 0.5px solid color-mix(in srgb, var(--accent, #6366F1) 40%, transparent); color: var(--color-text-primary); }
  .briefcard:hover { background: color-mix(in srgb, var(--accent, #6366F1) 20%, var(--color-background-primary)); }
  .bc-dim { color: var(--color-text-tertiary); font-size: 11px; }
  .bc-x { color: var(--color-text-tertiary); cursor: pointer; font-size: 12px; padding: 0 2px; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 200;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-left: 3px solid #10B981;
    border-radius: var(--border-radius-md); padding: 8px 14px; font-size: 12px; font-weight: 500;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28); animation: toastin 0.2s ease; }
  @keyframes toastin { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
  .bell { position: relative; }
  .bellbadge { position: absolute; top: -5px; right: -4px; background: #EF4444; color: #fff; font-size: 8px; font-weight: 700;
    min-width: 14px; height: 14px; border-radius: 99px; display: inline-flex; align-items: center; justify-content: center; padding: 0 3px; }
  .dropdown .dim { color: var(--color-text-tertiary); font-size: 10px; }
  .title { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .title .logo { height: 26px; width: 26px; object-fit: contain; }
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
  .ticker { display: flex; align-items: center; gap: 7px; padding: 5px 14px; margin-top: -6px; font-size: 11px;
    color: var(--color-text-secondary); background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); overflow: hidden; white-space: nowrap; }
  .ticker b { color: var(--color-text-primary); flex-shrink: 0; }
  .tdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .tstate { color: var(--color-text-tertiary); flex-shrink: 0; }
  .tlog { font-family: var(--font-mono); font-size: 10px; overflow: hidden; text-overflow: ellipsis; }
  .tproj { color: var(--color-text-tertiary); flex-shrink: 0; }
  .office-wrap { position: relative; height: calc(100vh - 175px); min-height: 440px; border: 0.5px solid var(--color-border-tertiary);
    border-radius: var(--border-radius-lg); overflow: auto; background: var(--color-background-primary); }
  code { font-family: var(--font-mono); background: var(--color-background-primary); padding: 1px 5px; border-radius: 4px; }

  /* mosaic grid */
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
</style>
