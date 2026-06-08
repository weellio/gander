<script>
  import { STATE_COLORS, STATE_LABEL } from './states.js';

  let { open = $bindable(false) } = $props();

  let events = $state([]);
  let errorsOnly = $state(false);
  let loading = $state(false);
  let timer = null;
  let _w = false;

  $effect(() => {
    if (open && !_w) {
      load();
      timer = setInterval(load, 2000);
      _w = true;
    } else if (!open) {
      clearInterval(timer);
      timer = null;
      _w = false;
    }
  });

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/feed');
      const j = await r.json();
      events = Array.isArray(j.events) ? j.events : [];
    } catch (_) {}
    loading = false;
  }

  function closePanel() { open = false; }

  function onKeydown(e) { if (e.key === 'Escape') closePanel(); }

  const filtered = $derived(
    errorsOnly ? events.filter((ev) => ev.error || ev.state === 'error') : events
  );

  const errorCount = $derived(events.filter((ev) => ev.error || ev.state === 'error').length);

  function relTime(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const s = Math.floor(diff / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function dotColor(ev) {
    if (ev.error || ev.state === 'error') return STATE_COLORS.error;
    return STATE_COLORS[ev.state] ?? '#6B7280';
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Activity feed">
    <div class="hd">
      <strong>Activity Feed</strong>
      <div class="hd-right">
        <button
          class="select toggle"
          class:active={errorsOnly}
          onclick={() => (errorsOnly = !errorsOnly)}
          aria-pressed={errorsOnly}
        >
          Errors only
          {#if errorCount > 0}<span class="badge">{errorCount}</span>{/if}
        </button>
        <button class="select refresh" onclick={load} disabled={loading} aria-label="Refresh">
          {loading ? '…' : '↻'}
        </button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="feed">
      {#if filtered.length === 0}
        <div class="empty">
          {errorsOnly ? 'No errors recorded.' : 'No events yet.'}
        </div>
      {:else}
        {#each filtered as ev (ev.ts + ev.agentId + ev.log)}
          <div class="row" class:is-error={ev.error || ev.state === 'error'}>
            <span class="dot" style="background:{dotColor(ev)}" title={STATE_LABEL[ev.state] ?? ev.state}></span>
            <span class="agent">{ev.agent ?? ev.agentId}</span>
            {#if ev.project}
              <span class="project">{ev.project}</span>
            {/if}
            <span class="log">{ev.log ?? ''}</span>
            <span class="time">{relTime(ev.ts)}</span>
          </div>
        {/each}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .ov {
    position: fixed; inset: 0; z-index: 90;
    background: rgba(0, 0, 0, 0.25);
  }
  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 91;
    width: 400px; max-width: 95vw;
    background: var(--color-background-primary);
    border-left: 0.5px solid var(--color-border-secondary);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.18);
    display: flex; flex-direction: column;
    border-radius: var(--border-radius-lg) 0 0 var(--border-radius-lg);
  }
  .hd {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 0.5px solid var(--color-border-tertiary);
    flex-shrink: 0;
  }
  .hd strong { font-size: 13px; color: var(--color-text-primary); }
  .hd-right { display: flex; align-items: center; gap: 6px; }
  .x {
    background: none; border: none; cursor: pointer;
    font-size: 14px; color: var(--color-text-tertiary);
    padding: 2px 5px;
  }
  .toggle {
    font-size: 10px; padding: 3px 9px;
    border-radius: var(--border-radius-md);
    display: inline-flex; align-items: center; gap: 5px;
  }
  .toggle.active {
    background: var(--accent, #6366F1); color: #fff;
    border-color: transparent;
  }
  .badge {
    display: inline-flex; align-items: center; justify-content: center;
    background: #EF4444; color: #fff;
    border-radius: 99px; font-size: 9px; font-weight: 600;
    min-width: 16px; height: 16px; padding: 0 4px;
    line-height: 1;
  }
  .toggle.active .badge { background: rgba(255,255,255,0.3); }
  .refresh {
    font-size: 14px; padding: 2px 8px;
    border-radius: var(--border-radius-md);
  }
  .feed {
    flex: 1 1 auto; overflow-y: auto;
    padding: 6px 0;
  }
  .empty {
    padding: 24px 16px;
    font-size: 12px; color: var(--color-text-tertiary);
    text-align: center;
  }
  .row {
    display: grid;
    grid-template-columns: 10px auto auto 1fr auto;
    align-items: baseline;
    gap: 6px;
    padding: 6px 14px;
    border-bottom: 0.5px solid var(--color-border-tertiary);
    font-size: 11px;
    transition: background 0.1s;
  }
  .row:hover { background: var(--color-background-secondary); }
  .row.is-error { background: rgba(239, 68, 68, 0.06); }
  .row.is-error:hover { background: rgba(239, 68, 68, 0.1); }
  .dot {
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
  }
  .agent {
    font-weight: 600; white-space: nowrap;
    color: var(--color-text-primary);
    overflow: hidden; text-overflow: ellipsis; max-width: 90px;
  }
  .project {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--color-text-tertiary); font-size: 10px; max-width: 80px;
  }
  .log {
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .time {
    white-space: nowrap; font-size: 9px;
    color: var(--color-text-tertiary);
    font-family: var(--font-mono);
    text-align: right;
  }
</style>
