<script>
  // Processes inspector — shows long-running / port-holding processes Claude
  // sessions spawned (node, dev servers, python…) so you can spot one stuck open
  // and kill it. Attribution is best-effort: descendants of a captured session
  // window are tagged to that session; orphans (parent gone) are grouped apart.
  let { open = $bindable(false) } = $props();
  let _w = false;
  let timer;
  $effect(() => {
    if (open && !_w) { load(); timer = setInterval(load, 5000); }
    if (!open && _w) { clearInterval(timer); }
    _w = open;
  });

  let loading = $state(false);
  let procs = $state([]);
  let note = $state('');
  let flash = $state('');
  let killing = $state(0);

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/processes');
      const j = await r.json();
      procs = j.processes || [];
      note = j.note || '';
    } catch (_) { procs = []; }
    loading = false;
  }

  async function kill(p) {
    const where = p.ports && p.ports.length ? ` holding port ${p.ports.join(', ')}` : '';
    if (!confirm(`Kill ${p.name} (pid ${p.pid})${where}?\n\nThis force-kills the process and its child tree (taskkill /T /F).`)) return;
    killing = p.pid;
    try {
      const r = await fetch('/api/kill-process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: p.pid }) });
      const j = await r.json();
      flash = j.ok ? `✓ killed pid ${p.pid}` : `✗ ${j.error || j.output || 'failed'}`;
    } catch (_) { flash = '✗ failed — is the bridge running?'; }
    killing = 0;
    setTimeout(() => (flash = ''), 2600);
    load();
  }

  function uptime(ms) {
    if (ms == null || isNaN(ms)) return '—';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  // group by session/project; orphans last
  let groups = $derived.by(() => {
    const g = new Map();
    for (const p of procs) {
      const key = p.attribution === 'orphan' ? '__orphan' : (p.sessionId || p.project || '__orphan');
      if (!g.has(key)) g.set(key, { label: p.attribution === 'orphan' ? 'Unattributed / orphaned' : (p.project || 'session'), kind: p.attribution, items: [] });
      g.get(key).items.push(p);
    }
    // orphans last
    return [...g.values()].sort((a, b) => (a.kind === 'orphan' ? 1 : 0) - (b.kind === 'orphan' ? 1 : 0));
  });

  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Processes spawned by Claude sessions">
    <div class="hd">
      <strong>Processes</strong>
      <div class="hdr">
        <button class="select" onclick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="intro">Long-running / port-holding processes your Claude sessions spawned (dev servers, <code>node</code>, <code>python</code>…). Catch one stuck open and kill it. Auto-refreshes every 5s.</div>

    <div class="body">
      {#if note}
        <div class="muted">{note}</div>
      {:else if loading && !procs.length}
        <div class="muted">Scanning processes…</div>
      {:else if !procs.length}
        <div class="muted">No spawned dev processes detected. Nothing stuck open. 🎉</div>
      {:else}
        {#each groups as grp (grp.label + grp.kind)}
          <div class="section">
            <div class="lbl" class:orphan={grp.kind === 'orphan'}>
              {grp.label}
              {#if grp.kind === 'project'}<span class="tag">by folder</span>{/if}
              {#if grp.kind === 'orphan'}<span class="tag warn">parent gone</span>{/if}
            </div>
            {#each grp.items as p (p.pid)}
              <div class="proc">
                <div class="pmain">
                  <span class="pname">{p.name}</span>
                  <span class="ppid mono">pid {p.pid}</span>
                  {#each (p.ports || []) as port (port)}<span class="port">:{port}</span>{/each}
                  <span class="age mono">{uptime(p.uptimeMs)}</span>
                  <button class="kill" disabled={killing === p.pid} onclick={() => kill(p)} title="Force-kill this process and its children">{killing === p.pid ? '…' : 'Kill'}</button>
                </div>
                {#if p.cmd}<div class="pcmd mono" title={p.cmd}>{p.cmd}</div>{/if}
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>

    {#if flash}<div class="flash" class:err={flash[0] === '✗'}>{flash}</div>{/if}
    <div class="foot">Orphans are best-effort: a process whose Claude/terminal parent has exited can’t be tied back to a session, but it’s still listed if it looks like a dev process. Windows-only for now.</div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 420px; }   /* shell (.ov/.drawer/.hd/.x) is shared in app.css */
  .hdr { display: flex; align-items: center; gap: 8px; }
  .intro { font-size: 11px; color: var(--color-text-secondary); line-height: 1.5; padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .intro code { font-family: var(--font-mono); font-size: 10px; }
  .body { flex: 1 1 auto; overflow: auto; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 14px; }
  .mono { font-family: var(--font-mono); }

  .section { padding: 10px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 7px; }
  .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent, #6366F1); font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .lbl.orphan { color: #F59E0B; }
  .tag { font-size: 8.5px; text-transform: none; letter-spacing: 0; padding: 1px 5px; border-radius: 999px; background: var(--color-background-secondary); color: var(--color-text-tertiary); font-weight: 400; }
  .tag.warn { background: #F59E0B1a; color: #F59E0B; }

  .proc { display: flex; flex-direction: column; gap: 2px; }
  .pmain { display: flex; align-items: center; gap: 7px; }
  .pname { font-size: 12px; font-weight: 600; color: var(--color-text-primary); }
  .ppid { font-size: 10px; color: var(--color-text-tertiary); }
  .port { font-size: 10px; font-family: var(--font-mono); padding: 1px 6px; border-radius: 999px; background: #10B9811a; color: #10B981; }
  .age { font-size: 10px; color: var(--color-text-tertiary); margin-left: auto; }
  .kill { flex-shrink: 0; padding: 3px 10px; border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 600;
    background: #EF44441a; border: 0.5px solid #EF444455; color: #EF4444; }
  .kill:hover:not(:disabled) { background: #EF4444; color: #fff; }
  .kill:disabled { opacity: 0.5; cursor: default; }
  .pcmd { font-size: 10px; color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .flash { font-size: 11px; padding: 8px 14px; color: #10B981; border-top: 0.5px solid var(--color-border-tertiary); }
  .flash.err { color: #EF4444; }
  .foot { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.5; padding: 9px 14px; border-top: 0.5px solid var(--color-border-tertiary); }
</style>
