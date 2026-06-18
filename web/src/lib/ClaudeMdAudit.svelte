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

  // Per-line approval: { lineNumber: true } means "yes, cut this one". Defaults to all
  // flagged lines approved; uncheck any you want to keep. Apply removes only the checked ones.
  let approved = $state({});
  async function load() {
    loading = true; data = null; copied = false; applyMsg = '';
    try {
      const r = await fetch('/api/claudemd-audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) });
      data = await r.json();
      const next = {};
      // red file-cuts default approved; amber "review" lines are opt-in (default off).
      if (data && data.lines) for (const l of data.lines) {
        if (l.status === 'cut') next[l.n] = true;
        else if (l.status === 'review') next[l.n] = false;
      }
      approved = next;
    } catch (_) {}
    loading = false;
  }
  function toggle(n) { approved = { ...approved, [n]: !approved[n] }; }
  const flaggable = (l) => l.status === 'cut' || l.status === 'review';
  const effRemove = (l) => flaggable(l) && approved[l.n];

  let cutLines = $derived(data && data.lines ? data.lines.filter((l) => l.status === 'cut') : []);
  let reviewLines = $derived(data && data.lines ? data.lines.filter((l) => l.status === 'review') : []);
  let flaggedLines = $derived([...cutLines, ...reviewLines]);
  let approvedLines = $derived(flaggedLines.filter((l) => approved[l.n]));
  let approvedTokens = $derived(approvedLines.reduce((s, l) => s + (l.tokens || 0), 0));
  // the "after" file: every line except the ones approved for removal
  let previewKept = $derived(data && data.lines ? data.lines.filter((l) => !effRemove(l)) : []);
  let trimmed = $derived(previewKept.map((l) => l.text).join('\n'));
  let filePct = $derived(data && data.totalTokens ? Math.round((approvedTokens / data.totalTokens) * 100) : 0);
  let additions = $derived(data && Array.isArray(data.additions) ? data.additions : []);

  let applying = $state(false);
  let applyMsg = $state('');
  async function apply() {
    if (!approvedLines.length || applying) return;
    if (!confirm(`Remove ${approvedLines.length} approved line(s) from CLAUDE.md?\n\nThe original is backed up to CLAUDE.md.bak first. Unchecked lines are kept. Suggested additions are NOT applied — add those yourself.`)) return;
    applying = true; applyMsg = '';
    try {
      const cuts = approvedLines.map((l) => ({ n: l.n, text: l.text }));
      const r = await fetch('/api/claudemd-apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, cuts }) });
      const j = await r.json();
      if (j.ok) { applyMsg = `✓ Removed ${j.applied} line(s) · ~${j.cutTokens} tok freed · backup: ${j.backup ? j.backup.split(/[\\/]/).pop() : 'CLAUDE.md.bak'}`; await load(); }
      else applyMsg = '✗ ' + (j.error || 'failed');
    } catch (_) { applyMsg = '✗ failed — is the bridge running?'; }
    applying = false;
  }

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
        <div class="save" class:lean={!flaggedLines.length} class:warn={flaggedLines.length}>
          {#if flaggedLines.length}
            <span class="big">~{approvedTokens} tokens</span> selected to remove — {approvedLines.length} of {flaggedLines.length} flagged ({filePct}% of this CLAUDE.md){#if reviewLines.length}: <b>{cutLines.length}</b> dead file ref{cutLines.length === 1 ? '' : 's'} <span class="amber-t">+ {reviewLines.length} to review</span>{/if}. <b>Re-sent every turn.</b> Red is checked by default; amber is opt-in.
          {:else}
            <b>Looks lean.</b> No dead file references or stale planning sections.
          {/if}
        </div>

        <div class="legend">
          <span class="lg cut">✓ dead file — cut</span>
          <span class="lg review">⚑ possibly stale — review</span>
          <span class="lg used">file exists / used</span>
          <span class="lg kept">kept · guardrail or prose</span>
        </div>

        <div class="panes">
          <div class="pane">
            <div class="ph">Current <span class="dim">· {data.totalTokens} tok</span></div>
            <div class="code">
              {#each data.lines as l (l.n)}
                <div class="row {effRemove(l) ? 'cut' : (l.status === 'review' ? 'review' : (l.status === 'used' ? 'used' : ''))}" title={l.reason}>
                  {#if flaggable(l)}
                    <input class="ck {l.status}" type="checkbox" checked={approved[l.n]} onchange={() => toggle(l.n)} title="Approve removing this line" aria-label="Approve removing line {l.n}" />
                  {:else}<span class="ck-sp"></span>{/if}
                  <span class="ln">{l.n}</span>
                  <span class="gut">{effRemove(l) ? '−' : ''}</span>
                  <span class="tx">{l.text || ' '}</span>
                </div>
                {#if flaggable(l)}<div class="why {l.status}" class:off={!approved[l.n]}>↳ {l.reason}</div>{/if}
              {/each}
            </div>
          </div>

          <div class="pane">
            <div class="ph">After <span class="dim">· −{approvedTokens} tok</span><button class="mini" onclick={copyTrimmed} disabled={!approvedLines.length}>{copied ? '✓ copied' : 'Copy'}</button></div>
            <div class="code">
              {#each previewKept as l (l.n)}
                <div class="row"><span class="ck-sp"></span><span class="ln">{l.n}</span><span class="gut"></span><span class="tx">{l.text || ' '}</span></div>
              {/each}
            </div>
          </div>
        </div>

        <div class="adds">
          <div class="adds-h">＋ Suggested additions <span class="dim">· used by the project, not in CLAUDE.md — add the useful ones yourself</span></div>
          {#if additions.length}
            {#each additions as a (a.text)}
              <div class="add"><span class="add-tx mono">{a.text}</span><span class="add-why">{a.reason}</span></div>
            {/each}
          {:else}
            <div class="add-empty">✓ Nothing obvious to add — your CLAUDE.md already covers the commands, stack &amp; key files.</div>
          {/if}
        </div>

        {#if cutLines.length}
          <div class="actions">
            <button class="apply" onclick={apply} disabled={applying || !approvedLines.length}>
              {applying ? 'Applying…' : `Apply — remove ${approvedLines.length} line${approvedLines.length === 1 ? '' : 's'}`}
            </button>
            <span class="amsg" class:err={applyMsg.startsWith('✗')}>{applyMsg}</span>
          </div>
        {/if}

        <div class="foot"><b>Red</b> = a <b>file that doesn't exist</b> in the project — a confident cut, checked by default. <b class="amber-t">Amber</b> = possibly-stale planning prose (unchecked to-dos, "open questions / TODO / roadmap" sections) — a soft <i>review</i>, opt-in. Guardrails, commands, real files, and plain prose are kept. Deterministic &amp; compact-proof — it checks files on disk, not the transcript. Review before applying; the original is backed up to <code>CLAUDE.md.bak</code> and the cache savings land next session.</div>
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
  .lg.review::before { background: var(--hm-warn, #F59E0B); }
  .lg.used::before { background: var(--hm-ok, #10B981); }
  .lg.kept::before { background: var(--color-border-secondary); }
  .amber-t { color: var(--hm-warn, #F59E0B); }

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
  .row.review { background: #F59E0B16; }
  .row.review .tx { color: var(--hm-warn, #F59E0B); }
  .row.used { background: #10B9810f; }
  .why { padding: 0 8px 2px 63px; font-size: 9.5px; color: var(--hm-err, #EF4444); opacity: 0.85; white-space: normal; }
  .why.review { color: var(--hm-warn, #F59E0B); }
  .why.off { color: var(--color-text-tertiary); opacity: 0.6; }
  .row .ck { width: 13px; height: 13px; flex-shrink: 0; margin: 0 4px 0 0; cursor: pointer; accent-color: var(--hm-err, #EF4444); align-self: center; }
  .row .ck.review { accent-color: var(--hm-warn, #F59E0B); }
  .row .ck-sp { width: 13px; flex-shrink: 0; margin-right: 4px; }

  .adds { margin: 10px 14px 0; padding: 9px 11px; border-radius: var(--border-radius-md); background: #10B9810f; border: 0.5px solid #10B98140; }
  .adds-h { font-size: 11px; font-weight: 600; color: var(--hm-ok, #10B981); margin-bottom: 6px; }
  .adds-h .dim { font-weight: 400; color: var(--color-text-tertiary); }
  .add { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-size: 11px; }
  .add-tx { color: var(--color-text-primary); flex-shrink: 0; }
  .add-tx::before { content: '+ '; color: var(--hm-ok, #10B981); font-weight: 700; }
  .add-why { color: var(--color-text-tertiary); font-size: 10.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .add-empty { font-size: 11px; color: var(--hm-ok, #10B981); opacity: 0.85; }

  .actions { display: flex; align-items: center; gap: 10px; padding: 11px 14px 2px; }
  .apply { font-size: 12px; font-weight: 600; padding: 7px 14px; border-radius: 6px; cursor: pointer; border: none; background: var(--hm-err, #EF4444); color: #fff; }
  .apply:disabled { opacity: 0.45; cursor: default; }
  .amsg { font-size: 11px; color: var(--hm-ok, #10B981); }
  .amsg.err { color: var(--hm-err, #EF4444); }

  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 10px 14px; border-top: 0.5px solid var(--color-border-tertiary); }

  @media (max-width: 720px) { .panes { flex-direction: column; overflow: auto; } .pane { flex: none; } }
</style>
