<script>
  import { STATE_COLORS, STATE_LABEL } from './states.js';
  import { costAlerts } from './stores.js';
  import Avatar from './Avatar.svelte';

  let { agent, onOpen = () => {} } = $props();

  let color = $derived(STATE_COLORS[agent.state] || '#6B7280');
  let awaiting = $derived(agent.state === 'awaiting');
  function hash(id) { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  let fd = $derived((hash(agent.id) % 50) / 10);
  function open() { onOpen(agent.id); }
</script>

<!-- A click opens the full agent modal (read · reply · stop · transcript · cost · GitHub),
     same as clicking a figure on the office floor. The ✎ on the avatar edits the image. -->
<div class="tile" class:idle={agent.state === 'idle'} class:working={agent.state !== 'idle' && agent.state !== 'done' && !awaiting} class:runaway={agent.runaway && $costAlerts} class:sub={!!agent.parentId} class:awaiting
     role="button" tabindex="0" title="Open — read, reply, stop, transcript"
     onclick={open} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
     style="--c:{color}; --fd:{fd}s" data-id={agent.id}>
  <div class="head">
    <span class="name">{agent.parentId ? '↳ ' : ''}{agent.name}</span>
    {#if $costAlerts && agent.costUSD != null}
      <span class="cost" class:hot={agent.runaway} title={agent.runaway ? `Burning ~$${(agent.burnRate || 0).toFixed(2)}/min — open and Stop it` : `Session cost ≈ $${agent.costUSD.toFixed(2)}`}>
        {#if agent.runaway}💸 ${(agent.burnRate || 0).toFixed(2)}/min{:else}${agent.costUSD.toFixed(2)}{/if}
      </span>
    {/if}
    {#if agent.model && agent.model !== 'inherit'}<span class="model" title="Defined model">{agent.model}</span>{/if}
    <span class="badge">{awaiting ? '🔔 ' : ''}{STATE_LABEL[agent.state] || agent.state}</span>
  </div>

  <div class="avatar"><Avatar {agent} /></div>

  <div class="log">{agent.logLines && agent.logLines[0] ? '› ' + agent.logLines[0] : ''}</div>

  <div class="teaser">{agent.lastMessage ? agent.lastMessage : 'Click to open · reply · stop'}</div>
</div>

<style>
  .tile {
    position: relative; cursor: pointer;
    background: var(--color-background-primary);
    border: 0.5px solid var(--color-border-tertiary);
    border-left: 3px solid var(--c);
    border-radius: var(--border-radius-lg);
    padding: 12px; display: flex; flex-direction: column; gap: 8px;
    min-height: 150px; transition: border-color 0.3s, transform 0.12s ease, box-shadow 0.12s ease;
    animation: float 6s ease-in-out infinite; animation-delay: var(--fd, 0s);
  }
  .tile:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18); border-color: color-mix(in srgb, var(--c) 60%, var(--color-border-tertiary)); }
  .tile:focus-visible { outline: 2px solid var(--accent, #6366F1); outline-offset: 2px; }
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
  .model { font-size: 9px; font-family: var(--font-mono); padding: 2px 6px; border-radius: 99px; white-space: nowrap;
    background: var(--color-background-secondary); color: var(--color-text-tertiary); border: 0.5px solid var(--color-border-tertiary); }
  .tile.sub { margin-left: 6px; }
  .tile.awaiting { opacity: 1; border-left-color: #F59E0B; }
  .tile.awaiting::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
    box-shadow: 0 0 0 0 rgba(245,158,11,0.5); animation: needpulse 1.2s ease-in-out infinite; }
  @keyframes needpulse { 0%,100%{ box-shadow: 0 0 0 0 rgba(245,158,11,0); } 50%{ box-shadow: 0 0 0 4px rgba(245,158,11,0.5); } }

  .head { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; }
  .name { font-size: 12px; font-weight: 500; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; font-weight: 600; color: #fff; background: var(--c); padding: 2px 7px; border-radius: 99px; white-space: nowrap; }
  .tile.awaiting .badge { background: #F59E0B; }
  .avatar { align-self: center; display: flex; align-items: center; justify-content: center; }
  .log {
    font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 14px;
  }
  .teaser {
    margin-top: auto; font-size: 10px; color: var(--color-text-tertiary); line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
</style>
