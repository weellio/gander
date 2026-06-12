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
        ['📊 Analytics', 'Per-session efficiency gauges from the transcript: cache-hit % (context reused vs re-sent), output-cost share (verbose vs context bulk), and a context-window bar. A parked, near-full session shows a “Compact now” nudge that types /compact to free context.'],
        ['📄 Transcript', 'Read the full conversation of the session.'],
        ['🪟 Focus window', 'Bring the running session’s terminal to the front — Gander raises the exact window it captured at launch (▶ Start / ＋ New task). Different from “Open in VS Code”, which opens the project folder.'],
        ['Open folder · VS Code', 'Jump to the project on disk or in your editor.'],
      ],
    },
    {
      title: 'Manage ▾ — Projects',
      items: [
        ['All projects', 'Every Claude project — running, recently active, or discovered from folders you add (typed path or native picker).'],
        ['Components', 'Browse each project’s skills, agents & commands — and copy any of them to another project or your global ~/.claude (with overwrite confirm).'],
        ['Hooks · MCP · settings.json', 'Expand a project to manage its hooks (view + delete), MCP servers (add from presets, remove) and raw settings.json — inline, where the project lives. (Replaced the old separate Config panel.)'],
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
        ['App configuration', 'Settings ▾ → App configuration: the app-wide stuff — Telegram, cost budget, new-session options, idle nudge, editor command (live, no restart).'],
        ['Routines & briefings', 'Save reusable prompts (that can call skills/MCP), Run now or schedule daily. They run headlessly and post their output as a “briefing” — a morning brief, a nightly digest, etc. A fresh one greets you with a card.'],
        ['Session history', 'Recent sessions across all projects with their first prompt — View the transcript or ▶ Resume any one.'],
        ['Search', 'Search across every session transcript + project — find which session touched a file or topic, then open it.'],
        ['Activity feed', 'A live chronological ticker of agent events, with an errors-only filter to spotlight failures.'],
        ['Processes (stuck open?)', 'Long-running / port-holding processes your sessions spawned (dev servers, node, python…). Spot one left running and Kill it (force-kills the tree). Each agent’s modal also lists what that session left open. Windows-only for now.'],
        ['Health / status', 'Confirm Gander is wired up: bridge uptime/events, hook-install checklist, node/platform.'],
      ],
    },
    {
      title: 'Options & alerts',
      items: [
        ['Conserve tokens', 'Gander sends almost nothing to the model itself — the real per-turn cost is the MCP servers / skills a project loads. Trim them per project: Manage → Projects → expand a project → MCP servers.'],
        ['Audit your context', 'Install ships a context-audit skill — in any session just ask “audit my context” or “trim my CLAUDE.md”. It reads each session’s cache-hit / context-fill, ranks what’s re-sent every turn (CLAUDE.md, MCP tool schemas, skills, memory), and proposes concrete cuts + a leaner CLAUDE.md.'],
        ['Cost budget', 'Set a daily / per-session spend cap (Settings → App configuration) — get a banner + Telegram alert when crossed.'],
        ['Performance toggles', 'Alert sound, desktop notifications, auto-refresh cost, fast agent updates, and office animations.'],
        ['Status bar', 'Today’s + total spend is always visible.'],
        ['Telegram', 'Get pinged when a session is waiting, and reply or /stop from your phone.'],
        ['Theme', 'Switch colour themes and background.'],
      ],
    },
    {
      title: 'FAQ / good to know',
      items: [
        ['“Waiting on you” but I can’t see the options?', 'Claude Code draws numbered prompts (plan approval, menus) in the terminal itself — it doesn’t send the option text through hooks, so Gander can’t display them. Open the session (Open in VS Code) to read the menu, then answer remotely with the ⌨ quick-keys. Permission prompts DO show their reason (e.g. “needs permission to use Bash”).'],
        ['Answering prompts (⌨ quick-keys)', 'The ⌨ row in an agent’s modal types a keystroke into that session’s window (1/2/3 · ↑/↓ · ↵ · y/n · Esc). Gander finds the window by the PID it captured at launch (▶ Start / ＋ New task) or by project name in the title (VS Code). A session you opened manually in a bare terminal (titled “Claude Code”) may not be reachable — the flash says so. It steals focus and types into whatever’s focused there, so keep the Claude terminal focused.'],
        ['“’claude’ is not recognized” on ▶ Start', 'Your claude CLI isn’t on PATH. Set its full path in Settings → New session options (find it with where claude / which claude).'],
        ['“Trust this folder?” on Start / New task', 'Launching opens a fresh terminal, so Claude shows its one-time, per-folder trust prompt — choose “Yes”. It’s remembered after you accept once (you don’t see it from VS Code because the folder’s already trusted there).'],
        ['Skip permission prompts', 'Settings → New session options → “skip ALL prompts” launches with --dangerously-skip-permissions, so Claude won’t ask before edits/commands. Only use it on projects you trust.'],
        ['Sub-agents show no dollar amount', 'Cost is tracked per session (one transcript). A sub-agent’s spend is part of its parent session, so only the session (root) carries the figure.'],
        ['Why does a session show “$X/min”?', 'Spend is estimated from token counts at API list prices — on a Max/subscription plan you aren’t literally paying that. Treat it as a relative “spending fast” signal.'],
        ['Replies aren’t instant', 'Replies are queued and delivered when the session next runs a turn. Turn on Settings → App configuration → Wake idle sessions to nudge a parked session so it picks up your reply right away.'],
        ['Routine email/calendar didn’t work', 'Routines run headlessly (claude -p). Interactively-authenticated MCP (claude.ai Gmail/Calendar connectors) often isn’t available unattended; skills and token-based MCP are fine. Use Run now to see what’s available, and keep briefing routines read-only.'],
      ],
    },
  ];
</script>

<svelte:window onkeydown={onKey} />

<button class="select" onclick={() => (open = true)} title="What can this do?" aria-label="Help">?</button>

{#if open}
  <div class="backdrop" onclick={() => (open = false)} role="presentation">
    <div class="modal" role="dialog" aria-label="Gander help" onclick={(e) => e.stopPropagation()}>
      <div class="hd">
        <strong>Gander — what you can do</strong>
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
      <div class="foot">Tip: press <kbd>/</kbd> (or click <b>🔍 Jump</b>) for the command palette — jump to any panel or fly to any agent by name. Panels also open from <b>⚙ Manage ▾</b>; everything runs locally via the bridge on :3131.</div>
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
