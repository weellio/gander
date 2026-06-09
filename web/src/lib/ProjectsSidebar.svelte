<script>
  let { open = $bindable(false) } = $props();
  let _wasOpen = false;
  $effect(() => { if (open && !_wasOpen) openPanel(); _wasOpen = open; });
  let data = $state({ roots: [], projects: [] });
  let newRoot = $state('');
  let expanded = $state({});
  let selected = $state(null);   // { fromPath, fromName, type, name }
  let target = $state('');
  let result = $state('');
  let gitMap = $state({});
  let costMap = $state({});
  let timer = null;

  async function load() { try { const r = await fetch('/api/projects'); data = await r.json(); loadGit(); loadCost(); } catch (_) {} }
  async function loadCost() { try { const r = await fetch('/api/usage'); const j = await r.json(); const m = {}; for (const p of (j.byProject || [])) m[String(p.path).toLowerCase()] = p.costUSD; costMap = m; } catch (_) {} }
  async function loadGit() {
    try {
      const paths = data.projects.map((p) => p.path);
      const r = await fetch('/api/git-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
      gitMap = await r.json();
    } catch (_) {}
  }
  function openPanel() { open = true; result = ''; load(); timer = setInterval(load, 3000); }
  function closePanel() { open = false; clearInterval(timer); }
  async function post(path, body) { try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch (_) { return null; } }
  async function addRoot() { const p = newRoot.trim(); if (!p) return; await post('/api/projects/roots', { path: p }); newRoot = ''; load(); }
  async function removeRoot(p) { await post('/api/projects/roots', { action: 'remove', path: p }); load(); }
  async function browse() { result = 'Opening folder picker…'; const j = await post('/api/pick-folder', {}); result = j && j.ok ? `Added ${j.path}` : (j && j.error ? j.error : ''); load(); }
  let mutedSet = $derived(new Set(data.muted || []));
  async function toggleMute(p) { const m = !mutedSet.has(p.name); await post('/api/mute', { project: p.name, muted: m }); load(); }
  function pick(proj, type, name) { selected = { fromPath: proj.path, fromName: proj.name, type, name }; target = ''; result = ''; pendingDiff = null; }

  let busy = $state('');
  let commitMsg = $state({});
  let startPrompt = $state({});
  async function launch(p) {
    busy = p.path + ':launch';
    const task = (startPrompt[p.path] || '').trim();
    const j = await post('/api/launch', { cwd: p.path, prompt: task });
    result = j && j.ok ? `Started${task ? ' with a task' : ''} in ${p.name}` : 'Could not launch';
    busy = ''; startPrompt = { ...startPrompt, [p.path]: '' };
  }
  async function openIn(p, target) { await post('/api/open', { cwd: p.path, target }); }
  async function gitDo(p, action) {
    busy = p.path + ':' + action;
    const j = await post('/api/git-action', { cwd: p.path, action, message: commitMsg[p.path] || '' });
    const tail = (j && j.output ? ' — ' + j.output.split('\n').slice(-1)[0] : '');
    result = j && j.ok ? `git ${action} ✓${tail}` : `git ${action} ✗${tail || ': ' + ((j && j.error) || 'failed')}`;
    busy = ''; loadGit();
  }

  let diffMap = $state({});
  let branchMap = $state({});
  let newBranch = $state({});
  async function gitDiff(p) {
    if (diffMap[p.path] !== undefined) { diffMap = { ...diffMap, [p.path]: undefined }; return; }
    busy = p.path + ':diff';
    const j = await post('/api/git-action', { cwd: p.path, action: 'diff' });
    diffMap = { ...diffMap, [p.path]: j && j.ok ? (j.stat ? j.stat + '\n\n' : '') + j.diff : 'error' };
    busy = '';
  }
  async function gitBranches(p) {
    if (branchMap[p.path]) { branchMap = { ...branchMap, [p.path]: undefined }; return; }
    busy = p.path + ':br';
    const j = await post('/api/git-action', { cwd: p.path, action: 'branches' });
    branchMap = { ...branchMap, [p.path]: j && j.ok ? j : { branches: [], current: '' } };
    busy = '';
  }
  async function refreshBranches(p) { branchMap = { ...branchMap, [p.path]: undefined }; await gitBranches(p); }
  async function gitCheckout(p, br) {
    busy = p.path + ':co';
    const j = await post('/api/git-action', { cwd: p.path, action: 'checkout', arg: br });
    result = j && j.ok ? `Switched to ${br}` : `checkout ✗ ${(j && j.output) || (j && j.error) || ''}`;
    busy = ''; loadGit(); await refreshBranches(p);
  }
  async function gitNewBranch(p) {
    const br = (newBranch[p.path] || '').trim();
    if (!br) return;
    busy = p.path + ':nb';
    const j = await post('/api/git-action', { cwd: p.path, action: 'newbranch', arg: br });
    result = j && j.ok ? `Created & switched to ${br}` : `branch ✗ ${(j && j.output) || (j && j.error) || ''}`;
    busy = ''; newBranch = { ...newBranch, [p.path]: '' }; loadGit(); await refreshBranches(p);
  }
  let pendingDiff = $state(null);
  async function doCopy(force = false) {
    if (!selected || !target) return;
    const body = { type: selected.type, name: selected.name, fromCwd: selected.fromPath, toCwd: target, overwrite: force };
    let j = await post('/api/copy-component', body);
    if (j && j.exists && !force) {
      const d = await post('/api/component-diff', { type: selected.type, name: selected.name, fromCwd: selected.fromPath, toCwd: target });
      pendingDiff = d && !d.error ? d : { note: 'Already exists in the target.' };
      return;
    }
    pendingDiff = null;
    result = j && j.ok ? `Copied ${selected.type} “${selected.name}” → ${String(target).split(/[\\/]/).pop()}` : 'Error: ' + ((j && j.error) || 'failed');
    load();
  }
  const GROUPS = [['skill', 'Skills'], ['agent', 'Agents'], ['command', 'Commands'], ['hook', 'Hooks'], ['mcp', 'MCP']];
  const itemsOf = (p, type) => type === 'skill' ? p.skills : type === 'agent' ? p.agents : type === 'command' ? p.commands : type === 'hook' ? p.hooks : p.mcp;
</script>

<!-- trigger provided by App's Manage menu (bind:open) -->

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Claude projects">
    <div class="hd"><strong>Claude Projects</strong><button class="x" onclick={closePanel} aria-label="Close">✕</button></div>

    <div class="roots">
      <div class="lbl">Project folders</div>
      {#each data.roots as r (r)}
        <div class="root"><span class="mono" title={r}>{r}</span><button class="mini" onclick={() => removeRoot(r)} aria-label="Remove">✕</button></div>
      {/each}
      <div class="addrow">
        <input bind:value={newRoot} placeholder="add a folder path…" onkeydown={(e) => e.key === 'Enter' && addRoot()} />
        <button class="select" onclick={addRoot}>Add</button>
        <button class="select" onclick={browse} title="Pick a folder with the OS dialog">Browse…</button>
      </div>
    </div>

    <div class="list">
      {#each data.projects as p (p.path)}
        <div class="proj" class:muted={mutedSet.has(p.name)}>
          <div class="phead">
          <button class="prow" onclick={() => (expanded = { ...expanded, [p.path]: !expanded[p.path] })}>
            <span class="caret">{expanded[p.path] ? '▾' : '▸'}</span>
            <span class="pname" title={p.path}>{p.name}</span>
            {#if p.running}<span class="run">● live</span>{/if}
            {#if gitMap[p.path]?.isRepo}
              <span class="git" title={[gitMap[p.path].remote, gitMap[p.path].lastWhen && 'last: ' + gitMap[p.path].lastWhen].filter(Boolean).join('\n')}>
                ⎇{gitMap[p.path].branch}{#if gitMap[p.path].dirty}<i class="dirty">●{gitMap[p.path].dirty}</i>{/if}{#if gitMap[p.path].ahead}<i class="ah">↑{gitMap[p.path].ahead}</i>{/if}{#if gitMap[p.path].behind}<i class="bh">↓{gitMap[p.path].behind}</i>{/if}
              </span>
            {/if}
            {#if costMap[p.path.toLowerCase()]}<span class="pcost" title="Estimated spend on this project">${costMap[p.path.toLowerCase()] >= 1 ? costMap[p.path.toLowerCase()].toFixed(0) : costMap[p.path.toLowerCase()].toFixed(2)}</span>{/if}
            <span class="counts">{p.skills.length}·{p.agents.length}·{p.commands.length}·{p.hooks.length}</span>
          </button>
          <button class="mute" onclick={() => toggleMute(p)} title={mutedSet.has(p.name) ? 'Unmute — show on the floor' : 'Mute — hide from the floor'}>{mutedSet.has(p.name) ? '🔇' : '🔊'}</button>
          </div>
          {#if expanded[p.path]}
            <div class="comps">
              <div class="acts">
                <button class="select" onclick={() => launch(p)} disabled={!!busy} title="Open a new terminal running Claude Code here (with the task if given)">▶ Start</button>
                <input class="cm" placeholder="task (optional)…" bind:value={startPrompt[p.path]} onkeydown={(e) => e.key === 'Enter' && launch(p)} />
                <button class="select" onclick={() => openIn(p, 'folder')} title="Open folder">📂</button>
                <button class="select" onclick={() => openIn(p, 'editor')} title="Open in VS Code">Code</button>
                {#if gitMap[p.path]?.isRepo}
                  <button class="select" onclick={() => gitDo(p, 'pull')} disabled={!!busy} title="git pull">⬇ Pull</button>
                  <button class="select" onclick={() => gitDiff(p)} disabled={!!busy} title="git diff">Diff</button>
                  <button class="select" onclick={() => gitBranches(p)} disabled={!!busy} title="branches">⎇ Branches</button>
                  <input class="cm" placeholder="commit message…" bind:value={commitMsg[p.path]} />
                  <button class="select" onclick={() => gitDo(p, 'commit-push')} disabled={!!busy || !gitMap[p.path].dirty} title="git add -A · commit · push">Commit & Push{#if gitMap[p.path].dirty} ({gitMap[p.path].dirty}){/if}</button>
                {/if}
              </div>
              {#if diffMap[p.path] !== undefined}<pre class="diff">{diffMap[p.path]}</pre>{/if}
              {#if branchMap[p.path]}
                <div class="branches">
                  {#each branchMap[p.path].branches as b (b)}
                    <button class="chip" class:sel={b === branchMap[p.path].current} onclick={() => gitCheckout(p, b)} title="git checkout {b}">{b === branchMap[p.path].current ? '● ' : ''}{b}</button>
                  {/each}
                  <input class="cm" placeholder="new branch…" bind:value={newBranch[p.path]} onkeydown={(e) => e.key === 'Enter' && gitNewBranch(p)} />
                  <button class="select" onclick={() => gitNewBranch(p)} disabled={!!busy}>+ Create</button>
                </div>
              {/if}
              {#each GROUPS as [type, label] (type)}
                {#if itemsOf(p, type).length}
                  <div class="grp"><span class="gl">{label}</span>
                    {#each itemsOf(p, type) as it (it)}
                      <button class="chip" class:sel={selected && selected.fromPath === p.path && selected.type === type && selected.name === it} onclick={() => pick(p, type, it)}>{it}</button>
                    {/each}
                  </div>
                {/if}
              {/each}
              {#if !p.skills.length && !p.agents.length && !p.commands.length && !p.hooks.length && !p.mcp.length}<div class="none">no local components</div>{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    {#if selected}
      <div class="copybar">
        <div class="sl">Copy <b>{selected.type}</b> “{selected.name}” from <b>{selected.fromName}</b></div>
        <div class="row">
          <select bind:value={target} class="select" onchange={() => (pendingDiff = null)}>
            <option value="">to project…</option>
            {#each data.projects.filter((p) => p.path !== selected.fromPath) as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
          </select>
          <button class="select" onclick={() => doCopy()} disabled={!target}>Copy</button>
        </div>
        {#if pendingDiff}
          <div class="diffbox">
            <div class="diffhd">⚠ Exists in target — review before overwriting:</div>
            {#if pendingDiff.lines}
              <div class="cdiff">{#each pendingDiff.lines as ln, i (i)}<div class="dl {ln.t === '+' ? 'add' : ln.t === '-' ? 'del' : 'ctx'}">{ln.t}{ln.text}</div>{/each}</div>
            {/if}
            {#if pendingDiff.note}<div class="diffnote">{pendingDiff.note}</div>{/if}
            <div class="row">
              <button class="select" onclick={() => doCopy(true)}>Overwrite</button>
              <button class="select" onclick={() => (pendingDiff = null)}>Cancel</button>
            </div>
          </div>
        {/if}
        {#if result}<div class="res">{result}</div>{/if}
      </div>
    {/if}
  </aside>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.25); }
  .drawer {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 91; width: 360px; max-width: 92vw;
    background: var(--color-background-primary); border-right: 0.5px solid var(--color-border-secondary);
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column;
  }
  .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .roots { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .root { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .root .mono { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--font-mono); }
  .mini { font-size: 10px; padding: 1px 6px; border-radius: 6px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .addrow { display: flex; gap: 6px; margin-top: 2px; }
  .addrow input { flex: 1 1 auto; min-width: 0; font-size: 11px; padding: 5px 7px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .list { flex: 1 1 auto; overflow: auto; padding: 6px 8px; }
  .proj { border-bottom: 0.5px solid var(--color-border-tertiary); }
  .phead { display: flex; align-items: center; }
  .proj.muted { opacity: 0.5; }
  .mute { background: none; border: none; cursor: pointer; font-size: 12px; padding: 4px 8px; flex-shrink: 0; filter: grayscale(0.3); }
  .prow { display: flex; align-items: center; gap: 7px; flex: 1 1 auto; min-width: 0; background: none; border: none; cursor: pointer; padding: 7px 6px; text-align: left; color: var(--color-text-primary); }
  .caret { color: var(--color-text-tertiary); font-size: 10px; width: 10px; }
  .pname { flex: 1 1 auto; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run { font-size: 9px; color: #10B981; }
  .counts { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }
  .pcost { font-size: 9px; color: #10B981; font-family: var(--font-mono); flex-shrink: 0; }
  .git { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-family: var(--font-mono); color: var(--color-text-tertiary); white-space: nowrap; }
  .git i { font-style: normal; }
  .git .dirty { color: #F59E0B; }
  .git .ah { color: #10B981; }
  .git .bh { color: #EF4444; }
  .comps { padding: 2px 6px 10px 26px; display: flex; flex-direction: column; gap: 6px; }
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-bottom: 6px; margin-bottom: 2px; border-bottom: 0.5px dashed var(--color-border-tertiary); }
  .acts .cm { flex: 1 1 90px; min-width: 80px; font-size: 10px; padding: 3px 6px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .diff { max-height: 220px; overflow: auto; margin: 0 0 6px; padding: 7px 9px; font-family: var(--font-mono); font-size: 10px; line-height: 1.4;
    background: var(--color-background-primary); border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); color: var(--color-text-secondary); white-space: pre; }
  .branches { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-bottom: 6px; }
  .branches .cm { flex: 1 1 90px; min-width: 80px; font-size: 10px; padding: 3px 6px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .grp { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .gl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); width: 60px; flex-shrink: 0; }
  .chip { font-size: 10px; padding: 2px 8px; border-radius: 99px; cursor: pointer; border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .chip.sel { background: var(--accent, #6366F1); color: #fff; border-color: transparent; }
  .chip.dim { cursor: default; color: var(--color-text-tertiary); }
  .none { font-size: 10px; color: var(--color-text-tertiary); }
  .copybar { border-top: 0.5px solid var(--color-border-tertiary); padding: 10px 14px; display: flex; flex-direction: column; gap: 7px; background: var(--color-background-secondary); }
  .sl { font-size: 11px; color: var(--color-text-secondary); }
  .copybar .row { display: flex; gap: 6px; }
  .copybar select { flex: 1 1 auto; }
  .res { font-size: 11px; color: var(--color-text-secondary); }
  .diffbox { display: flex; flex-direction: column; gap: 6px; }
  .diffhd { font-size: 10px; color: #F59E0B; }
  .cdiff { max-height: 200px; overflow: auto; font-family: var(--font-mono); font-size: 10px; line-height: 1.35;
    background: var(--color-background-primary); border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 6px 8px; }
  .dl { white-space: pre-wrap; word-break: break-all; }
  .dl.add { color: #10B981; background: rgba(16, 185, 129, 0.08); }
  .dl.del { color: #EF4444; background: rgba(239, 68, 68, 0.08); }
  .dl.ctx { color: var(--color-text-tertiary); }
  .diffnote { font-size: 10px; color: var(--color-text-tertiary); }
</style>
