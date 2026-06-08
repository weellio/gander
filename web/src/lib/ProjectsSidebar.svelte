<script>
  let open = $state(false);
  let data = $state({ roots: [], projects: [] });
  let newRoot = $state('');
  let expanded = $state({});
  let selected = $state(null);   // { fromPath, fromName, type, name }
  let target = $state('');
  let result = $state('');
  let gitMap = $state({});
  let timer = null;

  async function load() { try { const r = await fetch('/api/projects'); data = await r.json(); loadGit(); } catch (_) {} }
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
  function pick(proj, type, name) { selected = { fromPath: proj.path, fromName: proj.name, type, name }; target = ''; result = ''; }

  let busy = $state('');
  let commitMsg = $state({});
  async function launch(p) { busy = p.path + ':launch'; const j = await post('/api/launch', { cwd: p.path }); result = j && j.ok ? `Started a Claude session in ${p.name}` : 'Could not launch'; busy = ''; }
  async function openIn(p, target) { await post('/api/open', { cwd: p.path, target }); }
  async function gitDo(p, action) {
    busy = p.path + ':' + action;
    const j = await post('/api/git-action', { cwd: p.path, action, message: commitMsg[p.path] || '' });
    const tail = (j && j.output ? ' — ' + j.output.split('\n').slice(-1)[0] : '');
    result = j && j.ok ? `git ${action} ✓${tail}` : `git ${action} ✗${tail || ': ' + ((j && j.error) || 'failed')}`;
    busy = ''; loadGit();
  }
  async function doCopy() {
    if (!selected || !target) return;
    const body = { type: selected.type, name: selected.name, fromCwd: selected.fromPath, toCwd: target };
    let j = await post('/api/copy-component', body);
    if (j && j.exists) {
      if (!confirm(`“${selected.name}” already exists in the target project. Overwrite it?`)) { result = 'Cancelled — already exists.'; return; }
      j = await post('/api/copy-component', { ...body, overwrite: true });
    }
    result = j && j.ok ? `Copied ${selected.type} “${selected.name}” → ${String(target).split(/[\\/]/).pop()}` : 'Error: ' + ((j && j.error) || 'failed');
    load();
  }
  const GROUPS = [['skill', 'Skills'], ['agent', 'Agents'], ['command', 'Commands'], ['hook', 'Hooks'], ['mcp', 'MCP']];
  const itemsOf = (p, type) => type === 'skill' ? p.skills : type === 'agent' ? p.agents : type === 'command' ? p.commands : type === 'hook' ? p.hooks : p.mcp;
</script>

<button class="select" onclick={openPanel}>Projects</button>

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
        <div class="proj">
          <button class="prow" onclick={() => (expanded = { ...expanded, [p.path]: !expanded[p.path] })}>
            <span class="caret">{expanded[p.path] ? '▾' : '▸'}</span>
            <span class="pname" title={p.path}>{p.name}</span>
            {#if p.running}<span class="run">● live</span>{/if}
            {#if gitMap[p.path]?.isRepo}
              <span class="git" title={[gitMap[p.path].remote, gitMap[p.path].lastWhen && 'last: ' + gitMap[p.path].lastWhen].filter(Boolean).join('\n')}>
                ⎇{gitMap[p.path].branch}{#if gitMap[p.path].dirty}<i class="dirty">●{gitMap[p.path].dirty}</i>{/if}{#if gitMap[p.path].ahead}<i class="ah">↑{gitMap[p.path].ahead}</i>{/if}{#if gitMap[p.path].behind}<i class="bh">↓{gitMap[p.path].behind}</i>{/if}
              </span>
            {/if}
            <span class="counts">{p.skills.length}·{p.agents.length}·{p.commands.length}·{p.hooks.length}</span>
          </button>
          {#if expanded[p.path]}
            <div class="comps">
              <div class="acts">
                <button class="select" onclick={() => launch(p)} disabled={!!busy} title="Open a new terminal running Claude Code here">▶ Start</button>
                <button class="select" onclick={() => openIn(p, 'folder')} title="Open folder">📂</button>
                <button class="select" onclick={() => openIn(p, 'editor')} title="Open in VS Code">Code</button>
                {#if gitMap[p.path]?.isRepo}
                  <button class="select" onclick={() => gitDo(p, 'pull')} disabled={!!busy} title="git pull">⬇ Pull</button>
                  <input class="cm" placeholder="commit message…" bind:value={commitMsg[p.path]} />
                  <button class="select" onclick={() => gitDo(p, 'commit-push')} disabled={!!busy || !gitMap[p.path].dirty} title="git add -A · commit · push">Commit & Push{#if gitMap[p.path].dirty} ({gitMap[p.path].dirty}){/if}</button>
                {/if}
              </div>
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
          <select bind:value={target} class="select">
            <option value="">to project…</option>
            {#each data.projects.filter((p) => p.path !== selected.fromPath) as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
          </select>
          <button class="select" onclick={doCopy} disabled={!target}>Copy</button>
        </div>
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
  .prow { display: flex; align-items: center; gap: 7px; width: 100%; background: none; border: none; cursor: pointer; padding: 7px 6px; text-align: left; color: var(--color-text-primary); }
  .caret { color: var(--color-text-tertiary); font-size: 10px; width: 10px; }
  .pname { flex: 1 1 auto; font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run { font-size: 9px; color: #10B981; }
  .counts { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }
  .git { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-family: var(--font-mono); color: var(--color-text-tertiary); white-space: nowrap; }
  .git i { font-style: normal; }
  .git .dirty { color: #F59E0B; }
  .git .ah { color: #10B981; }
  .git .bh { color: #EF4444; }
  .comps { padding: 2px 6px 10px 26px; display: flex; flex-direction: column; gap: 6px; }
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-bottom: 6px; margin-bottom: 2px; border-bottom: 0.5px dashed var(--color-border-tertiary); }
  .acts .cm { flex: 1 1 90px; min-width: 80px; font-size: 10px; padding: 3px 6px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); }
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
</style>
