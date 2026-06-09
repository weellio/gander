<script>
  let { sessionId = $bindable(null) } = $props();

  let loading = $state(false);
  let error = $state('');
  let data = $state(null); // { sessionId, cwd, project, messages, count, truncated }
  let bodyEl = $state();
  // jump to the newest message (bottom) once a transcript loads
  $effect(() => { if (data && bodyEl) requestAnimationFrame(() => { if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight; }); });

  async function load() {
    if (!sessionId) return;
    loading = true;
    error = '';
    data = null;
    try {
      const r = await fetch('/api/transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const j = await r.json();
      if (j && j.ok) {
        data = j;
      } else {
        error = (j && j.error) || 'unknown error';
      }
    } catch (e) {
      error = 'Network error: ' + e.message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (sessionId) load();
  });

  function close() { sessionId = null; }

  function exportMd() {
    if (!data) return;
    const out = [`# Transcript — ${data.project || data.sessionId}`, '', `Session: \`${data.sessionId}\``];
    if (data.cwd) out.push(`Path: \`${data.cwd}\``);
    out.push(`${data.count} messages${data.truncated ? ' (last 500)' : ''}`, '', '---', '');
    for (const m of data.messages) {
      const who = m.role === 'assistant' ? 'Claude' : m.role === 'user' ? 'User' : 'System';
      const ts = m.ts ? ` _(${new Date(m.ts).toLocaleString()})_` : '';
      out.push(`### ${who}${ts}`);
      if (m.text) out.push('', m.text);
      if (m.tools && m.tools.length) out.push('', ...m.tools.map((t) => `- 🔧 \`${t.name}\`${t.input ? ' — ' + t.input : ''}`));
      out.push('', '---', '');
    }
    const blob = new Blob([out.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `transcript-${(data.project || 'session')}-${String(data.sessionId).slice(0, 8)}.md`;
    a.click(); URL.revokeObjectURL(url);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  function roleColor(role) {
    if (role === 'assistant') return 'chip-assistant';
    if (role === 'user') return 'chip-user';
    return 'chip-system';
  }

  function roleLabel(role) {
    if (role === 'assistant') return 'claude';
    return role;
  }

  function shortInput(s) {
    if (!s) return '';
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        if (keys.length === 0) return '';
        const first = keys[0];
        const val = String(v[first]);
        return val.length > 40 ? val.slice(0, 40) + '…' : val;
      }
    } catch (_) {}
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if sessionId !== null}
  <!-- overlay -->
  <div class="ov" onclick={close} role="presentation"></div>

  <!-- drawer -->
  <aside class="drawer" role="dialog" aria-label="Transcript viewer">
    <div class="hd">
      <div class="hd-left">
        <strong class="title">Transcript</strong>
        {#if data}
          <span class="project">{data.project || data.sessionId}</span>
          <span class="meta">{data.count} messages{data.truncated ? ' (last 500)' : ''}</span>
        {:else if loading}
          <span class="meta">Loading…</span>
        {/if}
      </div>
      <div class="hd-actions">
        {#if data}<button class="md" onclick={exportMd} title="Export to Markdown">⬇ .md</button>{/if}
        <button class="x" onclick={close} aria-label="Close">✕</button>
      </div>
    </div>

    {#if data}
      <div class="sub-hd">
        <span class="mono sid" title={data.cwd || data.sessionId}>{data.sessionId}</span>
        {#if data.cwd}<span class="cwd mono" title={data.cwd}>{data.cwd}</span>{/if}
      </div>
    {/if}

    <div class="body" bind:this={bodyEl}>
      {#if loading}
        <div class="empty">Loading transcript…</div>
      {:else if error}
        <div class="err">{error}</div>
      {:else if data}
        {#if data.truncated}
          <div class="truncated-notice">Showing last 500 messages of a longer session.</div>
        {/if}
        {#each data.messages as msg (msg.ts + msg.role + msg.text.slice(0, 20))}
          <div class="msg" class:msg-user={msg.role === 'user'} class:msg-assistant={msg.role === 'assistant'} class:msg-system={msg.role === 'system'}>
            <div class="row">
              <span class="chip {roleColor(msg.role)}">{roleLabel(msg.role)}</span>
              {#if msg.ts}
                <span class="ts">{new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              {/if}
            </div>
            {#if msg.text}
              <p class="txt" class:mono={msg.role === 'system'}>{msg.text}</p>
            {/if}
            {#if msg.tools && msg.tools.length}
              <div class="tools">
                {#each msg.tools as tool}
                  <span class="tool-chip" title={tool.input}>{tool.name}{#if shortInput(tool.input)}<span class="tool-arg">&nbsp;{shortInput(tool.input)}</span>{/if}</span>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {:else}
        <div class="empty">No transcript loaded.</div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .ov {
    position: fixed;
    inset: 0;
    z-index: 128; /* above the agent modal (100) it can be opened from */
    background: rgba(0, 0, 0, 0.25);
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 129;
    width: 520px;
    max-width: 96vw;
    background: var(--color-background-primary);
    border-left: 0.5px solid var(--color-border-secondary);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Header */
  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 0.5px solid var(--color-border-tertiary);
    flex-shrink: 0;
  }
  .hd-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
  }
  .title { font-size: 13px; color: var(--color-text-primary); }
  .project {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent, #6366F1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta { font-size: 10px; color: var(--color-text-tertiary); white-space: nowrap; }
  .x {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    color: var(--color-text-tertiary);
    flex-shrink: 0;
    padding: 2px 4px;
  }
  .x:hover { color: var(--color-text-primary); }
  .hd-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .md { font-size: 10px; padding: 2px 8px; border-radius: 99px; cursor: pointer; border: 0.5px solid var(--color-border-secondary);
    background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .md:hover { color: var(--color-text-primary); }

  /* Sub-header: session id + cwd */
  .sub-hd {
    padding: 6px 14px;
    border-bottom: 0.5px solid var(--color-border-tertiary);
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex-shrink: 0;
    background: var(--color-background-secondary);
  }
  .sid { font-size: 10px; color: var(--color-text-tertiary); }
  .cwd { font-size: 9px; color: var(--color-text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--font-mono); }

  /* Scrollable message body */
  .body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* Notices */
  .empty { font-size: 12px; color: var(--color-text-tertiary); padding: 24px 0; text-align: center; }
  .err { font-size: 12px; color: #EF4444; padding: 12px 0; }
  .truncated-notice {
    font-size: 10px;
    color: var(--color-text-tertiary);
    background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary);
    border-radius: var(--border-radius-md);
    padding: 5px 10px;
    margin-bottom: 4px;
  }

  /* Message rows */
  .msg {
    padding: 6px 10px;
    border-radius: var(--border-radius-md);
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 0.5px solid transparent;
  }
  .msg-user { background: var(--color-background-secondary); }
  .msg-assistant { background: var(--color-background-primary); border-color: var(--color-border-tertiary); }
  .msg-system { background: transparent; opacity: 0.7; }

  .row { display: flex; align-items: center; gap: 6px; }

  /* Role chips */
  .chip {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 99px;
    flex-shrink: 0;
  }
  .chip-user { background: var(--accent, #6366F1); color: #fff; }
  .chip-assistant { background: #10B981; color: #fff; }
  .chip-system { background: var(--color-background-secondary); color: var(--color-text-tertiary); border: 0.5px solid var(--color-border-secondary); }

  .ts { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }

  /* Message text */
  .txt {
    margin: 0;
    font-size: 11px;
    line-height: 1.55;
    color: var(--color-text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .txt.mono {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-text-secondary);
  }

  /* Tool call chips */
  .tools { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .tool-chip {
    font-size: 9px;
    padding: 2px 7px;
    border-radius: 99px;
    background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-secondary);
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    white-space: nowrap;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tool-arg { color: var(--color-text-tertiary); }
</style>
