<script>
  // CLAUDE.md dead-weight audit — a before/after view that flags lines referencing
  // files/commands that never appear in the project's actual activity, with the
  // reason for each, and the window real-estate they cost every turn.
  let { open = $bindable(false), cwd = '' } = $props();
  let _w = false;
  let data = $state(null);
  let loading = $state(false);
  let copied = $state(false);

  $effect(() => { if (open && !_w && cwd) load(); _w = open; });

  async function load() {
    loading = true; data = null; copied = false;
    try {
      const r = await fetch('/api/claudemd-audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) });
      data = await r.json();
    } catch (_) {}
    loading = false;
  }
  let cutLines = $derived(data && data.lines ? data.lines.filter((l) => l.status === 'cut') : []);
  let kept = $derived(data && data.lines ? data.lines.filter((l) => l.status !== 'cut') : []);
  let trimmed = $derived(kept.map((l) => l.text).join('\n'));
  let filePct = $derived(data && data.totalTokens ? Math.round((data.cutTokens / data.totalTokens) * 100) : 0);

  function copyTrimmed() { try { navigator.clipboard.writeText(trimmed); copied = true; setTimeout(() => (copied = false), 1800); } catch (_) {} }
  function close() { open = false; }
  function onKey(e) { if (e.key === 'Escape') close(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="backdrop" onclick={close} role="presentation">
    <div class="modal" role="dialog" aria-label="CLAUDE.md audit" onclick={(e) => e.stopPropagation()}>
      <div class="hd">
        <strong>CLAUDE.md audit</strong>
        {#if cwd}<span class="proj mono">{cwd.split(/[\\/]/).filter(Boolean).pop()}</span>{/if}
        <button class="x" onclick={close} aria-label="Close">✕</button>
      </div>

      {#if loading}
        <div class="muted">Scanning this project's transcripts…</div>
      {:else if !data || !data.exists}
        <div class="muted">No CLAUDE.md found for this project.</div>
      {:else}
        <div class="save" class:lean={data.measured && !data.cutTokens} class:warn={data.cutTokens}>
          {#if !data.measured}
            <b>No activity history yet.</b> Run this project a few times and I can measure which lines are dead weight. (Showing the file only.)
          {:else if data.cutTokens}
            <span class="big">~{data.cutTokens} tokens</span> of likely dead weight — {cutLines.length} line{cutLines.length === 1 ? '' : 's'}, {filePct}% of this CLAUDE.md, <b>re-sent every turn</b> before the agent reads a thing.
          {:else}
            <b>Looks lean.</b> No line references a file or command that never shows up in this project's activity.
          {/if}
        </div>

        <div class="legend">
          <span class="lg cut">flagged · referenced, never used</span>
          <span class="lg used">used in activity</span>
          <span class="lg kept">kept · guardrail or prose</span>
        </div>

        <div class="panes">
          <div class="pane">
            <div class="ph">Current <span class="dim">· {data.totalTokens} tok</span></div>
            <div class="code">
              {#each data.lines as l (l.n)}
                <div class="row {l.status}" title={l.reason}>
                  <span class="ln">{l.n}</span>
                  <span class="gut">{l.status === 'cut' ? '−' : ''}</span>
                  <span class="tx">{l.text || ' '}</span>
                </div>
                {#if l.status === 'cut'}<div class="why">↳ {l.reason}</div>{/if}
              {/each}
            </div>
          </div>

          <div class="pane">
            <div class="ph">Trimmed <span class="dim">· −{data.cutTokens} tok</span><button class="mini" onclick={copyTrimmed} disabled={!data.cutTokens}>{copied ? '✓ copied' : 'Copy'}</button></div>
            <div class="code">
              {#each kept as l (l.n)}
                <div class="row"><span class="ln">{l.n}</span><span class="gut"></span><span class="tx">{l.text || ' '}</span></div>
              {/each}
            </div>
          </div>
        </div>

        <div class="foot">A line is flagged <b>only</b> if it names a file/command/tool that <b>never appears</b> in this project's real transcripts — and it isn't a guardrail or plain prose (those are kept on purpose; "unused" ≠ "safe to cut"). Review before applying. Editing CLAUDE.md busts the prompt cache, so the savings land on the next session.</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 140; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(1px); padding: 24px; }
  .modal { width: 880px; max-width: 100%; max-height: calc(100vh - 56px); overflow: hidden; display: flex; flex-direction: column;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4); }
  .hd { display: flex; align-items: center; gap: 9px; padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .hd strong { font-size: 14px; }
  .proj { font-size: 11px; color: var(--color-text-tertiary); }
  .x { margin-left: auto; background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .mono { font-family: var(--font-mono); }
  .muted { padding: 28px 16px; font-size: 12px; color: var(--color-text-tertiary); }

  .save { margin: 12px 14px 0; padding: 9px 12px; border-radius: var(--border-radius-md); font-size: 12px; line-height: 1.5;
    background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); }
  .save.warn { background: #F59E0B14; border-color: #F59E0B55; color: var(--color-text-primary); }
  .save.lean { background: #10B98114; border-color: #10B98155; }
  .save .big { font-size: 16px; font-weight: 700; color: var(--hm-warn, #F59E0B); }

  .legend { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 14px 2px; font-size: 10px; color: var(--color-text-tertiary); }
  .lg { display: inline-flex; align-items: center; gap: 5px; }
  .lg::before { content: ''; width: 9px; height: 9px; border-radius: 2px; }
  .lg.cut::before { background: var(--hm-err, #EF4444); }
  .lg.used::before { background: var(--hm-ok, #10B981); }
  .lg.kept::before { background: var(--color-border-secondary); }

  .panes { flex: 1 1 auto; display: flex; gap: 10px; padding: 8px 14px 0; overflow: hidden; }
  .pane { flex: 1 1 50%; min-width: 0; display: flex; flex-direction: column; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); overflow: hidden; }
  .ph { display: flex; align-items: center; gap: 6px; padding: 5px 9px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--color-text-tertiary); background: var(--color-background-secondary); border-bottom: 0.5px solid var(--color-border-tertiary); }
  .ph .dim { text-transform: none; letter-spacing: 0; }
  .ph .mini { margin-left: auto; font-size: 10px; padding: 1px 8px; border-radius: 5px; cursor: pointer; text-transform: none; letter-spacing: 0;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-secondary); }
  .ph .mini:disabled { opacity: 0.4; cursor: default; }
  .code { flex: 1 1 auto; overflow: auto; padding: 4px 0; font-family: var(--font-mono); font-size: 10.5px; line-height: 1.55; }
  .row { display: flex; align-items: baseline; gap: 0; padding: 0 8px; white-space: pre; }
  .row .ln { width: 30px; flex-shrink: 0; text-align: right; padding-right: 8px; color: var(--color-text-tertiary); opacity: 0.6; user-select: none; }
  .row .gut { width: 12px; flex-shrink: 0; color: var(--hm-err, #EF4444); font-weight: 700; }
  .row .tx { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--color-text-primary); }
  .row.cut { background: #EF44441a; }
  .row.cut .tx { text-decoration: line-through; color: var(--hm-err, #EF4444); opacity: 0.85; }
  .row.used { background: #10B9810f; }
  .why { padding: 0 8px 2px 50px; font-size: 9.5px; color: var(--hm-err, #EF4444); opacity: 0.85; white-space: normal; }

  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 10px 14px; border-top: 0.5px solid var(--color-border-tertiary); }

  @media (max-width: 720px) { .panes { flex-direction: column; overflow: auto; } .pane { flex: none; } }
</style>
