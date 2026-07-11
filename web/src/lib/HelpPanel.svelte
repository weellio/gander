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
        ['Resizable panels', 'Every side panel (the Manage drawers + Settings) is resizable — hover the left edge for the ↔ grip and drag. The width is shared and remembered across reloads.'],
      ],
    },
    {
      title: 'Click an agent',
      items: [
        ['Current task / live message', 'What the agent is doing and its latest message. Sub-agents stream their message live as they work (not just at finish); root sessions update at the end of each turn.'],
        ['💬 Conversation', 'Toggle a live chat view of the whole session — read every turn as it happens, straight from the transcript on disk. Costs nothing (no model calls, just reads the file), so you can follow a session without its terminal open.'],
        ['Reply · Stop', 'Send a message or task to a running session, or stop it at its next tool. On a ⚡ dispatched session both are instant — the reply goes straight down the session\'s stdin and Stop interrupts the current turn.'],
        ['🔐 Allow / Deny (dispatch)', 'When a bridge-hosted session needs permission for a tool, the request shows as a card with the tool + exact input and Allow / Allow-&-don\'t-ask-again / Deny buttons — no terminal, works from your phone. Also inline in the 🔔 Needs-you rail.'],
        ['⤳ Resume (no terminal)', 'For a clocked-out session with no open window: type a reply and it resumes the session headlessly — a real turn on your own claude login (plan quota, no API key injected). Explicit + warned, because resuming a session whose terminal is still open can corrupt the conversation (use Send then).'],
        ['💰 Session cost', 'Live estimated spend for that session.'],
        ['📊 Analytics', 'Per-session efficiency gauges from the transcript: cache-hit % (context reused vs re-sent), output-cost share (verbose vs context bulk), and a context-window bar. A parked, near-full session shows a “Compact now” nudge that types /compact to free context.'],
        ['🔍 Audit CLAUDE.md', 'A before/after diff for your CLAUDE.md. 🔒 Flags pasted secrets (remove + rotate); red-cuts lines pointing at files that don’t exist plus generic boilerplate; ambers possibly-stale prose (old to-dos, planning sections, dated notes, moved paths). Compact-proof — it checks files on disk, not the transcript. Shows the tokens each costs every turn and suggests additions (undocumented npm scripts, frameworks, config). Tick/untick each flagged line, then Apply to write the trimmed file (backed up to CLAUDE.md.bak). Guardrails, commands, real files, and prose are kept.'],
        ['📄 Transcript', 'Read the full conversation of the session.'],
        ['⏪ Replay', 'Scrub the session on a timeline: a color strip of its states, playback (10–120×), what tool ran when, and cumulative tokens/cost at every moment. Also from Session history. Pure transcript reads — costs nothing.'],
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
        ['▶ Start', 'Launch a NEW Claude session in a fresh terminal there — optionally seeded with a task. (Always a new window, never your existing one.)'],
        ['↪ Send to open', 'Type the task into an ALREADY-OPEN window for this project instead of starting a duplicate — handy when a session went idle / clocked out but its VS Code window is still up. Only fires when exactly one window matches (never a guess), and is blocked if a session there is actively working.'],
        ['Pull · Diff · Branches · Commit & Push', 'Full source-control inline: view the diff, switch/create branches, and commit + push.'],
      ],
    },
    {
      title: 'Manage ▾ — more panels',
      items: [
        ['Usage / cost', 'Token & cost analytics from your transcripts: totals, 30-day chart, per-project/model, priciest sessions.'],
        ['GitHub', 'Open PRs & issues per project (★ stars · ⑂ forks), click to open in the browser, and create a pull request.'],
        ['App configuration', 'Settings ▾ → App configuration: the app-wide stuff — Telegram, cost budget, new-session options, idle nudge, editor command (live, no restart).'],
        ['📋 Task queue', 'Line up goals per project; the bridge starts the next one the moment a slot frees (default 2 slots, never two tasks in one project, never on top of a busy session). Runs via Dispatch when it\'s on (precise completion) or terminal launches when it\'s off. Done/failed tasks hit the feed + ambient alerts; failures ping Telegram. Queue from ＋ New task’s 📋 Queue button too.'],
        ['📰 Ship digest', '“What actually got done”: sessions + recent goals per project (from transcripts) and commits in range (from git), over 7/14/30 days, with a copy-as-markdown button. Deterministic — no model calls.'],
        ['Routines & briefings', 'Save reusable prompts (that can call skills/MCP), Run now or schedule daily. They run headlessly and post their output as a “briefing” — a morning brief, a nightly digest, etc. A fresh one greets you with a card.'],
        ['Session history', 'Recent sessions across all projects with their first prompt — View the transcript or ▶ Resume any one.'],
        ['Search', 'Search across every session transcript + project — find which session touched a file or topic, then open it.'],
        ['Activity feed', 'A live chronological ticker of agent events, with an errors-only filter to spotlight failures.'],
        ['Memory', 'View & edit what Claude remembers — the CLAUDE.md it loads every session (global or per project) and the .claude/memory/*.md fact store (read, edit, delete each). Per-project from a project’s 📝 Memory button too.'],
        ['Processes (stuck open?)', 'Long-running / port-holding processes your sessions spawned (dev servers, node, python…). Spot one left running and Kill it (force-kills the tree). Each agent’s modal also lists what that session left open. Windows-only for now.'],
        ['🧩 Skills (all projects)', 'One table of every skill across your projects + global ~/.claude, each with its one-line summary (read from its SKILL.md) and a Used·30d column — real invocation counts from your transcripts. A "never"-used skill still costs context every session (delete it?); a hot per-project skill is a → Global candidate. Copy a skill to another project, or move a broadly-useful one → Global — and spot redundant per-project copies of a skill that\'s already global. Filter box up top.'],
        ['💡 Tune (habits & suggestions)', 'Two mirrors held up to your last 30 days of transcripts. Prompt habits shows YOUR turn tax — turns spent only approving ("yes", "go"), poking quiet sessions ("still going?"), correcting a false "done", or hand-pasting errors — each habit with a copy-paste fix (e.g. a CLAUDE.md standing-authorization line). Repeated work finds what Claude keeps redoing and proposes the hook / /command / routine that removes it. Deterministic counts; nothing is auto-written.'],
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
        ['🔔 Needs you', 'The bell (top-right) is a triage rail across every session: who needs input (with the reason + how long they’ve waited), who errored, who went quiet mid-goal, who finished. Answer an awaiting prompt inline with the quick-keys (1/2/3 · ↑↓ · y/n · ↵ · esc), or Open the agent / Find it on the floor. The badge turns red when a human is actually needed.'],
        ['💤 Went quiet mid-goal', 'A session with a stated goal that ended its turn on a question and has sat idle (default 3 min) is flagged in the 🔔 rail — it’s waiting on an answer, not done, so you never have to type “still going?” again. Answer with the quick-keys or a reply; the bridge also pops one desktop toast per stall. Tune with stallMinutes in bridge/aoc-config.json (0 = off).'],
        ['🖥️ Desktop alerts (no browser)', 'Settings → App configuration → Desktop alerts: the bridge itself pops a native OS notification (Windows toast / macOS / Linux) on needs-you, error, or runaway cost — even with the dashboard closed. Built for terminal users who live in the CLI (e.g. claude agents) but still want a ping when they step away. Has a Test button; works alongside the light/Telegram alerts.'],
        ['💡 Ambient alerts (smart light)', 'Settings → App configuration → Ambient alerts: fire a webhook and/or shell command on each scenario — needs-you, error, runaway cost, task done, all-clear — so a smart light signals it across the room. Pick any colour + pattern (blink / pulse / strobe / rainbow) per scenario, each with a live preview swatch (the visual legend) and a Test button. Built-in LIFX support drives a bulb directly (paste a token — no hub), or wire the webhook/command to Home Assistant / IFTTT / Govee / a script. The bulb is optional; the webhook fires regardless.'],
        ['🖥 Claude Desktop tile', 'If the Anthropic desktop app is installed, a view-only tile appears automatically: running/closed, live MCP tool calls (from its local logs, with tool names), agent-mode activity. Conversations live on claude.ai so there\'s no reply channel — but you can see it\'s busy. Disable via desktopWatch:false in bridge/aoc-config.json. (Claude in Chrome leaves no local trace — verified — so it can\'t get a tile yet.)'],
        ['🖥 Fleet — other machines', 'Settings → App configuration → Fleet: add peer bridges (name + URL + their access token) and their agents appear on THIS floor with a 🖥 machine badge; replies/stops are forwarded to the owning machine. Set each peer\'s accessToken + allowRemote first (docs/REMOTE.md; Tailscale recommended).'],
        ['📱 On your phone', 'Gander installs as a PWA (add to home screen → standalone app). Safe recipe: access token + allowRemote + Tailscale, open http://<machine>:3131/?token=… once, then install. Full walkthrough in docs/REMOTE.md. Pings still come via Telegram.'],
        ['⚡ Gander Dispatch', 'Settings → App configuration → Gander Dispatch: host sessions IN the bridge (bidirectional stream-json) instead of terminal windows. Instant replies, dashboard-native permission Allow/Deny, phone-friendly. Toggle off anytime to go back to the classic terminal launch + window automation — or per-launch with “open a terminal window instead” in ＋ New task. Uses your own claude login (plan quota, no API key); hosted sessions still write normal transcripts.'],
        ['Status bar', 'Today’s + total spend is always visible — plus a ⚡ 5h chip: spend that landed in the current five-hour window (what subscription plans meter on), with the window’s real reset time once a dispatched session has reported it. Turns red if the CLI reports the plan limit hit.'],
        ['Telegram', 'Get pinged when a session is waiting, and reply or /stop from your phone.'],
        ['Theme', 'Switch colour themes and background.'],
      ],
    },
    {
      title: 'FAQ / good to know',
      items: [
        ['▶ Start vs ↪ Send to open vs Reply?', '▶ Start / ＋ New task = always a NEW session in a fresh terminal. ↪ Send to open (Projects) = type a task into an already-open window for that project (a session that went idle but its window\'s up), only when one window uniquely matches, blocked if it\'s busy. Reply (on a tile) = a session still tracked. With multiple VS Code windows, replies/quick-keys hit the right one or wait — never the wrong window.'],
        ['Why not just use `claude agents` / agent teams?', 'Use them together — Gander doesn’t replace them. `claude agents` is a terminal list of your sessions, good while you’re at the keyboard. Gander adds what it can’t: it reaches you when you’ve stepped away (desktop toast, phone, a smart light) so you don’t have to watch, and it’s a control center for your whole setup — CLAUDE.md health + secrets, cost/runaway, stuck processes, every project’s skills/MCP/hooks, memory. Agent teams is experimental, off by default, with state that’s deleted when the session ends and an API still changing, so we wait to build its view against real, stable data rather than guess at a moving schema. When it settles it’ll show up like sub-agents do — hook-driven and verified.'],
        ['What is ⚡ Gander Dispatch — and is it plan-quota?', 'Dispatch runs a session inside the bridge over Claude Code\'s bidirectional stream-json instead of a terminal window. Everything gets first-class: instant replies, structured permission prompts (real Allow/Deny buttons with the exact tool input), turn results, even live rate-limit info. It spawns your own claude CLI with your own login — plan quota, no API key involved, exactly like typing in a terminal. Toggle in Settings; when off (or per-launch), the classic terminal method is fully intact.'],
        ['“Waiting on you” but I can’t see the options?', 'For TERMINAL sessions: Claude Code draws numbered prompts (plan approval, menus) in the terminal TUI, and no hook carries the choices — we checked the whole hooks API (Notification, PreToolUse, PermissionRequest, Elicitation); they can approve/deny or say a prompt appeared, but never expose the option text. So Gander can’t render the menu — open the session (Open in VS Code) to read it, then answer with the ⌨ quick-keys. For ⚡ DISPATCHED sessions this problem is gone: permission requests arrive as structured data and render as Allow/Deny buttons with the exact tool + input.'],
        ['Answering prompts (⌨ quick-keys)', 'The ⌨ row in an agent’s modal types a keystroke into that session’s window (1/2/3 · ↑/↓ · ↵ · y/n · Esc). Gander finds the window by the PID it captured at launch (▶ Start / ＋ New task) or by project name in the title (VS Code). A session you opened manually in a bare terminal (titled “Claude Code”) may not be reachable — the flash says so. It steals focus and types into whatever’s focused there, so keep the Claude terminal focused.'],
        ['“’claude’ is not recognized” on ▶ Start', 'Your claude CLI isn’t on PATH. Set its full path in Settings → New session options (find it with where claude / which claude).'],
        ['“Trust this folder?” on Start / New task', 'Launching opens a fresh terminal, so Claude shows its one-time, per-folder trust prompt — choose “Yes”. It’s remembered after you accept once (you don’t see it from VS Code because the folder’s already trusted there).'],
        ['Skip permission prompts', 'Settings → New session options → “skip ALL prompts” launches with --dangerously-skip-permissions, so Claude won’t ask before edits/commands. Only use it on projects you trust.'],
        ['Sub-agents show no dollar amount', 'Cost is tracked per session (one transcript). A sub-agent’s spend is part of its parent session, so only the session (root) carries the figure.'],
        ['Why does a session show “$X/min”?', 'Spend is estimated from token counts at API list prices — on a Max/subscription plan you aren’t literally paying that. Treat it as a relative “spending fast” signal.'],
        ['Replies aren’t instant', 'For terminal sessions, replies are queued and delivered when the session next runs a turn — turn on Settings → App configuration → Wake idle sessions to nudge a parked session. For ⚡ dispatched sessions, replies deliver instantly (straight down the session’s stdin).'],
        ['Routine email/calendar didn’t work', 'Routines run headlessly (claude -p). Interactively-authenticated MCP (claude.ai Gmail/Calendar connectors) often isn’t available unattended; skills and token-based MCP are fine. Use Run now to see what’s available, and keep briefing routines read-only.'],
        ['Gander inside VS Code', 'A thin extension (vscode-extension/ in the repo) adds a goose icon to VS Code’s Activity Bar — click it to dock this dashboard in the sidebar next to your code (↻ reload / ↗ open-as-tab in its title bar), or use the 🚀 status-bar button / “Gander: Open Dashboard” command for a full editor tab. Same dashboard, same bridge — nothing forked; it can even autostart the bridge. Install its .vsix (Extensions → ⋯ → Install from VSIX…) or press F5 in that folder to develop.'],
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
