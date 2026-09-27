<script>
  // 📈 Improvement — are the agents actually getting better?
  //
  // Two rates over time (never raw counts: a busy week has more failures just
  // because it has more work), the recurring errors worth a rule, and — the part
  // that makes this improvement rather than accumulation — a before/after
  // verdict on every rule you promote. A rule that isn't moving its number is
  // still paid for in context on every turn, so it gets a Retire button.
  let { open = $bindable(false) } = $props();
  let _w = false;
  $effect(() => { if (open && !_w) load(); _w = open; });

  let loading = $state(false);
  let err = $state('');
  let data = $state(null);
  let projects = $state([]);
  let showTable = $state(false);
  let showRetired = $state(false);
  let hover = $state(-1);            // shared crosshair index across both charts
  let busy = $state({});             // sig/id -> true while an action is in flight
  let edits = $state({});            // sig -> { text, target }
  let flash = $state('');

  async function load() {
    loading = true; err = '';
    try {
      const [r, p] = await Promise.all([fetch('/api/lessons?days=60'), fetch('/api/projects')]);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      data = j;
      try { const pj = await p.json(); projects = (Array.isArray(pj) ? pj : pj.projects || []).filter((x) => x && x.path); } catch (_) {}
      for (const c of j.candidates || []) if (!edits[c.sig]) edits[c.sig] = { text: c.draft, target: defaultTarget(c) };
    } catch (e) { err = String(e.message || e); }
    loading = false;
  }

  // one project → that project's CLAUDE.md; seen across several → global
  function defaultTarget(c) {
    if ((c.projects || []).length === 1) {
      const p = projects.find((x) => x.name === c.projects[0]);
      if (p) return 'project:' + p.path;
    }
    return 'global';
  }

  async function post(act, body, key) {
    busy[key] = true; flash = '';
    try {
      const r = await fetch('/api/lessons/' + act, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.error) flash = '⚠ ' + j.error;
      else {
        flash = act === 'promote' ? '✓ Added to ' + shortFile(j.lesson && j.lesson.file) + ' — measuring from today'
          : act === 'retire' ? (j.removed ? '✓ Rule removed from its CLAUDE.md' : '✓ Retired (the line was already gone from the file)')
          : '✓ Dismissed — it won’t be suggested again';
        await load();
      }
    } catch (e) { flash = '⚠ ' + (e.message || e); }
    busy[key] = false;
  }
  function promote(c) {
    const e = edits[c.sig] || { text: c.draft, target: 'global' };
    const proj = e.target.startsWith('project:') ? e.target.slice(8) : '';
    post('promote', { sig: c.sig, text: e.text, target: proj ? 'project' : 'global', cwd: proj || undefined, project: proj ? (projects.find((x) => x.path === proj) || {}).name : '' }, c.sig);
  }
  function retire(l) {
    if (!confirm('Retire this rule?\n\n“' + l.text + '”\n\nIt is removed from ' + l.file + '.')) return;
    post('retire', { id: l.id }, l.id);
  }

  const shortFile = (f) => { const s = String(f || '').replace(/\\/g, '/').split('/'); return s.slice(-2).join('/'); };
  const fmtPct = (v, dp = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(dp) + '%');
  const fmtDate = (d) => { const [y, m, dd] = String(d).split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const dayOfMs = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ── the two measures ─────────────────────────────────────────────────────
  // Rolling values are a ratio of SUMS over 7 days, not an average of daily
  // ratios: a day with 1 prompt and 1 correction is not "100%" worth of evidence.
  const METRICS = [
    { key: 'rework', title: 'Rework rate', unit: 'of your prompts said it didn’t work', num: 'corrections', den: 'prompts', nLbl: 'corrections', dLbl: 'prompts' },
    { key: 'toolerr', title: 'Tool error rate', unit: 'of tool calls failed', num: 'toolErrors', den: 'toolCalls', nLbl: 'errors', dLbl: 'calls' },
  ];
  function rows(m) {
    const s = (data && data.series) || [];
    return s.map((d, i) => {
      let n = 0, dd = 0;
      for (let k = Math.max(0, i - 6); k <= i; k++) { n += s[k][m.num]; dd += s[k][m.den]; }
      return { date: d.date, n: d[m.num], d: d[m.den], daily: d[m.den] ? (d[m.num] / d[m.den]) * 100 : null, roll: dd ? (n / dd) * 100 : null };
    });
  }
  function headline(m) {
    const s = (data && data.series) || [];
    const sum = (a, k) => a.reduce((x, d) => x + d[k], 0);
    const last = s.slice(-7), prev = s.slice(-14, -7);
    const cur = sum(last, m.den) ? (sum(last, m.num) / sum(last, m.den)) * 100 : null;
    const was = sum(prev, m.den) ? (sum(prev, m.num) / sum(prev, m.den)) * 100 : null;
    let delta = null, dir = 'flat';
    // 1 correction vs 0 is not "100% better" — it's noise. Below 5 events across
    // both weeks there's nothing to call, and the tile says so instead of a trend.
    const events = sum(last, m.num) + sum(prev, m.num);
    if (events < 5) return { cur, was, delta: null, dir: 'thin', events, n: sum(last, m.num), d: sum(last, m.den) };
    if (cur != null && was != null && was > 0) {
      delta = ((cur - was) / was) * 100;
      dir = Math.abs(delta) < 10 ? 'flat' : delta < 0 ? 'better' : 'worse';
    }
    return { cur, was, delta, dir, n: sum(last, m.num), d: sum(last, m.den) };
  }
  const metricRows = $derived(data ? METRICS.map((m) => ({ m, rows: rows(m), head: headline(m) })) : []);

  // ── chart geometry (viewBox units; the SVG scales to the drawer width) ────
  const W = 480, H = 118, PL = 34, PR = 8, PT = 12, PB = 18;
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
    return 10 * p;
  }
  function geom(rs) {
    const n = rs.length;
    const rollMax = Math.max(0, ...rs.map((r) => r.roll || 0));
    const dailies = rs.map((r) => r.daily).filter((v) => v != null).sort((a, b) => a - b);
    const p90 = dailies.length ? dailies[Math.floor(dailies.length * 0.9)] : 0;
    // scale to the TREND, not to one noisy day: a day with 2 prompts can read 50%
    const yMax = niceMax(Math.max(rollMax * 1.6, p90, 0.1));
    const x = (i) => PL + (n <= 1 ? 0 : (i / (n - 1)) * (W - PL - PR));
    const y = (v) => PT + (1 - Math.min(v, yMax) / yMax) * (H - PT - PB);
    let path = '', pen = false;
    rs.forEach((r, i) => {
      if (r.roll == null) { pen = false; return; }
      path += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(r.roll).toFixed(1);
      pen = true;
    });
    const ticks = [0, yMax / 2, yMax];
    const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && v >= 0);
    return { x, y, yMax, path, ticks, xl, n };
  }
  const markers = $derived(((data && data.lessons) || [])
    .map((l, i) => ({ ...l, num: i + 1, day: dayOfMs(l.promotedAt) }))
    .filter((l) => !l.retiredAt));
  function markerIdx(rs, day) { return rs.findIndex((r) => r.date === day); }

  function onMove(ev, rs) {
    const svg = ev.currentTarget.ownerSVGElement || ev.currentTarget;
    const pt = svg.getBoundingClientRect();
    const vx = ((ev.clientX - pt.left) / pt.width) * W;
    const n = rs.length;
    hover = Math.max(0, Math.min(n - 1, Math.round(((vx - PL) / (W - PL - PR)) * (n - 1))));
  }

  // weekly table (accessible alternative to the chart)
  const weeks = $derived.by(() => {
    const s = (data && data.series) || [];
    const out = [];
    for (let end = s.length; end > 0 && out.length < 9; end -= 7) {
      const w = s.slice(Math.max(0, end - 7), end);
      const t = (k) => w.reduce((a, d) => a + d[k], 0);
      out.push({ from: w[0].date, prompts: t('prompts'), corr: t('corrections'), calls: t('toolCalls'), errs: t('toolErrors') });
    }
    return out;
  });

  const VERDICT = {
    working: { icon: '✓', label: 'Working', cls: 'ok' },
    'no-effect': { icon: '○', label: 'No effect', cls: 'warn' },
    worse: { icon: '▲', label: 'Worse', cls: 'err' },
    measuring: { icon: '…', label: 'Measuring', cls: 'dim' },
  };
  const active = $derived(((data && data.lessons) || []).map((l, i) => ({ ...l, num: i + 1 })).filter((l) => !l.retiredAt));
  const retired = $derived(((data && data.lessons) || []).filter((l) => l.retiredAt));

  function spark(vals, promoDay, dates) {
    const n = vals.length, mx = Math.max(1, ...vals);
    const pts = vals.map((v, i) => (n <= 1 ? 0 : (i / (n - 1)) * 120).toFixed(1) + ',' + (18 - (v / mx) * 16).toFixed(1)).join(' ');
    const pi = promoDay && dates ? dates.indexOf(promoDay) : -1;
    return { pts, px: pi >= 0 ? (n <= 1 ? 0 : (pi / (n - 1)) * 120) : null };
  }
  const dates = $derived(((data && data.series) || []).map((d) => d.date));

  function closePanel() { open = false; }
  function onKey(e) { if (e.key === 'Escape' && open) closePanel(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ov" onclick={closePanel} role="presentation"></div>
  <aside class="drawer viz-root" role="dialog" aria-label="Improvement — are the agents getting better">
    <div class="hd">
      <strong>📈 Improvement</strong>
      <div class="hdr">
        <button class="select" onclick={() => (showTable = !showTable)}>{showTable ? 'Chart' : 'Table'}</button>
        <button class="select" onclick={load} disabled={loading}>{loading ? 'Scanning…' : 'Refresh'}</button>
        <button class="x" onclick={closePanel} aria-label="Close">✕</button>
      </div>
    </div>

    <div class="body">
      {#if loading && !data}
        <div class="muted">Reading your transcripts… the first scan takes a few seconds, then it's instant.</div>
      {:else if err}
        <div class="muted">⚠ {err}</div>
      {:else if data}
        {#if flash}<div class="flash">{flash}</div>{/if}

        <!-- ── headline: this week vs last week ── -->
        <div class="section">
          <div class="lbl">Last 7 days vs the 7 before · lower is better</div>
          <div class="tiles">
            {#each metricRows as { m, head } (m.key)}
              <div class="tile">
                <div class="tk">{m.title}</div>
                <div class="tv">{fmtPct(head.cur, m.key === 'toolerr' ? 2 : 1)}</div>
                <div class="tsub">{m.unit}</div>
                {#if head.delta != null}
                  <div class="trend {head.dir}">
                    {head.dir === 'better' ? '↓' : head.dir === 'worse' ? '↑' : '→'}
                    {head.dir === 'flat' ? 'about the same' : Math.abs(Math.round(head.delta)) + '% ' + head.dir}
                    <span class="tdim">(was {fmtPct(head.was, m.key === 'toolerr' ? 2 : 1)})</span>
                  </div>
                {:else if head.dir === 'thin'}
                  <div class="trend flat">too few to call a trend <span class="tdim">({head.events} {head.events === 1 ? m.nLbl.replace(/s$/, "") : m.nLbl} in 2 weeks)</span></div>
                {:else}
                  <div class="trend flat">not enough history yet</div>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <!-- ── trend: small multiples, one measure per chart (never a dual axis) ── -->
        <div class="section">
          <div class="lbl">Last {data.days} days
            <span class="key"><svg width="18" height="8" aria-hidden="true"><line x1="1" y1="4" x2="17" y2="4" class="kline" /></svg> 7-day rate</span>
            <span class="key"><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="2.2" class="kdot" /></svg> single day</span>
            {#if markers.length}<span class="key"><svg width="8" height="10" aria-hidden="true"><line x1="4" y1="0" x2="4" y2="10" class="kmark" /></svg> rule added</span>{/if}
          </div>

          {#if showTable}
            <table class="wt">
              <thead><tr><th>Week from</th><th>Prompts</th><th>Rework</th><th>Tool calls</th><th>Errors</th></tr></thead>
              <tbody>
                {#each weeks as w}
                  <tr>
                    <td>{fmtDate(w.from)}</td>
                    <td class="num">{w.prompts}</td>
                    <td class="num">{w.prompts ? fmtPct((w.corr / w.prompts) * 100) : '—'} <span class="tdim">({w.corr})</span></td>
                    <td class="num">{w.calls}</td>
                    <td class="num">{w.calls ? fmtPct((w.errs / w.calls) * 100, 2) : '—'} <span class="tdim">({w.errs})</span></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            {#each metricRows as { m, rows: rs } (m.key)}
              {@const g = geom(rs)}
              <div class="chart">
                <div class="ct">{m.title}</div>
                <svg viewBox="0 0 {W} {H}" class="svg" role="img" aria-label="{m.title}, {data.days} days">
                  {#each g.ticks as t}
                    <line x1={PL} x2={W - PR} y1={g.y(t)} y2={g.y(t)} class="grid" />
                    <text x={PL - 5} y={g.y(t) + 3} class="ax" text-anchor="end">{t === 0 ? '0' : t < 1 ? String(+t.toFixed(2)) : String(Math.round(t * 10) / 10)}%</text>
                  {/each}
                  {#each g.xl as i}
                    <text x={g.x(i)} y={H - 4} class="ax" text-anchor={i === 0 ? 'start' : i === g.n - 1 ? 'end' : 'middle'}>{fmtDate(rs[i].date)}</text>
                  {/each}
                  {#each markers as mk (mk.id)}
                    {@const mi = markerIdx(rs, mk.day)}
                    {#if mi >= 0}
                      <line x1={g.x(mi)} x2={g.x(mi)} y1={PT - 2} y2={H - PB} class="mark" />
                      <text x={g.x(mi)} y={PT - 4} class="mnum" text-anchor="middle">{mk.num}</text>
                    {/if}
                  {/each}
                  {#each rs as r, i}
                    {#if r.daily != null}
                      <circle cx={g.x(i)} cy={g.y(r.daily)} r={r.daily > g.yMax ? 2.8 : 2.2} class="dot" class:clip={r.daily > g.yMax} />
                    {/if}
                  {/each}
                  <path d={g.path} class="line" />
                  {#if hover >= 0 && hover < rs.length}
                    <line x1={g.x(hover)} x2={g.x(hover)} y1={PT} y2={H - PB} class="cross" />
                    {#if rs[hover].roll != null}<circle cx={g.x(hover)} cy={g.y(rs[hover].roll)} r="4" class="hdot" />{/if}
                  {/if}
                  <!-- hit layer: the crosshair finds the X, the pointer never has to land on a 2px line -->
                  <rect x={PL} y="0" width={W - PL - PR} height={H - PB} fill="transparent"
                    role="presentation" onpointermove={(e) => onMove(e, rs)} onpointerleave={() => (hover = -1)} />
                </svg>
              </div>
            {/each}

            {#if hover >= 0 && metricRows.length}
              {@const d0 = metricRows[0].rows[hover]}
              <div class="tip">
                <div class="tipd">{fmtDate(d0.date)}</div>
                {#each metricRows as { m, rows: rs } (m.key)}
                  {@const r = rs[hover]}
                  <div class="tipr"><span class="tipk">{m.title}</span>
                    <span>7-day <b>{fmtPct(r.roll, m.key === 'toolerr' ? 2 : 1)}</b></span>
                    <span class="tdim">· day {r.d ? fmtPct(r.daily, m.key === 'toolerr' ? 2 : 1) + ' (' + r.n + '/' + r.d + ' ' + m.dLbl + ')' : 'no activity'}</span>
                  </div>
                {/each}
                {#each markers.filter((mk) => mk.day === d0.date) as mk (mk.id)}
                  <div class="tipr"><span class="tipk">Rule {mk.num} added</span><span class="tdim">{mk.text.slice(0, 80)}{mk.text.length > 80 ? '…' : ''}</span></div>
                {/each}
              </div>
            {/if}
          {/if}
          <div class="foot">{data.totals.prompts} prompts · {data.totals.toolCalls.toLocaleString()} tool calls · {data.totals.files} transcripts · scanned in {data.totals.scanMs}ms</div>
        </div>

        <!-- ── rules you've added, and whether each one is earning its place ── -->
        <div class="section">
          <div class="lbl">Rules you added · each is measured against its own error</div>
          {#if !active.length}
            <div class="empty">None yet. Promote a repeat below — it's appended to a CLAUDE.md, and this panel then tracks whether that error actually becomes rarer.</div>
          {/if}
          {#each active as l (l.id)}
            {@const v = VERDICT[l.effect.verdict] || VERDICT.measuring}
            {@const sp = spark(l.spark || [], dayOfMs(l.promotedAt), dates)}
            <div class="card">
              <div class="crow">
                <span class="num">{l.num}</span>
                <span class="verdict {v.cls}"><span aria-hidden="true">{v.icon}</span> {v.label}</span>
                <span class="tdim">{l.effect.note}</span>
              </div>
              <div class="ltext">{l.text}</div>
              <div class="crow small">
                <span class="tdim">{l.target === 'project' ? (l.project || 'project') : 'global'} · {shortFile(l.file)} · since {fmtDate(dayOfMs(l.promotedAt))}</span>
              </div>
              <div class="crow small">
                <svg width="120" height="20" class="spark" aria-hidden="true">
                  <polyline points={sp.pts} class="sline" />
                  {#if sp.px != null}<line x1={sp.px} x2={sp.px} y1="0" y2="20" class="kmark" />{/if}
                </svg>
                <span class="tdim">
                  before {l.effect.before.hits} in {l.effect.before.calls.toLocaleString()} calls → after {l.effect.after.hits} in {l.effect.after.calls.toLocaleString()}
                </span>
                <span class="spacer"></span>
                <button class="mini" onclick={() => retire(l)} disabled={busy[l.id]}>Retire</button>
              </div>
            </div>
          {/each}
          {#if retired.length}
            <button class="linky" onclick={() => (showRetired = !showRetired)}>{showRetired ? 'Hide' : 'Show'} {retired.length} retired</button>
            {#if showRetired}
              {#each retired as l (l.id)}<div class="retired">{l.text}</div>{/each}
            {/if}
          {/if}
        </div>

        <!-- ── repeats worth a rule ── -->
        <div class="section">
          <div class="lbl">Repeats worth a rule · seen {data.minCount}+ times in 2+ sessions</div>
          {#if !data.candidates.length}
            <div class="empty">Nothing repeats often enough to be worth a rule right now. That's the good outcome.</div>
          {/if}
          {#each data.candidates as c (c.sig)}
            {@const sp = spark(c.spark || [])}
            <div class="card">
              <div class="crow">
                <span class="chip">{c.tool}</span>
                <b>{c.count}×</b>
                <span class="tdim">in {c.sessions} sessions{c.projects.length ? ' · ' + c.projects.slice(0, 3).join(', ') + (c.projects.length > 3 ? ' +' + (c.projects.length - 3) : '') : ''}</span>
                <span class="spacer"></span>
                <svg width="120" height="20" class="spark" aria-label="{c.count} times over {data.days} days"><polyline points={sp.pts} class="sline" /></svg>
              </div>
              <div class="sig">{c.samples[0] || c.sig}</div>
              {#if edits[c.sig]}
                <textarea class="in rule" rows="2" bind:value={edits[c.sig].text} aria-label="Rule text"></textarea>
                <div class="crow">
                  <select class="in" bind:value={edits[c.sig].target} aria-label="Where the rule goes">
                    <option value="global">Global — every project</option>
                    {#each projects.filter((p) => c.projects.includes(p.name)) as p (p.path)}
                      <option value={'project:' + p.path}>{p.name} only</option>
                    {/each}
                  </select>
                  <span class="spacer"></span>
                  <button class="mini" onclick={() => post('dismiss', { sig: c.sig }, c.sig)} disabled={busy[c.sig]}>Dismiss</button>
                  <button class="select go" onclick={() => promote(c)} disabled={busy[c.sig] || !edits[c.sig].text.trim()}>Promote</button>
                </div>
              {/if}
            </div>
          {/each}
          <div class="foot">Rules cost context on every turn — promote the few that matter, and retire any that show no effect.</div>
        </div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  /* series color validated (dataviz validate_palette.js) on Gander's own surfaces:
     #2a78d6 on #ffffff (light), #3987e5 on #211f1c (dark) — all checks pass */
  .viz-root { --viz-line: #2a78d6; --viz-dot: #a9b8cc; }
  @media (prefers-color-scheme: dark) { .viz-root { --viz-line: #3987e5; --viz-dot: #55606e; } }

  .drawer { --drawer-w: 540px; }
  .hdr { display: flex; align-items: center; gap: 8px; }
  .body { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; }
  .muted { font-size: 11px; color: var(--color-text-tertiary); padding: 16px 14px; }
  .flash { font-size: 11px; padding: 8px 14px; background: var(--color-background-secondary); border-bottom: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); }
  .section { padding: 12px 14px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; flex-direction: column; gap: 8px; }
  .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .key { display: inline-flex; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; }
  .kline { stroke: var(--viz-line); stroke-width: 2; stroke-linecap: round; }
  .kdot { fill: var(--viz-dot); }
  .kmark { stroke: var(--color-text-secondary); stroke-width: 1; }

  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .tile { padding: 10px; border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); }
  .tk { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); }
  .tv { font-size: 28px; font-weight: 600; font-family: var(--font-mono); color: var(--color-text-primary); line-height: 1.15; margin-top: 2px; }
  .tsub { font-size: 10px; color: var(--color-text-tertiary); }
  .trend { font-size: 11px; margin-top: 6px; font-weight: 600; }
  .trend.better { color: var(--hm-ok); }
  .trend.worse { color: var(--hm-err); }
  .trend.flat { color: var(--color-text-secondary); font-weight: 500; }
  .tdim { color: var(--color-text-tertiary); font-weight: 400; }

  .chart { display: flex; flex-direction: column; gap: 2px; }
  .ct { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); }
  .svg { width: 100%; height: auto; display: block; overflow: visible; touch-action: none; }
  .grid { stroke: var(--color-border-tertiary); stroke-width: 1; }
  .ax { font-size: 9px; fill: var(--color-text-tertiary); font-family: var(--font-mono); }
  .dot { fill: var(--viz-dot); }
  .dot.clip { fill: none; stroke: var(--viz-dot); stroke-width: 1.2; }
  .line { fill: none; stroke: var(--viz-line); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .mark { stroke: var(--color-text-secondary); stroke-width: 1; opacity: 0.7; }
  .mnum { font-size: 9px; font-weight: 700; fill: var(--color-text-secondary); }
  .cross { stroke: var(--color-text-tertiary); stroke-width: 1; }
  .hdot { fill: var(--viz-line); stroke: var(--color-background-primary); stroke-width: 2; }

  .tip { font-size: 11px; padding: 8px 10px; border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); background: var(--color-background-secondary); display: flex; flex-direction: column; gap: 3px; }
  .tipd { font-weight: 600; color: var(--color-text-primary); }
  .tipr { display: flex; flex-wrap: wrap; gap: 6px; color: var(--color-text-primary); }
  .tipk { color: var(--color-text-secondary); min-width: 96px; }
  .foot { font-size: 9px; color: var(--color-text-tertiary); font-family: var(--font-mono); }

  .wt { width: 100%; border-collapse: collapse; font-size: 11px; }
  .wt th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); font-weight: 500; padding: 3px 4px; border-bottom: 0.5px solid var(--color-border-tertiary); }
  .wt td { padding: 4px; border-bottom: 0.5px solid var(--color-border-tertiary); color: var(--color-text-primary); }
  .wt .num { font-family: var(--font-mono); }

  .empty { font-size: 11px; color: var(--color-text-secondary); line-height: 1.5; }
  .card { border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md); padding: 9px 10px; display: flex; flex-direction: column; gap: 6px; background: var(--color-background-primary); }
  .crow { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11px; color: var(--color-text-primary); }
  .crow.small { font-size: 10px; }
  .spacer { flex: 1; }
  .num { font-family: var(--font-mono); font-size: 10px; font-weight: 700; color: var(--color-text-secondary); }
  .chip { font-size: 10px; font-family: var(--font-mono); padding: 1px 6px; border-radius: 6px; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-tertiary); color: var(--color-text-secondary); }
  .sig { font-size: 11px; font-family: var(--font-mono); color: var(--color-text-secondary); word-break: break-word; }
  .ltext { font-size: 12px; color: var(--color-text-primary); line-height: 1.45; }
  .rule { width: 100%; font: 12px/1.45 var(--font-sans); resize: vertical; }
  .spark { flex-shrink: 0; overflow: visible; }
  .sline { fill: none; stroke: var(--viz-line); stroke-width: 1.5; stroke-linejoin: round; }
  .verdict { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
  .verdict.ok { color: var(--hm-ok); }
  .verdict.warn { color: var(--hm-warn); }
  .verdict.err { color: var(--hm-err); }
  .verdict.dim { color: var(--color-text-tertiary); }
  .go { font-weight: 600; }
  .in { font-size: 11px; padding: 5px 7px; border-radius: var(--border-radius-md); border: 0.5px solid var(--color-border-tertiary);
    background: var(--color-background-primary); color: var(--color-text-primary); }
  .mini { font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer; border: 0.5px solid var(--color-border-secondary);
    background: var(--color-background-secondary); color: var(--color-text-secondary); }
  .mini:hover { border-color: var(--accent, #6366F1); color: var(--color-text-primary); }
  .linky { align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-size: 11px; color: var(--color-text-secondary); text-decoration: underline; }
  .retired { font-size: 11px; color: var(--color-text-tertiary); text-decoration: line-through; }
</style>
