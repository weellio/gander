<script>
  let { open = $bindable(false), scope = 'project', projectCwd = '' } = $props();   // 'app' = global settings · 'project' = this project's config (projectCwd preselects it)
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

  function openPanel() { open = true; cfg = null; cwd = (scope === 'project' && projectCwd) ? projectCwd : ''; rawOpen = false; status = ''; loadProjects(); loadTg(); loadBudget(); loadEditor(); loadClaude(); loadNudge(); loadAmbient(); loadOsNotify(); loadDispatch(); loadFleet(); if (cwd) loadConfig(); }

  // ── Fleet (multi-machine): peer bridges polled by this hub ──
  let flOpen = $state(false); let flPeers = $state([]); let flStatus = $state(''); let flHealth = $state([]);
  async function loadFleet() {
    try { const j = await (await fetch('/api/fleet-config')).json(); flPeers = (j.peers || []).map((p) => ({ ...p, token: '' })); flHealth = j.status || []; } catch (_) {}
  }
  function flAdd() { flPeers = [...flPeers, { name: '', url: '', token: '', hasToken: false }]; }
  function flRemove(i) { flPeers = flPeers.filter((_, x) => x !== i); }
  async function saveFleet() {
    flStatus = 'Saving…';
    const peers = flPeers.filter((p) => p.url.trim()).map((p) => ({ name: p.name.trim(), url: p.url.trim(), token: p.token.trim() || undefined }));
    const r = await post('/api/fleet-config', { peers });
    if (r && r.ok) { flStatus = '✓ Saved — polling ' + r.peers.length + ' peer(s)'; loadFleet(); } else flStatus = 'Error: ' + ((r && r.error) || 'failed');
    setTimeout(() => (flStatus = ''), 2500);
  }
  function flOnline(p) { const h = flHealth.find((x) => x.url === p.url); return h ? (h.online ? '🟢' : '🔴') : ''; }

  // ── Gander Dispatch (bridge-hosted sessions) ──
  let dpOpen = $state(false); let dpOn = $state(false); let dpStatus = $state(''); let dpSessions = $state(0);
  async function loadDispatch() { try { const j = await (await fetch('/api/dispatch-config')).json(); dpOn = !!j.enabled; dpSessions = (j.sessions || []).length; } catch (_) {} }
  async function saveDispatch() { dpStatus = 'Saving…'; const r = await post('/api/dispatch-config', { enabled: dpOn }); dpStatus = r && r.ok ? (dpOn ? '✓ Dispatch ON' : '✓ Dispatch off — classic terminal launch') : 'Error'; setTimeout(() => (dpStatus = ''), 2200); }

  // ── cost budget (global) ──
  let bud = $state(null); let budDaily = $state(''); let budSession = $state(''); let budStatus = $state(''); let budOpen = $state(false); let budEnforce = $state(false);
  async function loadBudget() { try { const r = await fetch('/api/budget'); bud = await r.json(); budDaily = bud.daily ? String(bud.daily) : ''; budSession = bud.session ? String(bud.session) : ''; budEnforce = !!bud.enforce; } catch (_) {} }
  async function saveBudget() { budStatus = 'Saving…'; const r = await post('/api/budget', { daily: Number(budDaily) || 0, session: Number(budSession) || 0, enforce: budEnforce }); if (r) { bud = r; budStatus = '✓ Saved'; } else budStatus = 'Error'; }

  // ── editor command (for "Open in VS Code") ──
  let edOpen = $state(false); let edCmd = $state(''); let edStatus = $state('');
  async function loadEditor() { try { const r = await fetch('/api/editor'); const j = await r.json(); edCmd = (j && j.cmd) || ''; } catch (_) {} }
  async function saveEditor() { edStatus = 'Saving…'; const r = await post('/api/editor', { cmd: edCmd }); edStatus = r && r.ok ? '✓ Saved' : 'Error'; }

  // ── new-session options (▶ Start / ＋ New task: claude path, permission mode, flags) ──
  let clOpen = $state(false); let clCmd = $state(''); let clPerm = $state(''); let clFlags = $state(''); let clStatus = $state('');
  async function loadClaude() { try { const r = await fetch('/api/claude-config'); const j = await r.json(); clCmd = (j && j.cmd) || ''; clPerm = (j && j.permMode) || ''; clFlags = (j && j.flags) || ''; } catch (_) {} }
  async function saveClaude() { clStatus = 'Saving…'; const r = await post('/api/claude-config', { cmd: clCmd, permMode: clPerm, flags: clFlags }); clStatus = r && r.ok ? '✓ Saved' : 'Error'; }

  // ── idle-session nudge (the bridge runs it itself — no external task needed) ──
  let nzOpen = $state(false); let nzOn = $state(false); let nzInterval = $state(0); let nzStatus = $state('');
  async function loadNudge() { try { const r = await fetch('/api/nudge-config'); const j = await r.json(); nzOn = !!j.onSend; nzInterval = Number(j.interval) || 0; } catch (_) {} }
  async function saveNudge() { nzStatus = 'Saving…'; const r = await post('/api/nudge-config', { onSend: nzOn, interval: Number(nzInterval) || 0 }); nzStatus = r && r.ok ? '✓ Saved' : 'Error'; }

  // ── Desktop alerts (bridge-native OS toast — no browser needed) ──
  let osNotify = $state(false); let osStatus = $state('');
  async function loadOsNotify() { try { osNotify = !!(await (await fetch('/api/os-notify-config')).json()).enabled; } catch (_) {} }
  async function saveOsNotify() { osStatus = 'Saving…'; const r = await post('/api/os-notify-config', { enabled: osNotify }); osStatus = r && r.ok ? '✓ saved' : 'error'; setTimeout(() => (osStatus = ''), 1500); }
  async function testOsNotify() { osStatus = 'sending…'; await post('/api/os-notify-config', { test: true }); osStatus = '⚡ sent — check your tray'; setTimeout(() => (osStatus = ''), 2800); }

  // ── Ambient alerts (webhook / command on state changes — drive a smart light, etc.) ──
  let ambOpen = $state(false); let ambStatus = $state('');
  // [event, label, default colour, default effect, what it means]
  const AMB_EVENTS = [
    ['awaiting', 'Needs your input', 'amber', 'pulse', 'a session is waiting on you (plan/permission/question)'],
    ['error', 'Errored', 'red', 'blink', 'a tool failed / a session hit an error'],
    ['runaway', 'Runaway cost', 'red', 'strobe', 'a session is burning money fast (stuck/looping)'],
    ['done', 'Task done', 'limegreen', 'pulse', 'a session finished a turn'],
    ['clear', 'All clear', 'off', 'solid', 'you handled the thing — back to calm / light off'],
  ];
  const AMB_EFFECTS = ['solid', 'blink', 'pulse', 'breathe', 'strobe', 'rainbow'];
  function cssColor(c) {
    const m = { amber: '#F59E0B', off: '#2a2a2a', red: '#EF4444', green: '#10B981', limegreen: '#10B981', blue: '#3B82F6', purple: '#8B5CF6', cyan: '#06B6D4', pink: '#EC4899', white: '#ffffff', orange: '#F97316', yellow: '#EAB308' };
    c = String(c || '').toLowerCase().trim();
    return m[c] || c || '#888';
  }
  let amb = $state({ enabled: false, awaiting: {}, error: {}, runaway: {}, done: {}, clear: {} });
  let lifx = $state({ enabled: false, hasToken: false, selector: 'all' }); let lifxToken = $state(''); let lifxStatus = $state('');
  async function loadAmbient() {
    try { const j = await (await fetch('/api/ambient-config')).json();
      amb = { enabled: !!j.enabled, awaiting: j.awaiting || {}, error: j.error || {}, runaway: j.runaway || {}, done: j.done || {}, clear: j.clear || {} };
      lifx = j.lifx || { enabled: false, hasToken: false, selector: 'all' }; lifxToken = '';
    } catch (_) {}
  }
  async function saveAmbient() {
    ambStatus = 'Saving…';
    const body = { enabled: amb.enabled, lifx: { enabled: lifx.enabled, selector: lifx.selector, token: lifxToken || undefined } };
    for (const [k] of AMB_EVENTS) body[k] = amb[k];
    const r = await post('/api/ambient-config', body);
    if (r && r.ok) { ambStatus = '✓ Saved'; if (r.lifx) lifx = r.lifx; lifxToken = ''; } else ambStatus = 'Error';
    setTimeout(() => (ambStatus = ''), 1800);
  }
  async function testAmbient(ev) { await post('/api/ambient-config', { test: ev, rule: amb[ev] }); ambStatus = '⚡ fired ' + ev; setTimeout(() => (ambStatus = ''), 1500); }
  async function testLifx() {
    lifxStatus = 'Testing…';
    const r = await post('/api/ambient-config', { test: 'lifx', lifx: { token: lifxToken || undefined, selector: lifx.selector } });
    lifxStatus = r && r.ok ? `✓ ${r.count} bulb${r.count === 1 ? '' : 's'}${r.lights && r.lights.length ? ': ' + r.lights.join(', ') : ''} — pulsed green` : '✗ ' + ((r && r.error) || 'failed');
  }

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
  <aside class="drawer" role="dialog" aria-label={scope === 'app' ? 'Settings' : 'Project config'}>
    <div class="hd"><strong>{scope === 'app' ? 'Settings' : 'Project Config'}</strong><button class="x" onclick={closePanel} aria-label="Close">✕</button></div>

    {#if scope === 'app'}
    <div class="appscroll">
    <div class="tg">
      <button class="collapser" onclick={() => (dpOpen = !dpOpen)}>
        <span class="caret">{dpOpen ? '▾' : '▸'}</span> ⚡ Gander Dispatch
        <span class="tg-state">· {dpOn ? `ON${dpSessions ? ` · ${dpSessions} hosted` : ''}` : 'off (terminal launch)'}</span>
      </button>
      {#if dpOpen}
        <div class="tg-form">
          <label class="cbrow"><input type="checkbox" bind:checked={dpOn} onchange={saveDispatch} /> <b>Host sessions in the bridge</b> <span class="dim">(no terminal window)</span></label>
          {#if dpStatus}<div class="tg-status">{dpStatus}</div>{/if}
          <div class="tg-hint">When ON, <b>▶ Start</b> / <b>＋ New task</b> with a goal (and <b>⤳ Resume</b> replies) run the session <b>inside the bridge</b> over stream-json instead of opening a terminal: replies deliver <b>instantly</b> (no window-typing), <b>permission prompts become Allow / Deny buttons</b> right on the dashboard and in the 🔔 rail, and it works with the dashboard on your phone. Runs on your own <code>claude</code> login — plan quota, no API key.</div>
          <div class="tg-hint">When OFF (or per-launch via “terminal instead” in ＋ New task), everything uses the classic method: a real terminal window + quick-keys/nudge window automation — nothing is removed. Goal-less ▶ Start always opens a terminal either way (an interactive session needs a keyboard). Hosted sessions still write normal transcripts, so History/Resume/cost all keep working.</div>
        </div>
      {/if}
    </div>

    <div class="tg">
      <button class="collapser" onclick={() => (flOpen = !flOpen)}>
        <span class="caret">{flOpen ? '▾' : '▸'}</span> 🖥 Fleet — other machines
        {#if flPeers.length}<span class="tg-state">· {flPeers.length} peer{flPeers.length === 1 ? '' : 's'}</span>{/if}
      </button>
      {#if flOpen}
        <div class="tg-form">
          <div class="tg-hint">Watch Claude Code agents running on <b>other machines</b> on this floor. On each peer machine: run Gander, set an <code>accessToken</code> + <code>allowRemote</code> in its <code>bridge/aoc-config.json</code> (see <b>docs/REMOTE.md</b> — Tailscale recommended), then add it here. Remote tiles get a 🖥 machine badge; replies/stops are forwarded to the owning bridge.</div>
          {#each flPeers as p, i (i)}
            <div class="amb-fields">
              <span title="online?">{flOnline(p)}</span>
              <input class="in clr" placeholder="name (laptop)" bind:value={p.name} />
              <input class="in grow" placeholder="http://100.x.y.z:3131" bind:value={p.url} />
              <input class="in clr" type="password" placeholder={p.hasToken ? 'token saved' : 'token'} bind:value={p.token} autocomplete="off" />
              <button class="mini" onclick={() => flRemove(i)}>✕</button>
            </div>
          {/each}
          <div class="tg-btns"><button class="select" onclick={flAdd}>＋ Add peer</button><button class="select" onclick={saveFleet}>Save</button></div>
          {#if flStatus}<div class="tg-status">{flStatus}</div>{/if}
        </div>
      {/if}
    </div>

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
          <label class="cbrow"><input type="checkbox" bind:checked={budEnforce} /> Enforce — <b>stop</b> a session that crosses the cap <span class="dim">(not just alert)</span></label>
          <div class="tg-btns"><button class="select" onclick={saveBudget}>Save</button></div>
          {#if budStatus}<div class="tg-status">{budStatus}</div>{/if}
          <div class="tg-hint">Alerts go to Telegram + a dashboard banner when crossed. With <b>Enforce</b> on, a session over its cap is <b>Stopped</b> at its next tool, and crossing the daily cap stops every active session. Spend is estimated from transcripts.</div>
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
        <span class="caret">{clOpen ? '▾' : '▸'}</span> New session options
        {#if clPerm === 'bypass'}<span class="tg-state">· skip prompts</span>{:else if clCmd || clPerm || clFlags}<span class="tg-state">· custom</span>{/if}
      </button>
      {#if clOpen}
        <div class="tg-form">
          <select class="in" bind:value={clPerm}>
            <option value="">Permission prompts: Ask (Claude's default)</option>
            <option value="acceptEdits">Permissions: auto-accept edits</option>
            <option value="plan">Permissions: plan only (read-only)</option>
            <option value="bypass">Permissions: skip ALL prompts</option>
          </select>
          <input class="in" placeholder="extra flags, e.g. --model sonnet" bind:value={clFlags} />
          <input class="in" placeholder="claude path (blank = 'claude' on PATH)" bind:value={clCmd} />
          <div class="tg-btns"><button class="select" onclick={saveClaude}>Save</button></div>
          {#if clStatus}<div class="tg-status">{clStatus}</div>{/if}
          <div class="tg-hint">Applies to ▶ Start and ＋ New task. <b>Skip ALL prompts</b> launches with <code>--dangerously-skip-permissions</code> — Claude won't ask before edits/commands, so only use it on projects you trust. The one-time <b>“trust this folder”</b> prompt has no bypass flag, but Claude remembers it per folder after you accept once. Set the path if Start says “'claude' is not recognized” (<code>where claude</code> / <code>which claude</code>).</div>
        </div>
      {/if}
    </div>

    <div class="tg">
      <button class="collapser" onclick={() => (nzOpen = !nzOpen)}>
        <span class="caret">{nzOpen ? '▾' : '▸'}</span> Wake idle sessions
        {#if nzOn || nzInterval > 0}<span class="tg-state">· {nzInterval > 0 ? `every ${nzInterval}m` : 'on send'}</span>{/if}
      </button>
      {#if nzOpen}
        <div class="tg-form">
          <label class="cbrow"><input type="checkbox" bind:checked={nzOn} /> Wake on send <span class="dim">— the moment I reply</span></label>
          <label class="cbrow">Also nudge every <input class="in num" type="number" min="0" max="1440" bind:value={nzInterval} /> minutes <span class="dim">(0 = off)</span></label>
          <div class="tg-btns"><button class="select" onclick={saveNudge}>Save</button></div>
          {#if nzStatus}<div class="tg-status">{nzStatus}</div>{/if}
          <div class="tg-hint">The bridge runs the nudge itself — <b>no Windows scheduled task or cron needed</b>. It finds each idle session's window (VS Code or terminal) by PID and types a wake so queued replies deliver. Keep the Claude terminal focused in each window. If you set up the old "Gander Nudge" task, you can delete it now.</div>
        </div>
      {/if}
    </div>

    <div class="tg">
      <label class="cbrow"><input type="checkbox" bind:checked={osNotify} onchange={saveOsNotify} /> <b>Desktop alerts</b> — toast when an agent needs you <span class="dim">(no browser tab needed)</span></label>
      <div class="amb-fields"><button class="mini" onclick={testOsNotify}>Test toast</button>{#if osStatus}<span class="tg-status">{osStatus}</span>{/if}</div>
      <div class="tg-hint">The bridge pops a native OS notification on needs-you / error / runaway, even with the dashboard closed — handy if you live in the terminal (e.g. <code>claude agents</code>). Works alongside the light/Telegram alerts below.</div>
    </div>

    <div class="tg">
      <button class="collapser" onclick={() => (ambOpen = !ambOpen)}>
        <span class="caret">{ambOpen ? '▾' : '▸'}</span> Ambient alerts — smart light / webhook
        {#if amb.enabled}<span class="tg-state">· on</span>{/if}
      </button>
      {#if ambOpen}
        <div class="tg-form">
          <label class="cbrow"><input type="checkbox" bind:checked={amb.enabled} /> Enabled</label>
          <div class="tg-hint">On each scenario Gander POSTs JSON <code>&#123;event, color, effect, project, reason&#125;</code> to your <b>webhook</b> and/or runs your <b>command</b> (same values as <code>$AOC_EVENT</code> / <code>$AOC_COLOR</code> / <code>$AOC_EFFECT</code> / …). Point it at Home Assistant, IFTTT, a LIFX/Govee call, or a script to flash a light across the room. Pick <b>any colour</b> (name or <code>#hex</code>) and a <b>pattern</b> — the swatch previews exactly what each scenario will look like. Leave a row's webhook + command blank to ignore that scenario.</div>
          <div class="amb-list">
            {#each AMB_EVENTS as [key, label, dcolor, deffect, meaning] (key)}
              <div class="amb-row">
                <div class="amb-top">
                  <span class="swatch eff-{amb[key].effect || deffect}" style="--c:{cssColor(amb[key].color || dcolor)}"></span>
                  <span class="amb-label">{label} <span class="amb-mean">— {meaning}</span></span>
                  <button class="mini" onclick={() => testAmbient(key)}>⚡ Test</button>
                </div>
                <div class="amb-fields">
                  <input class="in clr" placeholder="{dcolor}" bind:value={amb[key].color} title="colour name or #hex (or 'rainbow' effect for disco)" />
                  <select class="in eff" bind:value={amb[key].effect}>
                    <option value="">{deffect} ·default</option>
                    {#each AMB_EFFECTS as e (e)}<option value={e}>{e}</option>{/each}
                  </select>
                  <input class="in grow" placeholder="webhook URL (POST)" bind:value={amb[key].webhook} />
                </div>
                <input class="in wide" placeholder="…or a shell command (e.g. curl -s -X PUT …)" bind:value={amb[key].command} />
              </div>
            {/each}
          </div>

          <div class="lifx-box">
            <label class="cbrow"><input type="checkbox" bind:checked={lifx.enabled} /> <span class="swatch eff-pulse" style="--c:#10B981"></span> <b>LIFX bulb</b> — built-in, no hub {#if lifx.hasToken}<span class="dim">· token saved</span>{/if}</label>
            <div class="amb-fields">
              <input class="in grow" type="password" placeholder={lifx.hasToken ? 'token saved — leave blank to keep' : 'LIFX personal access token'} bind:value={lifxToken} autocomplete="off" />
              <input class="in clr" placeholder="all" bind:value={lifx.selector} title="selector: all · label:Office · group:Studio · id:abc" />
              <button class="mini" onclick={testLifx}>Test bulb</button>
            </div>
            {#if lifxStatus}<div class="tg-status">{lifxStatus}</div>{/if}
            <div class="tg-hint">Token: <code>cloud.lifx.com</code> → Settings → <b>Generate New Token</b>. When enabled, each scenario's colour + pattern above drives the bulb directly (blink/strobe → pulse, pulse/breathe/rainbow → breathe, "off" → power off). No bridge/hub needed; Wi-Fi only.</div>
          </div>

          <div class="tg-btns"><button class="select" onclick={saveAmbient}>Save</button></div>
          {#if ambStatus}<div class="tg-status">{ambStatus}</div>{/if}
          <div class="tg-hint">No light yet? The webhook + command fire regardless, so you can wire those now and add a bulb later.</div>
        </div>
      {/if}
    </div>
    </div>
    {/if}

    {#if scope === 'project'}
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
    {/if}

    {#if status}
      <div class="statusbar">{status}</div>
    {/if}
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 400px; }   /* shell (.ov/.drawer/.hd/.x) is shared in app.css — right-anchored like the others */
  .picker { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 5px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .wide { width: 100%; }
  .body { flex: 1 1 auto; overflow: auto; padding: 4px 0; }
  /* app-settings sections scroll within the drawer (min-height:0 lets a flex child overflow) */
  .appscroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 12px; }
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
  .collapser { display: flex; align-items: center; gap: 7px; width: 100%; background: none; border: none; cursor: pointer;
    font-size: 12.5px; font-weight: 600; color: var(--color-text-primary); padding: 4px 2px; text-align: left; border-radius: 6px; }
  .collapser:hover { background: var(--color-background-secondary); }
  .caret { color: var(--accent, #6366F1); font-size: 11px; width: 12px; flex-shrink: 0; }
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
  .in.num { width: 56px; flex: 0 0 auto; text-align: center; }

  /* Ambient alerts — per-scenario rows + live preview swatches (the visual legend) */
  .amb-list { display: flex; flex-direction: column; gap: 9px; margin: 8px 0 4px; }
  .amb-row { display: flex; flex-direction: column; gap: 5px; padding: 8px 9px; border: 0.5px solid var(--color-border-tertiary); border-radius: 8px; background: var(--color-background-secondary); }
  .amb-top { display: flex; align-items: center; gap: 9px; }
  .amb-label { font-size: 12px; font-weight: 600; flex: 1 1 auto; min-width: 0; }
  .amb-mean { font-size: 10px; font-weight: 400; color: var(--color-text-tertiary); }
  .amb-fields { display: flex; gap: 6px; }
  .in.clr { width: 84px; flex: 0 0 auto; }
  .in.eff { width: 104px; flex: 0 0 auto; }
  .in.grow { flex: 1 1 auto; min-width: 0; }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; flex: 0 0 auto;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-primary); color: var(--color-text-secondary); }
  .mini:hover { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .swatch { width: 16px; height: 16px; border-radius: 50%; flex: 0 0 auto; background: var(--c, #888); box-shadow: 0 0 7px var(--c, #888); }
  .eff-blink { animation: amb-blink 1s steps(1, end) infinite; }
  .eff-strobe { animation: amb-blink 0.24s steps(1, end) infinite; }
  .eff-pulse { animation: amb-pulse 1.7s ease-in-out infinite; }
  .eff-breathe { animation: amb-pulse 3.2s ease-in-out infinite; }
  .eff-rainbow { animation: amb-rainbow 2.2s linear infinite; background: #ff0040; box-shadow: 0 0 7px #ff0040; }
  @keyframes amb-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0.1; } }
  @keyframes amb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.22; } }
  @keyframes amb-rainbow { to { filter: hue-rotate(360deg); } }
  .lifx-box { margin: 8px 0 4px; padding: 9px 10px; border: 0.5px solid #10B98155; border-radius: 8px; background: #10B9810f; display: flex; flex-direction: column; gap: 6px; }
</style>
