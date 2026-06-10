<script>
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { costAlerts } from './stores.js';
  import Avatar from './Avatar.svelte';
  import SessionInfo from './SessionInfo.svelte';

  let { agent } = $props();

  let msg = $state('');
  let expanded = $state(false);
  let flash = $state('');
  let busy = $state('');
  let flashTimer;
  let color = $derived(STATE_COLORS[agent.state] || '#6B7280');
  let awaiting = $derived(agent.state === 'awaiting');
  function hash(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  let fd = $derived((hash(agent.id) % 50) / 10);

  function showFlash(text) {
    flash = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = ''; }, 2200);
  }
  async function send(type) {
    if (busy) return;
    if (type === 'message' && !msg.trim()) { showFlash('⚠ type a message first'); return; }
    const sessionId = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    busy = type;
    try {
      const r = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type, text: msg }),
      });
      if (r.ok) { showFlash(type === 'stop' ? '■ Stop sent' : '✓ Message sent'); if (type === 'message') msg = ''; }
      else showFlash('✗ Failed');
    } catch (_) { showFlash('✗ Failed'); }
    finally { busy = ''; }
  }
</script>

<div class="tile" class:idle={agent.state === 'idle'} class:working={agent.state !== 'idle' && agent.state !== 'done' && !awaiting} class:runaway={agent.runaway && $costAlerts} class:sub={!!agent.parentId} class:awaiting style="--c:{color}; --fd:{fd}s" data-id={agent.id}>
  <button class="head" onclick={() => (expanded = !expanded)} title="Toggle details">
    <span class="name">{agent.parentId ? '↳ ' : ''}{agent.name}</span>
    {#if $costAlerts && agent.costUSD != null}
      <span class="cost" class:hot={agent.runaway} title={agent.runaway ? `Burning ~$${(agent.burnRate || 0).toFixed(2)}/min — click and Stop it` : `Session cost ≈ $${agent.costUSD.toFixed(2)}`}>
        {#if agent.runaway}💸 ${(agent.burnRate || 0).toFixed(2)}/min{:else}${agent.costUSD.toFixed(2)}{/if}
      </span>
    {/if}
    <span class="badge">{awaiting ? '🔔 ' : ''}{STATE_LABEL[agent.state] || agent.state}</span>
  </button>

  <div class="avatar"><Avatar {agent} /></div>

  <div class="log">{agent.logLines && agent.logLines[0] ? '› ' + agent.logLines[0] : ''}</div>

  {#if expanded}
    <div class="panel">
      <div class="lm-h">Last message</div>
      {#if agent.lastMessage}
        <div class="lm">{agent.lastMessage}</div>
      {:else}
        <div class="lm-empty">Captured after the agent finishes a turn.</div>
      {/if}
      {#if agent.logLines && agent.logLines.length}
        <div class="lm-h">Recent activity</div>
        <ul class="logs">{#each agent.logLines.slice(0, 6) as l, i (i)}<li>{l}</li>{/each}</ul>
      {/if}
      {#if agent.root}<SessionInfo {agent} />{/if}
    </div>
  {/if}

  {#if agent.root}
    <div class="ctl">
      <input bind:value={msg} placeholder="message / question…" onkeydown={(e) => e.key === 'Enter' && send('message')} />
      <button disabled={busy === 'message'} onclick={() => send('message')}>{busy === 'message' ? '…' : 'Send'}</button>
      <button class="stop" disabled={busy === 'stop'} onclick={() => send('stop')}>{busy === 'stop' ? '…' : 'Stop'}</button>
    </div>
    {#if flash}<div class="flash" class:err={flash[0] === '✗' || flash[0] === '⚠'}>{flash}</div>{/if}
  {/if}
</div>

<style>
  .tile {
    position: relative;
    background: var(--color-background-primary);
    border: 0.5px solid var(--color-border-tertiary);
    border-left: 3px solid var(--c);
    border-radius: var(--border-radius-lg);
    padding: 12px; display: flex; flex-direction: column; gap: 8px;
    min-height: 150px; transition: border-color 0.3s;
    animation: float 6s ease-in-out infinite; animation-delay: var(--fd, 0s);
  }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  @media (prefers-reduced-motion: reduce) { .tile { animation: none; } }
  .tile.idle { opacity: 0.62; }
  .tile.idle::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
    border: 1.5px dashed rgba(245, 158, 11, 0.5); animation: idleflag 2.2s ease-in-out infinite; }
  @keyframes idleflag { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.9; } }
  .tile.working { border-color: color-mix(in srgb, var(--c) 50%, var(--color-border-tertiary)); }
  .tile.working::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
    box-shadow: 0 0 14px -1px var(--c); animation: workglow 2.4s ease-in-out infinite; }
  @keyframes workglow { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.7; } }
  .tile.runaway { border-left-color: #EF4444; border-color: color-mix(in srgb, #EF4444 55%, var(--color-border-tertiary)); }
  .tile.runaway::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); animation: burnpulse 1s ease-in-out infinite; }
  @keyframes burnpulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } 50% { box-shadow: 0 0 0 5px rgba(239, 68, 68, 0.6); } }
  .cost { font-size: 9px; font-family: var(--font-mono); padding: 2px 6px; border-radius: 99px; white-space: nowrap;
    background: var(--color-background-secondary); color: var(--color-text-secondary); border: 0.5px solid var(--color-border-tertiary); }
  .cost.hot { background: #EF4444; color: #fff; border-color: #EF4444; }
  .tile.sub { margin-left: 6px; }
  .tile.awaiting { opacity: 1; border-left-color: #F59E0B; }
  .tile.awaiting::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
    box-shadow: 0 0 0 0 rgba(245,158,11,0.5); animation: needpulse 1.2s ease-in-out infinite; }
  @keyframes needpulse { 0%,100%{ box-shadow: 0 0 0 0 rgba(245,158,11,0); } 50%{ box-shadow: 0 0 0 4px rgba(245,158,11,0.5); } }

  .head { display: flex; align-items: center; justify-content: space-between; gap: 6px;
    background: none; border: none; padding: 0; width: 100%; cursor: pointer; text-align: left; color: inherit; font: inherit; }
  .name { font-size: 12px; font-weight: 500; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; font-weight: 600; color: #fff; background: var(--c); padding: 2px 7px; border-radius: 99px; white-space: nowrap; }
  .tile.awaiting .badge { background: #F59E0B; }
  .avatar { align-self: center; display: flex; align-items: center; justify-content: center; }
  .log {
    font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 14px;
  }

  .panel { border-top: 0.5px solid var(--color-border-tertiary); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .lm-h { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); }
  .lm { font-size: 11px; color: var(--color-text-primary); max-height: 130px; overflow: auto; white-space: pre-wrap;
    background: var(--color-background-secondary); border-radius: 6px; padding: 6px; line-height: 1.4; }
  .lm-empty { font-size: 10px; color: var(--color-text-tertiary); }
  .logs { margin: 0; padding-left: 16px; font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary); }

  .ctl { display: flex; gap: 4px; margin-top: auto; }
  .ctl input {
    flex: 1 1 auto; min-width: 0; font-size: 10px; padding: 4px 6px;
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md);
    background: var(--color-background-secondary); color: var(--color-text-primary);
  }
  .ctl button {
    font-size: 10px; padding: 4px 7px; border-radius: var(--border-radius-md);
    border: 0.5px solid var(--color-border-secondary); cursor: pointer;
    background: var(--color-background-primary); color: var(--color-text-primary);
  }
  .ctl button.stop { color: #EF4444; border-color: #EF4444; }
  .ctl button { transition: transform 0.06s ease, background 0.12s ease, box-shadow 0.12s ease; }
  .ctl button:active:not(:disabled) { transform: translateY(1px) scale(0.96); box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25); }
  .ctl button:disabled { opacity: 0.6; cursor: default; }
  .flash { font-size: 10px; font-weight: 600; color: #10B981; margin-top: 2px; animation: flashin 0.18s ease; }
  .flash.err { color: #EF4444; }
  @keyframes flashin { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
</style>
