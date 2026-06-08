<script>
  let { open = $bindable(false), onView } = $props();

  // Track open state for load-on-open pattern (no auto-load; load on submit)
  let _w = false;
  $effect(() => { if (open && !_w) { _w = true; } else if (!open) { _w = false; } });

  let q        = $state('');
  let results  = $state([]);    // [{ sessionId, project, cwd, count, lastActive, snippets }]
  let projects = $state([]);    // matched project paths
  let total    = $state(0);
  let scanned  = $state(0);
  let loading  = $state(false);
  let searched = $state(false); // true after at least one search attempt
  let error    = $state('');

  let debounceTimer = null;

  function closePanel() { open = false; clearTimeout(debounceTimer); }

  function onKeydown(e) { if (e.key === 'Escape') closePanel(); }

  async function doSearch() {
    const query = q.trim();
    if (query.length < 2) {
      results  = [];
      projects = [];
      total    = 0;
      scanned  = 0;
      searched = false;
      error    = query.length === 1 ? 'Enter at least 2 characters.' : '';
      return;
    }
    loading  = true;
    error    = '';
    searched = false;
    try {
      const r = await fetch('/api/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ q: query }),
      });
      const data = await r.json();
      results  = data.results  || [];
      projects = data.projects || [];
      total    = data.total    ?? 0;
      scanned  = data.scanned  ?? 0;
      searched = true;
    } catch (err) {
      error   = 'Search failed. Is the bridge server running?';
      results = [];
      projects = [];
    } finally {
      loading = false;
    }
  }

  function onInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, 300);
  }

  function onEnter(e) {
    if (e.key === 'Enter') { clearTimeout(debounceTimer); doSearch(); }
  }

  function relTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return 'just now';
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  /** Highlight the matched term inside a snippet string. Returns an array of
   *  { text, hi } segments (hi=true means highlight). */
  function highlight(text, query) {
    if (!query || !text) return [{ text, hi: false }];
    const segments = [];
    const lower   = text.toLowerCase();
    const qLower  = query.toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const idx = lower.indexOf(qLower, pos);
      if (idx === -1) { segments.push({ text: text.slice(pos), hi: false }); break; }
      if (idx > pos)    segments.push({ text: text.slice(pos, idx), hi: false });
      segments.push({ text: text.slice(idx, idx + query.length), hi: true });
      pos = idx + query.length;
    }
    return segments;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- trigger provided by App's Manage menu (bind:open) -->

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Search transcripts">
    <div class="hd">
      <strong>Search Transcripts</strong>
      <button class="x" onclick={closePanel} aria-label="Close">✕</button>
    </div>

    <div class="search-row">
      <input
        class="q-input"
        bind:value={q}
        oninput={onInput}
        onkeydown={onEnter}
        placeholder="search sessions… (min 2 chars)"
        autofocus
      />
      <button class="select" onclick={() => { clearTimeout(debounceTimer); doSearch(); }} disabled={loading}>
        {loading ? '…' : 'Search'}
      </button>
    </div>

    {#if error}
      <div class="err">{error}</div>
    {/if}

    <div class="body">
      <!-- Matched project paths -->
      {#if projects.length > 0}
        <div class="section-label">Project paths ({projects.length})</div>
        <div class="proj-list">
          {#each projects as p (p)}
            <div class="proj-path mono" title={p}>{p}</div>
          {/each}
        </div>
      {/if}

      <!-- Results -->
      {#if loading}
        <div class="empty">Searching {scanned > 0 ? scanned + ' files…' : '…'}</div>
      {:else if searched && results.length === 0}
        <div class="empty">No sessions matched "{q.trim()}" (scanned {scanned} files).</div>
      {:else if results.length > 0}
        <div class="section-label">
          Sessions ({results.length}{total > results.length ? ` of ${total}` : ''}, {scanned} files scanned)
        </div>
        {#each results as s (s.sessionId)}
          <div class="row">
            <div class="row-top">
              <span class="project" title={s.cwd}>{s.project}</span>
              <span class="meta">{s.count} match{s.count !== 1 ? 'es' : ''} · {relTime(s.lastActive)}</span>
            </div>
            <div class="cwd mono" title={s.cwd}>{s.cwd}</div>

            {#each s.snippets as snip (snip.ts + snip.role)}
              <div class="snip">
                <span class="role" class:role-asst={snip.role === 'assistant'} class:role-user={snip.role === 'user'}>{snip.role}</span>
                <span class="snip-text">
                  {#each highlight(snip.text, q.trim()) as seg}
                    {#if seg.hi}<mark class="hl">{seg.text}</mark>{:else}{seg.text}{/if}
                  {/each}
                </span>
              </div>
            {/each}

            <div class="row-bottom">
              <span class="sid mono">{s.sessionId.slice(0, 8)}</span>
              {#if onView}
                <button class="select view-btn" onclick={() => onView?.(s.sessionId)}>View transcript</button>
              {/if}
            </div>
          </div>
        {/each}
      {:else if !searched}
        <div class="empty">Type a query above to search all session transcripts.</div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.25); }
  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 91; width: 440px; max-width: 96vw;
    background: var(--color-background-primary); border-left: 0.5px solid var(--color-border-secondary);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column;
  }
  .hd {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); flex-shrink: 0;
  }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }

  .search-row {
    display: flex; gap: 6px; padding: 8px 12px;
    border-bottom: 0.5px solid var(--color-border-tertiary); flex-shrink: 0;
  }
  .q-input {
    flex: 1 1 auto; min-width: 0; font-size: 12px; padding: 5px 8px;
    border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary);
    background: var(--color-background-secondary); color: var(--color-text-primary); outline: none;
  }
  .q-input:focus { border-color: var(--accent, #6366F1); }

  .err { font-size: 11px; color: #EF4444; padding: 6px 14px; flex-shrink: 0; }

  .body { flex: 1 1 auto; overflow-y: auto; }

  .empty { font-size: 11px; color: var(--color-text-tertiary); padding: 18px 16px; }

  .section-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--color-text-tertiary); padding: 8px 14px 4px;
  }

  .proj-list { padding: 0 14px 8px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .proj-path {
    font-size: 10px; color: var(--color-text-secondary); padding: 2px 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    cursor: default;
  }

  .row {
    padding: 9px 14px; border-bottom: 0.5px solid var(--color-border-tertiary);
    display: flex; flex-direction: column; gap: 4px;
  }
  .row:last-child { border-bottom: none; }
  .row-top { display: flex; align-items: baseline; gap: 8px; }
  .project {
    font-size: 12px; font-weight: 600; color: var(--color-text-primary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; max-width: 220px;
  }
  .meta { font-size: 10px; color: var(--color-text-tertiary); white-space: nowrap; flex-shrink: 0; }
  .cwd {
    font-size: 9px; color: var(--color-text-tertiary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .snip {
    display: flex; gap: 6px; align-items: flex-start;
    font-size: 10px; line-height: 1.45; color: var(--color-text-secondary);
    background: var(--color-background-secondary);
    border-radius: var(--border-radius-md); padding: 4px 7px;
  }
  .role {
    font-size: 8px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--color-text-tertiary); white-space: nowrap; flex-shrink: 0; padding-top: 1px;
    font-family: var(--font-mono);
  }
  .role-asst { color: var(--accent, #6366F1); }
  .role-user { color: var(--color-text-secondary); }
  .snip-text { flex: 1 1 auto; word-break: break-word; }

  .hl {
    background: var(--accent, #6366F1); color: #fff; border-radius: 2px;
    padding: 0 2px; font-style: normal;
  }

  .row-bottom {
    display: flex; align-items: center; justify-content: space-between; margin-top: 2px;
  }
  .sid { font-size: 9px; color: var(--color-text-tertiary); }
  .mono { font-family: var(--font-mono); }
  .view-btn { font-size: 10px; padding: 2px 9px; }
</style>
