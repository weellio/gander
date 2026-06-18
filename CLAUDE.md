# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Ops Center — Claude Code Project

## Project Overview

A real-time visual dashboard that displays Claude Code sub-agents as animated avatar tiles in a Hollywood Squares / Zoom-style grid. Each agent has a personality avatar that physically acts out what it's doing (thinking, coding, spawning sub-agents, reading, testing, erroring, idle).

## Current State (read first)

Gander is **built and shipping** — a Svelte 5 dashboard (`web/`, built into `dashboard/dist/`), a zero‑dependency Node bridge (`bridge/`), Claude Code hooks (`hooks/`), and a `node --test` suite (`test/`). See **[README.md](README.md)** for what it does and how to install. The detailed file tree and code samples further down are from the **original design spec** and may not match the shipped code one‑to‑one — trust the actual files + the README.

**Working in this repo** (Windows/PowerShell shown; on macOS/Linux swap `start`→`open`/`xdg-open`):

```powershell
cd web; npm install; npm run build     # build the dashboard -> dashboard/dist/ (what the bridge serves)
cd web; npm run dev                     # hot-reload dev server
node bridge/server.js --port 3131       # the zero-dep bridge on :3131
node --test                             # run the test suite (zero deps)
node install.js                         # merge the global Claude Code hooks (or: --project)
```

After editing anything in `web/src/`, run `npm run build` in `web/` so the served `dashboard/dist/` is current.

## Architecture

```
claude-agent-ops/
├── dashboard/          # Frontend — browser-based ops center
│   ├── index.html
│   ├── src/
│   │   ├── grid.js         # Layout engine (Hollywood Squares, War Room, etc.)
│   │   ├── avatar.js       # Avatar renderer (pixel art, GIF, abstract)
│   │   ├── socket.js       # WebSocket client
│   │   └── themes.js       # Grid layout presets
│   └── assets/
│       ├── avatars/        # Pixel art spritesheets + curated GIFs
│       └── sounds/         # Optional subtle audio cues
├── bridge/             # Node.js local server
│   ├── server.js           # WebSocket server + Claude Code stdout parser
│   ├── parser.js           # Event pattern matching → agent state
│   └── agent-registry.js   # Tracks active agents and their states
├── CLAUDE.md           # This file
└── memory.md           # Project memory and decisions log
```

## Tech Stack

- **Dashboard**: Vanilla JS + CSS (no framework — keep it fast and portable)
- **Bridge server**: Node.js with `ws` (WebSocket) and `chokidar` (file watching)
- **Avatar rendering**: HTML5 Canvas for pixel art sprites; `<img>` tags for GIFs
- **Claude Code integration**: Parse `claude` CLI stdout via child_process or pipe

## Agent States & Visual Mappings

| State      | Trigger (Claude Code event)           | Avatar behavior                        |
|------------|---------------------------------------|----------------------------------------|
| `idle`     | Agent initialized, waiting            | Z's floating, slouched posture         |
| `thinking` | Reading context, no tool call yet     | `?` bubble, ellipsis dots              |
| `coding`   | `write_file`, `str_replace_based_edit`| Typing animation, code on screen       |
| `reading`  | `read_file`, `list_files`             | Holding document, eyes tracking        |
| `spawning` | `Task` tool invoked (sub-agent)       | Holding phone, typing bubbles          |
| `running`  | `bash`, `execute_command`             | Hammering keyboard, terminal flicker   |
| `testing`  | Test file detected, assertions        | ✓/✗ alternating above head            |
| `searching`| `web_search`, `grep`                  | Hand over eyes, scanning left-right    |
| `error`    | Non-zero exit, exception detected     | Arms up, `!!` sparks                   |
| `done`     | Agent task complete                   | Thumbs up, celebration                 |

## Grid Layout Presets

- **Solo Focus** — 1 large tile, full width. Best for single-agent work.
- **Squad** — 2×2 grid. Default for small multi-agent tasks.
- **War Room** — 3×2 grid. For larger parallel workloads.
- **Broadcast** — 1 hero tile (large, left) + 4 small tiles (right column). Orchestrator + workers.
- **Mosaic** — Auto-flowing responsive grid. Grows as agents spawn.

## Avatar Tiers

1. **Pixel Art** — Canvas-rendered sprites, ~48×48px logical size (scaled up). Fully animated via requestAnimationFrame. State-driven pose changes.
2. **GIF** — User-supplied or curated set. CSS class overlays convey state (color tint, badge, border pulse).
3. **Abstract** — Animated geometric shapes / waveforms. Minimal, signal-focused.

Users select avatar type per-agent or set a global default.

## Claude Code Bridge — Parsing Strategy

Claude Code outputs structured JSON when run with output flags. Parse events:

```js
// Key patterns to detect in stdout stream
const EVENT_PATTERNS = {
  thinking:  /^\s*$/,                                    // empty lines between tool calls
  coding:    /tool.*?(write_file|str_replace)/i,
  reading:   /tool.*?(read_file|list_files|ls)/i,
  running:   /tool.*?(bash|execute|run)/i,
  spawning:  /tool.*?Task/i,
  searching: /tool.*?(grep|search|find)/i,
  error:     /(error|exception|failed|non-zero)/i,
  done:      /task.*(complete|finished|done)/i,
};
```

Use `claude --output-format stream-json` if available, otherwise tail stdout.

## WebSocket Protocol

Messages from bridge → dashboard:

```json
{ "type": "agent_update", "agentId": "agent-1", "state": "coding", "detail": "writing parser.js" }
{ "type": "agent_spawn",  "agentId": "agent-2", "parentId": "agent-1", "name": "FileIndexer" }
{ "type": "agent_done",   "agentId": "agent-2", "result": "success" }
{ "type": "log",          "agentId": "agent-1", "line": "Reading 42 files..." }
```

## Development Commands

These are the intended commands once the code exists. Written for **Windows PowerShell** (the dev environment); swap `start` for `open` / `xdg-open` on macOS/Linux.

```powershell
# Install bridge dependencies
npm install --prefix bridge

# Start bridge server (connects to Claude Code)
node bridge/server.js --port 3131

# Open dashboard (static file)
start dashboard/index.html
# or serve it: npx serve dashboard -p 3000

# Run Claude Code with bridge (pipe stdout into the parser)
claude code --output-format stream-json | node bridge/server.js
```

## Design Principles

- **Zero latency feel** — avatar state changes must be instant, no debounce on transitions
- **Non-intrusive** — dashboard runs in a separate window; never blocks Claude Code terminal
- **Personality** — avatars should feel alive even when idle; subtle micro-animations always running
- **Accessible** — all state info also conveyed via text label and color; not just animation
- **Portable** — works on macOS, Linux, Windows (WSL). No Electron required.
