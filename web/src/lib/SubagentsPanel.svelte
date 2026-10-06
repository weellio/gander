<script>
  // Sub-agents — every Task-tool agent your sessions have spawned, read from the
  // transcripts on disk. Claude Code's own agent map only knows the session it is
  // in; this one also covers finished agents from previous sessions.
  // GETs /api/subagents?days=N on open (days=0 = everything on disk).
  let { open = $bindable(false) } = $props();

  let days = $state(14);
  let d = $state(null);
  let loading = $state(false);
  let filter = $state('');

  async function load() {
    loading = true;
    try {
      const r = await fetch('/api/subagents?days=' + days);
      const j = await r.json();
      d = j && !j.error ? j : null;
    } catch (_) {
      d = null;
    }
    loading = false;
  }
  $effect(() => { if (open) load(); });
  function setDays(n) { days = n; load(); }
  function closePanel() { open = false; filter = ''; }
  function onKey(e) { if (e.key === 'Escape' && open) closePanel(); }

  // --- formatters ---
  function tok(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
  }
  function money(n) {
    const v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function dur(ms) {
    const v = Number(ms) || 0;
    if (v <= 0) return '—';
    if (v < 1000) return v + 'ms';
    const s = v / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + Math.round(s - m * 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m - h * 60) + 'm';
  }
  function ts(v) { return typeof v === 'number' ? v : (Date.parse(v) || 0); }
  function ago(v) {
    const t = ts(v);
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  const list = $derived(
    [...((d && d.subagents) || [])].sort((a, b) => ts(b.startedAt) - ts(a.startedAt))
  );
  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      String(s.description || '').toLowerCase().includes(q) ||
      String(s.agentType || '').toLowerCase().includes(q) ||
      String(s.project || '').toLowerCase().includes(q)
    );
  });
  const totals = $derived((d && d.totals) || { count: 0, today: 0, tokens: 0, costUSD: 0, toolUses: 0 });
  const byType = $derived((d && d.byType) || []);
  // tokens burned but nothing priced → the model has no entry in Settings → Model pricing
  const unpriced = $derived(!Number(totals.costUSD) && Number(totals.tokens) > 0);
  const rangeLabel = $derived(days ? 'in the last ' + days + (days === 1 ? ' day' : ' days') : 'on disk');
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer" role="dialog" aria-label="Sub-agents">
    <div class="hd">
      <strong>🤖 Sub-agents</strong>
      <span class="hdsub">every agent your sessions have spawned</span>
      <button class="x" onclick={closePanel} aria-label="Close">✕</button>
    </div>

    <div class="topbar">
      <div class="toprow">
        <span class="range">
          {#each [1, 7, 14, 30, 0] as n (n)}
            <button class="rb" class:on={days === n} onclick={() => setDays(n)}>{n ? n + 'd' : 'all'}</button>
          {/each}
        </span>
        <button class="mini" onclick={load} disabled={loading}>{loading ? '…' : '⟳'}</button>
      </div>

      <div class="totals mono">
        <b>{totals.today || 0}</b> today · <b>{totals.count || 0}</b> {rangeLabel} ·
        <b>{tok(totals.tokens)}</b> tokens · <b>{money(totals.costUSD)}</b>
      </div>
      {#if unpriced}
        <div class="hint warntxt">Unpriced — give this model a price in <b>Settings → Model pricing</b> to see spend here.</div>
      {/if}

      {#if byType.length}
        <div class="chips">
          {#each byType as t (t.agentType)}
            <span class="chip" title="{t.count} run{t.count === 1 ? '' : 's'} · {tok(t.tokens)} tokens · {money(t.costUSD)}">
              {t.agentType || 'agent'} <span class="cdim">· {t.count} · {tok(t.tokens)}</span>
            </span>
          {/each}
        </div>
      {/if}

      {#if d && d.scorecard && d.scorecard.length}
        <!-- 📊 scorecards: which agent TYPES are worth using -->
        <details class="score" open={d.scorecard.length <= 6}>
          <summary>📊 Scorecard by agent type</summary>
          <table>
            <thead><tr><th>Type</th><th>Runs</th><th>Avg cost</th><th>Avg time</th><th title="tool errors per 100 tool calls">Errors</th><th title="share of runs whose last step was an error">Ended on error</th></tr></thead>
            <tbody>
              {#each d.scorecard as s (s.agentType)}
                <tr class:small={s.sample === 'small'}>
                  <td class="mono">{s.agentType || 'agent'}{#if s.sample === 'small'} <span class="cdim" title="fewer than 3 runs: too few to judge">· few runs</span>{/if}</td>
                  <td class="num">{s.runs}</td>
                  <td class="num">{money(s.avgCostUSD)}</td>
                  <td class="num">{s.avgDurationMs ? Math.max(1, Math.round(s.avgDurationMs / 60000)) + 'm' : '—'}</td>
                  <td class="num">{s.toolErrorRate != null ? s.toolErrorRate.toFixed(1) + '%' : '—'}</td>
                  <td class="num" class:bad={s.sample !== 'small' && s.endedOnErrorPct >= 25}>{s.endedOnErrorPct != null ? s.endedOnErrorPct + '%' : '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </details>
      {/if}

      <input class="filter-input" bind:value={filter} placeholder="filter by description, type or project…" />
    </div>

    <div class="list">
      {#if loading && !d}
        <div class="empty">Reading transcripts…</div>
      {:else if !filtered.length}
        <div class="empty">
          {#if filter.trim()}No sub-agents match “{filter.trim()}”.
          {:else}No sub-agents found yet. They appear here as soon as a session spawns one.{/if}
        </div>
      {:else}
        {#each filtered as s (s.agentId)}
          <div class="row">
            <div class="desc">{s.description || s.agentType || 'sub-agent'}</div>
            <div class="tags">
              <span class="tag">{s.agentType || 'agent'}</span>
              {#if s.background}<span class="tag bg" title="ran in the background">background</span>{/if}
              {#if s.project}<span class="proj" title={s.project}>{s.project}</span>{/if}
              <span class="when mono">{ago(s.startedAt)}</span>
            </div>
            <div class="nums mono">
              <span title="wall-clock duration">{dur(s.durationMs)}</span>
              <span title="total tokens (in + out + cache)">{tok(s.tokens && s.tokens.total)} tok</span>
              <span title="tool calls">{s.toolUses || 0}⚒</span>
              {#if Number(s.costUSD)}<span class="cost" title="estimated cost">{money(s.costUSD)}</span>{/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .drawer { --drawer-w: 430px; }   /* shell (.ov/.drawer/.hd/.x) is shared in app.css */
  .hdsub { font-size: 10px; color: var(--color-text-tertiary); margin-left: 8px; flex: 1; }

  .topbar { flex-shrink: 0; padding: 9px 14px 10px; border-bottom: 0.5px solid var(--color-border-tertiary);
    display: flex; flex-direction: column; gap: 7px; }
  .toprow { display: flex; align-items: center; gap: 8px; }
  .range { display: flex; gap: 3px; flex: 1 1 auto; }
  .rb { font-size: 10px; padding: 2px 8px; border-radius: 99px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .rb.on { background: var(--accent, #6366F1); color: #fff; border-color: transparent; }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer;
    border: 0.5px solid var(--color-border-secondary); background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .mini:hover { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }

  .score { font-size: 11px; color: var(--color-text-secondary); }
  .score summary { cursor: pointer; font-weight: 600; margin-bottom: 4px; }
  .score table { width: 100%; border-collapse: collapse; }
  .score th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); font-weight: 500; padding: 2px 4px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .score td { padding: 3px 4px; border-bottom: 0.5px solid var(--color-border-tertiary); color: var(--color-text-primary); }
  .score td.num { font-family: var(--font-mono); text-align: right; }
  .score tr.small td { color: var(--color-text-tertiary); }
  .score td.bad { color: var(--hm-err); font-weight: 600; }
  .totals { font-size: 11.5px; color: var(--color-text-secondary); line-height: 1.5; }
  .totals b { color: var(--color-text-primary); font-weight: 600; }
  .hint { font-size: 10px; color: var(--color-text-tertiary); line-height: 1.4; }
  .warntxt { color: #C9820A; }
  .warntxt b { font-weight: 600; }

  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 10px; font-family: var(--font-mono); padding: 2px 8px; border-radius: 999px;
    color: var(--color-text-secondary); background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); }
  .cdim { color: var(--color-text-tertiary); }

  .filter-input { width: 100%; box-sizing: border-box; font-size: 11px; padding: 5px 8px;
    border-radius: var(--border-radius-md, 6px); border: 0.5px solid var(--color-border-tertiary);
    background: var(--color-background-secondary); color: var(--color-text-primary); outline: none; }

  .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 2px 0; }
  .empty { font-size: 11.5px; color: var(--color-text-tertiary); padding: 20px 16px; line-height: 1.5; }

  .row { padding: 8px 14px; border-bottom: 0.5px solid var(--color-border-tertiary);
    display: flex; flex-direction: column; gap: 3px; }
  .row:last-child { border-bottom: none; }
  .row:hover { background: var(--color-background-secondary); }

  .desc { font-size: 12px; line-height: 1.4; color: var(--color-text-primary);
    overflow-wrap: anywhere; word-break: break-word; }
  .tags { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 10px; min-width: 0; }
  .tag { font-family: var(--font-mono); font-size: 9.5px; padding: 1px 6px; border-radius: 4px;
    color: var(--color-text-secondary); background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); flex-shrink: 0; }
  .tag.bg { color: #A855F7; border-color: color-mix(in srgb, #A855F7 35%, transparent);
    background: color-mix(in srgb, #A855F7 10%, transparent); }
  .proj { color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 150px; min-width: 0; }
  .when { margin-left: auto; color: var(--color-text-tertiary); font-size: 9.5px; flex-shrink: 0; }

  .nums { display: flex; gap: 10px; font-size: 10px; color: var(--color-text-tertiary); flex-wrap: wrap; }
  .nums .cost { color: var(--color-text-secondary); }

  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
</style>
