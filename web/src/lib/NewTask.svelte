<script>
  import MicButton from './MicButton.svelte';
  let { open = $bindable(false) } = $props();
  let projects = $state([]);
  let cwd = $state('');
  let goal = $state('');
  let busy = $state(false);
  let result = $state('');
  let box = $state(null);
  let dispatchOn = $state(false);     // bridge-hosted launches enabled (Settings → Gander Dispatch)
  let forceTerminal = $state(false);  // per-launch override back to the classic terminal window

  // 📝 templates: saved goals with {blanks}. Picking one turns each {blank} into a
  // field, and the goal fills in as you type. Saved on the bridge, so every browser
  // (and the phone) sees the same list.
  let templates = $state([]);
  let tplId = $state('');
  let tplVals = $state({});
  let saving = $state(false);
  let tplName = $state('');
  const VAR = /\{([A-Za-z][\w ]{0,30})\}/g;
  const tpl = $derived(templates.find((t) => t.id === tplId) || null);
  const tplVars = $derived(tpl ? [...new Set([...tpl.text.matchAll(VAR)].map((m) => m[1]))] : []);
  function fillTemplate() {
    if (!tpl) return;
    goal = tpl.text.replace(VAR, (m, k) => (tplVals[k] && String(tplVals[k]).trim() ? String(tplVals[k]).trim() : m));
  }
  function pickTemplate(id) { tplId = id; tplVals = {}; fillTemplate(); setTimeout(() => box && box.focus(), 0); }
  async function loadTemplates() { try { templates = (await (await fetch('/api/templates')).json()).templates || []; } catch (_) { templates = []; } }
  async function saveTemplate() {
    const name = tplName.trim(); if (!name || !goal.trim()) return;
    try {
      const j = await (await fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text: goal.trim() }) })).json();
      if (j.ok) { templates = j.templates; saving = false; tplName = ''; result = '✓ Saved template “' + name + '”' + (/\{[A-Za-z]/.test(goal) ? '. Its {blanks} become fields when you pick it.' : '. Tip: write {blanks} like {error code} to get fill-in fields.'); }
      else result = '✗ ' + (j.error || 'could not save');
    } catch (e) { result = '✗ ' + e.message; }
  }
  async function deleteTemplate() {
    if (!tpl || !confirm('Delete the template “' + tpl.name + '”?')) return;
    try { templates = (await (await fetch('/api/templates/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tpl.id }) })).json()).templates || []; tplId = ''; } catch (_) {}
  }

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
    try { dispatchOn = !!(await (await fetch('/api/dispatch-config')).json()).enabled; } catch (_) { dispatchOn = false; }
  }
  $effect(() => { if (open) { result = ''; load(); loadTemplates(); setTimeout(() => box && box.focus(), 30); } });

  async function launch() {
    if (!cwd || busy) return;
    busy = true; result = '';
    try {
      const body = { cwd, prompt: goal.trim() };
      if (forceTerminal) body.mode = 'terminal';
      const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j && j.dispatched) { result = '⚡ Dispatched — hosted by the bridge, watch it on the floor'; goal = ''; setTimeout(() => (open = false), 1100); }
      else if (j && j.ok) { result = '✓ Launched' + (goal.trim() ? ' on your goal' : ''); goal = ''; setTimeout(() => (open = false), 850); }
      else {
        const e = (j && j.error) || 'could not launch';
        result = '✗ ' + e + (/recognized|not found|enoent/i.test(e) ? ' — set the Claude path in Settings → Claude command' : '');
      }
    } catch (_) { result = '✗ Failed — is the bridge running?'; }
    busy = false;
  }
  // Queue it instead: line the goal up in the task queue — the bridge starts it
  // as soon as a slot is free (and never on top of a busy session).
  async function queueIt() {
    if (!cwd || busy || !goal.trim()) { if (!goal.trim()) result = '⚠ type a goal to queue'; return; }
    busy = true; result = '';
    try {
      const r = await fetch('/api/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, prompt: goal.trim() }) });
      const j = await r.json();
      if (j && j.ok) { result = `📋 Queued #${j.item.id} — starts when a slot frees`; goal = ''; setTimeout(() => (open = false), 1100); }
      else result = '✗ ' + ((j && j.error) || 'could not queue');
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
      <div class="tplrow">
        <select class="in tplsel" value={tplId} onchange={(e) => pickTemplate(e.currentTarget.value)} aria-label="Start from a template">
          <option value="">📝 Start from a template…</option>
          {#each templates as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
        {#if tpl}<button class="mini" onclick={deleteTemplate} title="Delete this template">✕</button>{/if}
        {#if !saving}<button class="mini" onclick={() => { saving = true; tplName = tpl ? tpl.name : ''; }} disabled={!goal.trim()} title={'Save the goal below as a reusable template. Write {blanks} like {error code} to get fill-in fields'}>★ Save as template</button>
        {:else}<input class="in tplname" placeholder="Template name" bind:value={tplName} onkeydown={(e) => { if (e.key === 'Enter') saveTemplate(); if (e.key === 'Escape') saving = false; }} /><button class="mini" onclick={saveTemplate} disabled={!tplName.trim()}>Save</button><button class="mini" onclick={() => (saving = false)}>Cancel</button>{/if}
      </div>
      {#if tplVars.length}
        <div class="tplvars">
          {#each tplVars as v (v)}
            <label class="tplvar"><span>{v}</span><input class="in" bind:value={tplVals[v]} oninput={fillTemplate} placeholder={v} /></label>
          {/each}
        </div>
      {/if}
      <div class="lblrow"><label class="lbl">Goal <span class="sub">— what should Claude do?</span></label><MicButton onappend={(t) => (goal = (goal ? goal.trim() + ' ' : '') + t)} /></div>
      <textarea bind:this={box} bind:value={goal} rows="3" placeholder="e.g. add a dark-mode toggle to the settings page and wire it to the theme store" onkeydown={onKey}></textarea>
      <label class="lbl">Project</label>
      {#if projects.length}
        <select class="in" bind:value={cwd}>
          {#each projects as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
        </select>
      {:else}
        <div class="empty">No projects yet — add one in Manage → Projects.</div>
      {/if}
      {#if dispatchOn}
        <label class="dsp"><input type="checkbox" bind:checked={forceTerminal} /> Open a terminal window instead <span class="dspdim">(dispatch is ON — default runs inside the bridge: instant replies, Allow/Deny permission buttons)</span></label>
      {/if}
      {#if result}<div class="res" class:err={result[0] === '✗'}>{result}</div>{/if}
    </div>
    <div class="ft">
      <span class="hint">{dispatchOn && !forceTerminal ? 'Dispatches a bridge-hosted session working on the goal (blank goal = terminal session).' : 'Opens a new Claude session in that project, working on the goal. (Blank goal = just start a session.)'}</span>
      <button class="go ghost" disabled={busy || !cwd} onclick={queueIt} title="Add to the task queue — starts when a slot is free instead of right now">📋 Queue</button>
      <button class="go" disabled={busy || !cwd} onclick={launch}>{busy ? 'Launching…' : 'Launch ↵'}</button>
    </div>
  </div>
{/if}

<style>
  .tplrow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  .tplsel { flex: 1 1 200px; }
  .tplname { flex: 1 1 160px; }
  .tplvars { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
  .tplvar { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--color-text-tertiary); }
  .mini { font-size: 10.5px; padding: 3px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); white-space: nowrap; }
  .mini:disabled { opacity: 0.5; cursor: default; }
  .ov { position: fixed; inset: 0; z-index: 130; background: rgba(0, 0, 0, 0.4); }
  .modal { position: fixed; z-index: 131; top: 18%; left: 50%; transform: translateX(-50%);
    width: 460px; max-width: calc(100vw - 28px); display: flex; flex-direction: column;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4); }
  .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
  .lblrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
  .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); margin-top: 4px; }
  .lblrow .lbl { margin-top: 0; }
  .sub { text-transform: none; letter-spacing: 0; color: var(--color-text-tertiary); font-weight: 400; }
  textarea, .in { font-size: 13px; padding: 8px; border-radius: var(--border-radius-md); font-family: inherit;
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); box-sizing: border-box; width: 100%; }
  textarea { resize: vertical; line-height: 1.4; }
  .empty { font-size: 11px; color: var(--color-text-tertiary); padding: 6px 0; }
  .res { font-size: 11px; font-weight: 600; color: #10B981; }
  .dsp { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--color-text-secondary); cursor: pointer; margin-top: 2px; }
  .dspdim { font-size: 10px; color: var(--color-text-tertiary); }
  .res.err { color: #EF4444; }
  .ft { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
  .hint { font-size: 10px; color: var(--color-text-tertiary); }
  .go { font-size: 13px; font-weight: 600; padding: 7px 18px; border-radius: var(--border-radius-md); cursor: pointer; border: none; background: var(--accent, #6366F1); color: #fff; white-space: nowrap; }
  .go:disabled { opacity: 0.5; cursor: default; }
  .go.ghost { background: transparent; border: 0.5px solid var(--color-border-secondary); color: var(--color-text-secondary); font-weight: 500; }
  .go.ghost:hover:not(:disabled) { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .ft { flex-wrap: wrap; }
</style>
