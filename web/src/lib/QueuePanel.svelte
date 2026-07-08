<script>
  // Task queue — dump goals per project; the bridge starts the next one when a
  // slot frees (never two in one project, never on top of a busy session).
  import MicButton from './MicButton.svelte';
  let { open = $bindable(false) } = $props();
  let q = $state({ enabled: true, maxSlots: 2, items: [] });
  let projects = $state([]);
  let cwd = $state('');
  let goal = $state('');
  let flash = $state('');
  let tgOnDone = $state(false);
  let dispatchOn = $state(false);

  async function post(path, body) {
    try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
    catch (_) { return null; }
  }
  async function load() {
    try { q = await (await fetch('/api/queue')).json(); } catch (_) {}
    try { dispatchOn = !!(await (await fetch('/api/dispatch-config')).json()).enabled; } catch (_) {}
  }
  async function loadProjects() {
    try {
      const d = await (await fetch('/api/projects')).json();
      projects = (d.projects || []).filter((p) => p.sources?.[0] !== 'global');
      if (!cwd && projects.length) {
        const saved = localStorage.getItem('aoc-project');
        const m = saved && projects.find((p) => p.name === saved);
        cwd = (m && m.path) || projects[0].path;
      }
    } catch (_) {}
  }
  $effect(() => {
    if (!open) return;
    load(); loadProjects();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  });

  function note(t) { flash = t; setTimeout(() => (flash = ''), 2200); }
  async function add() {
    if (!cwd || !goal.trim()) { note('⚠ pick a project and type a goal'); return; }
    const r = await post('/api/queue', { cwd, prompt: goal.trim() });
    if (r && r.ok) { note('✓ queued #' + r.item.id); goal = ''; load(); }
    else note('✗ ' + ((r && r.error) || 'failed'));
  }
  async function act(id, action) {
    const r = await post('/api/queue/action', { id, action });
    if (r && r.ok) load(); else note('✗ ' + ((r && r.error) || 'failed'));
  }
  async function saveCfg() {
    const r = await post('/api/queue-config', { enabled: q.enabled, maxSlots: Number(q.maxSlots) || 2, telegramOnDone: tgOnDone });
    if (r) { q.enabled = r.enabled; q.maxSlots = r.maxSlots; tgOnDone = !!r.telegramOnDone; note('✓ saved'); }
  }
  function age(ts) { if (!ts) return ''; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; return Math.round(s / 3600) + 'h'; }
  const ICON = { queued: '⏳', running: '▶', done: '✅', failed: '⚠️', cancelled: '✕' };
  let counts = $derived.by(() => { const c = { queued: 0, running: 0 }; for (const it of q.items || []) if (c[it.status] !== undefined) c[it.status]++; return c; });
  function onGoalKey(e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }
</script>

