<script>
  import { STATE_COLORS, STATE_LABEL } from './states.js';

  let { sessionId = $bindable(null) } = $props();

  let loading = $state(false);
  let error = $state('');
  let data = $state(null); // build() result: { project, durationMs, totalTokens, totalCostUSD, events, ... }
  let playhead = $state(0); // ms since session start
  let playing = $state(false);
  let speed = $state(30);   // multiple of real time
  let listEl = $state();
  let timer = null;

  const TICK_MS = 100;

  async function load() {
    if (!sessionId) return;
    stopPlay();
    loading = true;
    error = '';
    data = null;
    playhead = 0;
    try {
      const r = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const j = await r.json();
      if (j && j.ok) {
        data = j;
      } else {
        error = (j && j.error) || 'unknown error';
      }
    } catch (e) {
      error = 'Network error: ' + e.message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (sessionId) load();
  });

  // Clear the interval if the component unmounts mid-playback.
  $effect(() => {
    return () => { if (timer) { clearInterval(timer); timer = null; } };
  });

  function close() {
    stopPlay();
    sessionId = null;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  function startPlay() {
    if (!data || !data.durationMs) return;
    if (playhead >= data.durationMs) playhead = 0; // replay from the top
    playing = true;
    timer = setInterval(() => {
      playhead = Math.min(data.durationMs, playhead + speed * TICK_MS);
      if (playhead >= data.durationMs) stopPlay(); // pause at the end
    }, TICK_MS);
  }

  function stopPlay() {
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function togglePlay() {
    playing ? stopPlay() : startPlay();
  }

  // ── Derived timeline state ────────────────────────────────────────────────
  const events = $derived(data && Array.isArray(data.events) ? data.events : []);
  const durationMs = $derived(data ? data.durationMs || 0 : 0);

  // Index of the current/most recent event at the playhead.
  const currentIdx = $derived.by(() => {
    let idx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i].t <= playhead) idx = i;
      else break;
    }
    return idx;
  });
  const current = $derived(currentIdx >= 0 ? events[currentIdx] : null);

  // Last ~12 events up to the playhead, newest at the bottom.
  const recent = $derived(currentIdx >= 0 ? events.slice(Math.max(0, currentIdx - 11), currentIdx + 1) : []);

  // Timeline strip segments: each event owns the span until the next event.
  const segments = $derived.by(() => {
    if (!events.length) return [];
    const dur = Math.max(1, durationMs);
    return events.map((e, i) => {
      const next = i + 1 < events.length ? events[i + 1].t : dur;
      return {
        e,
        left: (e.t / dur) * 100,
        width: Math.max(0.2, ((next - e.t) / dur) * 100),
      };
    });
  });

  // Auto-scroll the event list to the newest visible event.
  $effect(() => {
    void currentIdx;
    if (listEl) requestAnimationFrame(() => { if (listEl) listEl.scrollTop = listEl.scrollHeight; });
  });

  // ── Formatting ────────────────────────────────────────────────────────────
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtTok(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M tok';
    if (n >= 1000) return Math.round(n / 1000) + 'k tok';
    return n + ' tok';
  }

  function fmtCost(c) {
    return '$' + (c || 0).toFixed(2);
  }

  function colorOf(state) {
    return STATE_COLORS[state] || '#888';
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if sessionId !== null}
  <!-- overlay -->
  <div class="ov" onclick={close} role="presentation"></div>

  <!-- centered modal -->
  <div class="modal" role="dialog" aria-label="Session replay">
    <div class="hd">
      <div class="hd-left">
        <strong class="title">⏪ Replay</strong>
        {#if data}
          <span class="project">{data.project || data.sessionId}</span>
          <span class="meta mono">{String(data.sessionId || sessionId).slice(0, 8)}</span>
          <span class="meta">{fmtClock(durationMs)}</span>
          <span class="meta">{fmtTok(data.totalTokens)} · {fmtCost(data.totalCostUSD)} est</span>
        {:else if loading}
          <span class="meta">Loading…</span>
        {/if}
      </div>
      <button class="x" onclick={close} aria-label="Close">✕</button>
    </div>

    <div class="body">
      {#if loading}
        <div class="empty">Loading replay…</div>
      {:else if error}
        <div class="err">{error}</div>
      {:else if data && events.length === 0}
        <div class="empty">No events in this session.</div>
      {:else if data}
        <!-- timeline strip -->
        <div class="strip" role="presentation">
          {#each segments as seg}
            <button
              class="seg"
              style="left: {seg.left}%; width: {seg.width}%; background: {colorOf(seg.e.state)}"
              title="{fmtClock(seg.e.t)} — {seg.e.label}"
              onclick={() => { playhead = seg.e.t; }}
              aria-label="Jump to {fmtClock(seg.e.t)}"
            ></button>
          {/each}
          <div class="needle" style="left: {durationMs ? (playhead / durationMs) * 100 : 0}%"></div>
        </div>

        <!-- transport -->
        <div class="transport">
          <button class="play" onclick={togglePlay} title={playing ? 'Pause' : 'Play'}>
            {playing ? '⏸' : '▶'}
          </button>
          <input
            class="scrub"
            type="range"
            min="0"
            max={durationMs}
            step="1"
            bind:value={playhead}
            aria-label="Playhead"
          />
          <select class="speed" bind:value={speed} title="Playback speed">
            <option value={10}>10×</option>
            <option value={30}>30×</option>
            <option value={60}>60×</option>
            <option value={120}>120×</option>
          </select>
          <span class="clock mono">{fmtClock(playhead)} / {fmtClock(durationMs)}</span>
        </div>

        <!-- readout at the playhead -->
        <div class="readout">
          {#if current}
            <span class="chip" style="background: {colorOf(current.state)}">{STATE_LABEL[current.state] || current.state}</span>
            <span class="label" title={current.label}>{current.label}</span>
            <span class="stats mono">{fmtTok(current.tokens)} · {fmtCost(current.costUSD)}</span>
          {:else}
            <span class="label dim">Session start — drag the scrubber or press ▶</span>
            <span class="stats mono">0 tok · $0.00</span>
          {/if}
        </div>

        <!-- last ~12 events up to the playhead -->
        <div class="list" bind:this={listEl}>
          {#if recent.length === 0}
            <div class="empty small">Nothing yet at this point in the session.</div>
          {:else}
            {#each recent as e, i (currentIdx - recent.length + 1 + i)}
              <div class="row" class:now={i === recent.length - 1}>
                <span class="dot" style="background: {colorOf(e.state)}"></span>
                <span class="t mono">{fmtClock(e.t)}</span>
                <span class="row-label" title={e.label}>{e.label}</span>
              </div>
            {/each}
          {/if}
        </div>
      {:else}
        <div class="empty">No replay loaded.</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ov {
    position: fixed;
    inset: 0;
    z-index: 128; /* above the agent modal (100) it can be opened from */
    background: rgba(0, 0, 0, 0.35);
  }

  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 129;
    width: 720px;
    max-width: 94vw;
    max-height: 84vh;
    background: var(--color-background-primary);
    border: 0.5px solid var(--color-border-secondary);
    border-radius: var(--border-radius-lg, 12px);
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Header */
  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 0.5px solid var(--color-border-tertiary);
    flex-shrink: 0;
  }
  .hd-left { display: flex; align-items: baseline; gap: 8px; min-width: 0; overflow: hidden; }
  .title { font-size: 13px; color: var(--color-text-primary); white-space: nowrap; }
  .project {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent, #6366F1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta { font-size: 10px; color: var(--color-text-tertiary); white-space: nowrap; }
  .mono { font-family: var(--font-mono); }
  .x {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    color: var(--color-text-tertiary);
    flex-shrink: 0;
    padding: 2px 4px;
  }
  .x:hover { color: var(--color-text-primary); }

  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    overflow: hidden;
    flex: 1 1 auto;
    min-height: 0;
  }

  .empty { font-size: 12px; color: var(--color-text-tertiary); padding: 24px 0; text-align: center; }
  .empty.small { padding: 10px 0; font-size: 11px; }
  .err { font-size: 12px; color: #EF4444; padding: 12px 0; }

  /* Timeline strip */
  .strip {
    position: relative;
    height: 14px;
    border-radius: 4px;
    background: var(--color-background-secondary);
    overflow: hidden;
    flex-shrink: 0;
  }
  .seg {
    position: absolute;
    top: 0;
    bottom: 0;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    opacity: 0.85;
  }
  .seg:hover { opacity: 1; }
  .needle {
    position: absolute;
    top: -1px;
    bottom: -1px;
    width: 2px;
    background: var(--color-text-primary);
    pointer-events: none;
  }

  /* Transport row */
  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .play {
    width: 28px;
    height: 24px;
    font-size: 11px;
    border-radius: var(--border-radius-md, 6px);
    border: 0.5px solid var(--color-border-secondary);
    background: var(--color-background-secondary);
    color: var(--color-text-primary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .play:hover { border-color: var(--accent, #6366F1); }
  .scrub { flex: 1 1 auto; min-width: 0; accent-color: var(--accent, #6366F1); }
  .speed {
    font-size: 10px;
    padding: 2px 4px;
    border-radius: var(--border-radius-md, 6px);
    border: 0.5px solid var(--color-border-secondary);
    background: var(--color-background-secondary);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }
  .clock { font-size: 10px; color: var(--color-text-tertiary); white-space: nowrap; flex-shrink: 0; }

  /* Playhead readout */
  .readout {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 0.5px solid var(--color-border-tertiary);
    border-radius: var(--border-radius-md, 6px);
    background: var(--color-background-secondary);
    flex-shrink: 0;
    min-height: 20px;
  }
  .chip {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 7px;
    border-radius: 99px;
    color: #fff;
    flex-shrink: 0;
  }
  .label {
    font-size: 11px;
    color: var(--color-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
  }
  .label.dim { color: var(--color-text-tertiary); }
  .stats { font-size: 10px; color: var(--color-text-secondary); white-space: nowrap; flex-shrink: 0; }

  /* Recent-events list */
  .list {
    flex: 1 1 auto;
    min-height: 90px;
    max-height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px;
    border-radius: var(--border-radius-md, 6px);
    opacity: 0.75;
  }
  .row.now {
    opacity: 1;
    background: var(--color-background-secondary);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .t { font-size: 9px; color: var(--color-text-tertiary); flex-shrink: 0; width: 34px; text-align: right; }
  .row-label {
    font-size: 11px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .row.now .row-label { color: var(--color-text-primary); }
</style>
