<script>
  import { onMount } from 'svelte';
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import TranscriptPanel from './TranscriptPanel.svelte';

  let { id, onClose } = $props();
  let agent = $state(null);
  let info = $state(null);
  let msg = $state('');
  let cost = $state(null);
  let txId = $state(null);
  let sid = $derived(agent ? (agent.sessionId || String(agent.id).replace(/^sess:/, '')) : '');

  async function refresh() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const d = await r.json();
      const found = (d.agents || []).find((a) => String(a.id) === String(id));
      if (found) agent = found;
    } catch (_) {}
  }
  async function loadInfo() {
    if (!agent || !agent.root) return;
    try {
      const sid = agent.sessionId || String(agent.id).replace(/^sess:/, '');
      const r = await fetch('/api/inspect?session=' + encodeURIComponent(sid));
      info = await r.json();
    } catch (_) {}
  }
  async function loadCost() {
    if (!sid) return;
    try { const r = await fetch('/api/usage'); const j = await r.json(); cost = (j.bySession && j.bySession[sid]) || null; } catch (_) {}
  }
  onMount(() => {
    refresh().then(() => { loadInfo(); loadCost(); });
    const t = setInterval(refresh, 1200);
    return () => clearInterval(t);
  });

  async function send(type) {
    if (!agent) return;
    const sid = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    try {
      await fetch('/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, type, text: msg }),
      });
      msg = '';
    } catch (_) {}
  }
  async function openIn(target) {
    if (!agent || !agent.cwd) return;
    try { await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: agent.cwd, target }) }); } catch (_) {}
  }
  function onKey(e) { if (e.key === 'Escape') onClose(); }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" onclick={onClose} role="presentation">
  <div class="modal" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} style="--c:{agent ? (STATE_COLORS[agent.state] || '#6B7280') : '#6B7280'}">
    {#if agent}
      <div class="hd">
        <span class="dot"></span>
        <span class="name" title={agent.name}>{agent.name}</span>
        <span class="badge">{STATE_LABEL[agent.state] || agent.state}</span>
        <button class="x" onclick={onClose} aria-label="Close">✕</button>
      </div>
      <div class="meta">
        {#if agent.project}<span>{agent.project}</span>{/if}
        {#if agent.sessionId}<span class="mono">· {String(agent.sessionId).slice(0, 8)}</span>{/if}
        {#if agent.parentId}<span>· sub-agent</span>{/if}
        {#if agent.role}<span title="Agent type">· {agent.role}</span>{/if}
        {#if cost}<span class="mono" title="This session's estimated spend">· 💰 ${cost.costUSD.toFixed(2)}</span>{/if}
      </div>
      {#if agent.cwd}<div class="path mono">{agent.cwd}</div>{/if}

      <div class="sec">
        <div class="lbl">Current task / last message</div>
        {#if agent.lastMessage}<div class="lm">{agent.lastMessage}</div>{:else}<div class="dim">No captured message yet (appears after the agent finishes a turn).</div>{/if}
      </div>

      {#if agent.logLines && agent.logLines.length}
        <div class="sec"><div class="lbl">Recent activity</div>
          <ul class="logs">{#each agent.logLines.slice(0, 6) as l, i (i)}<li>{l}</li>{/each}</ul>
        </div>
      {/if}

      {#if info}
        <div class="sec chips">
          <span class="chip">Skills: {info.skills && info.skills.length ? info.skills.join(', ') : '—'}</span>
          <span class="chip">Sub-agents: {(info.subagents && info.subagents.length) || 0}</span>
          <span class="chip">Hooks: {(info.hooks && info.hooks.length) || 0}</span>
        </div>
      {/if}

      {#if agent.cwd || sid}
        <div class="actions">
          {#if sid}<button class="select" onclick={() => (txId = sid)}>📄 Transcript</button>{/if}
          {#if agent.cwd}<button class="select" onclick={() => openIn('folder')}>📂 Open folder</button>{/if}
          {#if agent.cwd}<button class="select" onclick={() => openIn('editor')}>Open in VS Code</button>{/if}
        </div>
      {/if}

      <div class="reply">
        <input bind:value={msg} placeholder="reply / send a task…" onkeydown={(e) => e.key === 'Enter' && send('message')} />
        <button onclick={() => send('message')}>Send</button>
        <button class="stop" onclick={() => send('stop')}>Stop</button>
      </div>
      <div class="foot">Replies are delivered when the agent next checks in. “Stop” halts it at its next tool.</div>
    {:else}
      <div class="dim" style="padding:8px 4px">Agent not found — it may have finished.</div>
      <button onclick={onClose}>Close</button>
    {/if}
  </div>
</div>

<TranscriptPanel bind:sessionId={txId} />

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.35); backdrop-filter: blur(1px);
  }
  .modal {
    width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 80px); overflow: auto;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-left: 3px solid var(--c);
    border-radius: var(--border-radius-lg); padding: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    display: flex; flex-direction: column; gap: 10px;
  }
  .hd { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
  .name { font-size: 14px; font-weight: 600; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 10px; font-weight: 600; color: #fff; background: var(--c); padding: 2px 8px; border-radius: 99px; }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .meta { font-size: 11px; color: var(--color-text-secondary); display: flex; gap: 4px; flex-wrap: wrap; }
  .path { font-size: 10px; color: var(--color-text-tertiary); word-break: break-all; }
  .mono { font-family: var(--font-mono); }
  .sec { display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .lm { font-size: 12px; line-height: 1.45; white-space: pre-wrap; background: var(--color-background-secondary);
    border-radius: 8px; padding: 8px; max-height: 200px; overflow: auto; }
  .dim { font-size: 11px; color: var(--color-text-tertiary); }
  .logs { margin: 0; padding-left: 16px; font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary); }
  .chips { flex-direction: row; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 10px; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary);
    border-radius: 99px; padding: 3px 8px; color: var(--color-text-secondary); }
  .reply { display: flex; gap: 6px; }
  .reply input { flex: 1 1 auto; min-width: 0; font-size: 12px; padding: 6px 8px;
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md);
    background: var(--color-background-secondary); color: var(--color-text-primary); }
  .reply button { font-size: 11px; padding: 6px 10px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-primary); }
  .reply button.stop { color: #EF4444; border-color: #EF4444; }
  .foot { font-size: 10px; color: var(--color-text-tertiary); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
