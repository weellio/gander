# Gander — architecture, API & contributing

Internals for developers. See also: [README](../README.md) · [FEATURES.md](FEATURES.md) · [INSTALL.md](INSTALL.md) · [FAQ.md](FAQ.md).

## How the automatic wiring works

| Hook | Effect on the dashboard |
|------|-------------------------|
| `SessionStart` | Runs `bridge/launch.js` (async, 10s timeout): starts the bridge and opens the dashboard once |
| `UserPromptSubmit` | Orchestrator → thinking; a substantive prompt becomes the session's current goal |
| `PreToolUse` | Maps to no state — it is only the return channel for the operator's stop/deny command |
| `PostToolUse` | Maps the tool to a state (Read/Glob→reading, Write/Edit→coding, Bash→coding/testing, Task→spawning, …) |
| `PostToolUseFailure` | → error |
| `PermissionRequest` | Tile → awaiting; the hook parks until you Allow/Deny in the rail (590s timeout, then Claude's own prompt) |
| `Notification` | Tile → awaiting with the reason (permission_prompt / idle_prompt / elicitation); auth/complete notices are ignored |
| `SubagentStart` / `SubagentStop` | Creates a child tile (spawning) / marks it done + captures its final message (its live message streams from each sub-agent's own transcript) |
| `Stop` | Orchestrator → idle, captures the last assistant message; also delivers a queued operator message |
| `SessionEnd` | Orchestrator → idle and closed |
| `TeammateIdle` | Agent Teams: orchestrator → idle with a "teammate idle" feed line |
| `TaskCreated` / `TaskCompleted` | Agent Teams: feed lines for the shared task list (no state change) |

Every hook is `type: "command"` running `node hooks/emit.js` (see `setup/lib.js` `buildHooks` and `hooks/hooks.json`), which POSTs the raw payload to `http://localhost:3131/api/hook`; the bridge maps it to agent updates. `emit.js` also carries the command return channel (a queued operator message rides back on `Stop`, a stop request on `PreToolUse`) and captures the root + per-sub-agent last message. The one exception is `SessionStart`, which runs `bridge/launch.js` asynchronously instead of `emit.js`.

## Manual control

Use the `/agent-ops` skill, or:

```bash
node bridge/launch.js                      # start bridge + open dashboard (idempotent)
curl -s http://localhost:3131/api/state    # status
curl -s -X POST http://localhost:3131/api/reset   # clear tiles
```

### Drive it from a headless run (no plugin/hooks)

```bash
claude -p "task" --output-format stream-json --verbose | node bridge/server.js --stdin
# or let the server spawn the run itself:
node bridge/server.js --run "claude -p 'task' --output-format stream-json --verbose"
```

## File layout

```
.claude-plugin/
  plugin.json          # plugin manifest
  marketplace.json     # distribution manifest
hooks/
  hooks.json           # SessionStart launches the bridge; tool/Stop/Notification → emit.js
  emit.js              # forwards hook payloads to the bridge (+ command return channel, root + per-sub-agent message capture)
bridge/
  server.js            # zero-dep HTTP server: serves the dashboard + the event/command/inspect API
  parser.js            # stream-json → agent events (for the --stdin / --run pipeline)
  dispatch.js          # Gander Dispatch: bridge-hosted sessions (bidirectional stream-json + permission control channel)
  queue.js             # task queue: goals per project, auto-started when a slot frees
  digest.js            # ship digest: sessions + commits + spend over the last N days
  replay.js            # session replay: transcript → timeline events with cumulative cost
  fleet.js             # multi-machine hub: poll peer bridges, merge their agents, forward commands
  desktop.js           # Claude Desktop watcher: process + MCP-log + agent-mode activity (view-only tile)
  launch.js            # cross-platform idempotent launcher
  license.js           # optional Gumroad license verification
  projects.js          # project registry: discover projects + components, copy between them
  git.js               # per-project git status (branch/dirty/ahead/behind)
  usage.js             # token/cost analytics from ~/.claude transcripts
  patterns.js          # prompt-habit ("turn tax") + skill-usage mining — incrementally cached
                       #   (per-file tallies in aoc-patterns.json, revalidated by mtime+size)
  procs.js             # process attribution: real parent-chain walking with PID-reuse guards
  github.js            # PRs/issues via the gh CLI
  configmgr.js         # read/delete hooks + MCP servers in a project
  history.js           # recent resumable sessions
web/                   # Svelte 5 + Vite dashboard SOURCE
  src/App.svelte, src/lib/*.svelte, src/lib/*.js
  src/lib/{ProjectsSidebar,CostPanel,GithubPanel,SettingsPanel,HistoryPanel}.svelte  # control-center panels
  src/lib/procgroups.js  # shared server-room grouping (Office floor robots + Mosaic strip)
  -> `npm run build` outputs to dashboard/dist (what the bridge serves)
dashboard/dist/        # built dashboard (shipped)
skills/                # copied into ~/.claude (or the project's .claude) by the installer — setup/lib.js COMPONENTS
  agent-ops/           # open/restart/reset Gander from any session
  autopilot/           # run a multi-step task to completion, sub-agent per step
  component-builder/   # draft a new agent / skill / command (pairs with the New-component builder)
  context-audit/       # rank always-on context by per-turn token cost, propose trims
agents/
  component-smith.md   # clean-context specialist behind component-builder
  context-auditor.md   # clean-context specialist behind context-audit
commands/
  gander.md            # /gander — open the dashboard + report whether the bridge is running
install.js, uninstall.js   # merge/remove the hooks in settings.json (+ the components above)
```

The bridge + hooks stay small, readable Node (they run on every tool call on the user's machine); the dashboard is a compiled Svelte app.

### Develop / rebuild the dashboard

Only needed if you change the UI (`web/src`):

```bash
cd web && npm install && npm run build   # outputs to dashboard/dist (what the bridge serves)
cd web && npm run dev                    # hot-reload dev server
```

Run the zero-dependency test suite from the repo root:

```bash
node --test
```

## Event API

```
# Sessions & control
GET  /api/state           -> { agents:[...], projects:[...], muted:[...], pending:{}, budget, queue:{queued,running}, board, escalations, plans, teams, reviews, boardPosts, procs:[...], fleet, dispatch, build }   the full snapshot the WebSocket pushes
GET  /api/feed            -> { events:[...] }   last 200 feed lines (state changes, escalations, stalls)
POST /api/search          -> { q, ...filters } -> { q, results, total, scanned, projects }   full-text search across transcripts
GET  /api/inspect?session=<id>  -> { cwd, subagents, skills, agents, hooks }
GET  /api/history         -> [{ sessionId, cwd, project, startedAt, lastActive, firstPrompt, bytes, resumeCmd }]   recent sessions
POST /api/transcript      -> { sessionId } -> { ok, sessionId, cwd, project, messages, count, truncated }   read one transcript
POST /api/replay          -> { sessionId } -> { ok, sessionId, project, cwd, startedAt, endedAt, durationMs, totalTokens, totalCostUSD, events:[{t, kind, state, label, tokens, costUSD}] }
POST /api/event           -> { agentId, name?, state?, parentId?, project?, cwd?, log?, remove? }
POST /api/hook            -> raw Claude Code hook payload -> { ok, applied, deliver, pending?, requestId? }   (mapped automatically; a PermissionRequest parks a prompt for the rail)
POST /api/command         -> { sessionId | agentId:"fleet:…", type:"message"|"stop", text } -> { ok, instant?, via? }   fleet peer, Dispatch stdin, session inbox, else queued for the hook return channel
POST /api/resume-reply    -> { sessionId, text, cwd? } -> { ok, delivered:"dispatch"|"resume", busy? }   reply to a parked session via `claude -p --resume`
POST /api/wake-deliver    -> { sessionId } -> { text }   the nudge script collects the queued message
POST /api/send-to-window  -> { cwd, text } -> { ok, found, busy?, project }   type a task into the project's open window (Windows)
POST /api/sendkeys        -> { sessionId, keys } -> { ok, found, match }   keystrokes into the session window (answer prompts)
POST /api/focus-window    -> { sessionId } -> { ok, found, hadPid }   raise the session's terminal (Windows)
POST /api/drop-image      -> { sessionId, dataUrl, name?, text?, cwd? } -> { ok, path }   save to .gander/drops, queue a "Read this image" message
POST /api/launch          -> { cwd, prompt?, resume?, mode?:"terminal" } -> { ok, dispatched? }   Dispatch when on and a goal is given, else a terminal
GET  /api/statusline?cwd= -> { needsYou, queued, running, review, paused, escalations, gems }   cheap in-memory signals for the status bar
POST /api/mute            -> { project, muted } -> { ok, muted:[...] }
POST /api/reset           -> clear registry -> { ok }

# Permissions (Gander Dispatch + hook-parked prompts)
GET  /api/dispatch-config -> { enabled, sessions:[...], rateLimit, inboxDeliver, inboxes }
POST /api/dispatch-config -> { enabled?, inboxDeliver? } -> { ok, enabled, inboxDeliver }   the Dispatch on/off toggle + inbox delivery
GET  /api/permissions     -> { pending:[{sessionId, project, cwd, requestId, tool, detail, input, suggestions, ts, viaHook?}] }   Dispatch prompts + hook-parked prompts
POST /api/permissions/answer -> { sessionId, requestId, behavior:"allow"|"deny", applySuggestions?, message? } -> { ok, behavior }
GET  /api/hook-permission/wait?requestId= -> { pending } | { answered, behavior, message } | { gone }   emit.js long-polls (~25s) for the decision

# Task queue
GET  /api/queue           -> { enabled, maxSlots, worktrees, testGate, review, paused, items:[...] }
POST /api/queue           -> { cwd, prompt, doneWhen?, candidates? } -> { ok, item, ids, candidates? }   "then:" splits a chain; candidates>=2 fans out
POST /api/queue/action    -> { id, action:"cancel"|"retry"|"remove"|"clear-done"|"approve"|"request-changes", note? } -> { ok }   note rides with request-changes
GET  /api/queue/diff?id=  -> { id, status, branch, ahead, log, stat, patch, truncated }   what a held worktree branch would land
POST /api/queue-config    -> { enabled?, maxSlots?, worktrees?, testGate?, review?, telegramOnDone? } -> { ok, enabled, maxSlots, worktrees, testGate, review, telegramOnDone }

# Coordination board
GET  /api/board           -> { summary, types } · ?project=&type=&limit=&all=1 -> { project, entries, claims, types } · &view=lineage|gems -> { project, lineage | gems }
POST /api/board           -> { project, text, type?, agent?, refs?, meta? } -> { ok, entry }   an escalation also pings feed / Telegram / desktop
POST /api/board/action    -> { id, action:pin|unpin|resolve|reopen|approve|veto|release|claim-task|complete|promote|demote|remove, agent? } | { action:"clear", project } -> { ok, entry }
GET  /api/board-config    -> { inject, claudeMd }
POST /api/board-config    -> { inject?, claudeMd?:true|false } -> { ok, inject, claudeMd }   briefing inject toggle + the CLAUDE.md snippet

# Projects & components
GET  /api/projects        -> { roots, projects:[{path,name,running,skills,agents,commands,hooks,mcp}], muted }
POST /api/projects/roots  -> { action:"add"|"remove", path } -> { ok, roots }
POST /api/pick-folder     -> native folder picker (Windows); registers a project root -> { ok, path, roots } | { cancelled }
POST /api/git-status      -> { paths:[...] } -> path -> { isRepo, branch, dirty, ahead, behind, remote, lastWhen, lastMsg }
POST /api/git-action      -> { cwd, action:pull|fetch|commit-push|diff|branches|checkout|newbranch, message?, arg? } -> { ok, output }
POST /api/github          -> { cwd, kind:info|prs|issues|createPr, ... }   via the gh CLI
POST /api/open            -> { cwd, target:"folder"|"editor" } -> { ok }
POST /api/config-read     -> { cwd } -> { ok, settingsRaw, hooks, mcp, hasSettings, hasMcp }
POST /api/config          -> { cwd, action:delHook|delMcp|addMcp, name?, server? } -> { ok }
GET  /api/skills          -> { skills:[...], projects:[{name, path, global}] }   skills index across every known project + global
POST /api/copy-skill      -> { fromCwd, toCwd, skill } -> { ok, copied, to }   (older skill-only copy; prefer copy-component)
POST /api/copy-component  -> { type:skill|agent|command|hook|mcp, name, fromCwd, toCwd, overwrite? }
POST /api/component-move  -> { type?, name, fromCwd, toCwd, overwrite? } -> { ok, moved, removed } | { exists }   copy, then remove the original ("-> Global")
POST /api/component-diff  -> { type, name, fromCwd, toCwd } -> { exists, kind, ...line diff }
POST /api/component-read  -> { type, name, cwd } -> { ok, type, name, path, lang, readonly, content }
POST /api/component-write -> { cwd, path, content } -> { ok, path }   .md/.txt under the project's .claude only
POST /api/component-new   -> { type, name, targets?:[cwd|"global"], description?, model?, color?, tools?, argumentHint?, body?, overwrite? } -> { results:[...] }
POST /api/component-generate -> { type, prompt, targets? } -> { ok, session, sid }   hands the build to a live session (component-builder skill)

# Memory & CLAUDE.md
POST /api/memory-read     -> { scope:"project"|"global", cwd? } -> { ok, scope, root, memoryDir, claudeMd, index, facts:[...] }
POST /api/memory-write    -> { scope, cwd?, target:"claudemd"|"index"|"fact", file?, content } -> { ok, path }
POST /api/memory-delete   -> { scope, cwd?, file } -> { ok }   removes one fact file (never MEMORY.md)
POST /api/claudemd-audit  -> { cwd } -> { ok, exists, path, lines:[{n,status,reason,tokens}], cutTokens, additions, totalTokens, windowMax }
POST /api/claudemd-apply  -> { cwd, cuts?:[{n,text}] } -> { ok, applied, cutTokens, path, backup }   writes the trimmed CLAUDE.md (backs up to .bak)

# Cost & analytics
GET  /api/usage           -> { totals, byProject, byModel, byDay, topSessions, bySession, window5h, generatedAt, fileCount }   token/cost summary from transcripts
GET  /api/budget          -> { dailyCost, daily, session, enforce, overDaily, generatedAt }
POST /api/budget          -> { daily?, session?, enforce? } -> same shape   daily / per-session USD caps
GET  /api/digest?days=7   -> { days, generatedAt, totals, byDay, projects:[...], markdown }   ship digest
GET  /api/forensics?days=30 -> { days, waste, productivity, taskTypes, generatedAt }   re-read churn, dead MCP, productive-vs-abandoned spend
GET  /api/patterns?days=30   -> { generatedAt, days, totals, buckets, suggestions }   prompt habits: turn-tax buckets (approval/keep-alive/correction/…) + fix cards
GET  /api/skill-usage?days=30 -> { skillUsage, generatedAt, days }   per-skill invocation counts + last-used from the same cached transcript scan
GET  /api/suggestions     -> config suggestions mined from recent transcripts (hooks / skills / routines)

# Config
GET  /api/license         -> { licensed, mode:pending|unconfigured|missing|verified|invalid|offline, email?, message? }
GET  /api/health          -> { bridge:{uptimeMs, port, eventsReceived, sessions, projectsKnown, version}, doctor, hooks, plugin, env }
GET  /api/editor          -> { cmd }
POST /api/editor          -> { cmd } -> { ok, cmd }   editor command behind "Open in editor"
GET  /api/claude-config   -> { cmd, permMode, flags }
POST /api/claude-config   -> { cmd?, permMode?:acceptEdits|plan|bypass|"", flags? } -> { ok, cmd, permMode, flags }   claude CLI path + launch flags
GET  /api/nudge-config    -> { onSend, interval }
POST /api/nudge-config    -> { onSend?, interval? } -> { ok, onSend, interval }   wake parked sessions (minutes, 0 = off)
GET  /api/os-notify-config -> { enabled }
POST /api/os-notify-config -> { enabled? } | { test:true } -> { ok, enabled } | { ok, tested }   desktop toasts
GET  /api/ambient-config  -> { enabled, events, colors, awaiting, error, runaway, done, clear, lifx:{enabled, hasToken, selector} }
POST /api/ambient-config  -> { enabled?, <event>:{webhook,command,color,effect}, lifx? } | { test:<event>|"lifx", rule? } -> { ok, ... }   webhook / command / LIFX per state change

# Notifications & chat
GET  /api/telegram-config -> { configured, hasToken, chatId, dashboardUrl }
POST /api/telegram-config -> { token?, chatId?, dashboardUrl?, test? } -> { ok, configured, test? }
GET  /api/slack-config    -> { configured, url, hasAppToken, hasBotToken, channel, inbound }
POST /api/slack-config    -> { url?, appToken?, botToken?, channel?, test? } -> { ok, configured, hasAppToken, hasBotToken, inbound }   webhook out + Socket Mode in
GET  /api/routines        -> { routines:[...], briefings:[...] }
POST /api/routines        -> { id?, name, cwd, prompt, permMode?, schedule:"HH:MM", enabled, notify, timeoutSec } -> { ok, routine }   create / update a scheduled headless run
POST /api/routines/delete -> { id } -> { ok }
POST /api/routines/run    -> { id } -> { ok, started }   run a routine now
GET  /api/briefings       -> { briefings:[...] }   last 80 routine outputs
POST /api/briefings/delete -> { id } -> { ok }
POST /api/briefings/clear -> { ok }

# Fleet & peers
GET  /api/fleet-config    -> { peers:[{name, url, hasToken}], intervalMs, status:[{name, url, online, lastSeenMs, agentCount, error}] }
POST /api/fleet-config    -> { peers:[{name, url, token?}], intervalMs? } -> { ok, intervalMs, peers }   a blank token keeps the saved one
GET  /api/peers           -> { peers:[{pid, sessionId, cwd, name, kind, entrypoint, startedAt, version, inbox}], inboxDeliver }   Claude Code's own session registry
GET  /api/teams           -> { teams:[...] }   Agent Teams read from ~/.claude/teams + tasks

# Misc
GET  /api/processes       -> { processes:[...], generatedAt }   attributed long-running / port-holding processes (shared cache with /api/state's procs; Windows)
POST /api/kill-process    -> { pid } -> { ok, output }   (taskkill /T /F; refuses the bridge's own pid)
POST /api/focus-pid       -> { pid } -> { ok, output }   raise a background process's window (Windows)
```

States: `idle · thinking · coding · spawning · reading · testing · error · done · awaiting`.

## Platform support & contributing

Gander is developed and exercised daily on **Windows**. The dashboard, bridge, and all the data features (projects, usage, GitHub, history, routines/briefings) are plain Node + browser and should work anywhere. The **OS-specific surface is the window automation** — launching sessions and typing into them:

| What | Windows | macOS | Linux |
|------|---------|-------|-------|
| Launch a session (▶ Start / ＋ New task) | `cmd` + captured window PID | `osascript` (Terminal) | `x-terminal-emulator` |
| Idle nudge / ⌨ quick-keys (type into a session window) | WScript + PID/title | `osascript` keystrokes | `xdotool` |
| Open folder / editor | ✓ | `open` | `xdg-open` |
| Audio (TTS + voice input) | browser Web Speech | browser Web Speech | browser Web Speech |

**On macOS or Linux? Please give it a spin and open issues/PRs** — that's the fastest way to make it solid everywhere. The window-automation scripts (`scripts/nudge-idle.sh`, `scripts/sendkeys.sh`) and the launch/open paths in `bridge/server.js` are the most likely places to need a tweak. Bug reports, "it didn't work on my distro" notes, and PRs are all welcome. 🙏
