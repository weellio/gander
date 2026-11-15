<script>
  // External sources — every API, website, feed, CDN and repo your projects talk
  // to, read from their own files. One registry across all projects: who shares
  // what, which credentials (env NAMES only) sit beside each source, and whether
  // the host answers right now. Nothing here edits a project.
  let { open = $bindable(false) } = $props();
  let _w = false;
  let timer;
  $effect(() => {
    if (open && !_w) { load(); timer = setInterval(() => { if (data && data.scanning) load(); }, 2500); }
    if (!open && _w) { clearInterval(timer); }
    _w = open;
  });

  let loading = $state(false);
  let data = $state(null);
  let flash = $state('');
  let checking = $state(false);
  let q = $state('');
  let kind = $state('');          // '' = all
  let project = $state('');       // path filter
  let sharedOnly = $state(false);
  let showNoise = $state(false);  // package registries
  let mentions = $state(false);   // hosts only mentioned in docs / data files
  const RENDER_CAP = 400;
  let openHost = $state('');

  const KINDS = [['api', 'APIs'], ['feed', 'Feeds'], ['site', 'Sites'], ['cdn', 'CDN'], ['repo', 'Repos'], ['docs', 'Docs'], ['package', 'Packages']];
  const KLABEL = Object.fromEntries(KINDS);

  async function load() {
    loading = true;
    try { data = await (await fetch('/api/sources')).json(); } catch (_) { data = null; }
    loading = false;
  }
  async function post(url, body) {
    try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json(); } catch (_) { return null; }
  }
  async function rescan(p) {
    const r = await post('/api/sources/rescan', p ? { path: p } : {});
    say(r && r.ok ? (p ? '🔄 rescanning that project…' : `🔄 rescanning ${r.queued} projects…`) : '✗ rescan failed');
    load();
  }
  async function checkAll(host) {
    checking = true;
    const r = await post('/api/sources/check', host ? { host } : {});
    checking = false;
    if (r && r.ok) { const down = Object.values(r.results).filter((c) => !c.ok).length; say(down ? `✓ checked ${r.checked} · ${down} not answering` : `✓ checked ${r.checked} · all answering`); } else say('✗ check failed');
    load();
  }
  async function toggleOwn(r) { await post('/api/sources/own', { host: r.host, own: !r.own }); load(); }
  async function toggleDaily(e) { const r = await post('/api/sources/daily', { enabled: e.target.checked }); say(r && r.enabled ? '✓ daily check on — a host that stops answering pings Telegram' : '✓ daily check off'); load(); }
  async function copyMd() {
    const qs = new URLSearchParams(); if (mentions) qs.set('mentions', '1'); if (project) qs.set('project', project);
    const url = '/api/sources.md' + (qs.toString() ? '?' + qs.toString() : '');
    try { const md = await (await fetch(url)).text(); await navigator.clipboard.writeText(md); say('✓ copied as Markdown — paste it into any project'); }
    catch (_) { window.open(url, '_blank'); say('opened the Markdown in a tab (clipboard blocked)'); }
  }
  function say(m) { flash = m; setTimeout(() => (flash = ''), 3200); }
  function ago(ts) {
    if (!ts) return 'never';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; const h = Math.round(m / 60); if (h < 48) return h + 'h ago'; return Math.round(h / 24) + 'd ago';
  }

  let rows = $derived.by(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.rows.filter((r) =>
      (showNoise || r.kind !== 'package') &&
      (mentions || r.code) &&
      (!kind || r.kind === kind) &&
      (!project || r.projects.some((p) => p.path === project)) &&
      (!sharedOnly || r.shared) &&
      (!needle || r.host.includes(needle) || r.env.some((e) => e.toLowerCase().includes(needle)) || r.projects.some((p) => p.name.toLowerCase().includes(needle))));
  });
  let counts = $derived.by(() => {
    const c = {}; if (!data) return c;
    for (const r of data.rows) if (mentions || r.code) c[r.kind] = (c[r.kind] || 0) + 1;
    return c;
  });
  let scannedProjects = $derived(data ? data.projects.filter((p) => p.scannedAt) : []);

  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="External sources used by your projects">
    <div class="hd">
      <strong>🌐 Sources</strong>
      <div class="hdr">
        <button class="select" onclick={copyMd} title={project ? 'This project\'s sources as Markdown, on the clipboard' : 'The whole registry as Markdown, on the clipboard'}>Copy as Markdown{project ? ' (this project)' : ''}</button>
        <button class="select" onclick={() => checkAll()} disabled={checking} title="HEAD each API, feed and site: does it answer right now?">{checking ? 'Checking…' : 'Check all'}</button>
        <button class="select" onclick={() => rescan()} disabled={data && data.scanning} title="Read every project's files again">{data && data.scanning ? 'Scanning…' : 'Rescan'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="intro">Every API, website, feed and CDN your projects talk to, read from their own files. Shared ones float to the top, so when a new project needs a source you can see who already uses it and which env names it reads. Hosts only, never the values of your keys.</div>

    <div class="tools">
      <input class="in" placeholder="search host, project or env name…" bind:value={q} />
      <select class="in" bind:value={project} title="Only sources this project uses">
        <option value="">all projects</option>
        {#each scannedProjects as p (p.path)}<option value={p.path}>{p.name} ({p.hosts})</option>{/each}
      </select>
    </div>
    <div class="chips">
      <button class="chip" class:on={kind === ''} onclick={() => (kind = '')}>all</button>
      {#each KINDS as [k, label] (k)}
        {#if k !== 'package' || showNoise}<button class="chip" class:on={kind === k} onclick={() => (kind = kind === k ? '' : k)}>{label} <span class="n">{counts[k] || 0}</span></button>{/if}
      {/each}
      <label class="chk"><input type="checkbox" bind:checked={sharedOnly} /> shared by 2+</label>
      <label class="chk" title="Also list hosts that only appear in notes, READMEs and data files"><input type="checkbox" bind:checked={mentions} /> mentions in docs &amp; data</label>
      <label class="chk"><input type="checkbox" bind:checked={showNoise} /> package registries</label>
    </div>

    <div class="body">
      {#if loading && !data}
        <div class="muted">Reading the registry…</div>
      {:else if !data}
        <div class="muted">The bridge did not answer.</div>
      {:else if data.scanning && !data.rows.length}
        <div class="muted">First scan running: reading every project's files. This takes a minute for a big folder; the list fills in as projects finish.</div>
      {:else if !rows.length}
        <div class="muted">{data.rows.length ? 'Nothing matches that filter.' : 'No external sources found yet. Rescan if you just added a project.'}</div>
      {:else}
        {#each rows.slice(0, RENDER_CAP) as r (r.host)}
          <div class="row" class:openrow={openHost === r.host} class:mention={!r.code}>
            <div class="main">
              <button class="star" class:on={r.own} onclick={() => toggleOwn(r)} title={r.own ? 'Your own domain (click to unmark)' : 'Mark as your own domain'}>{r.own ? '⭐' : '☆'}</button>
              <a class="host" href={'https://' + r.host + '/'} target="_blank" rel="noopener" title="Open in a new tab">{r.host}</a>
              {#if !r.code}<span class="tag" title="Only mentioned in docs or data files, no code calls it">mention</span>{/if}
              <span class="tag k-{r.kind}">{KLABEL[r.kind] || r.kind}</span>
              {#if r.shared}<span class="tag shared">{r.projects.length} projects</span>{/if}
              {#if r.check}
                <span class="tag" class:up={r.check.ok} class:down={!r.check.ok} title={`${r.check.method} https://${r.host}/ → ${r.check.status || r.check.error} in ${r.check.ms} ms, ${ago(r.check.at)}`}>{r.check.ok ? `up ${r.check.ms}ms` : `down · ${r.check.error || r.check.status}`}</span>
              {/if}
              <button class="more" onclick={() => (openHost = openHost === r.host ? '' : r.host)} title="Where it is used">{openHost === r.host ? '▾' : '▸'}</button>
            </div>
            <div class="sub">
              <span class="projs">{#each r.projects as p (p.path)}<button class="pchip" onclick={() => (project = project === p.path ? '' : p.path)} title={p.path}>{p.name}<span class="pc">{p.count}</span></button>{/each}</span>
              {#if r.env.length}<span class="env mono" title="Env names read in the files that mention this host">{r.env.join(' · ')}</span>{/if}
            </div>
            {#if openHost === r.host}
              <div class="detail">
                {#each r.projects as p (p.path)}
                  <div class="dproj">
                    <div class="dname">{p.name} <span class="muted2">{p.count} mention{p.count === 1 ? '' : 's'}</span></div>
                    {#if p.files.length}<div class="mono dfiles">{p.files.join('  ·  ')}</div>{/if}
                    {#each p.urls as u (u)}<div class="mono durl">{u}</div>{/each}
                  </div>
                {/each}
                <div class="dact"><button class="select" onclick={() => checkAll(r.host)}>Check this host</button></div>
              </div>
            {/if}
          </div>
        {/each}
        {#if rows.length > RENDER_CAP}<div class="muted">{rows.length - RENDER_CAP} more. Narrow the filter or search.</div>{/if}
      {/if}
    </div>

    {#if flash}<div class="flash" class:err={flash[0] === '✗'}>{flash}</div>{/if}
    <div class="foot">
      {#if data}
        <span>{scannedProjects.length} projects · {data.rows.filter((r) => r.code && r.kind !== 'package').length} hosts the code talks to · {data.rows.filter((r) => !r.code).length} more only mentioned{#if data.lastCheckAt} · checked {ago(data.lastCheckAt)}{/if}</span>
        <label class="chk daily" title="Once a day, HEAD every API, feed and site; a host that answered last time and does not now sends one Telegram line"><input type="checkbox" checked={!!data.dailyCheck} onchange={toggleDaily} /> daily check + Telegram when one stops answering</label>
        <details class="pl">
          <summary>Per project</summary>
          {#each data.projects as p (p.path)}
            <div class="prow"><span class="pn" title={p.path}>{p.name}</span><span class="muted2">{p.scanning ? 'scanning…' : p.scannedAt ? `${p.hosts} hosts · ${p.files} files · ${ago(p.scannedAt)}` : 'not scanned'}</span><button class="mini" onclick={() => rescan(p.path)} title="Rescan this project">↻</button></div>
          {/each}
        </details>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 560px; }
  .hdr { display: flex; align-items: center; gap: 6px; }
  .intro { font-size: 11px; color: var(--color-text-secondary); line-height: 1.5; padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .tools { display: flex; gap: 6px; padding: 8px 14px 4px; }
  .tools .in { flex: 1 1 auto; min-width: 0; font-size: 11px; padding: 5px 8px; border-radius: 6px; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-primary); }
  .tools select.in { flex: 0 0 170px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; padding: 4px 14px 8px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .chip { font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); cursor: pointer; }
  .chip.on { border-color: var(--accent, #6366F1); color: var(--accent, #6366F1); background: #6366F11a; }
  .chip .n { opacity: 0.7; margin-left: 3px; }
  .chk { font-size: 10px; color: var(--color-text-tertiary); display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; cursor: pointer; }
  .body { flex: 1 1 auto; overflow: auto; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 14px; line-height: 1.5; }
  .muted2 { font-size: 10px; color: var(--color-text-tertiary); font-weight: 400; }
  .mono { font-family: var(--font-mono); }

  .row { padding: 8px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 4px; }
  .row.openrow { background: var(--color-background-secondary); }
  .row.mention .host { font-weight: 400; color: var(--color-text-secondary); }
  .main { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .star { background: none; border: 0; cursor: pointer; font-size: 12px; padding: 0 2px; opacity: 0.45; }
  .star.on, .star:hover { opacity: 1; }
  .host { font-size: 12px; font-weight: 600; color: var(--color-text-primary); text-decoration: none; }
  .host:hover { text-decoration: underline; }
  .tag { font-size: 8.5px; padding: 1px 6px; border-radius: 999px; background: var(--color-background-secondary); color: var(--color-text-tertiary); white-space: nowrap; }
  .tag.k-api { background: #6366F11f; color: var(--accent, #6366F1); }
  .tag.k-feed { background: #F59E0B1f; color: #D97706; }
  .tag.k-site { background: #10B9811a; color: #059669; }
  .tag.k-cdn, .tag.k-package { opacity: 0.8; }
  .tag.shared { background: #EC48991a; color: #DB2777; }
  .tag.up { background: #10B9811a; color: #10B981; }
  .tag.down { background: #EF44441a; color: #EF4444; }
  .more { margin-left: auto; background: none; border: 0; cursor: pointer; color: var(--color-text-tertiary); font-size: 12px; }
  .sub { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .projs { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .pchip { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 0.5px solid var(--color-border-secondary); background: transparent; color: var(--color-text-secondary); cursor: pointer; }
  .pchip:hover { border-color: var(--accent, #6366F1); }
  .pc { margin-left: 4px; opacity: 0.6; }
  .env { font-size: 9.5px; color: var(--color-text-tertiary); }
  .detail { margin-top: 4px; padding: 6px 8px; border-left: 2px solid var(--accent, #6366F1); display: flex; flex-direction: column; gap: 6px; }
  .dname { font-size: 11px; font-weight: 600; color: var(--color-text-primary); }
  .dfiles, .durl { font-size: 9.5px; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .durl { color: var(--color-text-secondary); }
  .dact { padding-top: 2px; }

  .flash { font-size: 11px; padding: 8px 14px; color: #10B981; border-top: 0.5px solid var(--color-border-tertiary); }
  .flash.err { color: #EF4444; }
  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 9px 14px; border-top: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 4px; }
  .daily { margin: 0; }
  .pl summary { cursor: pointer; }
  .prow { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
  .pn { font-weight: 600; color: var(--color-text-secondary); }
  .prow .muted2 { margin-left: auto; }
  .mini { background: none; border: 0.5px solid var(--color-border-secondary); border-radius: 4px; cursor: pointer; color: var(--color-text-secondary); font-size: 10px; padding: 0 5px; }
</style>
