<script>
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import Avatar from './Avatar.svelte';
  import SessionInfo from './SessionInfo.svelte';

  let { agent } = $props();

  let msg = $state('');
  let expanded = $state(false);
  let color = $derived(STATE_COLORS[agent.state] || '#6B7280');
  let awaiting = $derived(agent.state === 'awaiting');

  async function send(type) {
    const sessionId = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    try {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type, text: msg }),
      });
      msg = '';
    } catch (_) {}
  }
</script>

<div class="tile" class:idle={agent.state === 'idle'} class:sub={!!agent.parentId} class:awaiting style="--c:{color}" data-id={agent.id}>
  <button class="head" onclick={() => (expanded = !expanded)} title="Toggle details">
    <span class="name">{agent.parentId ? '↳ ' : ''}{agent.name}</span>
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
      <button onclick={() => send('message')}>Send</button>
      <button class="stop" onclick={() => send('stop')}>Stop</button>
    </div>
  {/if}
</div>

<style>
  .tile {
    background: var(--color-background-primary);
    border: 0.5px solid var(--color-border-tertiary);
    border-left: 3px solid var(--c);
    border-radius: var(--border-radius-lg);
    padding: 12px; display: flex; flex-direction: column; gap: 8px;
    min-height: 150px; transition: border-color 0.3s;
  }
  .tile.idle { opacity: 0.7; }
  .tile.sub { margin-left: 6px; }
  .tile.awaiting { opacity: 1; border-left-color: #F59E0B; animation: needpulse 1.2s ease-in-out infinite; }
  @keyframes needpulse { 0%,100%{ box-shadow: 0 0 0 0 rgba(245,158,11,0); } 50%{ box-shadow: 0 0 0 3px rgba(245,158,11,0.45); } }

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
</style>
