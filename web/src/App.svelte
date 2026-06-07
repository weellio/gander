<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './lib/states.js';
  import AgentTile from './lib/AgentTile.svelte';

  let agents = $state([]);
  let projects = $state([]);
  let online = $state(false);
  let selectedProject = $state(localStorage.getItem('aoc-project') || '');

  async function poll() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      agents = d.agents || [];
      projects = d.projects || [];
      online = true;
    } catch (_) {
      online = false;
    }
  }

  onMount(() => {
    poll();
    const id = setInterval(poll, 500);
    return () => clearInterval(id);
  });

  // derived: filtered agents + state counts for the current scope
  let shown = $derived(
    selectedProject ? agents.filter((a) => (a.project || 'unknown') === selectedProject) : agents
  );
  let counts = $derived.by(() => {
    const c = {};
    for (const a of shown) c[a.state] = (c[a.state] || 0) + 1;
    return c;
  });
  let sessionCount = $derived(new Set(shown.map((a) => a.sessionId).filter(Boolean)).size);

  function pickProject(e) {
    selectedProject = e.target.value;
    localStorage.setItem('aoc-project', selectedProject);
  }
</script>

<div class="dashboard">
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
    <div class="empty">
      No agents reporting yet. Run <code>/hooks</code> in a Claude Code session (or start a new one) to begin.
    </div>
  {:else}
    <div class="grid">
      {#each shown as agent (agent.id)}
        <AgentTile {agent} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .dashboard { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 1500px; margin: 0 auto; }
  .top-bar, .statusbar {
    display: flex; align-items: center; gap: 12px; padding: 10px 14px;
    background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-lg);
  }
  .top-bar { justify-content: space-between; }
  .title { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #9CA3AF; }
  .dot.online { background: #10B981; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .select {
    font-size: 12px; padding: 5px 10px; border-radius: var(--border-radius-md);
    border: 0.5px solid var(--color-border-secondary);
    background: var(--color-background-primary); color: var(--color-text-primary);
  }
  .statusbar { font-size: 11px; color: var(--color-text-secondary); flex-wrap: wrap; }
  .cnt { display: inline-flex; align-items: center; gap: 4px; }
  .cnt i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
  .empty { padding: 40px; text-align: center; color: var(--color-text-tertiary); font-size: 13px; }
  code { font-family: var(--font-mono); background: var(--color-background-primary); padding: 1px 5px; border-radius: 4px; }
</style>
