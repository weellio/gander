<script>
  // Coordination board — the shared notes agents leave each other on a project,
  // so a swarm builds on each other's work instead of re-deriving it. You can
  // read it, pin what matters, resolve escalations, post your own note, or clear
  // it. The whole point is that it's yours to see — never a hidden side-channel.
  let { open = $bindable(false), project = $bindable('') } = $props();
  let summary = $state([]);       // [{project,total,pinned,escalations,latest}]
  let entries = $state([]);
  let tree = $state([]);          // lineage forest when view==='lineage'
  let gems = $state([]);          // durable findings when view==='gems'
  let filter = $state('');        // '' | note | finding | claim | plan | escalation
  let view = $state('list');      // 'list' | 'lineage' | 'gems'
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
    if (!project) { entries = []; tree = []; return; }
    try {
      if (view === 'lineage') {
        const r = await (await fetch('/api/board?' + new URLSearchParams({ project, view: 'lineage' }))).json();
        tree = r.lineage || [];
      } else if (view === 'gems') {
        const r = await (await fetch('/api/board?' + new URLSearchParams({ project, view: 'gems' }))).json();
        gems = r.gems || [];
      } else {
        const q = new URLSearchParams({ project, all: '1' });
        if (filter) q.set('type', filter);
        const r = await (await fetch('/api/board?' + q)).json();
        entries = r.entries || [];
      }
    } catch (_) { entries = []; tree = []; }
  }
  $effect(() => {
    if (!open) { _w = false; return; }
    if (!_w) { _w = true; loadSummary().then(loadEntries); }
    const t = setInterval(() => { loadSummary(); loadEntries(); }, 4000);
    return () => clearInterval(t);
  });
  // reload when the chosen project, filter, or view changes
  $effect(() => { project; filter; view; if (open && _w) loadEntries(); });

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
          {#each [['', 'all'], ['note', '📝'], ['finding', '🔬'], ['claim', '🔒'], ['plan', '📋'], ['assignment', '📌'], ['escalation', '🙋']] as [v, lbl] (v)}
            <button class="fchip" class:on={view === 'list' && filter === v} onclick={() => { view = 'list'; filter = v; }} title={v || 'all'}>{lbl}</button>
          {/each}
          <button class="fchip" class:on={view === 'gems'} onclick={() => (view = 'gems')} title="gems — the durable findings the next session should start from">💎</button>
          <button class="fchip" class:on={view === 'lineage'} onclick={() => (view = 'lineage')} title="lineage — findings as a build-on tree">🌳</button>
        </div>
      </div>

      <div class="addbox">
        <textarea rows="2" bind:value={note} placeholder="Leave a note for the agents on this project… (Ctrl+Enter)" onkeydown={onNoteKey}></textarea>
        <div class="addrow">
          <span class="hint">Posts as <b>you</b> — agents read it with <code>board.js read</code>.</span>
          <button class="go" onclick={addNote}>＋ Post</button>
        </div>
      </div>

      {#if view === 'gems'}
        {#if !gems.length}
          <div class="empty">No gems yet. Promote a load-bearing finding (💎) and it survives the cap — the durable knowledge the <b>next</b> session starts from. Agents read them with <code>node scripts/board.js gems --project {project}</code>.</div>
        {:else}
          {#each gems as g (g.id)}
            <div class="item finding">
              <span class="ic">💎</span>
              <div class="ibody">
                <div class="itop"><b>#{g.id}</b>{#if g.agent}<span class="who">{g.agent}</span>{/if}<span class="age">{when(g.createdAt)}</span></div>
                <div class="txt">{g.text}</div>
              </div>
              <div class="acts"><button class="mini" onclick={() => act(g.id, 'demote')}>demote</button></div>
            </div>
          {/each}
        {/if}
      {:else if view === 'lineage'}
        {#if !tree.length}
          <div class="empty">No findings yet. Findings that reference others (<code>--refs</code>) chain up here as a build-on tree.</div>
        {:else}
          {#snippet branch(nodes, depth)}
            {#each nodes as n (n.id)}
              <div class="ln" style="margin-left:{depth * 16}px">
                <span class="ln-dot">{depth ? '↳' : '🔬'}</span>
                <div class="ln-body"><span class="ln-id">#{n.id}</span> {#if n.agent}<span class="who">{n.agent}</span>{/if}<div class="ln-txt">{n.text}</div></div>
              </div>
              {#if n.children && n.children.length}{@render branch(n.children, depth + 1)}{/if}
            {/each}
          {/snippet}
          {@render branch(tree, 0)}
        {/if}
      {:else if !entries.length}
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
                {#if e.meta?.status}<span class="status {e.meta.status}">{e.meta.status}{#if e.meta.assignee} · {e.meta.assignee}{/if}</span>{/if}
                {#if e.pinned}<span class="pin">📌</span>{/if}
                <span class="age">{when(e.createdAt)}</span>
              </div>
              <div class="txt">{e.text}</div>
              {#if e.refs && e.refs.length}<div class="refs">builds on #{e.refs.join(', #')}</div>{/if}
            </div>
            <div class="acts">
              {#if e.type === 'finding' || e.type === 'note'}<button class="mini" class:gem={e.meta?.gem} onclick={() => act(e.id, e.meta?.gem ? 'demote' : 'promote')} title="a durable finding the next session should start from">💎</button>{/if}
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
  .mini.gem { border-color: color-mix(in srgb, var(--accent, #6366F1) 45%, transparent); background: color-mix(in srgb, var(--accent, #6366F1) 12%, transparent); }
  .clear { align-self: flex-start; font-size: 10.5px; padding: 4px 10px; border-radius: 6px; cursor: pointer; margin-top: 2px;
    border: 0.5px solid var(--color-border-tertiary); background: none; color: var(--color-text-tertiary); }
  .clear:hover { border-color: #EF4444; color: #EF4444; }
  .status { font-size: 9px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .03em; padding: 1px 6px; border-radius: 5px; background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .status.open { color: var(--accent, #6366F1); }
  .status.claimed { color: #C9820A; }
  .status.done, .status.approved { color: #0f9e6e; }
  .status.vetoed { color: #EF4444; }
  .ln { display: flex; gap: 7px; padding: 5px 2px; align-items: flex-start; border-left: 1.5px solid var(--color-border-tertiary); padding-left: 8px; }
  .ln-dot { font-size: 11px; line-height: 1.4; flex-shrink: 0; color: var(--accent, #6366F1); }
  .ln-body { min-width: 0; }
  .ln-id { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-tertiary); }
  .ln-txt { font-size: 12.5px; line-height: 1.4; word-break: break-word; }
  .statusbar { border-top: 0.5px solid var(--color-border-tertiary); padding: 8px 14px; font-size: 11px; color: var(--color-text-secondary); background: var(--color-background-secondary); }
</style>
