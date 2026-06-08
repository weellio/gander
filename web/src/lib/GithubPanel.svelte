<script>
  let open = $state(false);
  let projects = $state([]);
  let chosenPath = $state('');
  let repoInfo = $state(null);   // { repo, url, defaultBranch, visibility } | { error } | null
  let prList = $state(null);     // array | { error } | null
  let issueList = $state(null);  // array | { error } | null
  let loading = $state(false);

  async function post(path, body) {
    try {
      return await (await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
    } catch (_) { return null; }
  }

  async function loadProjects() {
    try {
      const r = await fetch('/api/projects');
      const d = await r.json();
      projects = d.projects || [];
    } catch (_) { projects = []; }
  }

  function openPanel() {
    open = true;
    repoInfo = null; prList = null; issueList = null;
    loadProjects();
  }

  function closePanel() { open = false; }

  function handleKeydown(e) { if (e.key === 'Escape') closePanel(); }

  async function loadGithub() {
    if (!chosenPath) return;
    loading = true;
    repoInfo = null; prList = null; issueList = null;
    const [inf, prs, iss] = await Promise.all([
      post('/api/github', { cwd: chosenPath, kind: 'info' }),
      post('/api/github', { cwd: chosenPath, kind: 'prs' }),
      post('/api/github', { cwd: chosenPath, kind: 'issues' }),
    ]);
    repoInfo  = inf;
    prList    = prs;
    issueList = iss;
    loading = false;
  }

  function onProjectChange() { loadGithub(); }

  function openUrl(url) { if (url) window.open(url, '_blank', 'noopener'); }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) { return iso.slice(0, 10); }
  }

  const notRepo = (x) => x && typeof x === 'object' && !Array.isArray(x) && x.error;
</script>

<svelte:window onkeydown={handleKeydown} />

