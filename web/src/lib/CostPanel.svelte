<script>
  // Token-usage & cost analytics panel. Self-contained: renders its own
  // "Usage" trigger button and a right-anchored drawer. Drop <CostPanel />
  // into the toolbar — no other wiring needed. GETs /api/usage on open.
  let { open = $bindable(false) } = $props();
  let _wasOpen = false;
  $effect(() => { if (open && !_wasOpen) openPanel(); _wasOpen = open; });
  let loading = $state(false);
  let data = $state(null);

  let forensics = $state(null);
  async function load() {
    loading = true;
    // spend forensics (deterministic): where tokens went + whether it shipped.
    // Fired in PARALLEL with usage — both are slow transcript/git passes, so
    // don't gate one behind the other.
    forensics = null;
    fetch('/api/forensics?days=14').then((r) => r.json()).then((f) => { if (!f.error) forensics = f; }).catch(() => {});
    try {
      const r = await fetch('/api/usage');
      data = await r.json();
    } catch (_) {
      data = null;
    }
    loading = false;
  }
  function openPanel() {
    open = true;
    if (!data) load();
  }
  function closePanel() {
    open = false;
  }
  function onKey(e) {
    if (e.key === 'Escape') closePanel();
  }

  // --- formatters ---
  function money(n) {
    const v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function rate(n) { return '$' + (Number(n) || 0).toFixed(2); }   // effective $ per million tokens
  function pct(x) { return Math.round((Number(x) || 0) * 100) + '%'; }
  function compact(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'K';
    return String(Math.round(v));
  }
  function shortDate(d) {
    // 'YYYY-MM-DD' -> 'M/D'
    const p = String(d || '').split('-');
    return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : d;
  }
  function shortSession(id) {
    return String(id || '').slice(0, 8);
  }

  const maxDayCost = $derived(
    data && data.byDay && data.byDay.length
      ? Math.max(...data.byDay.map((d) => d.costUSD), 0.000001)
      : 1
  );
</script>

<svelte:window onkeydown={onKey} />

<!-- trigger provided by App's Manage menu (bind:open) -->

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Token usage and cost">
    <div class="hd">
      <strong>Usage &amp; Cost</strong>
      <div class="hdr">
        <button class="select" onclick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="body">
      {#if !data && loading}
        <div class="muted">Loading usage…</div>
      {:else if !data}
        <div class="muted">No usage data.</div>
      {:else}
        <!-- Headline -->
        <div class="headline">
          <div class="big">{money(data.totals.costUSD)}</div>
          <div class="sub">{compact(data.totals.totalTokens)} tokens · {data.fileCount} sessions</div>
          <div class="meta">
            in {compact(data.totals.inputTokens)} · out {compact(data.totals.outputTokens)} ·
            cache-w {compact(data.totals.cacheWriteTokens)} · cache-r {compact(data.totals.cacheReadTokens)}
          </div>
        </div>

        <!-- 30-day chart -->
        <div class="section">
          <div class="lbl">Daily cost · last 30 days</div>
          <div class="chart">
            {#each data.byDay as d (d.date)}
              <div
                class="bar"
                style="height: {Math.max(2, (d.costUSD / maxDayCost) * 100)}%"
                title="{shortDate(d.date)} · {money(d.costUSD)} · {compact(d.tokens)} tok"
              ></div>
            {/each}
          </div>
          <div class="axis">
            <span>{shortDate(data.byDay[0] && data.byDay[0].date)}</span>
            <span>{shortDate(data.byDay[data.byDay.length - 1] && data.byDay[data.byDay.length - 1].date)}</span>
          </div>
        </div>

        <!-- Per project -->
        <div class="section">
          <div class="lbl">By project</div>
          <table>
            <thead>
              <tr><th>Project</th><th class="num">Tokens</th><th class="num" title="Effective $ per million tokens — why two projects with different token counts can cost the same">$/M</th><th class="num">Cost</th></tr>
            </thead>
            <tbody>
              {#each data.byProject as p (p.path)}
                <tr>
                  <td class="name" title={p.path}>{p.project}{#if p.cacheHit != null}<span class="psub" title="Share of input-side tokens served from cache — high = cheap tokens">♻ {pct(p.cacheHit)} cache</span>{/if}</td>
                  <td class="num mono">{compact(p.tokens)}</td>
                  <td class="num mono" title="Effective $ per million tokens">{rate(p.effRate)}</td>
                  <td class="num mono">{money(p.costUSD)}</td>
                </tr>
              {/each}
              {#if !data.byProject.length}<tr><td colspan="4" class="muted">No projects.</td></tr>{/if}
            </tbody>
          </table>
        </div>

        <!-- Per model -->
        <div class="section">
          <div class="lbl">By model</div>
          <table>
            <tbody>
              {#each data.byModel as m (m.model)}
                <tr>
                  <td class="name mono" title={m.model}>{m.model}</td>
                  <td class="num mono">{compact(m.tokens)}</td>
                  <td class="num mono">{money(m.costUSD)}</td>
                </tr>
              {/each}
              {#if !data.byModel.length}<tr><td colspan="3" class="muted">No models.</td></tr>{/if}
            </tbody>
          </table>
        </div>

        <!-- Top sessions -->
        <div class="section">
          <div class="lbl">Top sessions</div>
          <table>
            <tbody>
              {#each data.topSessions as s (s.sessionId)}
                <tr>
                  <td class="name">
                    <span class="mono" title={s.sessionId}>{shortSession(s.sessionId)}</span>
                    <span class="dim"> · {s.project}</span>
                  </td>
                  <td class="num mono">{compact(s.tokens)}</td>
                  <td class="num mono">{money(s.costUSD)}</td>
                </tr>
              {/each}
              {#if !data.topSessions.length}<tr><td colspan="3" class="muted">No sessions.</td></tr>{/if}
            </tbody>
          </table>
        </div>

        <!-- Spend forensics -->
        {#if forensics}
          <div class="section">
            <div class="lbl">🔎 Spend forensics <span class="fdim">· last {forensics.days}d · where it went, and whether it shipped</span></div>

            {#if forensics.productivity.shippedPct != null}
              <div class="frow"><span class="fk">Shipped vs. exploratory</span><span class="fv mono">{forensics.productivity.shippedPct}% shipped</span></div>
              <div class="bar" title="{money(forensics.productivity.productiveCost)} landed a commit · {money(forensics.productivity.abandonedCost)} did not">
                <div class="bar-ship" style="width:{forensics.productivity.shippedPct}%"></div>
              </div>
              <div class="fsub">{money(forensics.productivity.productiveCost)} landed a commit within ~90 min · {money(forensics.productivity.abandonedCost)} was exploration or abandoned ({forensics.productivity.abandoned} sessions)</div>
              {#if forensics.productivity.abandonedTop?.length}
                <div class="fsub2">Priciest exploratory: {forensics.productivity.abandonedTop.slice(0, 3).map((a) => `${a.project} ${money(a.costUSD)}`).join(' · ')}</div>
              {/if}
            {/if}

            {#if forensics.waste.reReads?.length}
              <div class="fhead">Re-read churn <span class="fdim">· same file read ≥3× in one session</span></div>
              {#each forensics.waste.reReads.slice(0, 5) as r (r.session + r.file)}
                <div class="frow"><span class="fk mono" title={r.file}>{r.file.split(/[\\/]/).pop()}<span class="dim"> · {r.project}</span></span><span class="fv mono warn">×{r.reads}</span></div>
              {/each}
              {#if forensics.waste.reReadTotal > 5}<div class="fsub2">+{forensics.waste.reReadTotal - 5} more re-read hotspots</div>{/if}
            {/if}

            {#if forensics.waste.deadMcp?.length}
              <div class="fhead">Unused MCP servers <span class="fdim">· declared, never called — context you pay for every turn</span></div>
              <div class="fchips">{#each forensics.waste.deadMcp as m (m)}<span class="fchip">{m}</span>{/each}</div>
            {/if}
          </div>
        {/if}

        <div class="genat">updated {data.generatedAt}</div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 420px; }   /* shell (.ov/.drawer/.hd/.x) is shared in app.css */
  .fdim { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--color-text-tertiary); font-size: 10px; }
  .frow { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 12px; }
  .fk { flex: 1 1 auto; min-width: 0; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fv { flex-shrink: 0; color: var(--color-text-primary); font-weight: 600; }
  .fv.warn { color: #C9820A; }
  .bar { height: 8px; border-radius: 5px; background: color-mix(in srgb, #C9820A 22%, transparent); overflow: hidden; margin: 4px 0; }
  .bar-ship { height: 100%; background: #0f9e6e; border-radius: 5px; }
  .fsub { font-size: 10.5px; color: var(--color-text-tertiary); line-height: 1.5; margin-top: 2px; }
  .fsub2 { font-size: 10px; color: var(--color-text-tertiary); margin-top: 3px; }
  .fhead { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); margin-top: 12px; margin-bottom: 2px; }
  .fchips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
  .fchip { font-size: 10.5px; font-family: var(--font-mono); padding: 2px 8px; border-radius: 999px; color: #C9820A;
    background: color-mix(in srgb, #C9820A 12%, transparent); border: 0.5px solid color-mix(in srgb, #C9820A 30%, transparent); }
  .hdr { display: flex; align-items: center; gap: 8px; }
  .body { flex: 1 1 auto; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 16px; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 6px 0; }
  .mono { font-family: var(--font-mono); }

  .headline { display: flex; flex-direction: column; gap: 3px; padding: 6px 0 2px; }
  .big { font-size: 34px; font-weight: 600; color: var(--color-text-primary); font-family: var(--font-mono); line-height: 1.1; }
  .sub { font-size: 12px; color: var(--color-text-secondary); }
  .meta { font-size: 10px; color: var(--color-text-tertiary); font-family: var(--font-mono); }

  .section { display: flex; flex-direction: column; gap: 6px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); }

  .chart {
    display: flex; align-items: flex-end; gap: 2px; height: 80px;
    padding: 6px 8px; border: 0.5px solid var(--color-border-tertiary);
    border-radius: var(--border-radius-md); background: var(--color-background-secondary);
  }
  .bar { flex: 1 1 0; min-width: 2px; background: var(--accent, #6366F1); border-radius: 2px 2px 0 0; opacity: 0.85; }
  .bar:hover { opacity: 1; }
  .axis { display: flex; justify-content: space-between; font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }

  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); font-weight: 500; padding: 2px 4px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  td { padding: 4px 4px; border-bottom: 0.5px solid var(--color-border-tertiary); color: var(--color-text-primary); vertical-align: top; }
  td.name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .psub { display: block; font-size: 9px; color: var(--color-text-tertiary); font-weight: 400; margin-top: 1px; }
  .num { text-align: right; white-space: nowrap; }
  .dim { color: var(--color-text-tertiary); }

  .genat { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); text-align: right; }
</style>
