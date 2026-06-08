<script>
  let open = $state(false);
  let sessions = $state([]);
  let loading = $state(false);
  let filter = $state('');
  let copied = $state(null);   // sessionId of recently copied row

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/history');
      sessions = await r.json();
    } catch (_) {
      sessions = [];
    } finally {
      loading = false;
    }
  }

  function openPanel() { open = true; load(); }
  function closePanel() { open = false; filter = ''; copied = null; }

  function onKeydown(e) { if (e.key === 'Escape') closePanel(); }

  async function copyResume(session) {
    try {
      await navigator.clipboard.writeText(session.resumeCmd);
      copied = session.sessionId;
      setTimeout(() => { if (copied === session.sessionId) copied = null; }, 1800);
    } catch (_) {}
  }

  const filtered = $derived(
    filter.trim()
      ? sessions.filter((s) => {
          const q = filter.toLowerCase();
          return (
            s.project.toLowerCase().includes(q) ||
            (s.firstPrompt && s.firstPrompt.toLowerCase().includes(q))
          );
        })
      : sessions
  );

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
</script>

<svelte:window onkeydown={onKeydown} />

<button class="select" onclick={openPanel}>History</button>

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Session history">
    <div class="hd">
      <strong>Session History</strong>
      <div class="hd-actions">
        <button class="mini" onclick={load} title="Refresh">↻</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="search-row">
      <input
        class="filter-input"
        bind:value={filter}
        placeholder="filter by project or prompt…"
      />
    </div>

    <div class="list">
      {#if loading && sessions.length === 0}
        <div class="empty">Loading…</div>
      {:else if filtered.length === 0}
        <div class="empty">{filter ? 'No matches.' : 'No sessions found.'}</div>
      {:else}
        {#each filtered as s (s.sessionId)}
          <div class="row">
            <div class="row-top">
              <span class="project" title={s.cwd}>{s.project}</span>
              <span class="meta">{s.messageCount} msgs · {relTime(s.lastActive)}</span>
            </div>
            <div class="prompt" title={s.firstPrompt || '(no prompt)'}>
              {s.firstPrompt || '(no prompt recorded)'}
            </div>
            <div class="row-bottom">
              <span class="sid mono">{s.sessionId.slice(0, 8)}</span>
              <button
                class="copy-btn"
                class:copied-state={copied === s.sessionId}
                onclick={() => copyResume(s)}
                title={s.resumeCmd}
              >
                {copied === s.sessionId ? 'copied!' : 'Copy resume'}
              </button>
            </div>
          </div>
        {/each}
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
    padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary);
  }
  .hd-actions { display: flex; align-items: center; gap: 6px; }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .mini {
    font-size: 13px; padding: 1px 7px; border-radius: 6px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary);
    color: var(--color-text-secondary);
  }
  .search-row { padding: 8px 12px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .filter-input {
    width: 100%; box-sizing: border-box; font-size: 11px; padding: 5px 8px;
    border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary);
    background: var(--color-background-secondary); color: var(--color-text-primary);
    outline: none;
  }
  .list { flex: 1 1 auto; overflow-y: auto; padding: 4px 0; }
  .empty { font-size: 11px; color: var(--color-text-tertiary); padding: 18px 16px; }
  .row {
    padding: 8px 14px; border-bottom: 0.5px solid var(--color-border-tertiary);
    display: flex; flex-direction: column; gap: 3px;
  }
  .row:last-child { border-bottom: none; }
  .row-top { display: flex; align-items: baseline; gap: 8px; }
  .project {
    font-size: 12px; font-weight: 500; color: var(--color-text-primary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto;
    max-width: 200px;
  }
  .meta { font-size: 10px; color: var(--color-text-tertiary); white-space: nowrap; flex-shrink: 0; }
  .prompt {
    font-size: 11px; color: var(--color-text-secondary); line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .row-bottom { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
  .sid { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }
  .mono { font-family: var(--font-mono); }
  .copy-btn {
    font-size: 10px; padding: 2px 9px; border-radius: 99px; cursor: pointer;
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary);
    color: var(--color-text-primary); transition: background 0.15s, color 0.15s;
  }
  .copy-btn.copied-state {
    background: var(--accent, #6366F1); color: #fff; border-color: transparent;
  }
</style>
