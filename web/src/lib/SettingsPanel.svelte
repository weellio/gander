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

  function openPanel() { open = true; cfg = null; cwd = ''; rawOpen = false; status = ''; loadProjects(); loadTg(); loadBudget(); loadEditor(); loadClaude(); loadNudge(); }

  // ── cost budget (global) ──
  let bud = $state(null); let budDaily = $state(''); let budSession = $state(''); let budStatus = $state(''); let budOpen = $state(false);
  async function loadBudget() { try { const r = await fetch('/api/budget'); bud = await r.json(); budDaily = bud.daily ? String(bud.daily) : ''; budSession = bud.session ? String(bud.session) : ''; } catch (_) {} }
  async function saveBudget() { budStatus = 'Saving…'; const r = await post('/api/budget', { daily: Number(budDaily) || 0, session: Number(budSession) || 0 }); if (r) { bud = r; budStatus = '✓ Saved'; } else budStatus = 'Error'; }

  // ── editor command (for "Open in VS Code") ──
  let edOpen = $state(false); let edCmd = $state(''); let edStatus = $state('');
  async function loadEditor() { try { const r = await fetch('/api/editor'); const j = await r.json(); edCmd = (j && j.cmd) || ''; } catch (_) {} }
  async function saveEditor() { edStatus = 'Saving…'; const r = await post('/api/editor', { cmd: edCmd }); edStatus = r && r.ok ? '✓ Saved' : 'Error'; }

  // ── claude command / path (for the ▶ Start button) ──
  let clOpen = $state(false); let clCmd = $state(''); let clStatus = $state('');
  async function loadClaude() { try { const r = await fetch('/api/claude-config'); const j = await r.json(); clCmd = (j && j.cmd) || ''; } catch (_) {} }
  async function saveClaude() { clStatus = 'Saving…'; const r = await post('/api/claude-config', { cmd: clCmd }); clStatus = r && r.ok ? '✓ Saved' : 'Error'; }

  // ── wake-on-send (fire the nudge scheduled task when a message is sent) ──
  let nzOpen = $state(false); let nzOn = $state(false); let nzTask = $state('Hivemind Nudge'); let nzStatus = $state('');
  async function loadNudge() { try { const r = await fetch('/api/nudge-config'); const j = await r.json(); nzOn = !!j.onSend; nzTask = j.taskName || 'Hivemind Nudge'; } catch (_) {} }
  async function saveNudge() { nzStatus = 'Saving…'; const r = await post('/api/nudge-config', { onSend: nzOn, taskName: nzTask }); nzStatus = r && r.ok ? '✓ Saved' : 'Error'; }

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
  // Curated presets so users don't have to memorise package names. Placeholders
  // (in <…>) and env keys are filled in by the user before adding.
  const MCP_PRESETS = [
    { label: 'Filesystem — expose local files', name: 'filesystem', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem C:/path/to/folder', note: 'Replace the path with a folder to expose.' },
    { label: 'GitHub', name: 'github', command: 'npx', args: '-y @modelcontextprotocol/server-github', env: 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx', note: 'Create a token at github.com → Settings → Developer settings.' },
    { label: 'Supabase', name: 'supabase', command: 'npx', args: '-y @supabase/mcp-server-supabase@latest --read-only --project-ref=<project-ref>', env: 'SUPABASE_ACCESS_TOKEN=sbp_xxx', note: 'Token: Supabase → Account → Access Tokens. project-ref: Project Settings → General.' },
    { label: 'PostgreSQL', name: 'postgres', command: 'npx', args: '-y @modelcontextprotocol/server-postgres postgresql://user:pass@localhost:5432/db', note: 'Replace the connection string.' },
    { label: 'SQLite', name: 'sqlite', command: 'npx', args: '-y @modelcontextprotocol/server-sqlite --db-path C:/path/to.db', note: 'Replace the database path.' },
    { label: 'Brave Search', name: 'brave-search', command: 'npx', args: '-y @modelcontextprotocol/server-brave-search', env: 'BRAVE_API_KEY=xxx', note: 'Free key at brave.com/search/api.' },
    { label: 'Playwright — drive a browser', name: 'playwright', command: 'npx', args: '@playwright/mcp@latest' },
    { label: 'Puppeteer — drive a browser', name: 'puppeteer', command: 'npx', args: '-y @modelcontextprotocol/server-puppeteer' },
    { label: 'Memory — knowledge graph', name: 'memory', command: 'npx', args: '-y @modelcontextprotocol/server-memory' },
    { label: 'Sequential thinking', name: 'sequential-thinking', command: 'npx', args: '-y @modelcontextprotocol/server-sequential-thinking' },
    { label: 'Slack', name: 'slack', command: 'npx', args: '-y @modelcontextprotocol/server-slack', env: 'SLACK_BOT_TOKEN=xoxb-xxx, SLACK_TEAM_ID=Txxx', note: 'From your Slack app config.' },
    { label: 'Fetch — web page → markdown', name: 'fetch', command: 'uvx', args: 'mcp-server-fetch', note: 'Requires uv/uvx (Python).' },
  ];
  let mcpNew = $state({ name: '', command: '', args: '' });
  let mcpEnv = $state(''); let mcpNote = $state('');
  function applyPreset(e) {
    const i = e.target.value; e.target.value = '';
    if (i === '') return;
    const p = MCP_PRESETS[+i];
    mcpNew = { name: p.name, command: p.command, args: p.args };
    mcpEnv = p.env || ''; mcpNote = p.note || '';
  }
  async function addMcp() {
    if (!cwd || !mcpNew.name.trim() || !mcpNew.command.trim()) return;
    status = '';
    const env = {};
    for (const pair of (mcpEnv || '').split(',')) { const k = pair.indexOf('='); if (k > 0) env[pair.slice(0, k).trim()] = pair.slice(k + 1).trim(); }
    const server = { name: mcpNew.name.trim(), command: mcpNew.command.trim(), args: mcpNew.args.trim() };
    if (Object.keys(env).length) server.env = env;
    const r = await post('/api/config', { cwd, action: 'addMcp', server });
    if (r && r.ok) { status = `Added MCP server "${mcpNew.name.trim()}".`; mcpNew = { name: '', command: '', args: '' }; mcpEnv = ''; mcpNote = ''; await loadConfig(); }
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

    <div class="tg">
      <button class="collapser" onclick={() => (budOpen = !budOpen)}>
        <span class="caret">{budOpen ? '▾' : '▸'}</span> Cost budget
        {#if bud && bud.daily}<span class="tg-state">· ${bud.dailyCost?.toFixed?.(2) ?? '0'} / ${bud.daily} today</span>{/if}
      </button>
      {#if budOpen}
        <div class="tg-form">
          <input class="in" placeholder="daily cap (USD, 0 = off)" bind:value={budDaily} />
          <input class="in" placeholder="per-session cap (USD, 0 = off)" bind:value={budSession} />
          <div class="tg-btns"><button class="select" onclick={saveBudget}>Save</button></div>
          {#if budStatus}<div class="tg-status">{budStatus}</div>{/if}
          <div class="tg-hint">Alerts go to Telegram + a dashboard banner when crossed. Spend is estimated from transcripts.</div>
        </div>
      {/if}
    </div>

    <div class="tg">
      <button class="collapser" onclick={() => (edOpen = !edOpen)}>
        <span class="caret">{edOpen ? '▾' : '▸'}</span> Open-in-editor command
        {#if edCmd}<span class="tg-state">· custom</span>{/if}
      </button>
      {#if edOpen}
        <div class="tg-form">
          <input class="in" placeholder="blank = auto-detect VS Code" bind:value={edCmd} />
          <div class="tg-btns"><button class="select" onclick={saveEditor}>Save</button></div>
          {#if edStatus}<div class="tg-status">{edStatus}</div>{/if}
          <div class="tg-hint">Set this only if “Open in VS Code” fails — a full path (e.g. C:\Users\you\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd) or another editor command like codium / subl. Receives the file/folder as its argument.</div>
        </div>
      {/if}
    </div>

    <div class="tg">
      <button class="collapser" onclick={() => (clOpen = !clOpen)}>
        <span class="caret">{clOpen ? '▾' : '▸'}</span> Claude command / path
        {#if clCmd}<span class="tg-state">· custom</span>{/if}
      </button>
      {#if clOpen}
        <div class="tg-form">
          <input class="in" placeholder="blank = 'claude' on PATH" bind:value={clCmd} />
          <div class="tg-btns"><button class="select" onclick={saveClaude}>Save</button></div>
          {#if clStatus}<div class="tg-status">{clStatus}</div>{/if}
          <div class="tg-hint">Set this if ▶ Start says “'claude' is not recognized”. Use the full path to the Claude CLI — find it with <code>where claude</code> (Windows) or <code>which claude</code> (macOS/Linux), e.g. C:\Users\you\AppData\Roaming\npm\claude.cmd. Used by ▶ Start and Resume.</div>
        </div>
      {/if}
    </div>

    <div class="tg">
      <button class="collapser" onclick={() => (nzOpen = !nzOpen)}>
        <span class="caret">{nzOpen ? '▾' : '▸'}</span> Wake on send
        {#if nzOn}<span class="tg-state">· on</span>{/if}
      </button>
      {#if nzOpen}
        <div class="tg-form">
          <label class="cbrow"><input type="checkbox" bind:checked={nzOn} /> Run the nudge task when I send a message</label>
          <input class="in" placeholder="scheduled task name" bind:value={nzTask} />
          <div class="tg-btns"><button class="select" onclick={saveNudge}>Save</button></div>
          {#if nzStatus}<div class="tg-status">{nzStatus}</div>{/if}
          <div class="tg-hint">Runs schtasks /Run /TN "&lt;name&gt;" after a reply so a parked/idle session wakes immediately (instead of waiting for the timer). Needs the scheduled task set up — see scripts/nudge-idle.ps1. Windows only.</div>
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
            <select class="in" onchange={applyPreset}>
              <option value="">＋ add from a preset…</option>
              {#each MCP_PRESETS as p, i (p.name)}<option value={i}>{p.label}</option>{/each}
            </select>
            <input class="in" placeholder="name (e.g. supabase)" bind:value={mcpNew.name} />
            <input class="in" placeholder="command (e.g. npx)" bind:value={mcpNew.command} />
            <input class="in" placeholder="args (e.g. -y @supabase/mcp-server-supabase@latest)" bind:value={mcpNew.args} />
            <input class="in" placeholder="env (optional, KEY=value, KEY2=value)" bind:value={mcpEnv} />
            {#if mcpNote}<div class="tg-hint">💡 {mcpNote}</div>{/if}
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
  .cbrow { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--color-text-secondary); cursor: pointer; }
</style>
