<script>
  // 🎮 GPU — what's on the card, and which local models are sitting in it.
  //
  // A local model loaded by some background job holds gigabytes of VRAM until
  // its keep-alive runs out, and whatever else wants the card (a game, a render,
  // the next model) just gets slower with nothing saying why. This panel says
  // why, and has the two buttons that fix it: Unload a model, or Free the GPU.
  let { open = $bindable(false) } = $props();

  let data = $state(null);
  let err = $state('');
  let busy = $state({});
  let flash = $state('');
  let hover = $state(-1);
  let timer = null;

  async function load() {
    try {
      const r = await fetch('/api/gpu?panel=1');
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      data = j; err = '';
      // the top-bar chip polls slowly; hand it every fresh reading so it never disagrees with this panel
      try { window.dispatchEvent(new CustomEvent('gander-gpu', { detail: j })); } catch (_) {}
    } catch (e) { err = String(e.message || e); }
  }
  $effect(() => {
    if (open) { load(); timer = setInterval(load, 3000); }
    return () => { clearInterval(timer); timer = null; };
  });

  async function post(path, body, key) {
    busy[key] = true; flash = '';
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.error && !j.ok) flash = '⚠ ' + j.error;
      return j;
    } catch (e) { flash = '⚠ ' + (e.message || e); return null; }
    finally { busy[key] = false; setTimeout(load, 600); }
  }
  async function unload(name) {
    const j = await post('/api/gpu/unload', { model: name }, 'u:' + name);
    if (j && j.ok) flash = '✓ Unloaded ' + name + ' — it reloads by itself the next time something asks for it';
  }
  async function freeGpu() {
    const j = await post('/api/gpu/free', { mode: 'lower' }, 'free');
    if (!j) return;
    const u = (j.unloaded || []).filter((x) => x.ok).length, c = (j.changed || []).length;
    flash = '✓ ' + [u ? u + ' model' + (u === 1 ? '' : 's') + ' unloaded' : 'no models were loaded',
      c ? c + ' Claude-started job' + (c === 1 ? '' : 's') + ' set to lowest priority' : 'no heavy Claude jobs running'].join(' · ');
  }
  async function restore() {
    const j = await post('/api/gpu/free', { mode: 'restore' }, 'restore');
    if (j && j.ok) flash = '✓ ' + (j.changed || []).length + ' job(s) back to normal priority';
  }

  const gpu = $derived(data && data.nvidia && data.nvidia.gpus && data.nvidia.gpus[0]);
  const models = $derived(data ? [
    ...(data.ollama.loaded || []).map((m) => ({ ...m, runtime: 'Ollama', canUnload: true })),
    ...(data.lmstudio.loaded || []).map((m) => ({ ...m, runtime: 'LM Studio', canUnload: false })),
  ] : []);
  const modelVramMB = $derived(models.reduce((s, m) => s + (m.vramMB || 0), 0));
  const apps = $derived.by(() => {
    const by = new Map();
    for (const a of (data && data.nvidia.apps) || []) {
      const k = a.name.replace(/\.exe$/i, '');
      by.set(k, (by.get(k) || 0) + 1);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const gb = (mb) => (mb == null ? '—' : (mb / 1024).toFixed(1));
  const until = (ms) => {
    if (!ms) return '';
    const m = Math.round((ms - Date.now()) / 60000);
    const at = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return m <= 0 ? 'unloading now' : `unloads at ${at} (in ${m}m) unless used again`;
  };

  // ── history charts: one measure per chart, never a second y-axis ─────────
  const W = 480, H = 92, PL = 34, PR = 8, PT = 8, PB = 16;
  const hist = $derived((data && data.history) || []);
  function series(kind) {
    const total = gpu ? gpu.vramTotalMB / 1024 : 12;
    const max = kind === 'util' ? 100 : Math.ceil(total);
    const vals = hist.map((h) => (kind === 'util' ? h.util : (h.vramUsedMB || 0) / 1024));
    const n = vals.length;
    const x = (i) => PL + (n <= 1 ? 0 : (i / (n - 1)) * (W - PL - PR));
    const y = (v) => PT + (1 - Math.min(v, max) / max) * (H - PT - PB);
    const path = vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
    const area = n > 1 ? path + `L${x(n - 1).toFixed(1)},${H - PB}L${x(0).toFixed(1)},${H - PB}Z` : '';
    return { vals, x, y, max, path, area, n };
  }
  function onMove(ev, n) {
    const svg = ev.currentTarget.ownerSVGElement || ev.currentTarget;
    const b = svg.getBoundingClientRect();
    const vx = ((ev.clientX - b.left) / b.width) * W;
    hover = Math.max(0, Math.min(n - 1, Math.round(((vx - PL) / (W - PL - PR)) * (n - 1))));
  }
  const ago = (at) => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago'; };
  const spanLabel = $derived(hist.length > 1 ? Math.round((hist[hist.length - 1].at - hist[0].at) / 60000) + ' min' : '');

  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape' && open) closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer viz-root" role="dialog" aria-label="GPU and local models">
    <div class="hd">
      <strong>🎮 GPU &amp; local models</strong>
      <div class="hdr"><button class="x" onclick={closePanel} aria-label="Close">✕</button></div>
    </div>

    <div class="body">
      {#if err && !data}
        <div class="muted">⚠ {err}</div>
      {:else if !data}
        <div class="muted">Reading the GPU…</div>
      {:else}
        {#if flash}<div class="flash">{flash}</div>{/if}

        {#if data.game}
          <div class="paused">
            <b>🎮 {data.game.label || data.game.name} is running — GPU readings are paused.</b>
            Reading the graphics driver briefly interrupts it, which can make a game stutter, so Gander leaves it alone until the game closes.{#if data.nvidia.readAt}&nbsp;Numbers below are from {ago(data.nvidia.readAt)}.{/if}
            Local models and <b>Free the GPU</b> still work.
          </div>
        {/if}

        <!-- ── the card, now ── -->
        <div class="section">
          {#if gpu}
            <div class="lbl">{gpu.name} · driver {gpu.driver}</div>
            <div class="tiles">
              <div class="tile"><div class="tk">GPU busy</div><div class="tv">{gpu.util ?? '—'}%</div></div>
              <div class="tile">
                <div class="tk">Video memory</div>
                <div class="tv">{gb(gpu.vramUsedMB)}<span class="tu"> / {gb(gpu.vramTotalMB)} GB</span></div>
                <div class="bar" role="img" aria-label="{Math.round((gpu.vramUsedMB / gpu.vramTotalMB) * 100)}% of video memory used">
                  <span class="fill" class:hot={gpu.vramUsedMB / gpu.vramTotalMB >= 0.9} style="width:{Math.min(100, (gpu.vramUsedMB / gpu.vramTotalMB) * 100)}%"></span>
                  {#if modelVramMB}<span class="models" style="width:{Math.min(100, (modelVramMB / gpu.vramTotalMB) * 100)}%" title="held by local models"></span>{/if}
                </div>
                {#if modelVramMB}<div class="tsub">{gb(modelVramMB)} GB of it is local models</div>{/if}
              </div>
              <div class="tile"><div class="tk">Temperature</div><div class="tv">{gpu.tempC ?? '—'}°C</div></div>
              <div class="tile"><div class="tk">Power</div><div class="tv">{gpu.powerW != null ? Math.round(gpu.powerW) : '—'}<span class="tu"> W{gpu.powerLimitW ? ' / ' + Math.round(gpu.powerLimitW) : ''}</span></div></div>
            </div>
          {:else if data.game}
            <div class="empty">No reading yet — the GPU is read again once the game closes.</div>
          {:else}
            <div class="empty">No NVIDIA GPU found (nvidia-smi isn't available). Local models below still show if Ollama or LM Studio is running.</div>
          {/if}
        </div>

        <!-- ── free the GPU ── -->
        <div class="section">
          <div class="lbl">Want the card for something else?</div>
          <div class="freebox">
            <button class="select go" onclick={freeGpu} disabled={busy.free}>{busy.free ? 'Freeing…' : '🎮 Free the GPU'}</button>
            <div class="freetxt">Unloads every local model and puts heavy jobs Claude started (renders, encodes, Python) at the lowest priority. Nothing is stopped — the work carries on, it just waits its turn.</div>
          </div>
          {#if data.lowered && data.lowered.length}
            <div class="crow">
              <span class="tdim">{data.lowered.length} job{data.lowered.length === 1 ? '' : 's'} at lowest priority: {data.lowered.map((x) => x.name.replace(/\.exe$/i, '') + ' ' + x.pid).join(', ')}</span>
              <span class="spacer"></span>
              <button class="mini" onclick={restore} disabled={busy.restore}>Restore</button>
            </div>
          {/if}
        </div>

        <!-- ── local models ── -->
        <div class="section">
          <div class="lbl">Local models in memory</div>
          {#if !data.ollama.available && !data.lmstudio.available}
            <div class="empty">Neither Ollama nor LM Studio is running. (Different address? Set it in ⚙ Settings → Advanced.)</div>
          {:else if !models.length}
            <div class="empty">None loaded — the card is free of models.{#if data.ollama.available}&nbsp;Ollama {data.ollama.version} has {data.ollama.installed} installed, none in memory.{/if}</div>
          {/if}
          {#each models as m (m.runtime + m.name)}
            <div class="card">
              <div class="crow">
                <b class="mname">{m.name}</b>
                <span class="chip">{m.runtime}</span>
                {#if m.params || m.quant}<span class="tdim">{[m.params, m.quant].filter(Boolean).join(' · ')}</span>{/if}
                <span class="spacer"></span>
                {#if m.vramMB}<b>{gb(m.vramMB)} GB</b>{/if}
              </div>
              <div class="crow small">
                <span class="tdim">{m.expiresAt ? until(m.expiresAt) : m.runtime === 'LM Studio' ? 'stays loaded until you eject it in LM Studio' : ''}{m.context ? ' · context ' + m.context.toLocaleString() : ''}</span>
                <span class="spacer"></span>
                {#if m.canUnload}<button class="mini" onclick={() => unload(m.name)} disabled={busy['u:' + m.name]}>Unload</button>{/if}
              </div>
            </div>
          {/each}
        </div>

        <!-- ── history ── -->
        {#if hist.length > 1 && gpu}
          <div class="section">
            <div class="lbl">Last {spanLabel}</div>
            {#each [['util', 'GPU busy', '%'], ['vram', 'Video memory', ' GB']] as [kind, title, unit] (kind)}
              {@const s = series(kind)}
              <div class="chart">
                <div class="ct">{title}</div>
                <svg viewBox="0 0 {W} {H}" class="svg" role="img" aria-label="{title} over the last {spanLabel}">
                  {#each [0, s.max / 2, s.max] as t}
                    <line x1={PL} x2={W - PR} y1={s.y(t)} y2={s.y(t)} class="grid" />
                    <text x={PL - 5} y={s.y(t) + 3} class="ax" text-anchor="end">{Math.round(t)}{unit.trim()}</text>
                  {/each}
                  <path d={s.area} class="area" />
                  <path d={s.path} class="line" />
                  {#if hover >= 0 && hover < s.n}
                    <line x1={s.x(hover)} x2={s.x(hover)} y1={PT} y2={H - PB} class="cross" />
                    <circle cx={s.x(hover)} cy={s.y(s.vals[hover])} r="3.5" class="hdot" />
                  {/if}
                  <rect x={PL} y="0" width={W - PL - PR} height={H - PB} fill="transparent" role="presentation"
                    onpointermove={(e) => onMove(e, s.n)} onpointerleave={() => (hover = -1)} />
                </svg>
              </div>
            {/each}
            {#if hover >= 0 && hist[hover]}
              <div class="tip">{ago(hist[hover].at)} · GPU <b>{hist[hover].util}%</b> · video memory <b>{gb(hist[hover].vramUsedMB)} GB</b></div>
            {/if}
          </div>
        {/if}

        <!-- ── what else is on the card ── -->
        {#if apps.length}
          <div class="section">
            <div class="lbl">Programs using the GPU</div>
            <div class="apps">{#each apps as [name, n] (name)}<span class="chip">{name}{n > 1 ? ' ×' + n : ''}</span>{/each}</div>
            {#if !data.nvidia.perProcessVram}<div class="foot">Windows doesn't report video memory per program, only the total above.</div>{/if}
          </div>
        {/if}
      {/if}
    </div>
  </aside>
{/if}

<style>
  /* series colour validated with the dataviz validator on Gander's surfaces */
  .viz-root { --viz-line: #2a78d6; }
  @media (prefers-color-scheme: dark) { .viz-root { --viz-line: #3987e5; } }
  .drawer { --drawer-w: 520px; }
  .hdr { display: flex; align-items: center; gap: 8px; }
  .body { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 14px; }
  .paused { font-size: 11px; line-height: 1.5; padding: 10px 14px; color: var(--color-text-primary); background: #F59E0B1a; border-bottom: 0.5px solid #F59E0B66; }
  .flash { font-size: 11px; padding: 8px 14px; background: var(--color-background-secondary); border-bottom: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); }
  .section { padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 8px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }
  .empty { font-size: 11px; color: var(--color-text-secondary); line-height: 1.5; }
  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .tile { padding: 9px 10px; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); }
  .tk { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); }
  .tv { font-size: 24px; font-weight: 600; font-family: var(--font-mono); color: var(--color-text-primary); line-height: 1.2; }
  .tu { font-size: 12px; font-weight: 500; color: var(--color-text-tertiary); }
  .tsub { font-size: 10px; color: var(--color-text-tertiary); margin-top: 4px; }
  .bar { position: relative; height: 8px; border-radius: 4px; background: var(--color-border-tertiary); margin-top: 6px; overflow: hidden; }
  .bar .fill { position: absolute; inset: 0 auto 0 0; background: var(--viz-line); border-radius: 4px; }
  .bar .fill.hot { background: var(--hm-warn); }
  .bar .models { position: absolute; inset: 0 auto 0 0; background: repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 2px, transparent 2px 5px); border-radius: 4px; }
  .freebox { display: flex; gap: 10px; align-items: flex-start; }
  .freetxt { font-size: 11px; color: var(--color-text-secondary); line-height: 1.45; }
  .go { font-weight: 600; white-space: nowrap; }
  .card { border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
  .crow { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11px; color: var(--color-text-primary); }
  .crow.small { font-size: 10px; }
  .spacer { flex: 1; }
  .mname { font-family: var(--font-mono); font-size: 12px; }
  .chip { font-size: 10px; font-family: var(--font-mono); padding: 1px 6px; border-radius: 6px; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); }
  .tdim { color: var(--color-text-tertiary); }
  .apps { display: flex; flex-wrap: wrap; gap: 5px; }
  .foot { font-size: 10px; color: var(--color-text-tertiary); }
  .chart { display: flex; flex-direction: column; gap: 2px; }
  .ct { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); }
  .svg { width: 100%; height: auto; display: block; overflow: visible; touch-action: none; }
  .grid { stroke: var(--color-border-tertiary); stroke-width: 1; }
  .ax { font-size: 9px; fill: var(--color-text-tertiary); font-family: var(--font-mono); }
  .line { fill: none; stroke: var(--viz-line); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .area { fill: var(--viz-line); opacity: 0.12; }
  .cross { stroke: var(--color-text-tertiary); stroke-width: 1; }
  .hdot { fill: var(--viz-line); stroke: var(--color-background-primary); stroke-width: 2; }
  .tip { font-size: 11px; color: var(--color-text-secondary); }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .mini:hover { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
</style>
