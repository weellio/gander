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
        ['Current task / live message', 'What the agent is doing and its latest message. Sub-agents stream their message live as they work (not just at finish); root sessions update at the end of each turn.'],
        ['Reply · Stop', 'Send a message or task to a running session, or stop it at its next tool.'],
        ['💰 Session cost', 'Live estimated spend for that session.'],
        ['📊 Analytics', 'Per-session efficiency gauges from the transcript: cache-hit % (context reused vs re-sent), output-cost share (verbose vs context bulk), and a context-window bar. A parked, near-full session shows a “Compact now” nudge that types /compact to free context.'],
        ['🔍 Audit CLAUDE.md', 'A before/after diff for your CLAUDE.md. 🔒 Flags pasted secrets (remove + rotate); red-cuts lines pointing at files that don’t exist plus generic boilerplate; ambers possibly-stale prose (old to-dos, planning sections, dated notes, moved paths). Compact-proof — it checks files on disk, not the transcript. Shows the tokens each costs every turn and suggests additions (undocumented npm scripts, frameworks, config). Tick/untick each flagged line, then Apply to write the trimmed file (backed up to CLAUDE.md.bak). Guardrails, commands, real files, and prose are kept.'],
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
        ['Memory', 'View & edit what Claude remembers — the CLAUDE.md it loads every session (global or per project) and the .claude/memory/*.md fact store (read, edit, delete each). Per-project from a project’s 📝 Memory button too.'],
        ['Processes (stuck open?)', 'Long-running / port-holding processes your sessions spawned (dev servers, node, python…). Spot one left running and Kill it (force-kills the tree). Each agent’s modal also lists what that session left open. Windows-only for now.'],
        ['💡 Tune (suggestions)', 'Mines your recent session transcripts for repeated work and suggests config that removes it — a PostToolUse hook for a command you keep running after edits (with a copy-paste JSON snippet), or a /command / routine for a prompt you keep typing. Deterministic counts; nothing is auto-written.'],
        ['Health / status', 'Confirm Gander is wired up: bridge uptime/events, hook-install checklist, node/platform.'],
      ],
    },
    {
      title: 'Options & alerts',
      items: [
        ['Conserve tokens', 'Gander sends almost nothing to the model itself — the real per-turn cost is the MCP servers / skills a project loads. Trim them per project: Manage → Projects → expand a project → MCP servers.'],
        ['Audit your context', 'Install ships a context-audit skill — in any session just ask “audit my context” or “trim my CLAUDE.md”. It reads each session’s cache-hit / context-fill, ranks what’s re-sent every turn (CLAUDE.md, MCP tool schemas, skills, memory), and proposes concrete cuts + a leaner CLAUDE.md.'],
        ['Cost budget', 'Set a daily / per-session spend cap (Settings → App configuration) — banner + Telegram alert when crossed. Turn on Enforce to make it a hard stop: a session over its cap is Stopped at its next tool; crossing the daily cap stops every active session.'],
        ['Performance toggles', 'Alert sound, desktop notifications, auto-refresh cost, fast agent updates, and office animations.'],
        ['🔔 Needs you', 'The bell (top-right) is a triage rail across every session: who needs input (with the reason + how long they’ve waited), who errored, who finished. Answer an awaiting prompt inline with the quick-keys (1/2/3 · ↑↓ · y/n · ↵ · esc), or Open the agent / Find it on the floor. The badge turns red when a human is actually needed.'],
        ['🖥️ Desktop alerts (no browser)', 'Settings → App configuration → Desktop alerts: the bridge itself pops a native OS notification (Windows toast / macOS / Linux) on needs-you, error, or runaway cost — even with the dashboard closed. Built for terminal users who live in the CLI (e.g. claude agents) but still want a ping when they step away. Has a Test button; works alongside the light/Telegram alerts.'],
        ['💡 Ambient alerts (smart light)', 'Settings → App configuration → Ambient alerts: fire a webhook and/or shell command on each scenario — needs-you, error, runaway cost, task done, all-clear — so a smart light signals it across the room. Pick any colour + pattern (blink / pulse / strobe / rainbow) per scenario, each with a live preview swatch (the visual legend) and a Test button. Built-in LIFX support drives a bulb directly (paste a token — no hub), or wire the webhook/command to Home Assistant / IFTTT / Govee / a script. The bulb is optional; the webhook fires regardless.'],
        ['Status bar', 'Today’s + total spend is always visible.'],
        ['Telegram', 'Get pinged when a session is waiting, and reply or /stop from your phone.'],
        ['Theme', 'Switch colour themes and background.'],
      ],
    },
    {
      title: 'FAQ / good to know',
      items: [
        ['Why not just use `claude agents` / agent teams?', 'Use them together — Gander doesn’t replace them. `claude agents` is a terminal list of your sessions, good while you’re at the keyboard. Gander adds what it can’t: it reaches you when you’ve stepped away (desktop toast, phone, a smart light) so you don’t have to watch, and it’s a control center for your whole setup — CLAUDE.md health + secrets, cost/runaway, stuck processes, every project’s skills/MCP/hooks, memory. Agent teams is experimental, off by default, with state that’s deleted when the session ends and an API still changing, so we wait to build its view against real, stable data rather than guess at a moving schema. When it settles it’ll show up like sub-agents do — hook-driven and verified.'],
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
      <div class="foot">Tip: press <kbd>/</kbd> (or click <b>🔍 Jump</b>) for the command palette — jump to any panel or fly to any agent by name. Panels open from <b>⚙ Manage ▾</b> and are <b>drag-resizable</b> from their left edge (the width is remembered). Everything runs locally via the bridge on :3131.</div>
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
