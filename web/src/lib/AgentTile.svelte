<script>
  import { STATE_COLORS, STATE_LABEL } from './states.js';

  let { agent } = $props();

  let msg = $state('');
  let color = $derived(STATE_COLORS[agent.state] || '#6B7280');
  let initial = $derived(((agent.name || '?').trim()[0] || '?').toUpperCase());

  async function send(type) {
    const sessionId = agent.sessionId || String(agent.id).replace(/^sess:/, '');
    try {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type, text: msg }),
      });
      msg = '';
    } catch (_) { /* ignore */ }
  }
</script>

<div class="tile" class:idle={agent.state === 'idle'} class:sub={!!agent.parentId} style="--c:{color}">
  <div class="head">
    <span class="name">{agent.parentId ? '↳ ' : ''}{agent.name}</span>
    <span class="badge">{STATE_LABEL[agent.state] || agent.state}</span>
  </div>

  <div class="avatar">{initial}</div>

  <div class="log">{agent.logLines && agent.logLines[0] ? '› ' + agent.logLines[0] : ''}</div>

  {#if agent.root}
    <div class="ctl">
      <input
        bind:value={msg}
        placeholder="message / question…"
        onkeydown={(e) => e.key === 'Enter' && send('message')} />
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
  .head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .name { font-size: 12px; font-weight: 500; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; font-weight: 600; color: #fff; background: var(--c); padding: 2px 7px; border-radius: 99px; white-space: nowrap; }
  .avatar {
    align-self: center; width: 52px; height: 52px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; font-weight: 600; color: #fff; background: var(--c);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 25%, transparent);
  }
  .log {
    font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 14px;
  }
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
