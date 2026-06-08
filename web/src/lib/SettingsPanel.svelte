<script>
  let { open = $bindable(false) } = $props();
  let _wasOpen = false;
  $effect(() => { if (open && !_wasOpen) openPanel(); _wasOpen = open; });
  let projects = $state([]);
  let cwd = $state('');
  let cfg = $state(null);   // { ok, settingsRaw, hooks, mcp, hasSettings, hasMcp }
  let loading = $state(false);
  let rawOpen = $state(false);
  let status = $state('');

  async function post(path, body) {
    try {
      return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    } catch (_) { return null; }
  }

  async function loadProjects() {
    try { const r = await fetch('/api/projects'); const d = await r.json(); projects = d.projects || []; } catch (_) {}
  }

  async function loadConfig() {
    if (!cwd) { cfg = null; return; }
    loading = true; status = '';
    const r = await post('/api/config-read', { cwd });
    cfg = r && r.ok ? r : null;
    loading = false;
  }

  function openPanel() { open = true; cfg = null; cwd = ''; rawOpen = false; status = ''; loadProjects(); loadTg(); }
  function closePanel() { open = false; }

  // ── Telegram (global bridge config) ──
  let tgCfg = $state(null); let tgToken = $state(''); let tgChat = $state(''); let tgStatus = $state(''); let tgOpen = $state(false);
  async function loadTg() { try { const r = await fetch('/api/telegram-config'); tgCfg = await r.json(); tgChat = (tgCfg && tgCfg.chatId) || ''; } catch (_) {} }
  async function saveTg(test) {
    tgStatus = 'Saving…';
    const body = { chatId: tgChat, test };
    if (tgToken.trim()) body.token = tgToken.trim();
    const r = await post('/api/telegram-config', body);
    if (r && r.ok) { tgStatus = test ? (r.test === 'sent' ? '✓ Test message sent — check Telegram!' : 'Saved, but test failed — check token & chat id.') : '✓ Saved.'; tgToken = ''; loadTg(); }
    else tgStatus = 'Error: ' + ((r && r.error) || 'failed');
  }

  // ── Add MCP server to the selected project ──
  let mcpNew = $state({ name: '', command: '', args: '' });
  async function addMcp() {
    if (!cwd || !mcpNew.name.trim() || !mcpNew.command.trim()) return;
    status = '';
    const r = await post('/api/config', { cwd, action: 'addMcp', server: { name: mcpNew.name.trim(), command: mcpNew.command.trim(), args: mcpNew.args.trim() } });
    if (r && r.ok) { status = `Added MCP server "${mcpNew.name.trim()}".`; mcpNew = { name: '', command: '', args: '' }; await loadConfig(); }
    else status = 'Error: ' + ((r && r.error) || 'failed');
  }

  async function onProjectChange(e) {
    cwd = e.target.value;
    await loadConfig();
  }

  async function delHook(event) {
    if (!confirm(`Delete hook event "${event}"? This cannot be undone.`)) return;
    status = '';
    const r = await post('/api/config', { cwd, action: 'delHook', name: event });
    if (r && r.ok) { status = `Deleted hook "${event}".`; await loadConfig(); }
    else { status = 'Error: ' + ((r && r.error) || 'failed'); }
  }

  async function delMcp(name) {
    if (!confirm(`Remove MCP server "${name}"? This cannot be undone.`)) return;
    status = '';
    const r = await post('/api/config', { cwd, action: 'delMcp', name });
    if (r && r.ok) { status = `Removed MCP server "${name}".`; await loadConfig(); }
    else { status = 'Error: ' + ((r && r.error) || 'failed'); }
  }
</script>