{#if open}
  <div class="ov" onclick={() => (open = false)} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Task queue">
    <div class="hd"><strong>📋 Task queue</strong>
      <span class="hdsub">{counts.running} running · {counts.queued} queued</span>
      <button class="x" onclick={() => (open = false)} aria-label="Close">✕</button>
    </div>

    <div class="body">
      <div class="addbox">
        <div class="lblrow"><span class="lbl">Add a task</span><MicButton onappend={(t) => (goal = (goal ? goal.trim() + ' ' : '') + t)} /></div>
        <textarea rows="2" bind:value={goal} placeholder="what should Claude do? (Ctrl+Enter adds)" onkeydown={onGoalKey}></textarea>
        <div class="addrow">
          <select class="in" bind:value={cwd}>
            {#each projects as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
          </select>
          <button class="go" onclick={add}>＋ Queue</button>
        </div>
        <div class="hint">{dispatchOn ? '⚡ Runs via Gander Dispatch — instant permission buttons, precise completion.' : 'Dispatch is OFF — tasks open terminal windows; completion is inferred from the session going idle. Turn on Settings → Gander Dispatch for the smoothest queue.'}</div>
      </div>

      <div class="cfgrow">
        <label class="cb"><input type="checkbox" bind:checked={q.enabled} onchange={saveCfg} /> Queue enabled</label>
        <label class="cb">slots <input class="in num" type="number" min="1" max="8" bind:value={q.maxSlots} onchange={saveCfg} /></label>
        <label class="cb"><input type="checkbox" bind:checked={tgOnDone} onchange={saveCfg} /> Telegram on done</label>
        {#if (q.items || []).some((i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled')}
          <button class="mini" onclick={() => act(0, 'clear-done')}>clear finished</button>
        {/if}
      </div>

      {#if !(q.items || []).length}
        <div class="empty">Nothing queued. Add a goal above — the bridge starts it as soon as a slot is free, and lines the rest up behind it (one at a time per project).</div>
      {:else}
        {#each q.items as it (it.id)}
          <div class="item {it.status}">
            <span class="ic">{ICON[it.status] || '•'}</span>
            <div class="ibody">
              <div class="itop"><b>#{it.id}</b> <span class="proj">{it.project}</span> <span class="st">{it.status}{it.runner === 'terminal' ? ' · terminal' : ''}</span>
                <span class="when">{it.status === 'running' ? age(it.startedAt) + ' in' : it.doneAt ? age(it.doneAt) + ' ago' : age(it.createdAt) + ' waiting'}</span>
              </div>
              <div class="prompt">{it.prompt}</div>
              {#if it.error}<div class="err">{it.error}</div>{/if}
            </div>
            <div class="acts">
              {#if it.status === 'queued'}<button class="mini" onclick={() => act(it.id, 'cancel')}>cancel</button>{/if}
              {#if it.status === 'failed' || it.status === 'cancelled'}<button class="mini" onclick={() => act(it.id, 'retry')}>retry</button>{/if}
              {#if it.status !== 'running'}<button class="mini ghost" onclick={() => act(it.id, 'remove')}>✕</button>{/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>

    {#if flash}<div class="statusbar">{flash}</div>{/if}
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 430px; }
  .hdsub { font-size: 10px; color: var(--color-text-tertiary); margin-left: 8px; flex: 1; }
  .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
  .addbox { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; background: var(--color-background-secondary); }
  .lblrow { display: flex; align-items: center; justify-content: space-between; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  textarea { font-size: 12px; padding: 7px 8px; border-radius: 6px; font-family: inherit; resize: vertical; line-height: 1.4;
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-primary); color: var(--color-text-primary); }
  .addrow { display: flex; gap: 6px; }
  .in { font-size: 11px; padding: 5px 7px; border-radius: 6px; border: 0.5px solid var(--color-border-tertiary);
    background: var(--color-background-primary); color: var(--color-text-primary); flex: 1 1 auto; min-width: 0; }
  .in.num { width: 46px; flex: 0 0 auto; text-align: center; }
  .go { font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 6px; cursor: pointer; border: none; background: var(--accent, #6366F1); color: #fff; flex-shrink: 0; }
  .hint { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.4; }
  .cfgrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 11px; }
  .cb { display: flex; align-items: center; gap: 5px; color: var(--color-text-secondary); cursor: pointer; }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .mini:hover { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .mini.ghost { border: none; background: none; }
  .empty { font-size: 12px; color: var(--color-text-tertiary); padding: 18px 6px; line-height: 1.5; }
  .item { display: flex; gap: 8px; padding: 8px 9px; border-radius: 8px; border: 0.5px solid var(--color-border-tertiary); align-items: flex-start; }
  .item.running { border-color: var(--accent, #6366F1); background: color-mix(in srgb, var(--accent, #6366F1) 7%, transparent); }
  .item.failed { border-color: #EF444466; background: #EF44440d; }
  .item.done { opacity: 0.75; }
  .item.cancelled { opacity: 0.55; }
  .ic { flex-shrink: 0; font-size: 13px; line-height: 1.4; }
  .ibody { flex: 1 1 auto; min-width: 0; }
  .itop { display: flex; align-items: baseline; gap: 7px; font-size: 11px; flex-wrap: wrap; }
  .proj { color: var(--color-text-secondary); }
  .st { color: var(--color-text-tertiary); }
  .when { margin-left: auto; color: var(--color-text-tertiary); font-size: 10px; }
  .prompt { font-size: 11.5px; line-height: 1.45; margin-top: 2px; word-break: break-word; }
  .err { font-size: 10px; color: #EF4444; margin-top: 2px; }
  .acts { display: flex; flex-direction: column; gap: 3px; flex-shrink: 0; }
  .statusbar { border-top: 0.5px solid var(--color-border-tertiary); padding: 8px 14px; font-size: 11px; color: var(--color-text-secondary); background: var(--color-background-secondary); }
</style>
