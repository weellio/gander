# Gander — architecture, API & contributing

Internals for developers. See also: [README](../README.md) · [FEATURES.md](FEATURES.md) · [INSTALL.md](INSTALL.md) · [FAQ.md](FAQ.md).

## How the automatic wiring works

| Hook | Effect on the dashboard |
|------|-------------------------|
| `SessionStart` | Launches the bridge (`bridge/launch.js`) and opens the dashboard once |
| `UserPromptSubmit` | Orchestrator → thinking |
| `PostToolUse` | Maps the tool to a state (Read/Glob→reading, Write/Edit→coding, Bash→coding/testing, Task→spawning, …) |
| `PostToolUseFailure` | → error |
| `SubagentStart` / `SubagentStop` | Creates a child tile (spawning) / marks it done + captures its final message (its live message streams from each sub-agent's own transcript) |
| `Stop` / `SessionEnd` | Orchestrator → idle |

All event hooks are `type: "http"` posting to `http://localhost:3131/api/hook`, which maps the raw payload to agent updates — cross-platform, no scripts.

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
skills/
  agent-ops/SKILL.md   # manual control skill
install.js, uninstall.js   # merge/remove the hooks in settings.json
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
GET  /api/state      -> { agents:[...], projects:[...], muted:[...], pending:{}, procs:[...] }
GET  /api/license    -> { licensed, mode, ... }
GET  /api/inspect?session=<id>  -> { cwd, subagents, skills, agents, hooks }
POST /api/event      -> { agentId, name?, state?, parentId?, project?, cwd?, log?, remove? }
POST /api/hook       -> raw Claude Code hook payload (mapped automatically)
POST /api/command    -> { sessionId, type:"message"|"stop", text }   (delivered via hook return channel)
POST /api/mute       -> { project, muted }
POST /api/reset      -> clear registry

# Control center
GET  /api/projects        -> { roots, projects:[{path,name,running,skills,agents,commands,hooks,mcp}] }
POST /api/projects/roots  -> { action:"add"|"remove", path }
POST /api/pick-folder     -> native folder picker (Windows); registers a project root
POST /api/copy-component  -> { type:skill|agent|command|hook|mcp, name, fromCwd, toCwd, overwrite? }
POST /api/git-status      -> { paths:[...] } -> path -> { branch, dirty, ahead, behind, remote, lastWhen }
POST /api/git-action      -> { cwd, action:pull|fetch|commit-push, message? }
POST /api/launch          -> { cwd, resume? }   (opens a terminal running claude)
POST /api/open            -> { cwd, target:"folder"|"editor" }
GET  /api/usage           -> token/cost summary from transcripts
POST /api/github          -> { cwd, kind:info|prs|issues }
POST /api/config-read     -> { cwd } -> { hooks, mcp, settingsRaw, ... }
POST /api/config          -> { cwd, action:delHook|delMcp|addMcp, name }
GET  /api/history         -> recent sessions [{ sessionId, project, firstPrompt, resumeCmd, ... }]
POST /api/claudemd-audit  -> { cwd } -> { lines:[{n,status,reason,tokens}], additions, cutTokens }
POST /api/claudemd-apply  -> { cwd, cuts:[{n,text}] } -> writes the trimmed CLAUDE.md (backs up to .bak)
GET  /api/suggestions     -> config suggestions mined from recent transcripts (hooks / skills / routines)
GET  /api/patterns?days=30   -> prompt habits: turn-tax buckets (approval/keep-alive/correction/…) + fix cards
GET  /api/skill-usage        -> per-skill invocation counts + last-used from the same cached transcript scan
GET  /api/processes       -> attributed long-running / port-holding processes (shared cache with /api/state's procs)
POST /api/kill-process    -> { pid }   (taskkill /T /F)

# Gander Dispatch (bridge-hosted sessions)
GET  /api/dispatch-config -> { enabled, sessions:[...], rateLimit }
POST /api/dispatch-config -> { enabled }                    (the on/off toggle)
GET  /api/permissions     -> { pending:[{sessionId, requestId, tool, detail, input, suggestions}] }
POST /api/permissions/answer -> { sessionId, requestId, behavior:"allow"|"deny", applySuggestions? }

# Task queue
GET  /api/queue           -> { enabled, maxSlots, items:[...] }
POST /api/queue           -> { cwd, prompt }                (enqueue a goal)
POST /api/queue/action    -> { id, action:"cancel"|"retry"|"remove"|"clear-done" }
POST /api/queue-config    -> { enabled?, maxSlots?, telegramOnDone? }

# Ship digest
GET  /api/digest?days=7   -> { totals, byDay, projects:[...], markdown }

# Session replay
POST /api/replay          -> { sessionId } -> { events:[{t, kind, state, label, tokens, costUSD}], totals... }

# Fleet (multi-machine hub)
GET  /api/fleet-config    -> { peers:[{name, url, hasToken}], intervalMs, status:[...] }
POST /api/fleet-config    -> { peers:[{name, url, token?}], intervalMs? }
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
