<script>
  // Ship digest — "what actually got done": sessions + commits + spend over the
  // last N days, parsed from transcripts and git. Deterministic, zero model cost.
  let { open = $bindable(false) } = $props();
  let days = $state(7);
  let d = $state(null);
  let loading = $state(false);
  let flash = $state('');

  async function load() {
    loading = true;
    try { d = await (await fetch('/api/digest?days=' + days)).json(); } catch (_) { d = null; }
    loading = false;
  }
  $effect(() => { if (open) load(); });
  function setDays(n) { days = n; load(); }
  async function copyMd() {
    if (!d?.markdown) return;
    try { await navigator.clipboard.writeText(d.markdown); flash = '✓ copied as markdown'; }
    catch (_) { flash = '✗ clipboard blocked'; }
    setTimeout(() => (flash = ''), 1800);
  }
  const tok = (x) => x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round((x || 0) / 1000) + 'k';
</script>

{#if open}
  <div class="ov" onclick={() => (open = false)} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Ship digest">
    <div class="hd"><strong>📰 Ship digest</strong>
      <span class="range">
        {#each [7, 14, 30] as n (n)}<button class="rb" class:on={days === n} onclick={() => setDays(n)}>{n}d</button>{/each}
      </span>
      <button class="mini" onclick={copyMd} title="Copy the whole digest as markdown (for standups, notes, a blog…)">⧉ Copy md</button>
      <button class="x" onclick={() => (open = false)} aria-label="Close">✕</button>
    </div>

    <div class="body">
      {#if loading && !d}
        <div class="empty">Reading transcripts + git history…</div>
      {:else if !d || d.error}
        <div class="empty">Could not build the digest{d?.error ? ' — ' + d.error : ''}.</div>
      {:else}
        <div class="totals">
          <div class="t"><b>{d.totals.sessions}</b><span>sessions</span></div>
          <div class="t"><b>{d.totals.projects}</b><span>projects</span></div>
          <div class="t"><b>{d.totals.commits}</b><span>commits</span></div>
          <div class="t"><b>${d.totals.costUSD.toFixed(2)}</b><span>{tok(d.totals.tokens)} tok</span></div>
        </div>
        <div class="hint">Everything below is parsed from your <code>~/.claude</code> transcripts and each project's git log — deterministic, no model calls. Spend is estimated at API list prices.</div>

        {#if !d.projects.length}
          <div class="empty">Nothing in the last {d.days} days.</div>
        {/if}
        {#each d.projects as p (p.path || p.project)}
          <div class="proj">
            <div class="ph"><b>{p.project}</b>
              <span class="pm">{p.sessions} session{p.sessions === 1 ? '' : 's'}{p.commits ? ` · ${p.commits} commit${p.commits === 1 ? '' : 's'}` : ''}</span>
            </div>
            {#if p.lastCommits?.length}
              <ul class="commits">
                {#each p.lastCommits as c (c.hash)}<li><code>{c.hash}</code> {c.subject} <span class="cd">{c.date}</span></li>{/each}
                {#if p.commits > p.lastCommits.length}<li class="more">…and {p.commits - p.lastCommits.length} more</li>{/if}
              </ul>
            {/if}
            {#if p.prompts?.length}
              <div class="prompts">Worked on: {#each p.prompts as q, i (q)}{#if i}<span class="sep"> · </span>{/if}<span class="q">“{q}”</span>{/each}</div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
    {#if flash}<div class="statusbar">{flash}</div>{/if}
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 440px; }
  .range { display: flex; gap: 3px; margin-left: 10px; flex: 1; }
  .rb { font-size: 10px; padding: 2px 8px; border-radius: 99px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .rb.on { background: var(--accent, #6366F1); color: #fff; border-color: transparent; }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); margin-right: 8px; }
  .mini:hover { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
  .empty { padding: 20px 8px; font-size: 12px; color: var(--color-text-tertiary); }
  .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .t { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 9px 4px; border-radius: 8px; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); }
  .t b { font-size: 15px; }
  .t span { font-size: 9.5px; color: var(--color-text-tertiary); }
  .hint { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.4; }
  .proj { border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }
  .ph { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
  .pm { font-size: 10.5px; color: var(--color-text-tertiary); }
  .commits { margin: 0; padding-left: 4px; list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .commits li { font-size: 11px; line-height: 1.45; }
  .commits code { font-family: var(--font-mono); font-size: 10px; background: var(--color-background-secondary); padding: 0 4px; border-radius: 4px; }
  .cd { color: var(--color-text-tertiary); font-size: 9.5px; }
  .more { color: var(--color-text-tertiary); font-size: 10px; }
  .prompts { font-size: 10.5px; color: var(--color-text-secondary); line-height: 1.5; }
  .q { font-style: italic; }
  .sep { color: var(--color-text-tertiary); }
  .statusbar { border-top: 0.5px solid var(--color-border-tertiary); padding: 8px 14px; font-size: 11px; color: var(--color-text-secondary); background: var(--color-background-secondary); }
</style>
