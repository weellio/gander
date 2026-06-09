<script>
  // Quick launcher. Items come from the parent: { label, sub?, action }.
  let { open = $bindable(false), items = [] } = $props();
  let q = $state('');
  let sel = $state(0);
  let inputEl = $state();

  let filtered = $derived.by(() => {
    const s = q.trim().toLowerCase();
    const list = s ? items.filter((i) => (i.label + ' ' + (i.sub || '')).toLowerCase().includes(s)) : items;
    return list.slice(0, 50);
  });

  $effect(() => { if (open && inputEl) { inputEl.focus(); inputEl.select(); } });
  $effect(() => { sel = 0; void q; });

  function run(i) { open = false; q = ''; try { i.action(); } catch (_) {} }
  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') { open = false; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[sel]) run(filtered[sel]); }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={() => (open = false)} role="presentation"></div>
  <div class="pal" role="dialog" aria-label="Command palette">
    <input class="inp" bind:this={inputEl} bind:value={q} placeholder="Jump to a panel or an agent…" spellcheck="false" />
    <div class="list">
      {#each filtered as it, i (it.label + i)}
        <button class="it" class:sel={i === sel} onclick={() => run(it)} onmouseenter={() => (sel = i)}>
          <span class="lbl">{it.label}</span>{#if it.sub}<span class="sub">{it.sub}</span>{/if}
        </button>
      {/each}
      {#if filtered.length === 0}<div class="none">No matches</div>{/if}
    </div>
    <div class="foot"><kbd>/</kbd> opens this · <kbd>↑↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>esc</kbd> close</div>
  </div>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, 0.35); }
  .pal { position: fixed; z-index: 121; top: 12vh; left: 50%; transform: translateX(-50%); width: 540px; max-width: 92vw;
    background: var(--color-background-primary); border: 0.5px solid var(--color-border-secondary);
    border-radius: var(--border-radius-lg); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4); display: flex; flex-direction: column; overflow: hidden; }
  .inp { font-size: 14px; padding: 13px 16px; border: none; border-bottom: 0.5px solid var(--color-border-tertiary);
    background: transparent; color: var(--color-text-primary); outline: none; }
  .list { max-height: 50vh; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
  .it { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; background: none; border: none; cursor: pointer;
    padding: 8px 10px; border-radius: var(--border-radius-md); color: var(--color-text-primary); font: inherit; }
  .it.sel { background: var(--accent, #6366F1); color: #fff; }
  .lbl { font-size: 13px; flex: 0 0 auto; }
  .sub { font-size: 11px; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .it.sel .sub { color: rgba(255, 255, 255, 0.75); }
  .none { padding: 16px; font-size: 12px; color: var(--color-text-tertiary); text-align: center; }
  .foot { padding: 7px 14px; border-top: 0.5px solid var(--color-border-tertiary); font-size: 10px; color: var(--color-text-tertiary); }
  kbd { font-family: var(--font-mono); font-size: 9px; background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: 4px; padding: 0 4px; }
</style>