<!-- trigger provided by App's Manage menu (bind:open) -->

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Project config">
    <div class="hd"><strong>Project Config</strong><button class="x" onclick={closePanel} aria-label="Close">✕</button></div>

    <div class="tg">
      <button class="collapser" onclick={() => (tgOpen = !tgOpen)}>
        <span class="caret">{tgOpen ? '▾' : '▸'}</span> Telegram alerts
        {#if tgCfg}<span class="tg-state">{tgCfg.configured ? '· connected' : '· not set up'}</span>{/if}
      </button>
      {#if tgOpen}
        <div class="tg-form">
          <input class="in" placeholder={tgCfg && tgCfg.hasToken ? 'bot token (blank = keep current)' : 'bot token (from @BotFather)'} bind:value={tgToken} />
          <input class="in" placeholder="chat id (your numeric id)" bind:value={tgChat} />
          <div class="tg-btns">
            <button class="select" onclick={() => saveTg(false)}>Save</button>
            <button class="select" onclick={() => saveTg(true)}>Save &amp; Test</button>
          </div>
          {#if tgStatus}<div class="tg-status">{tgStatus}</div>{/if}
          <div class="tg-hint">Make a bot with @BotFather; get your chat id from @userinfobot. Applies live — no restart.</div>
        </div>
      {/if}
    </div>

    <div class="picker">
      <div class="lbl">Project</div>
      <select class="select wide" value={cwd} onchange={onProjectChange}>
        <option value="">choose a project…</option>
        {#each projects as p (p.path)}<option value={p.path}>{p.name}</option>{/each}
      </select>
    </div>

    <div class="body">
      {#if !cwd}
        <div class="empty">Select a project above to view its settings.</div>
      {:else if loading}
        <div class="empty">Loading…</div>
      {:else if !cfg}
        <div class="empty">Could not read config for this project.</div>
      {:else}

        <!-- ── Hooks ── -->
        <div class="section">
          <div class="sec-hd">Hooks</div>
          {#if cfg.hooks.length === 0}
            <div class="empty-sm">No hooks defined in .claude/settings.json{cfg.hasSettings ? '' : ' (file not found)'}.</div>
          {:else}
            {#each cfg.hooks as h (h.event)}
              <div class="row-item">
                <div class="row-main">
                  <span class="tag">{h.event}</span>
                  <span class="count">{h.count} group{h.count !== 1 ? 's' : ''}</span>
                  <button class="del" onclick={() => delHook(h.event)} aria-label="Delete hook {h.event}">✕</button>
                </div>
                {#if h.commands.length}
                  <div class="cmds">
                    {#each h.commands as cmd (cmd)}
                      <div class="cmd mono">{cmd}</div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <!-- ── MCP Servers ── -->
        <div class="section">
          <div class="sec-hd">MCP Servers</div>
          {#if cfg.mcp.length === 0}
            <div class="empty-sm">No MCP servers defined in .mcp.json{cfg.hasMcp ? '' : ' (file not found)'}.</div>
          {:else}
            {#each cfg.mcp as srv (srv.name)}
              <div class="row-item">
                <div class="row-main">
                  <span class="tag">{srv.name}</span>
                  <button class="del" onclick={() => delMcp(srv.name)} aria-label="Remove MCP server {srv.name}">✕</button>
                </div>
                <div class="srv-detail">
                  <span class="mono cmd-sm">{srv.command}{srv.args.length ? ' ' + srv.args.join(' ') : ''}</span>
                  {#if srv.envKeys.length}
                    <div class="chips">
                      {#each srv.envKeys as k (k)}<span class="chip">{k}</span>{/each}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
          <div class="mcp-add">
            <input class="in" placeholder="name (e.g. playwright)" bind:value={mcpNew.name} />
            <input class="in" placeholder="command (e.g. npx)" bind:value={mcpNew.command} />
            <input class="in" placeholder="args (e.g. @playwright/mcp@latest)" bind:value={mcpNew.args} />
            <button class="select" onclick={addMcp} disabled={!mcpNew.name.trim() || !mcpNew.command.trim()}>+ Add MCP server</button>
          </div>
        </div>

        <!-- ── Raw settings.json ── -->
        {#if cfg.hasSettings}
          <div class="section">
            <button class="collapser" onclick={() => (rawOpen = !rawOpen)}>
              <span class="caret">{rawOpen ? '▾' : '▸'}</span> Raw settings.json
            </button>
            {#if rawOpen}
              <pre class="raw mono">{cfg.settingsRaw}</pre>
            {/if}
          </div>
        {/if}

      {/if}
    </div>

    {#if status}
      <div class="statusbar">{status}</div>
    {/if}
  </aside>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.25); }
  .drawer {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 91; width: 400px; max-width: 94vw;
    background: var(--color-background-primary); border-right: 0.5px solid var(--color-border-secondary);
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column;
  }
  .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .x { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--color-text-tertiary); }
  .picker { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .wide { width: 100%; }
  .body { flex: 1 1 auto; overflow: auto; padding: 4px 0; }
  .empty { padding: 20px 16px; font-size: 12px; color: var(--color-text-tertiary); }
  .empty-sm { padding: 6px 0; font-size: 11px; color: var(--color-text-tertiary); }
  .section { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .sec-hd { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); margin-bottom: 6px; }
  .row-item { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .row-item:last-child { margin-bottom: 0; }
  .row-main { display: flex; align-items: center; gap: 7px; }
  .tag { font-size: 11px; font-weight: 500; color: var(--color-text-primary); flex: 1 1 auto; }
  .count { font-size: 10px; color: var(--color-text-tertiary); }
  .del { font-size: 10px; padding: 1px 6px; border-radius: 6px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); flex-shrink: 0; }
  .del:hover { color: #EF4444; border-color: #EF4444; }
  .cmds { display: flex; flex-direction: column; gap: 2px; padding-left: 4px; }
  .cmd { font-size: 10px; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .srv-detail { display: flex; flex-direction: column; gap: 3px; padding-left: 4px; }
  .cmd-sm { font-size: 10px; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chips { display: flex; flex-wrap: wrap; gap: 3px; }
  .chip { font-size: 9px; padding: 1px 6px; border-radius: 99px; border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-tertiary); }
  .mono { font-family: var(--font-mono); }
  .collapser { display: flex; align-items: center; gap: 5px; background: none; border: none; cursor: pointer; font-size: 11px; color: var(--color-text-secondary); padding: 0; }
  .caret { color: var(--color-text-tertiary); font-size: 10px; width: 10px; }
  .raw { margin-top: 8px; font-size: 10px; color: var(--color-text-secondary); background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 8px 10px; overflow: auto; max-height: 300px; white-space: pre; }
  .statusbar { border-top: 0.5px solid var(--color-border-tertiary); padding: 8px 14px; font-size: 11px; color: var(--color-text-secondary); background: var(--color-background-secondary); }
  .tg { padding: 8px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .tg-state { font-size: 10px; color: var(--color-text-tertiary); }
  .tg-form, .mcp-add { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }
  .mcp-add { margin-top: 9px; padding-top: 8px; border-top: 0.5px dashed var(--color-border-tertiary); }
  .in { font-size: 11px; padding: 5px 7px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary);
    background: var(--color-background-secondary); color: var(--color-text-primary); box-sizing: border-box; width: 100%; }
  .tg-btns { display: flex; gap: 6px; }
  .tg-status { font-size: 11px; color: var(--color-text-secondary); }
  .tg-hint { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.4; }
</style>
