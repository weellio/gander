<script>
  import ComponentBuilder from './ComponentBuilder.svelte';
  let { open = $bindable(false), onConfig } = $props();
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

  // component builder (new agent/skill/command)
  let builderOpen = $state(false);
  let builderCwd = $state('');
  function openBuilder() { const ex = Object.keys(expanded).find((k) => expanded[k]); builderCwd = ex || ''; builderOpen = true; }

  // lightweight poll: just the project list + running badges (NOT git/cost — those are heavy)
  async function load() { try { const r = await fetch('/api/projects'); data = await r.json(); } catch (_) {} }
  // full refresh: list + git status + per-project cost. Run on open + after actions, never on the poll.
  async function loadAll() { await load(); loadGit(); loadCost(); }
  async function loadCost() { try { const r = await fetch('/api/usage'); const j = await r.json(); const m = {}; for (const p of (j.byProject || [])) m[String(p.path).toLowerCase()] = p.costUSD; costMap = m; } catch (_) {} }

  // reverse lookup: "which project has this skill/agent/hook/mcp?"
  let find = $state('');
  let matches = $derived.by(() => {
    const q = find.trim().toLowerCase();
    if (!q) return [];
    const TYPES = [['skill', 'skills'], ['agent', 'agents'], ['command', 'commands'], ['hook', 'hooks'], ['mcp', 'mcp']];
    const groups = new Map();
    for (const p of (data.projects || [])) {
      for (const [type, arrKey] of TYPES) {
        for (const name of (p[arrKey] || [])) {
          if (String(name).toLowerCase().includes(q)) {
            const key = type + ':' + name;
            if (!groups.has(key)) groups.set(key, { key, type, name, projects: [] });
            groups.get(key).projects.push(p);
          }
        }
      }
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80);
  });
  function openProj(p) { expanded = { ...expanded, [p.path]: true }; find = ''; }
  async function loadGit() {
    try {
      const paths = data.projects.map((p) => p.path);
      const r = await fetch('/api/git-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
      gitMap = await r.json();
    } catch (_) {}
  }
  function openPanel() { open = true; result = ''; loadAll(); timer = setInterval(load, 5000); }
  function closePanel() { open = false; clearInterval(timer); }
  async function post(path, body) { try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch (_) { return null; } }
  async function addRoot() { const p = newRoot.trim(); if (!p) return; await post('/api/projects/roots', { path: p }); newRoot = ''; loadAll(); }
  async function removeRoot(p) { await post('/api/projects/roots', { action: 'remove', path: p }); load(); }
  async function browse() { result = 'Opening folder picker…'; const j = await post('/api/pick-folder', {}); result = j && j.ok ? `Added ${j.path}` : (j && j.error ? j.error : ''); loadAll(); }
  let mutedSet = $derived(new Set(data.muted || []));
  async function toggleMute(p) { const m = !mutedSet.has(p.name); await post('/api/mute', { project: p.name, muted: m }); load(); }
  function pick(proj, type, name) { selected = { fromPath: proj.path, fromName: proj.name, type, name }; target = ''; result = ''; pendingDiff = null; }

  // view / edit a component's underlying file
  let viewer = $state(null);
  async function openViewer() {
    if (!selected) return;
    viewer = { loading: true };
    const r = await post('/api/component-read', { type: selected.type, name: selected.name, cwd: selected.fromPath });
    if (r && r.ok) viewer = { ...r, fromName: selected.fromName, fromPath: selected.fromPath, editing: false, status: '' };
    else viewer = { error: (r && r.error) || 'could not read file', type: selected.type, name: selected.name };
  }
  async function saveViewer() {
    if (!viewer || viewer.readonly) return;
    viewer.status = 'Saving…';
    const r = await post('/api/component-write', { cwd: viewer.fromPath, path: viewer.path, content: viewer.content });
    if (r && r.ok) { viewer.status = '✓ Saved'; viewer.editing = false; }
    else viewer.status = 'Error: ' + ((r && r.error) || 'failed');
  }
  async function openViewerInEditor(t) { if (viewer && viewer.path) await post('/api/open', { cwd: viewer.path, target: t }); }

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
    <div class="hd"><strong>Claude Projects</strong><span class="hd-actions"><button class="newbtn" onclick={openBuilder} title="Create a new agent, skill, or command">+ New</button><button class="x" onclick={closePanel} aria-label="Close">✕</button></span></div>

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

    <div class="findbar">
      <input class="findinput" placeholder="🔎 Find a skill / agent / hook / MCP across all projects…" bind:value={find} />
      {#if find}<button class="fx" onclick={() => (find = '')} aria-label="Clear">✕</button>{/if}
    </div>

    {#if find.trim()}
      <div class="list">
        {#if matches.length === 0}<div class="none" style="padding:12px 14px">No component matches “{find}”.</div>{/if}
        {#each matches as m (m.key)}
          <div class="fr">
            <div class="frhd"><span class="frtype">{m.type}</span><b class="frname">{m.name}</b><span class="frcount">{m.projects.length}×</span></div>
            <div class="frprojects">
              {#each m.projects as p (p.path)}<button class="chip" onclick={() => openProj(p)} title="Open {p.path}">{p.name}</button>{/each}
            </div>
          </div>
        {/each}
      </div>
    {:else}
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
                <button class="select" onclick={() => onConfig && onConfig(p.path)} title="This project's hooks · MCP servers · settings.json">⚙ Config</button>
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
    {/if}

    {#if selected}
      <div class="copybar">
        <div class="sl">Copy <b>{selected.type}</b> “{selected.name}” from <b>{selected.fromName}</b></div>
        <div class="row"><button class="select" onclick={openViewer}>👁 View / edit file</button></div>
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

    {#if viewer}
      <div class="vov" onclick={() => (viewer = null)} role="presentation"></div>
      <div class="vmodal" role="dialog" aria-label="Component file">
        <div class="vhd">
          <span class="frtype">{viewer.type}</span><b class="frname">{viewer.name}</b>
          {#if viewer.fromName}<span class="vproj">· {viewer.fromName}</span>{/if}
          <button class="x" onclick={() => (viewer = null)} aria-label="Close">✕</button>
        </div>
        {#if viewer.loading}
          <div class="none" style="padding:14px">Loading…</div>
        {:else if viewer.error}
          <div class="none" style="padding:14px">{viewer.error}</div>
        {:else}
          <div class="vpath mono" title={viewer.path}>{viewer.path}</div>
          {#if viewer.files && viewer.files.length > 1}<div class="vfiles">skill has {viewer.files.length} files: {viewer.files.join(', ')}</div>{/if}
          {#if viewer.editing}
            <textarea class="vedit mono" bind:value={viewer.content} spellcheck="false"></textarea>
          {:else}
            <pre class="vcontent">{viewer.content}</pre>
          {/if}
          <div class="vfoot">
            {#if viewer.readonly}
              <span class="dim">Read-only — edit hooks/MCP via the Config panel.</span>
            {:else if viewer.editing}
              <button class="select" onclick={saveViewer}>Save</button>
              <button class="select" onclick={() => (viewer.editing = false)}>Cancel</button>
            {:else}
              <button class="select" onclick={() => (viewer.editing = true)}>✎ Edit</button>
            {/if}
            <button class="select" onclick={() => openViewerInEditor('editor')}>Open in VS Code</button>
            {#if viewer.status}<span class="dim">{viewer.status}</span>{/if}
          </div>
        {/if}
      </div>
    {/if}
  </aside>
{/if}

<ComponentBuilder bind:open={builderOpen} defaultCwd={builderCwd} onCreated={loadAll} />

<style>
  .hd-actions { display: flex; align-items: center; gap: 8px; }
  .newbtn { font-size: 11px; padding: 2px 9px; border-radius: 99px; cursor: pointer;
    border: 0.5px solid var(--accent, #6366F1); background: transparent; color: var(--accent, #6366F1); font-weight: 600; }
  .newbtn:hover { background: color-mix(in srgb, var(--accent, #6366F1) 12%, transparent); }
  .drawer { --drawer-w: 360px; }   /* shell (.ov/.drawer/.hd/.x) is shared in app.css — right-anchored like the others */
  .roots { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .root { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .root .mono { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--font-mono); }
  .mini { font-size: 10px; padding: 1px 6px; border-radius: 6px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .addrow { display: flex; gap: 6px; margin-top: 2px; }
  .addrow input { flex: 1 1 auto; min-width: 0; font-size: 11px; padding: 5px 7px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .list { flex: 1 1 auto; overflow: auto; padding: 6px 8px; }
  .findbar { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .findinput { flex: 1 1 auto; min-width: 0; font-size: 11px; padding: 5px 8px; border-radius: var(--border-radius-md);
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .findbar .fx { background: none; border: none; cursor: pointer; color: var(--color-text-tertiary); font-size: 12px; }
  .fr { padding: 7px 12px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 5px; }
  .frhd { display: flex; align-items: center; gap: 7px; }
  .frtype { font-size: 8px; text-transform: uppercase; letter-spacing: 0.05em; color: #fff; background: var(--accent, #6366F1); padding: 1px 6px; border-radius: 99px; flex-shrink: 0; }
  .frname { font-size: 12px; color: var(--color-text-primary); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .frcount { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); flex-shrink: 0; }
  .frprojects { display: flex; flex-wrap: wrap; gap: 4px; padding-left: 2px; }
  .proj { border-bottom: 0.5px solid var(--color-border-tertiary); }
  .phead { display: flex; align-items: center; }
  .proj.muted { opacity: 0.5; }
  .mute { background: none; border: none; cursor: pointer; font-size: 12px; padding: 4px 8px; flex-shrink: 0; filter: grayscale(0.3); }
  .prow { display: flex; align-items: center; gap: 7px; flex: 1 1 auto; min-width: 0; background: none; border: none; cursor: pointer; padding: 7px 6px; text-align: left; color: var(--color-text-primary); border-radius: 6px; }
  .prow:hover { background: var(--color-background-secondary); }
  .caret { color: var(--accent, #6366F1); font-size: 11px; width: 12px; flex-shrink: 0; }
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
  .vov { position: fixed; inset: 0; z-index: 95; background: rgba(0, 0, 0, 0.4); }
  .vmodal { position: fixed; z-index: 96; top: 8vh; left: 50%; transform: translateX(-50%); width: 660px; max-width: 92vw; max-height: 82vh;
    background: var(--color-background-primary); border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg);
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.4); display: flex; flex-direction: column; overflow: hidden; }
  .vhd { display: flex; align-items: center; gap: 7px; padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .vproj { font-size: 11px; color: var(--color-text-tertiary); }
  .vhd .x { margin-left: auto; background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .vpath { font-size: 10px; color: var(--color-text-tertiary); padding: 6px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); word-break: break-all; }
  .vfiles { font-size: 10px; color: var(--color-text-tertiary); padding: 5px 14px 0; }
  .vcontent { flex: 1 1 auto; overflow: auto; margin: 0; padding: 12px 14px; font-family: var(--font-mono); font-size: 11px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; color: var(--color-text-primary); }
  .vedit { flex: 1 1 auto; min-height: 320px; margin: 8px 12px; padding: 10px; font-size: 11px; line-height: 1.5; resize: none;
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .vfoot { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
  .vfoot .dim { font-size: 11px; color: var(--color-text-tertiary); }
</style>
