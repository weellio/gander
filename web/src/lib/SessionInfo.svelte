<script>
  import { STATE_COLORS } from './states.js';

  let { agent } = $props();

  let info = $state(null);
  let loading = $state(false);
  let failed = $state(false);

  function sessionParam() {
    return agent.sessionId || String(agent.id).replace(/^sess:/, '');
  }

  async function load() {
    loading = true;
    failed = false;
    try {
      const res = await fetch('/api/inspect?session=' + encodeURIComponent(sessionParam()));
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      info = data && typeof data === 'object' ? data : null;
      failed = !info;
    } catch (_) {
      info = null;
      failed = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });

  let skills = $derived((info && Array.isArray(info.skills)) ? info.skills : []);
  let agents = $derived((info && Array.isArray(info.agents)) ? info.agents : []);
  let hooks = $derived((info && Array.isArray(info.hooks)) ? info.hooks : []);
  let subagents = $derived((info && Array.isArray(info.subagents)) ? info.subagents : []);
</script>

<div class="si">
  <div class="si-h">
    <span>Session</span>
    <button class="ref" onclick={load} title="Refresh" disabled={loading}>↻</button>
  </div>

  {#if failed && !info}
    <div class="si-empty">—</div>
  {:else}
    {#if info && info.cwd}
      <div class="cwd">{info.cwd}</div>
    {/if}

    <div class="row">
      <span class="lbl">Skills ({skills.length})</span>
      {#if skills.length}
        <span class="chips">{#each skills as s, i (i)}<span class="chip">{s}</span>{/each}</span>
      {:else}
        <span class="none">none</span>
      {/if}
    </div>

    <div class="row">
      <span class="lbl">Agents ({agents.length})</span>
      {#if agents.length}
        <span class="chips">{#each agents as a, i (i)}<span class="chip">{a}</span>{/each}</span>
      {:else}
        <span class="none">none</span>
      {/if}
    </div>

    <div class="row">
      <span class="lbl">Hooks ({hooks.length})</span>
      {#if hooks.length}
        <span class="chips">{#each hooks as h, i (i)}<span class="chip">{h}</span>{/each}</span>
      {:else}
        <span class="none">none</span>
      {/if}
    </div>

    <div class="row">
      <span class="lbl">Sub-agents ({subagents.length})</span>
      {#if subagents.length}
        <span class="subs">
          {#each subagents as sa (sa.id)}
            <span class="sub"><span class="dot" style="background:{STATE_COLORS[sa.state] || '#6B7280'}"></span>{sa.name}</span>
          {/each}
        </span>
      {:else}
        <span class="none">none</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .si { border-top: 0.5px solid var(--color-border-tertiary); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .si-h { display: flex; align-items: center; justify-content: space-between;
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); }
  .ref { font-size: 11px; line-height: 1; padding: 1px 5px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md);
    background: var(--color-background-primary); color: var(--color-text-secondary); }
  .ref:disabled { opacity: 0.5; cursor: default; }

  .cwd { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; font-size: 10px; }
  .lbl { font-size: 10px; font-weight: 600; color: var(--color-text-primary); white-space: nowrap; }
  .none { font-size: 10px; color: var(--color-text-tertiary); }

  .chips { display: inline-flex; flex-wrap: wrap; gap: 3px; }
  .chip { font-size: 10px; line-height: 1.4; padding: 1px 6px; border-radius: 99px;
    background: var(--color-background-secondary); color: var(--color-text-secondary); }

  .subs { display: inline-flex; flex-wrap: wrap; gap: 4px 8px; }
  .sub { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--color-text-secondary); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }

  .si-empty { font-size: 10px; color: var(--color-text-tertiary); }
</style>
