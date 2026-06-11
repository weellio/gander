<script>
  let { open = $bindable(false) } = $props();
  let _w = false;
  $effect(() => { if (open && !_w) load(); _w = open; });

  let loading = $state(false);
  let data = $state(null);

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/health');
      data = await r.json();
    } catch (_) {
      data = null;
    }
    loading = false;
  }

  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }

  function fmtUptime(ms) {
    if (ms == null || isNaN(ms)) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  const EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PostToolUse',
    'PostToolUseFailure',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'SessionEnd',
    'Notification',
  ];
</script>

<svelte:window onkeydown={onKey} />

<!-- trigger provided by App's Manage menu (bind:open) -->

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Hivemind health status">
    <div class="hd">
      <strong>Hivemind Health</strong>
      <div class="hdr">
        <button class="select" onclick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="body">
      {#if loading && !data}
        <div class="muted">Checking…</div>
      {:else if !data}
        <div class="muted">Could not reach bridge — is <code>node bridge/server.js</code> running?</div>
      {:else}
        <!-- ── Bridge ── -->
        <div class="section">
          <div class="lbl">Bridge</div>
          <div class="row">
            <span class="dot" class:green={true}></span>
            <span class="field">Bridge online</span>
          </div>
          <div class="kv">
            <div class="kv-row"><span class="k">Port</span><span class="v mono">{data.bridge?.port ?? '—'}</span></div>
            <div class="kv-row"><span class="k">Uptime</span><span class="v mono">{fmtUptime(data.bridge?.uptimeMs)}</span></div>
            <div class="kv-row"><span class="k">Events received</span><span class="v mono">{data.bridge?.eventsReceived ?? '—'}</span></div>
            <div class="kv-row"><span class="k">Sessions tracked</span><span class="v mono">{data.bridge?.sessions ?? '—'}</span></div>
            <div class="kv-row"><span class="k">Projects known</span><span class="v mono">{data.bridge?.projectsKnown ?? '—'}</span></div>
            <div class="kv-row"><span class="k">Version</span><span class="v mono">{data.bridge?.version ?? '—'}</span></div>
          </div>
        </div>

        <!-- ── Hooks ── -->
        <div class="section">
          <div class="lbl">Hooks</div>
          <div class="row">
            {#if data.hooks?.installed}
              <span class="dot green"></span>
              <span class="field">Hooks installed ✓</span>
            {:else}
              <span class="dot red"></span>
              <span class="field">Hooks not installed ✗</span>
            {/if}
          </div>

          <div class="checklist">
            {#each (data.hooks?.events ?? EVENTS.map((e) => ({ event: e, wired: false }))) as ev (ev.event)}
              <div class="check-row">
                <span class="check-dot" class:wired={ev.wired} class:missing={!ev.wired}>{ev.wired ? '✓' : '✗'}</span>
                <span class="check-label" class:dim={!ev.wired}>{ev.event}</span>
              </div>
            {/each}
          </div>

          {#if data.hooks?.settingsPath}
            <div class="path mono muted">{data.hooks.settingsPath}</div>
          {/if}

          {#if !data.hooks?.installed}
            <div class="hint">
              Run <code>node install.js</code> then <code>/hooks</code> (or restart) to wire Hivemind.
            </div>
          {/if}
        </div>

        <!-- ── Environment ── -->
        <div class="section">
          <div class="lbl">Environment</div>
          <div class="kv">
            <div class="kv-row"><span class="k">Node</span><span class="v mono">{data.env?.node ?? '—'}</span></div>
            <div class="kv-row"><span class="k">Platform</span><span class="v mono">{data.env?.platform ?? '—'}</span></div>
            <div class="kv-row">
              <span class="k">Plugin</span>
              <span class="v mono" class:green-text={data.plugin} class:dim={!data.plugin}>
                {data.plugin ? 'installed ✓' : 'not detected'}
              </span>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 360px; }   /* shell (.ov/.drawer/.hd/.x) is shared in app.css */
  .hdr { display: flex; align-items: center; gap: 8px; }
  .body { flex: 1 1 auto; overflow: auto; padding: 0; display: flex; flex-direction: column; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 14px; }
  .mono { font-family: var(--font-mono); }

  .section { padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 8px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }

  .row { display: flex; align-items: center; gap: 7px; }
  .field { font-size: 12px; font-weight: 500; color: var(--color-text-primary); }

  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: #9CA3AF; }
  .dot.green { background: #10B981; }
  .dot.red { background: #EF4444; }

  .kv { display: flex; flex-direction: column; gap: 3px; }
  .kv-row { display: flex; align-items: baseline; gap: 6px; }
  .k { font-size: 10px; color: var(--color-text-tertiary); width: 120px; flex-shrink: 0; }
  .v { font-size: 11px; color: var(--color-text-primary); }
  .green-text { color: #10B981; }
  .dim { color: var(--color-text-tertiary); }

  .checklist { display: flex; flex-direction: column; gap: 3px; }
  .check-row { display: flex; align-items: center; gap: 7px; }
  .check-dot { font-size: 11px; font-family: var(--font-mono); width: 14px; flex-shrink: 0; }
  .check-dot.wired { color: #10B981; }
  .check-dot.missing { color: #9CA3AF; }
  .check-label { font-size: 11px; color: var(--color-text-primary); }
  .check-label.dim { color: var(--color-text-tertiary); }

  .path { font-size: 10px; color: var(--color-text-tertiary); word-break: break-all; }

  .hint {
    font-size: 11px; color: var(--color-text-secondary);
    padding: 8px 10px; background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md);
  }
  .hint code { font-family: var(--font-mono); font-size: 10px; }
</style>
