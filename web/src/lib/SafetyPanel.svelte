<script>
  // 🛡 Safety — the danger guard, and "stop asking me".
  //
  // Sessions often run in bypass mode (no permission prompts), so a destructive
  // command would run unattended. The guard sees every shell command before it
  // runs and can hold the dangerous ones until you allow them. The other half
  // goes the opposite way: a prompt you have approved dozens of times can stop
  // coming back, as a Claude Code allow-rule you add with one click.
  let { open = $bindable(false) } = $props();

  let data = $state(null);
  let err = $state('');
  let busy = $state({});
  let flash = $state('');
  let extraIn = $state('');
  let showRules = $state(false);

  async function load() {
    try {
      const j = await (await fetch('/api/safety')).json();
      if (j.error) throw new Error(j.error);
      data = j; err = '';
      extraIn = (j.guard.extra || []).join(', ');
    } catch (e) { err = String(e.message || e); }
  }
  let t = null;
  $effect(() => { if (open) { load(); t = setInterval(load, 5000); } return () => clearInterval(t); });

  async function post(path, body, key) {
    busy[key] = true; flash = '';
    try {
      const j = await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (j.error) flash = '⚠ ' + j.error;
      return j;
    } catch (e) { flash = '⚠ ' + (e.message || e); return null; }
    finally { busy[key] = false; load(); }
  }
  async function setMode(mode) { const j = await post('/api/safety/config', { mode }, 'mode'); if (j && j.ok) flash = '✓ Danger guard: ' + MODES.find((m) => m.id === mode).label; }
  async function saveExtra() {
    const extra = extraIn.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    const j = await post('/api/safety/config', { extra }, 'extra');
    if (j && j.ok) flash = '✓ Saved your guarded list';
  }
  async function addRule(s, scope) {
    const j = await post('/api/safety/apply', { rule: s.rule, scope }, 'a:' + s.rule);
    if (j && j.ok) flash = '✓ Added ' + s.rule + ' to ' + (j.file || 'your Claude Code settings') + '. New sessions stop asking; open ones pick it up after /hooks or a restart.';
  }
  async function forget(s) { const j = await post('/api/safety/forget', { rule: s.rule }, 'f:' + s.rule); if (j && j.ok) flash = '✓ Won’t suggest ' + s.rule + ' again'; }

  const MODES = [
    { id: 'off', label: 'Off', help: 'Commands are not checked.' },
    { id: 'flag', label: 'Flag only', help: 'Risky commands run, and are listed below and in the activity feed.' },
    { id: 'critical', label: 'Block the dangerous ones', help: 'Commands that can destroy work (wipe a drive, force-push main, reset --hard, drop a database) are held until you click Allow once. Lesser risks run and are listed below.' },
    { id: 'all', label: 'Block everything risky', help: 'Every flagged command is held until you allow it.' },
  ];
  const ago = (ts) => { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const ACTION = { block: 'blocked', flag: 'flagged', ask: 'asked you', allowed: 'allowed once' };

  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape' && open) closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Safety">
    <div class="hd">
      <strong>🛡 Safety</strong>
      <div class="hdr"><button class="x" onclick={closePanel} aria-label="Close">✕</button></div>
    </div>
    <div class="body">
      {#if err && !data}
        <div class="muted">⚠ {err}</div>
      {:else if !data}
        <div class="muted">Loading…</div>
      {:else}
        {#if flash}<div class="flash">{flash}</div>{/if}

        <!-- ── danger guard ── -->
        <div class="section">
          <div class="lbl">Danger guard · checks every shell command before it runs</div>
          <div class="modes" role="radiogroup" aria-label="Danger guard mode">
            {#each MODES as m (m.id)}
              <button class="mode" class:on={data.guard.mode === m.id} role="radio" aria-checked={data.guard.mode === m.id} onclick={() => setMode(m.id)} disabled={busy.mode}>
                <b>{m.label}</b><span>{m.help}</span>
              </button>
            {/each}
          </div>
          <div class="note">Blocking works in every permission mode, bypass included: Claude is told the command was held and to wait or ask you. Allow once in the 🔔 rail lets that exact command through on its next try.</div>
          <label class="row">Also guard commands containing
            <input class="in grow" type="text" placeholder="e.g. taskkill /im chrome.exe, prod-db" bind:value={extraIn} />
            <button class="mini" onclick={saveExtra} disabled={busy.extra}>Save</button>
          </label>
          <button class="linky" onclick={() => (showRules = !showRules)}>{showRules ? 'Hide' : 'Show'} what it watches for ({data.guard.rules.length})</button>
          {#if showRules}
            <div class="rules">{#each data.guard.rules as r (r.id)}<div class="rule"><span class="lv {r.level}">{r.level === 'critical' ? 'dangerous' : 'risky'}</span> {r.label}</div>{/each}</div>
          {/if}
        </div>

        <!-- ── recent ── -->
        <div class="section">
          <div class="lbl">Recent ({data.guard.recent.length})</div>
          {#if !data.guard.recent.length}<div class="empty">Nothing risky has been run since the bridge started.</div>{/if}
          {#each data.guard.recent as d (d.id)}
            <div class="card">
              <div class="crow"><span class="lv {d.level}">{ACTION[d.allowed ? 'allowed' : d.action] || d.action}</span><b>{d.project}</b><span class="dim">{ago(d.at)}</span></div>
              <div class="mono">{d.command}</div>
              <div class="dim small">{d.label}</div>
            </div>
          {/each}
        </div>

        <!-- ── stop asking me ── -->
        <div class="section">
          <div class="lbl">Stop asking me · prompts you keep approving</div>
          {#if !data.suggestions.length}
            <div class="empty">Nothing yet. After you approve the same kind of command {data.minAllows} times (and never deny it), it shows up here as a one-click allow-rule. Risky commands are never suggested.</div>
          {/if}
          {#each data.suggestions as s (s.rule)}
            <div class="card">
              <div class="crow"><b class="mono">{s.rule}</b><span class="spacer"></span><span class="dim">approved {s.allows}×{s.projects && s.projects.length ? ' · ' + s.projects.slice(0, 3).join(', ') : ''}</span></div>
              {#if s.examples && s.examples.length}<div class="mono dim small">{s.examples.join('  ·  ')}</div>{/if}
              <div class="crow">
                <button class="select go" onclick={() => addRule(s, 'global')} disabled={busy['a:' + s.rule]}>Allow everywhere</button>
                <span class="spacer"></span>
                <button class="mini" onclick={() => forget(s)} disabled={busy['f:' + s.rule]}>Dismiss</button>
              </div>
            </div>
          {/each}
          {#if data.allowList && data.allowList.length}
            <div class="dim small">Already allowed in your global settings: {data.allowList.length} rule{data.allowList.length === 1 ? '' : 's'}.</div>
          {/if}
        </div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 520px; }
  .hdr { display: flex; align-items: center; gap: 8px; }
  .body { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 14px; }
  .flash { font-size: 11px; padding: 8px 14px; background: var(--color-background-secondary); border-bottom: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); line-height: 1.45; }
  .section { padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 8px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .mode { text-align: left; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: var(--border-radius-md); cursor: pointer;
    border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-secondary); color: var(--color-text-secondary); font: inherit; font-size: 10.5px; line-height: 1.4; }
  .mode b { font-size: 12px; color: var(--color-text-primary); }
  .mode.on { border-color: var(--accent, #6366F1); box-shadow: 0 0 0 1px var(--accent, #6366F1) inset; background: var(--color-background-primary); }
  .note { font-size: 10.5px; color: var(--color-text-secondary); line-height: 1.45; }
  .row { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--color-text-secondary); flex-wrap: wrap; }
  .grow { flex: 1 1 200px; }
  .rules { display: flex; flex-direction: column; gap: 3px; }
  .rule { font-size: 11px; color: var(--color-text-primary); }
  .lv { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; margin-right: 4px; }
  .lv.critical, .lv.block { color: var(--hm-err); }
  .lv.warn, .lv.flag { color: var(--hm-warn); }
  .card { border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
  .crow { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11px; color: var(--color-text-primary); }
  .spacer { flex: 1; }
  .mono { font-family: var(--font-mono); font-size: 11px; word-break: break-all; }
  .dim { color: var(--color-text-tertiary); }
  .small { font-size: 10px; }
  .empty { font-size: 11px; color: var(--color-text-secondary); line-height: 1.5; }
  .go { font-weight: 600; }
  .in { font-size: 11px; padding: 5px 7px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary); background: var(--color-background-primary); color: var(--color-text-primary); }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .linky { align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-size: 11px; color: var(--color-text-secondary); text-decoration: underline; }
</style>
