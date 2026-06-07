# Hivemind

> *Agent Ops Center* — a NOC for everything your Claude Code agents are doing.

A live, animated dashboard of your **Claude Code agents and sub-agents** — a Hollywood-Squares / Zoom-style grid where each agent is a pixel-art avatar that physically acts out what it's doing: thinking, reading, coding, spawning sub-agents, running tests, erroring, idling. Parent and child agents are linked with curved connectors carrying **animated packets that flow downward** to show information moving through the hierarchy.

It attaches to any project automatically via Claude Code **hooks** — no manual wiring once installed.

![states: idle · thinking · coding · spawning · reading · testing · error · done](dashboard/index.html)

## What you get

- **Live agent tiles** — one per session/sub-agent, driven by real tool activity.
- **Persistent Orchestrator root** — the main session is always present (idle when quiet) as the root of the tree.
- **Recursive hierarchy view** — connectors from each agent to its sub-agents at any depth, with subtree hover-highlight and animated parent→child flow.
- **3 avatar tiers** — pixel art (procedural Canvas), abstract (waveforms/EQ/rings), and GIF (your own).
- **5 grid layouts** — Solo, Squad, War Room, Broadcast, Mosaic.

## Install

**Requirements:** [Node.js](https://nodejs.org) and Claude Code.

### Quick install (recommended)

From the Hivemind folder:

```
node install.js            # global: every Claude session on this machine reports in
node install.js --project  # only sessions started in the current folder
```

This merges Hivemind's hooks into your Claude Code `settings.json` (without touching your other settings) and computes all paths automatically. Then, in any open session run `/hooks` (or restart) to load them.

To remove it completely:

```
node uninstall.js          # or: node uninstall.js --project
```

### Alternative: as a Claude Code plugin

```
/plugin marketplace add <this-repo-or-path>
/plugin install hivemind@hivemind
```

Either way, on your next session the `SessionStart` hook starts the bridge and opens the dashboard at `http://localhost:3131/`. As Claude works, tiles light up automatically — and you can **send messages or stop** any session right from its tile.

### How the automatic wiring works

| Hook | Effect on the dashboard |
|------|-------------------------|
| `SessionStart` | Launches the bridge (`bridge/launch.js`) and opens the dashboard once |
| `UserPromptSubmit` | Orchestrator → thinking |
| `PostToolUse` | Maps the tool to a state (Read/Glob→reading, Write/Edit→coding, Bash→coding/testing, Task→spawning, …) |
| `PostToolUseFailure` | → error |
| `SubagentStart` / `SubagentStop` | Creates a child tile (spawning) / marks it done |
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

## Architecture

```
.claude-plugin/
  plugin.json          # plugin manifest
  marketplace.json     # distribution manifest
hooks/
  hooks.json           # SessionStart (command) + event hooks (http) → the bridge
bridge/
  server.js            # zero-dep HTTP server: serves dashboard, /api/state, /api/event, /api/hook
  parser.js            # stream-json → agent events (for the --stdin / --run pipeline)
  launch.js            # cross-platform idempotent launcher
dashboard/
  index.html           # the dashboard (vanilla JS + Canvas)
  src/
    themes.js, layout.js          # 5 grid layout presets + switcher
    abstract-avatar.js            # abstract avatar tier
    gif-avatar.js                 # GIF avatar tier
    hierarchy.js                  # recursive connectors + animated flow
skills/
  agent-ops/SKILL.md   # manual control skill
```

### Event API

```
GET  /api/state   -> { agents: [ { id, name, state, parentId?, root?, logLines } ] }
POST /api/event   -> { agentId, name?, state?, detail?, parentId?, log?, remove? }
POST /api/hook    -> raw Claude Code hook payload (mapped automatically)
POST /api/reset   -> clear registry (keeps the root Orchestrator)
```

States: `idle · thinking · coding · spawning · reading · testing · error · done`.

## Configuration

- **Port** — default `3131`; set `AOC_PORT` and update the URLs in `hooks/hooks.json`.
- **Your own GIFs** — drop files in `dashboard/assets/avatars/` and list them in `dashboard/assets/avatars/manifest.json`, or set `window.AOC_GIFS` in the page.

## License

MIT
