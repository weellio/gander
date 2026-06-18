<script>
  // "Tune" — config suggestions mined from your recent session transcripts. Surfaces
  // repeated work (a command run after every edit, a prompt you keep re-typing) and
  // proposes the config that removes it: a PostToolUse hook, a /command, a routine.
  let { open = $bindable(false) } = $props();
  let _w = false;
  $effect(() => { if (open && !_w) load(); _w = open; });

  let loading = $state(false);
  let data = $state(null);
  let copied = $state(null);

  async function load() {
    loading = true; data = null;
    try { data = await (await fetch('/api/suggestions')).json(); } catch (_) { data = { suggestions: [] }; }
    loading = false;
  }
  function copy(s, i) { try { navigator.clipboard.writeText(s); copied = i; setTimeout(() => { if (copied === i) copied = null; }, 1600); } catch (_) {} }

  const ICON = { hook: '🪝', command: '⚙️', skill: '✨', routine: '📋' };
  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Config suggestions">
    <div class="hd">
      <strong>Tune <span class="dim">· suggestions</span></strong>
      <div class="hdr">
        <button class="select" onclick={load} disabled={loading}>{loading ? 'Scanning…' : 'Rescan'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="intro">Patterns from your <b>recent session transcripts</b>{#if data?.scanned}<span class="dim"> ({data.scanned} scanned)</span>{/if}. Repeated work the right config could remove — a hook for a command you keep running, a skill/routine for a prompt you keep typing. Nothing is changed for you; copy what's useful.</div>

    <div class="body">
      {#if loading}
        <div class="muted">Reading transcripts…</div>
      {:else if !data || !data.suggestions?.length}
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
    </div>

    <div class="foot">Hooks go in a project's <code>.claude/settings.json</code> (Manage → Projects → expand a project, or the <i>update-config</i> skill). Prompts → make a <code>/command</code> with <i>component-builder</i>, or a scheduled <b>Routine</b>. Deterministic — same counts every scan.</div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 440px; }
  .dim { color: var(--color-text-tertiary); font-weight: 400; }
  .hdr { display: flex; align-items: center; gap: 8px; }
  .intro { font-size: 11px; color: var(--color-text-secondary); line-height: 1.5; padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .body { flex: 1 1 auto; overflow: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 0; }

  .card { border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 10px 11px; }
  .card.hook { border-left: 2px solid #10B981; }
  .card.command { border-left: 2px solid #3B82F6; }
  .card.skill { border-left: 2px solid #8B5CF6; }
  .ttl { display: flex; align-items: baseline; gap: 7px; }
  .ic { font-size: 13px; }
  .ttx { font-size: 12.5px; font-weight: 600; flex: 1 1 auto; min-width: 0; }
  .ev { font-size: 10px; color: var(--color-text-tertiary); font-family: var(--font-mono); flex-shrink: 0; }
  .dtl { font-size: 11px; color: var(--color-text-secondary); line-height: 1.45; margin-top: 4px; }
  .snip { font-family: var(--font-mono); font-size: 10px; line-height: 1.4; background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: 6px; padding: 7px 8px; margin: 7px 0 5px; overflow: auto; white-space: pre; }
  .cp { font-size: 10px; padding: 2px 9px; border-radius: 5px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-secondary); }
  .cp:hover { border-color: var(--accent, #6366F1); }
  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 9px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
  .foot code { font-family: var(--font-mono); font-size: 9.5px; }
</style>
