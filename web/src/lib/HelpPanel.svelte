<script>
  // Self-contained help/guide modal. Renders its own "?" trigger + a centered modal.
  let open = $state(false);
  function onKey(e) { if (e.key === 'Escape') open = false; }

  // Grouped capability reference — keep in sync as features land.
  const sections = [
    {
      title: 'Views & layout',
      items: [
        ['Office (floor)', 'A top-down animated office. Agents sit at desks, route packets to their sub-agents, and wander to the water cooler when idle.'],
        ['Mosaic', 'A compact responsive tile grid. Here you can switch avatar style (pixel / abstract / desk / your images) and import images.'],
        ['Activity highlight', 'Working agents get a coloured glow; idle agents get a pulsing amber ring so you can spot who to put back to work.'],
        ['Pan / zoom', 'Drag to pan, use the +/− controls (or scroll) to zoom the Office floor; Fit re-centres.'],
      ],
    },
    {
      title: 'Click an agent',
      items: [
        ['Current task', 'See the agent’s latest message / what it’s doing right now.'],
        ['Reply · Stop', 'Send a message or task to a running session, or stop it at its next tool.'],
        ['💰 Session cost', 'Live estimated spend for that session.'],
        ['📄 Transcript', 'Read the full conversation of the session.'],
        ['Open folder · VS Code', 'Jump to the project on disk or in your editor.'],
      ],
    },
    {
      title: 'Manage ▾ — Projects',
      items: [
        ['All projects', 'Every Claude project — running, recently active, or discovered from folders you add (typed path or native picker).'],
        ['Components', 'Browse each project’s skills, agents, commands, hooks & MCP servers — and copy any of them to another project or your global ~/.claude (with overwrite confirm).'],
        ['Git status', 'Per-project ⎇ branch · dirty · ahead/behind badge.'],
        ['▶ Start', 'Launch a Claude session in a terminal there — optionally seeded with a task.'],
        ['Pull · Diff · Branches · Commit & Push', 'Full source-control inline: view the diff, switch/create branches, and commit + push.'],
      ],
    },
    {
      title: 'Manage ▾ — more panels',
      items: [
        ['Usage / cost', 'Token & cost analytics from your transcripts: totals, 30-day chart, per-project/model, priciest sessions.'],
        ['GitHub', 'Open PRs & issues per project (★ stars · ⑂ forks), click to open in the browser, and create a pull request.'],
        ['Config', 'View a project’s hooks, MCP servers & raw settings; add or delete an MCP server, delete a hook — plus set up Telegram (live, no restart).'],
        ['Session history', 'Recent sessions across all projects with their first prompt — View the transcript or ▶ Resume any one.'],
        ['Health / status', 'Confirm Hivemind is wired up: bridge uptime/events, hook-install checklist, node/platform.'],
      ],
    },
    {
      title: 'Options & alerts',
      items: [
        ['Conserve tokens', 'Hivemind sends almost nothing to the model itself — the real per-turn cost is the MCP servers / skills a project loads. Trim them in Config.'],
        ['Performance toggles', 'Alert sound, desktop notifications, auto-refresh cost, fast agent updates, and office animations.'],
        ['Status bar', 'Today’s + total spend is always visible.'],
        ['Telegram', 'Get pinged when a session is waiting, and reply or /stop from your phone.'],
        ['Theme', 'Switch colour themes and background.'],
      ],
    },
  ];
</script>

<svelte:window onkeydown={onKey} />

<button class="select" onclick={() => (open = true)} title="What can this do?" aria-label="Help">?</button>

{#if open}
  <div class="backdrop" onclick={() => (open = false)} role="presentation">
    <div class="modal" role="dialog" aria-label="Hivemind help" onclick={(e) => e.stopPropagation()}>
      <div class="hd">
        <strong>Hivemind — what you can do</strong>
        <button class="x" onclick={() => (open = false)} aria-label="Close">✕</button>
      </div>
      <div class="intro">A local control center for Claude Code on your machine — watch every agent, manage projects &amp; components, track cost, and drive source control.</div>
      <div class="grid">
        {#each sections as s (s.title)}
          <section class="sec">
            <div class="sec-h">{s.title}</div>
            {#each s.items as [term, desc] (term)}
              <div class="item"><span class="term">{term}</span><span class="desc">{desc}</span></div>
            {/each}
          </section>
        {/each}
      </div>
      <div class="foot">Tip: panels open from <b>⚙ Manage ▾</b>; everything runs locally via the bridge on :3131. Press <kbd>Esc</kbd> to close.</div>
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(1px); padding: 24px; }
  .modal { width: 720px; max-width: 100%; max-height: calc(100vh - 60px); overflow: auto;
    background: var(--color-background-primary); color: var(--color-text-primary);
    border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-lg);
    padding: 18px 20px; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35); display: flex; flex-direction: column; gap: 12px; }
  .hd { display: flex; align-items: center; justify-content: space-between; }
  .hd strong { font-size: 15px; }
  .x { background: none; border: none; cursor: pointer; font-size: 15px; color: var(--color-text-tertiary); }
  .intro { font-size: 12px; color: var(--color-text-secondary); line-height: 1.5; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 22px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  .sec-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent, #6366F1); font-weight: 600; margin-bottom: 7px; }
  .item { display: flex; flex-direction: column; gap: 1px; margin-bottom: 8px; }
  .term { font-size: 12px; font-weight: 500; color: var(--color-text-primary); }
  .desc { font-size: 11px; color: var(--color-text-secondary); line-height: 1.45; }
  .foot { border-top: 0.5px solid var(--color-border-tertiary); padding-top: 10px; font-size: 11px; color: var(--color-text-tertiary); line-height: 1.5; }
  kbd { font-family: var(--font-mono); font-size: 10px; background: var(--color-background-secondary);
    border: 0.5px solid var(--color-border-tertiary); border-radius: 4px; padding: 0 4px; }
</style>
