<script>
  // "Needs you" triage rail — one ranked list of every session waiting on a human
  // (needs input / errored / finished), with the reason, how long it's waited, and
  // the answer keys right here so you never have to go find the terminal.
  let { agents = [], budget = null, onOpen, onFly, onConfig } = $props();
  let open = $state(false);
  let sentId = $state(null);

  const sid = (a) => a.sessionId || String(a.id).replace(/^sess:/, '');
  async function key(a, keys, label) {
    try {
      await fetch('/api/sendkeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid(a), keys }) });
      sentId = a.id + ':' + label; setTimeout(() => { if (sentId === a.id + ':' + label) sentId = null; }, 1100);
    } catch (_) {}
  }
  function openModal(a) { onOpen?.(a.id); open = false; }
  function find(a) { onFly?.(a); open = false; }

  function age(a) {
    if (!a.updatedAt) return '';
    const s = Math.max(0, Math.round((Date.now() - a.updatedAt) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }

  // awaiting (oldest first = most urgent) → error → finished roots.
  let items = $derived.by(() => {
    const rank = { awaiting: 0, error: 1, done: 2 };
    return agents
      .filter((a) => a.state === 'awaiting' || a.state === 'error' || (a.state === 'done' && a.root))
      .sort((x, y) => (rank[x.state] - rank[y.state]) || ((x.updatedAt || 0) - (y.updatedAt || 0)));
  });
  let count = $derived(items.length + (budget?.overDaily ? 1 : 0));
  const KEYS = [['1', '1'], ['2', '2'], ['3', '3'], ['↑', '{UP}'], ['↓', '{DOWN}'], ['y', 'y'], ['n', 'n'], ['↵', '{ENTER}'], ['esc', '{ESC}']];
  function onKey(e) { if (e.key === 'Escape') open = false; }
</script>

<svelte:window onkeydown={onKey} />

<div class="nu-wrap">
  <button class="select bell" onclick={() => (open = !open)} title="What needs you">🔔{#if count}<span class="bellbadge" class:hot={items.some((a) => a.state === 'awaiting' || a.state === 'error')}>{count}</span>{/if}</button>
  {#if open}
    <div class="nu-backdrop" onclick={() => (open = false)} role="presentation"></div>
    <div class="nu-panel" role="menu">
      <div class="nu-h">Needs you{#if count}<span class="dim"> · {count}</span>{/if}</div>
      {#if !items.length && !budget?.overDaily}
        <div class="nu-empty">All clear — nothing needs you. ✨</div>
      {:else}
        {#if budget?.overDaily}
          <div class="nu-item budget">
            <span class="nu-ic">💸</span>
            <div class="nu-body"><div class="nu-title">Daily budget exceeded</div><div class="nu-sub">${budget.dailyCost?.toFixed(2)} / ${budget.daily}</div></div>
            <div class="nu-actcol"><button class="nu-act" onclick={() => { onConfig?.(); open = false; }}>Open</button></div>
          </div>
        {/if}
        {#each items as a (a.id)}
          <div class="nu-item {a.state}">
            <span class="nu-ic">{a.state === 'awaiting' ? '🔔' : a.state === 'error' ? '⚠️' : '✅'}</span>
            <div class="nu-body">
              <div class="nu-title">{a.name || a.id}{#if a.project}<span class="nu-proj">{a.project}</span>{/if}{#if age(a)}<span class="nu-age">{age(a)}</span>{/if}</div>
              <div class="nu-sub">{a.state === 'awaiting' ? (a.awaitMsg || 'needs your input') : a.state === 'error' ? 'errored — take a look' : 'finished — give it the next task?'}</div>
              {#if a.state === 'awaiting'}
                <div class="nu-keys" title="Types into the session's terminal — keep that window focused">
                  {#each KEYS as [lbl, k] (lbl)}<button class="kk" class:sent={sentId === a.id + ':' + lbl} onclick={() => key(a, k, lbl)}>{lbl}</button>{/each}
                </div>
              {/if}
            </div>
            <div class="nu-actcol">
              <button class="nu-act" onclick={() => openModal(a)}>Open</button>
              <button class="nu-act ghost" onclick={() => find(a)}>Find</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .nu-wrap { position: relative; }
  .bell { position: relative; }
  .bellbadge { position: absolute; top: -5px; right: -4px; background: var(--color-text-tertiary); color: #fff; font-size: 8px; font-weight: 700;
    min-width: 14px; height: 14px; line-height: 14px; text-align: center; border-radius: 7px; padding: 0 3px; }
  .bellbadge.hot { background: #EF4444; }
  .nu-backdrop { position: fixed; inset: 0; z-index: 90; }
  .nu-panel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 95; width: 360px; max-height: 70vh; overflow: auto;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4); padding: 6px; }
  .nu-h { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); padding: 6px 8px 8px; }
  .nu-h .dim { text-transform: none; letter-spacing: 0; }
  .nu-empty { padding: 18px 12px; font-size: 12px; color: var(--color-text-tertiary); text-align: center; }
  .nu-item { display: flex; gap: 9px; padding: 9px; border-radius: var(--border-radius-md); align-items: flex-start; }
  .nu-item + .nu-item { border-top: 0.5px solid var(--color-border-tertiary); }
  .nu-item.awaiting { background: #F59E0B12; }
  .nu-item.error { background: #EF44440f; }
  .nu-ic { font-size: 14px; flex-shrink: 0; line-height: 1.4; }
  .nu-body { flex: 1 1 auto; min-width: 0; }
  .nu-title { font-size: 12.5px; font-weight: 600; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .nu-proj { font-size: 10px; font-weight: 400; color: var(--color-text-tertiary); }
  .nu-age { font-size: 10px; font-weight: 400; color: var(--color-text-tertiary); margin-left: auto; }
  .nu-sub { font-size: 11px; color: var(--color-text-secondary); margin-top: 1px; line-height: 1.4; word-break: break-word; }
  .nu-keys { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 6px; }
  .kk { font-size: 11px; min-width: 22px; padding: 2px 5px; border-radius: 5px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); font-family: var(--font-mono); }
  .kk:hover { border-color: var(--accent, #6366F1); }
  .kk.sent { background: var(--accent, #6366F1); color: #fff; }
  .nu-actcol { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
  .nu-act { font-size: 11px; padding: 3px 9px; border-radius: 5px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .nu-act.ghost { background: none; color: var(--color-text-tertiary); }
  .nu-act:hover { border-color: var(--accent, #6366F1); }
</style>
