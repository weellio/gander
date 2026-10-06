<script>
  // 🌙 "While you were away" — one card instead of scrolling the feed.
  // Remembers when this browser last had Gander in view; after 45+ minutes
  // away, it asks the bridge what happened since and shows it once.
  let { onFeed, onQueue } = $props();

  const KEY = 'gander.lastSeen';
  const AWAY_MS = 45 * 60 * 1000;
  let card = $state(null);

  function lastSeen() { try { return Number(localStorage.getItem(KEY)) || 0; } catch (_) { return 0; } }
  function markSeen() { try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {} }

  async function check() {
    const since = lastSeen();
    markSeen();
    if (!since || Date.now() - since < AWAY_MS) return;
    try {
      const j = await (await fetch('/api/away?since=' + since)).json();
      if (j && !j.error) card = j;
    } catch (_) {}
  }

  $effect(() => {
    check();
    // while the tab is in view, keep "last seen" fresh; coming back to a tab
    // that was hidden for a while counts as coming back too
    const t = setInterval(() => { if (!document.hidden) markSeen(); }, 60000);
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  });

  const away = (m) => (m >= 120 ? Math.round(m / 60) + ' hours' : m + ' minutes');
</script>

{#if card}
  <div class="away" role="status">
    <div class="ahd">
      <b>🌙 While you were away</b><span class="dim"> · {away(card.minutes)}</span>
      <span class="sp"></span>
      <button class="x" onclick={() => (card = null)} aria-label="Dismiss">✕</button>
    </div>
    <div class="headline">{card.headline}</div>
    {#if !card.quiet}
      <div class="cols">
        {#if card.waiting.length}
          <div class="col"><div class="ct">🔔 Needs you ({card.waiting.length})</div>
            {#each card.waiting.slice(0, 4) as w}<div class="li"><b>{w.project}</b> {w.why || 'is waiting'}</div>{/each}</div>
        {/if}
        {#if card.failed.length}
          <div class="col"><div class="ct">⚠ Failed ({card.failed.length})</div>
            {#each card.failed.slice(0, 4) as f}<div class="li"><b>{f.project}</b> {f.detail || f.name}</div>{/each}</div>
        {/if}
        {#if card.finished.length}
          <div class="col"><div class="ct">✅ Finished ({card.finished.length})</div>
            {#each card.finished.slice(0, 4) as f}<div class="li"><b>{f.project}</b> {f.goal || f.name}</div>{/each}</div>
        {/if}
      </div>
      <div class="foot">
        {#if card.queue && (card.queue.done || card.queue.failed || card.queue.review)}<span>📋 queue: {card.queue.done} done · {card.queue.failed} failed · {card.queue.review} to review</span>{/if}
        {#if card.blocked}<span>🛡 {card.blocked} risky command{card.blocked === 1 ? '' : 's'} blocked</span>{/if}
        {#if card.collisions}<span>⚠ {card.collisions} file collision{card.collisions === 1 ? '' : 's'}</span>{/if}
        {#if card.held}<span>🌙 {card.held} alert{card.held === 1 ? '' : 's'} held for quiet hours</span>{/if}
        <span class="sp"></span>
        <button class="mini" onclick={() => { onFeed?.(); card = null; }}>Activity feed</button>
        {#if card.queue && (card.queue.done || card.queue.failed || card.queue.review)}<button class="mini" onclick={() => { onQueue?.(); card = null; }}>Queue</button>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .away { margin: 0 0 10px; padding: 12px 14px; border-radius: var(--border-radius-lg); border: 0.5px solid var(--color-border-secondary);
    background: var(--color-background-primary); display: flex; flex-direction: column; gap: 8px; }
  .ahd { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--color-text-primary); }
  .sp { flex: 1; }
  .dim { color: var(--color-text-tertiary); font-weight: 400; font-size: 12px; }
  .x { background: none; border: 0; cursor: pointer; color: var(--color-text-tertiary); font-size: 14px; }
  .headline { font-size: 15px; font-weight: 600; color: var(--color-text-primary); }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .col { display: flex; flex-direction: column; gap: 3px; }
  .ct { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); }
  .li { font-size: 11px; color: var(--color-text-primary); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 11px; color: var(--color-text-secondary); }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
</style>
