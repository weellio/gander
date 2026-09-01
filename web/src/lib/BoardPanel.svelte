<script>
  // Coordination board — the shared notes agents leave each other on a project,
  // so a swarm builds on each other's work instead of re-deriving it. You can
  // read it, pin what matters, resolve escalations, post your own note, or clear
  // it. The whole point is that it's yours to see — never a hidden side-channel.
  let { open = $bindable(false), project = $bindable('') } = $props();
  let summary = $state([]);       // [{project,total,pinned,escalations,latest}]
  let entries = $state([]);
  let filter = $state('');        // '' | note | finding | escalation
  let note = $state('');
  let flash = $state('');
  let _w = false;

  async function post(path, body) {
    try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
    catch (_) { return null; }
  }
  async function loadSummary() {
    try { const r = await (await fetch('/api/board')).json(); summary = r.summary || []; } catch (_) {}
    if (!project && summary.length) project = summary[0].project;
  }
  async function loadEntries() {
    if (!project) { entries = []; return; }
    try {
      const q = new URLSearchParams({ project, all: '1' });
      if (filter) q.set('type', filter);
      const r = await (await fetch('/api/board?' + q)).json();
      entries = r.entries || [];
    } catch (_) { entries = []; }
  }
  $effect(() => {
    if (!open) { _w = false; return; }
    if (!_w) { _w = true; loadSummary().then(loadEntries); }
    const t = setInterval(() => { loadSummary(); loadEntries(); }, 4000);
    return () => clearInterval(t);
  });
  // reload the list when the chosen project or filter changes
  $effect(() => { project; filter; if (open && _w) loadEntries(); });

  function say(t) { flash = t; setTimeout(() => (flash = ''), 1800); }
  async function addNote() {
    if (!project || !note.trim()) { say('⚠ pick a project and type a note'); return; }
    const r = await post('/api/board', { project, type: 'note', agent: 'you', text: note.trim() });
    if (r && r.ok) { note = ''; say('✓ posted'); loadEntries(); loadSummary(); } else say('✗ ' + ((r && r.error) || 'failed'));
  }
  async function act(id, action) { const r = await post('/api/board/action', { id, action }); if (r && r.ok) { loadEntries(); loadSummary(); } }
  async function clearAll() {
    if (!project || !confirm(`Clear the whole board for ${project}? This removes every note, finding, and escalation.`)) return;
    const r = await post('/api/board/action', { action: 'clear', project }); if (r && r.ok) { say(`cleared ${r.cleared}`); loadEntries(); loadSummary(); }
  }
  function when(ts) { if (!ts) return ''; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; return Math.round(s / 3600) + 'h'; }
  const ICON = { note: '📝', finding: '🔬', escalation: '🙋', claim: '🔒', plan: '📋', assignment: '📌' };
  function onKey(e) { if (e.key === 'Escape') open = false; }
  function onNoteKey(e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote(); } }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={() => (open = false)} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Coordination board">
    <div class="hd">
      <strong>🪧 Coordination board</strong>
      <span class="hdsub">what the agents are telling each other</span>
      <button class="x" onclick={() => (open = false)} aria-label="Close">✕</button>
    </div>

    <div class="body">
      <div class="picker">
        <select class="in" bind:value={project}>
          {#if !summary.length}<option value="">no boards yet</option>{/if}
          {#each summary as s (s.project)}
            <option value={s.project}>{s.project} · {s.total}{s.escalations ? ' · 🙋' + s.escalations : ''}</option>
          {/each}
        </select>
        <div class="filters">
          {#each [['', 'all'], ['note', '📝'], ['finding', '🔬'], ['escalation', '🙋']] as [v, lbl] (v)}
            <button class="fchip" class:on={filter === v} onclick={() => (filter = v)}>{lbl}</button>
          {/each}
        </div>
      </div>

      <div class="addbox">
        <textarea rows="2" bind:value={note} placeholder="Leave a note for the agents on this project… (Ctrl+Enter)" onkeydown={onNoteKey}></textarea>
        <div class="addrow">
          <span class="hint">Posts as <b>you</b> — agents read it with <code>board.js read</code>.</span>
          <button class="go" onclick={addNote}>＋ Post</button>
        </div>
      </div>

      {#if !entries.length}
        <div class="empty">{project ? 'This board is empty. Agents post with ' : 'No project selected. '}{#if project}<code>node scripts/board.js post --project {project} --text "…"</code>{/if} — or leave the first note above.</div>
      {:else}
        {#each entries as e (e.id)}
          <div class="item {e.type}" class:resolved={e.resolved}>
            <span class="ic">{ICON[e.type] || '•'}</span>
            <div class="ibody">
              <div class="itop">
                <b>#{e.id}</b>
                {#if e.type !== 'note'}<span class="ty">{e.type}</span>{/if}
                {#if e.agent}<span class="who">{e.agent}</span>{/if}
                {#if e.pinned}<span class="pin">📌</span>{/if}
                <span class="age">{when(e.createdAt)}</span>
              </div>
              <div class="txt">{e.text}</div>
              {#if e.refs && e.refs.length}<div class="refs">builds on #{e.refs.join(', #')}</div>{/if}
            </div>
            <div class="acts">
              <button class="mini" onclick={() => act(e.id, e.pinned ? 'unpin' : 'pin')}>{e.pinned ? 'unpin' : 'pin'}</button>
              {#if e.type === 'escalation' && !e.resolved}<button class="mini" onclick={() => act(e.id, 'resolve')}>resolve</button>{/if}
              <button class="mini ghost" onclick={() => act(e.id, 'remove')}>✕</button>
            </div>
          </div>
        {/each}
        <button class="clear" onclick={clearAll}>Clear this board</button>
      {/if}
    </div>

    {#if flash}<div class="statusbar">{flash}</div>{/if}
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 430px; }
  .hdsub { font-size: 10px; color: var(--color-text-tertiary); margin-left: 8px; flex: 1; }
  .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
  .picker { display: flex; flex-direction: column; gap: 8px; }
  .in { font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 0.5px solid var(--color-border-tertiary);
    background: var(--color-background-primary); color: var(--color-text-primary); }
  .filters { display: flex; gap: 5px; }
  .fchip { font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer;
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .fchip.on { border-color: var(--accent, #6366F1); color: var(--color-text-primary); background: color-mix(in srgb, var(--accent, #6366F1) 12%, transparent); }
  .addbox { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; background: var(--color-background-secondary); }
  textarea { font-size: 12px; padding: 7px 8px; border-radius: 6px; font-family: inherit; resize: vertical; line-height: 1.4;
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-primary); color: var(--color-text-primary); }
  .addrow { display: flex; align-items: center; gap: 8px; }
  .hint { font-size: 10px; color: var(--color-text-tertiary); flex: 1; }
  .hint code { font-size: 9.5px; }
  .go { font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 6px; cursor: pointer; border: none; background: var(--accent, #6366F1); color: #fff; flex-shrink: 0; }
  .empty { font-size: 12px; color: var(--color-text-tertiary); padding: 16px 4px; line-height: 1.6; }
  .empty code { font-size: 10px; word-break: break-all; }
  .item { display: flex; gap: 8px; padding: 8px 9px; border-radius: 8px; border: 0.5px solid var(--color-border-tertiary); align-items: flex-start; }
  .item.finding { border-color: color-mix(in srgb, var(--accent, #6366F1) 30%, transparent); background: color-mix(in srgb, var(--accent, #6366F1) 5%, transparent); }
  .item.escalation { border-color: #F59E0B66; background: #F59E0B12; }
  .item.resolved { opacity: 0.5; }
  .ic { flex-shrink: 0; font-size: 13px; line-height: 1.4; }
  .ibody { flex: 1 1 auto; min-width: 0; }
  .itop { display: flex; align-items: baseline; gap: 7px; font-size: 11px; flex-wrap: wrap; color: var(--color-text-tertiary); }
  .itop b { color: var(--color-text-secondary); }
  .ty { text-transform: uppercase; letter-spacing: .04em; font-size: 9px; color: var(--accent, #6366F1); }
  .who { color: var(--color-text-secondary); }
  .age { margin-left: auto; }
  .txt { font-size: 12.5px; line-height: 1.45; margin-top: 2px; word-break: break-word; color: var(--color-text-primary); }
  .refs { font-size: 10px; font-family: var(--font-mono); color: var(--color-text-tertiary); margin-top: 3px; }
  .acts { display: flex; flex-direction: column; gap: 3px; flex-shrink: 0; }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .mini:hover { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .mini.ghost { border: none; background: none; }
  .clear { align-self: flex-start; font-size: 10.5px; padding: 4px 10px; border-radius: 6px; cursor: pointer; margin-top: 2px;
    border: 0.5px solid var(--color-border-tertiary); background: none; color: var(--color-text-tertiary); }
  .clear:hover { border-color: #EF4444; color: #EF4444; }
  .statusbar { border-top: 0.5px solid var(--color-border-tertiary); padding: 8px 14px; font-size: 11px; color: var(--color-text-secondary); background: var(--color-background-secondary); }
</style>
