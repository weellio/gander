<script>
  // Server-room strip for the Mosaic view — the same background-process triage
  // the Office floor draws as robots, as DOM cards under the tile grid. Groups
  // and verdicts come from procgroups.js, so the two views always agree.
  import { buildClusters, TONE_COL } from './procgroups.js';
  let { procs = [] } = $props();
  let clusters = $derived(buildClusters(procs));
  let killing = $state(0);

  async function killPid(pid) {
    try { await fetch('/api/kill-process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) }); } catch (_) {}
  }
  async function killProc(p) {
    const where = p.ports && p.ports.length ? ` holding port ${p.ports.join(', ')}` : '';
    if (!confirm(`Kill ${p.name} (pid ${p.pid})${where}?\n\nForce-kills the process and its child tree.`)) return;
    killing = p.pid; await killPid(p.pid); killing = 0;
  }
  async function endSession(c) {
    const work = c.bots.filter((b) => b.attribution !== 'plugin');
    const warn = work.length ? `\n\nWARNING — it still has live work that dies with it:\n${work.map((b) => `  ${b.name}${b.ports?.length ? ' :' + b.ports.join(',') : ''}`).join('\n')}` : '';
    if (!confirm(`End this Claude session (kill claude.exe ${c.claudePid} and its ${c.bots.length} background process${c.bots.length === 1 ? '' : 'es'})?\n\nThe conversation stays resumable from Session history.${warn}`)) return;
    killing = c.claudePid; await killPid(c.claudePid); killing = 0;
  }
  const lblOf = (p) => p.plugin || String(p.name || '').replace(/\.exe$/i, '');
</script>

{#if clusters.length}
  <div class="strip">
    <div class="sh">🤖 Server room <span class="dim">· background processes your sessions left running</span></div>
    <div class="cards">
      {#each clusters as c (c.key)}
        <div class="card" style="--tone:{TONE_COL[c.tone]}">
          <div class="ch">
            <b>{c.title}</b>
            {#if c.sub}<span class="sub">{c.sub}</span>{/if}
            {#if c.claudePid}
              <button class="end" disabled={killing === c.claudePid} onclick={() => endSession(c)}
                title="Kill claude.exe {c.claudePid} and all its background processes — the conversation stays resumable from Session history">
                {killing === c.claudePid ? '…' : 'End session'}
              </button>
            {/if}
          </div>
          <div class="pill">{c.verdict}</div>
          <div class="bots">
            {#each c.bots as p (p.pid)}
              <span class="chip" title={(p.linked || '') + ' · pid ' + p.pid}>
                <svg class="bot" viewBox="0 0 16 16" aria-hidden="true">
                  <line x1="8" y1="3" x2="8" y2="1" stroke="var(--tone)" stroke-width="1" />
                  <circle cx="8" cy="1.6" r="1.1" fill="var(--tone)" />
                  <rect x="2.5" y="3.5" width="11" height="8" rx="2" fill="var(--tone)" opacity="0.25" stroke="var(--tone)" stroke-width="1" />
                  <rect x="5" y="6" width="2" height="2" fill="var(--tone)" />
                  <rect x="9" y="6" width="2" height="2" fill="var(--tone)" />
                  <rect x="3.5" y="12.5" width="3.5" height="1.8" fill="var(--tone)" opacity="0.7" />
                  <rect x="9" y="12.5" width="3.5" height="1.8" fill="var(--tone)" opacity="0.7" />
                </svg>
                {lblOf(p)}
                {#each (p.ports || []) as port (port)}<a class="port" href="http://localhost:{port}" target="_blank" rel="noopener">:{port}</a>{/each}
                <button class="x" disabled={killing === p.pid} onclick={() => killProc(p)} title="Kill pid {p.pid}">✕</button>
              </span>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .strip { margin-top: 16px; }
  .sh { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; color: var(--color-text-tertiary); margin-bottom: 8px; }
  .sh .dim { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .card { border: 0.5px solid color-mix(in srgb, var(--tone) 45%, transparent); border-radius: var(--border-radius-md);
    background: color-mix(in srgb, var(--tone) 4%, transparent); padding: 9px 11px; }
  .ch { display: flex; align-items: baseline; gap: 8px; }
  .ch b { font-size: 12px; color: var(--color-text-primary); }
  .sub { font-size: 10px; color: var(--color-text-tertiary); }
  .end { margin-left: auto; font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer;
    background: #EF44441a; border: 0.5px solid #EF444455; color: #EF4444; white-space: nowrap; }
  .end:hover:not(:disabled) { background: #EF4444; color: #fff; }
  .pill { display: inline-block; margin-top: 6px; font-size: 10px; font-weight: 600; color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent); border-radius: 999px; padding: 2px 9px; }
  .bots { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--color-text-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: 999px; padding: 2px 7px 2px 5px; background: var(--color-background-primary); }
  .bot { width: 14px; height: 14px; }
  .port { font-family: var(--font-mono); font-size: 9.5px; color: #10B981; text-decoration: none; }
  .port:hover { text-decoration: underline; }
  .x { border: 0; background: none; color: var(--color-text-tertiary); cursor: pointer; font-size: 9px; padding: 0 1px; }
  .x:hover { color: #EF4444; }
</style>