<button class="select" onclick={openPanel}>GitHub</button>

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="GitHub panel">
    <div class="hd">
      <strong>GitHub</strong>
      <div class="hd-actions">
        {#if chosenPath}
          <button class="mini" onclick={loadGithub} disabled={loading} title="Refresh">↺ Refresh</button>
        {/if}
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="picker">
      <div class="lbl">Project</div>
      <select
        class="select proj-select"
        bind:value={chosenPath}
        onchange={onProjectChange}
      >
        <option value="">choose a project…</option>
        {#each projects as p (p.path)}
          <option value={p.path}>{p.name}</option>
        {/each}
      </select>
    </div>

    <div class="body">
      {#if !chosenPath}
        <div class="empty">Select a project to see its GitHub status.</div>

      {:else if loading}
        <div class="empty">Loading…</div>

      {:else if notRepo(repoInfo)}
        <div class="empty err">
          {#if repoInfo.error === 'not a git repo'}
            Not a Git repository.
          {:else if repoInfo.error === 'no GitHub remote'}
            No GitHub remote configured.
          {:else if repoInfo.error === 'gh not authenticated'}
            Run <code>gh auth login</code> to connect.
          {:else if repoInfo.error === 'gh CLI not found'}
            <code>gh</code> CLI not found in PATH.
          {:else}
            {repoInfo.error}
          {/if}
        </div>

      {:else if repoInfo}
        <!-- Repo header -->
        <div class="repo-header">
          <button class="repo-name" onclick={() => openUrl(repoInfo.url)} title={repoInfo.url}>
            {repoInfo.repo}
          </button>
          <span class="badge vis">{repoInfo.visibility.toLowerCase()}</span>
          <span class="branch mono">⎇ {repoInfo.defaultBranch}</span>
        </div>

        <!-- Open PRs -->
        <div class="section">
          <div class="sec-hd">
            <span class="lbl">Open PRs</span>
            {#if Array.isArray(prList)}<span class="count">{prList.length}</span>{/if}
          </div>
          {#if notRepo(prList)}
            <div class="row-empty">{prList.error}</div>
          {:else if Array.isArray(prList) && prList.length === 0}
            <div class="row-empty">No open pull requests.</div>
          {:else if Array.isArray(prList)}
            {#each prList as pr (pr.number)}
              <button class="item-row" onclick={() => openUrl(pr.url)}>
                <span class="num mono">#{pr.number}</span>
                <span class="title">{pr.title}</span>
                <span class="meta-right">
                  {#if pr.isDraft}<span class="badge draft">draft</span>{/if}
                  <span class="badge pr-state">{pr.state.toLowerCase()}</span>
                  <span class="author">@{pr.author}</span>
                  <span class="date">{fmtDate(pr.updatedAt)}</span>
                </span>
              </button>
            {/each}
          {/if}
        </div>

        <!-- Issues -->
        <div class="section">
          <div class="sec-hd">
            <span class="lbl">Issues</span>
            {#if Array.isArray(issueList)}<span class="count">{issueList.length}</span>{/if}
          </div>
          {#if notRepo(issueList)}
            <div class="row-empty">{issueList.error}</div>
          {:else if Array.isArray(issueList) && issueList.length === 0}
            <div class="row-empty">No open issues.</div>
          {:else if Array.isArray(issueList)}
            {#each issueList as iss (iss.number)}
              <button class="item-row" onclick={() => openUrl(iss.url)}>
                <span class="num mono">#{iss.number}</span>
                <span class="title">{iss.title}</span>
                <span class="meta-right">
                  <span class="badge iss-state">{iss.state.toLowerCase()}</span>
                  <span class="author">@{iss.author}</span>
                  <span class="date">{fmtDate(iss.updatedAt)}</span>
                </span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.25); }
  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 91; width: 400px; max-width: 94vw;
    background: var(--color-background-primary); border-left: 0.5px solid var(--color-border-secondary);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column;
  }
  .hd {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); flex-shrink: 0;
  }
  .hd-actions { display: flex; align-items: center; gap: 8px; }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .mini {
    font-size: 10px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary);
    color: var(--color-text-secondary);
  }
  .mini:disabled { opacity: 0.45; cursor: default; }
  .picker { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); flex-shrink: 0; display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .proj-select { width: 100%; }
  .body { flex: 1 1 auto; overflow-y: auto; padding: 8px 0; }
  .empty { padding: 20px 14px; font-size: 12px; color: var(--color-text-tertiary); text-align: center; }
  .empty.err { color: #e57373; }
  .empty code { font-family: var(--font-mono); font-size: 11px; }
  .repo-header {
    display: flex; align-items: center; gap: 7px; padding: 8px 14px 10px;
    border-bottom: 0.5px solid var(--color-border-tertiary);
  }
  .repo-name {
    background: none; border: none; cursor: pointer; font-size: 13px; font-weight: 600;
    color: var(--accent, #6366F1); padding: 0; text-decoration: underline; text-underline-offset: 2px;
  }
  .repo-name:hover { opacity: 0.8; }
  .branch { font-size: 10px; color: var(--color-text-tertiary); margin-left: auto; }
  .mono { font-family: var(--font-mono); }
  .badge {
    font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .vis { background: var(--color-background-secondary); color: var(--color-text-tertiary); border: 0.5px solid var(--color-border-tertiary); }
  .draft { background: #7c3aed22; color: #7c3aed; }
  .pr-state { background: #16803322; color: #168033; }
  .iss-state { background: #16803322; color: #168033; }
  .section { padding: 8px 0; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .section:last-child { border-bottom: none; }
  .sec-hd { display: flex; align-items: center; gap: 6px; padding: 4px 14px 6px; }
  .count { font-size: 9px; background: var(--color-background-secondary); color: var(--color-text-tertiary); padding: 1px 6px; border-radius: 99px; border: 0.5px solid var(--color-border-tertiary); font-family: var(--font-mono); }
  .row-empty { padding: 4px 14px 6px; font-size: 11px; color: var(--color-text-tertiary); }
  .item-row {
    display: flex; align-items: center; gap: 7px; width: 100%;
    background: none; border: none; cursor: pointer; padding: 6px 14px;
    text-align: left; color: var(--color-text-primary);
    border-bottom: 0.5px solid var(--color-border-tertiary);
  }
  .item-row:last-child { border-bottom: none; }
  .item-row:hover { background: var(--color-background-secondary); }
  .num { font-size: 10px; color: var(--color-text-tertiary); flex-shrink: 0; width: 32px; }
  .title { flex: 1 1 auto; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta-right { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
  .author { font-size: 9px; color: var(--color-text-tertiary); }
  .date { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }
</style>
