<script>
  // "Tune" — two mirrors held up to your recent transcripts:
  //   Prompt habits — how YOU prompt (the "turn tax"): approval-only turns,
  //     keep-alive pokes, correction turns, pasted errors/transcripts — with
  //     copy-paste fixes (a CLAUDE.md line, a skill, a queue habit).
  //   Repeated work — commands/prompts Claude keeps redoing that the right
  //     config (a hook, a /command, a routine) would remove.
  let { open = $bindable(false) } = $props();
  let _w = false;
  $effect(() => { if (open && !_w) load(); _w = open; });

  let loading = $state(false);
  let data = $state(null);          // /api/suggestions (repeated work)
  let habits = $state(null);        // /api/patterns (prompt habits)
  let copied = $state(null);

  async function load() {
    loading = true; data = null; habits = null;
    const [s, p] = await Promise.all([
      fetch('/api/suggestions').then((r) => r.json()).catch(() => ({ suggestions: [] })),
      fetch('/api/patterns?days=30').then((r) => r.json()).catch(() => null),
    ]);
    data = s; habits = p && !p.error ? p : null;
    loading = false;
  }
  function copy(s, i) { try { navigator.clipboard.writeText(s); copied = i; setTimeout(() => { if (copied === i) copied = null; }, 1600); } catch (_) {} }

  const ICON = { hook: '🪝', command: '⚙️', skill: '✨', routine: '📋', 'claude-md': '📜' };
  const COPYLBL = { 'claude-md': 'Copy CLAUDE.md line', hook: 'Copy hook JSON' };
  let taxPct = $derived.by(() => {
    if (!habits || !habits.totals?.prompts) return 0;
    const t = (k) => habits.buckets.find((b) => b.key === k)?.count || 0;
    return Math.round(((t('approval') + t('keepalive')) / habits.totals.prompts) * 100);
  });
  let shownBuckets = $derived(habits ? habits.buckets.filter((b) => b.count > 0) : []);
  let maxCount = $derived(shownBuckets.length ? shownBuckets[0].count : 1);
  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Tune — prompt habits & config suggestions">
    <div class="hd">
      <strong>Tune <span class="dim">· habits & suggestions</span></strong>
      <div class="hdr">
        <button class="select" onclick={load} disabled={loading}>{loading ? 'Scanning…' : 'Rescan'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="body">
      {#if loading}
        <div class="muted">Reading transcripts…</div>
      {:else}
        <!-- ── Prompt habits ─────────────────────────────────────────────── -->
        <div class="sec">Prompt habits <span class="dim">· last {habits?.days || 30} days</span></div>
        {#if !habits || !habits.totals?.prompts}
          <div class="muted">No typed prompts found in the window yet.</div>
        {:else}
          <div class="tiles">
            <div class="tile"><b>{habits.totals.prompts}</b><span>prompts</span></div>
            <div class="tile"><b>{habits.totals.sessions}</b><span>sessions</span></div>
            <div class="tile"><b>{habits.totals.projects}</b><span>projects</span></div>
            <div class="tile tax" class:hot={taxPct >= 10}><b>{taxPct}%</b><span>turn tax</span></div>
          </div>
          <div class="taxnote">Turn tax = turns spent only approving (“yes”, “go”) or poking a quiet session — work you shouldn't have to do.</div>
          <div class="buckets">
            {#each shownBuckets as b (b.key)}
              <div class="brow" title={b.hint + (b.samples.length ? '\n\ne.g. “' + b.samples[0] + '”' : '')}>
                <span class="blbl">{b.label}</span>
                <span class="bbar"><i style="width:{Math.max(3, Math.round((b.count / maxCount) * 100))}%"></i></span>
                <span class="bnum">{b.count}<em>{b.pct}%</em></span>
              </div>
            {/each}
          </div>
          {#each habits.suggestions as s, i (s.title)}
            <div class="card {s.kind}">
              <div class="ttl"><span class="ic">{ICON[s.kind] || '•'}</span><span class="ttx">{s.title}</span><span class="ev">{s.evidence}</span></div>
              <div class="dtl">{s.detail}</div>
              {#if s.snippet}
                <pre class="snip">{s.snippet}</pre>
                <button class="cp" onclick={() => copy(s.snippet, 'h' + i)}>{copied === 'h' + i ? '✓ copied' : (COPYLBL[s.kind] || 'Copy')}</button>
              {/if}
            </div>
          {/each}
        {/if}

        <!-- ── Repeated work ─────────────────────────────────────────────── -->
        <div class="sec">Repeated work {#if data?.scanned}<span class="dim">· {data.scanned} transcripts</span>{/if}</div>
        {#if !data || !data.suggestions?.length}
          <div class="muted">No clear patterns yet — run a few more sessions and rescan. (Looks for commands run ≥4× and prompts repeated ≥2×.)</div>
        {:else}
          {#each data.suggestions as s, i (s.title + i)}
            <div class="card {s.kind}">
              <div class="ttl"><span class="ic">{ICON[s.kind] || '•'}</span><span class="ttx">{s.title}</span><span class="ev">{s.evidence}</span></div>
              <div class="dtl">{s.detail}</div>
              {#if s.snippet}
                <pre class="snip">{s.snippet}</pre>
                <button class="cp" onclick={() => copy(s.snippet, i)}>{copied === i ? '✓ copied' : 'Copy hook JSON'}</button>
              {/if}
            </div>
          {/each}
        {/if}
      {/if}
    </div>

    <div class="foot">Deterministic — same counts every scan, no model calls. Incrementally cached: a rescan re-reads only transcripts that changed, so it's instant. CLAUDE.md lines go in your global <code>~/.claude/CLAUDE.md</code> (Manage → Memory) or a project's. Hooks go in <code>.claude/settings.json</code>; prompts → a <code>/command</code> via <i>component-builder</i>, or a scheduled <b>Routine</b>.</div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 460px; }
  .dim { color: var(--color-text-tertiary); font-weight: 400; }
  .hdr { display: flex; align-items: center; gap: 8px; }
  .body { flex: 1 1 auto; overflow: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 8px 0; }
  .sec { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; color: var(--color-text-tertiary); padding-top: 4px; }
  .sec:not(:first-child) { margin-top: 8px; border-top: 0.5px solid var(--color-border-tertiary); padding-top: 12px; }

  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .tile { border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 7px 4px; text-align: center; }
  .tile b { display: block; font-size: 16px; }
  .tile span { font-size: 9px; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
  .tile.tax b { color: #F59E0B; }
  .tile.tax.hot b { color: #EF4444; }
  .taxnote { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.45; }

  .buckets { display: flex; flex-direction: column; gap: 3px; }
  .brow { display: grid; grid-template-columns: 128px 1fr 58px; align-items: center; gap: 8px; font-size: 11px; cursor: default; }
  .blbl { color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bbar { height: 8px; border-radius: 4px; background: var(--color-background-secondary); overflow: hidden; }
  .bbar i { display: block; height: 100%; background: var(--accent, #6366F1); opacity: 0.75; border-radius: 4px; }
  .bnum { font-family: var(--font-mono); font-size: 10.5px; text-align: right; white-space: nowrap; }
  .bnum em { font-style: normal; color: var(--color-text-tertiary); margin-left: 4px; font-size: 9px; }

  .card { border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 10px 11px; }
  .card.hook { border-left: 2px solid #10B981; }
  .card.command { border-left: 2px solid #3B82F6; }
  .card.skill { border-left: 2px solid #8B5CF6; }
  .card.routine { border-left: 2px solid #F59E0B; }
  .card.claude-md { border-left: 2px solid #EC4899; }
  .ttl { display: flex; align-items: baseline; gap: 7px; }
  .ic { font-size: 13px; }
  .ttx { font-size: 12.5px; font-weight: 600; flex: 1 1 auto; min-width: 0; }
  .ev { font-size: 10px; color: var(--color-text-tertiary); font-family: var(--font-mono); flex-shrink: 0; }
  .dtl { font-size: 11px; color: var(--color-text-secondary); line-height: 1.45; margin-top: 4px; }
  .snip { font-family: var(--font-mono); font-size: 10px; line-height: 1.4; background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: 6px; padding: 7px 8px; margin: 7px 0 5px; overflow: auto; white-space: pre-wrap; }
  .cp { font-size: 10px; padding: 2px 9px; border-radius: 5px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-secondary); }
  .cp:hover { border-color: var(--accent, #6366F1); }
  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 9px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
  .foot code { font-family: var(--font-mono); font-size: 9.5px; }
</style>
