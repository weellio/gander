<script>
  // View + edit Claude's memory: CLAUDE.md (the instructions Claude reads every
  // session) and the .claude/memory/*.md fact files. Scope is Global (~/.claude)
  // or any project (its CLAUDE.md + .claude/memory). Edits write straight to disk.
  let { open = $bindable(false), initialScope = 'global', initialCwd = '' } = $props();
  let _w = false;
  $effect(() => { if (open && !_w) onOpen(); _w = open; });

  let projects = $state([]);
  let sel = $state('__global');   // '__global' or a project path
  let data = $state(null);
  let loading = $state(false);
  let openFacts = $state({});
  let st = $state({});            // status keyed by claudemd / index / <file>
  let flash = $state('');

  async function post(p, b) { try { return await (await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(); } catch (_) { return null; } }
  async function loadProjects() { try { const r = await fetch('/api/projects'); const j = await r.json(); projects = j.projects || []; } catch (_) {} }
  function ctx() { return sel === '__global' ? { scope: 'global' } : { scope: 'project', cwd: sel }; }

  async function load() {
    loading = true; data = null; openFacts = {}; st = {};
    const j = await post('/api/memory-read', ctx());
    data = j && j.ok ? j : null;
    loading = false;
  }
  async function onOpen() {
    sel = initialScope === 'project' && initialCwd ? initialCwd : '__global';
    await loadProjects();
    await load();
  }
  function onScope() { load(); }
  function toggle(k) { openFacts = { ...openFacts, [k]: !openFacts[k] }; }

  async function saveClaudeMd() {
    st = { ...st, claudemd: 'Saving…' };
    const r = await post('/api/memory-write', { ...ctx(), target: 'claudemd', content: data.claudeMd.content });
    st = { ...st, claudemd: r && r.ok ? '✓ saved' : ('✗ ' + ((r && r.error) || 'failed')) };
    if (r && r.ok) data.claudeMd.exists = true;
  }
  async function saveIndex() {
    st = { ...st, index: 'Saving…' };
    const r = await post('/api/memory-write', { ...ctx(), target: 'index', content: data.index.content });
    st = { ...st, index: r && r.ok ? '✓ saved' : ('✗ ' + ((r && r.error) || 'failed')) };
  }
  async function saveFact(f) {
    st = { ...st, [f.file]: 'Saving…' };
    const r = await post('/api/memory-write', { ...ctx(), target: 'fact', file: f.file, content: f.content });
    st = { ...st, [f.file]: r && r.ok ? '✓ saved' : ('✗ ' + ((r && r.error) || 'failed')) };
  }
  async function delFact(f) {
    if (!confirm(`Delete memory "${f.name || f.file}"? This removes the file.`)) return;
    const r = await post('/api/memory-delete', { ...ctx(), file: f.file });
    if (r && r.ok) { flash = `🗑 deleted ${f.name || f.file}`; load(); } else { flash = '✗ ' + ((r && r.error) || 'failed'); }
    setTimeout(() => (flash = ''), 2600);
  }

  function close() { open = false; }
  function onKey(e) { if (e.key === 'Escape') close(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={close} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Claude memory">
    <div class="hd"><strong>Claude Memory</strong><button class="x" onclick={close} aria-label="Close">✕</button></div>

    <div class="picker">
      <div class="lbl">Scope</div>
      <select class="select wide" bind:value={sel} onchange={onScope}>
        <option value="__global">Global (~/.claude)</option>
        {#each projects as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
      </select>
    </div>

    <div class="body">
      {#if loading}
        <div class="muted">Loading…</div>
      {:else if !data}
        <div class="muted">Couldn't read memory for this scope.</div>
      {:else}
        <div class="sec">
          <div class="sh">CLAUDE.md {#if !data.claudeMd.exists}<span class="dim">· not created yet</span>{/if}</div>
          <div class="pathline mono" title={data.claudeMd.path}>{data.claudeMd.path}</div>
          <textarea class="ta" bind:value={data.claudeMd.content} placeholder="The instructions Claude reads every session for this scope…"></textarea>
          <div class="row"><button class="select" onclick={saveClaudeMd}>Save CLAUDE.md</button>{#if st.claudemd}<span class="dim">{st.claudemd}</span>{/if}</div>
        </div>

        <div class="sec">
          <div class="sh">Memory facts <span class="dim">· {data.facts.length}</span></div>
          <div class="pathline mono" title={data.memoryDir}>{data.memoryDir}</div>
          {#if !data.facts.length && !data.index.exists}
            <div class="muted" style="padding:6px 0">No memory files here.</div>
          {/if}
          {#each data.facts as f (f.file)}
            <div class="fact">
              <button class="fhd" onclick={() => toggle(f.file)}>
                <span class="caret">{openFacts[f.file] ? '▾' : '▸'}</span>
                <span class="fname">{f.name || f.file}</span>
                {#if f.type}<span class="ftype">{f.type}</span>{/if}
              </button>
              {#if f.description}<div class="fdesc">{f.description}</div>{/if}
              {#if openFacts[f.file]}
                <textarea class="ta" bind:value={f.content}></textarea>
                <div class="row">
                  <button class="select" onclick={() => saveFact(f)}>Save</button>
                  <button class="select danger" onclick={() => delFact(f)}>Delete</button>
                  {#if st[f.file]}<span class="dim">{st[f.file]}</span>{/if}
                </div>
              {/if}
            </div>
          {/each}
          {#if data.index.exists}
            <div class="fact">
              <button class="fhd" onclick={() => toggle('__index')}><span class="caret">{openFacts['__index'] ? '▾' : '▸'}</span><span class="fname">MEMORY.md <span class="dim">(index)</span></span></button>
              {#if openFacts['__index']}
                <textarea class="ta" bind:value={data.index.content}></textarea>
                <div class="row"><button class="select" onclick={saveIndex}>Save index</button>{#if st.index}<span class="dim">{st.index}</span>{/if}</div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if flash}<div class="flash">{flash}</div>{/if}
    <div class="foot">Edits write straight to the .md files. CLAUDE.md loads every session; the facts are whatever Claude has stored. Changes apply next session.</div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 500px; }
  .picker { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .wide { width: 100%; }
  .body { flex: 1 1 auto; overflow: auto; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 14px; }
  .mono { font-family: var(--font-mono); }
  .sec { padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 6px; }
  .sh { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent, #6366F1); font-weight: 600; }
  .dim { color: var(--color-text-tertiary); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .pathline { font-size: 9px; color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ta { width: 100%; min-height: 120px; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; padding: 8px 10px;
    border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-primary); resize: vertical; box-sizing: border-box; }
  .row { display: flex; align-items: center; gap: 8px; }
  .fact { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; border-top: 0.5px solid var(--color-border-tertiary); }
  .fhd { display: flex; align-items: center; gap: 7px; background: none; border: none; cursor: pointer; padding: 2px 0; text-align: left; font-size: 12.5px; font-weight: 600; color: var(--color-text-primary); width: 100%; }
  .fhd:hover { color: var(--accent, #6366F1); }
  .caret { color: var(--accent, #6366F1); font-size: 11px; width: 12px; flex-shrink: 0; }
  .fname { flex: 1 1 auto; }
  .ftype { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px; background: var(--color-background-secondary); color: var(--color-text-tertiary); flex-shrink: 0; }
  .fdesc { font-size: 11px; color: var(--color-text-secondary); line-height: 1.4; padding-left: 19px; }
  .danger { color: var(--hm-err, #EF4444); border-color: #EF444455; }
  .danger:hover { background: var(--hm-err, #EF4444); color: #fff; }
  .flash { font-size: 11px; padding: 8px 14px; color: var(--hm-ok, #10B981); border-top: 0.5px solid var(--color-border-tertiary); }
  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 9px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
</style>
