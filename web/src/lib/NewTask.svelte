<script>
  let { open = $bindable(false) } = $props();
  let projects = $state([]);
  let cwd = $state('');
  let goal = $state('');
  let busy = $state(false);
  let result = $state('');
  let box = $state(null);

  async function load() {
    try {
      const r = await fetch('/api/projects');
      const d = await r.json();
      projects = (d.projects || []).filter((p) => p.sources?.[0] !== 'global');
      if (!cwd && projects.length) {
        const saved = localStorage.getItem('aoc-project');
        const m = saved && projects.find((p) => p.name === saved);
        cwd = (m && m.path) || projects[0].path;
      }
    } catch (_) { projects = []; }
  }
  $effect(() => { if (open) { result = ''; load(); setTimeout(() => box && box.focus(), 30); } });

  async function launch() {
    if (!cwd || busy) return;
    busy = true; result = '';
    try {
      const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, prompt: goal.trim() }) });
      const j = await r.json();
      if (j && j.ok) { result = '✓ Launched' + (goal.trim() ? ' on your goal' : ''); goal = ''; setTimeout(() => (open = false), 850); }
      else {
        const e = (j && j.error) || 'could not launch';
        result = '✗ ' + e + (/recognized|not found|enoent/i.test(e) ? ' — set the Claude path in Settings → Claude command' : '');
      }
    } catch (_) { result = '✗ Failed — is the bridge running?'; }
    busy = false;
  }
  function onKey(e) {
    if (e.key === 'Escape') { open = false; return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); launch(); }
  }
  function close() { open = false; }
</script>

{#if open}
  <div class="ov" onclick={close} role="presentation"></div>
  <div class="modal" role="dialog" aria-label="New task">
    <div class="hd"><strong>＋ New task</strong><button class="x" onclick={close} aria-label="Close">✕</button></div>
    <div class="body">
      <label class="lbl">Goal <span class="sub">— what should Claude do?</span></label>
      <textarea bind:this={box} bind:value={goal} rows="3" placeholder="e.g. add a dark-mode toggle to the settings page and wire it to the theme store" onkeydown={onKey}></textarea>
      <label class="lbl">Project</label>
      {#if projects.length}
        <select class="in" bind:value={cwd}>
          {#each projects as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
        </select>
      {:else}
        <div class="empty">No projects yet — add one in Manage → Projects.</div>
      {/if}
      {#if result}<div class="res" class:err={result[0] === '✗'}>{result}</div>{/if}
    </div>
    <div class="ft">
      <span class="hint">Opens a new Claude session in that project, working on the goal. (Blank goal = just start a session.)</span>
      <button class="go" disabled={busy || !cwd} onclick={launch}>{busy ? 'Launching…' : 'Launch ↵'}</button>
    </div>
  </div>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 130; background: rgba(0, 0, 0, 0.4); }
  .modal { position: fixed; z-index: 131; top: 18%; left: 50%; transform: translateX(-50%);
    width: 460px; max-width: calc(100vw - 28px); display: flex; flex-direction: column;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4); }
  .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); margin-top: 4px; }
  .sub { text-transform: none; letter-spacing: 0; color: var(--color-text-tertiary); font-weight: 400; }
  textarea, .in { font-size: 13px; padding: 8px; border-radius: var(--border-radius-md); font-family: inherit;
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); box-sizing: border-box; width: 100%; }
  textarea { resize: vertical; line-height: 1.4; }
  .empty { font-size: 11px; color: var(--color-text-tertiary); padding: 6px 0; }
  .res { font-size: 11px; font-weight: 600; color: #10B981; }
  .res.err { color: #EF4444; }
  .ft { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
  .hint { font-size: 10px; color: var(--color-text-tertiary); }
  .go { font-size: 13px; font-weight: 600; padding: 7px 18px; border-radius: var(--border-radius-md); cursor: pointer; border: none; background: var(--accent, #6366F1); color: #fff; white-space: nowrap; }
  .go:disabled { opacity: 0.5; cursor: default; }
</style>
