# Gander with other models & other agent CLIs

Gander is built around **Claude Code** — but a lot of it is tool-agnostic, and there are three ways in depending on what you run. This page is the honest map of what works where.

## 1. Other models *inside* Claude Code — the full experience

If what you want is a different **model** (DeepSeek, Gemini, OpenRouter, local Ollama…) rather than a different CLI, route Claude Code itself with [claude-code-router](https://github.com/musistudio/claude-code-router). The hooks still fire and transcripts are still written, so **every Gander feature works unchanged** — floor, analytics, Dispatch, queue, all of it. Setup + pricing config: [INSTALL.md → Using other models](INSTALL.md#using-other-models-claude-code-router).

## 1½. OpenAI Codex — native, nothing to wrap

Codex (the CLI **and** the Codex desktop app) writes every session to disk, so Gander reads it the same way it reads Claude's transcripts: **no wrapper, no hook, no config**.

- **Where it looks:** `$CODEX_HOME` (default `~/.codex`) → `sessions/YYYY/MM/DD/rollout-*.jsonl`. Override with `GANDER_CODEX_HOME` if you keep it elsewhere.
- **What you get:** a tile per live Codex session with the project, live state (thinking / coding / reading / testing / searching / awaiting when Codex asks to run something), the last message, model, turns, tool calls, token counts, and cost. Tiles carry a **Codex** chip; the modal shows the session facts (read-only — reply in Codex).
- **Cost:** Codex tokens are priced through the same `pricing` map as any other model, e.g. `{ "pricing": { "gpt-6": { "input": 2.0, "output": 8.0 } } }` in `bridge/aoc-config.json`. Unpriced = $0, never silently charged Claude rates.
- **📊 Cost panel → Codex:** sessions today, tokens, $ by project, the last sessions, and Codex's own **goals** when one is `usage_limited` / `budget_limited` / `blocked`, plus how many follow-ups sit in its queue (read from Codex's SQLite state through Node's built-in driver — still zero dependencies).
- **Off switch:** `{ "codex": false }`.

Not covered (Codex has no outside channel for them): replying into a Codex session, or approving its permission prompts — the tile goes **awaiting** so you know to switch over.


## 2. Any other agent CLI — `gander-wrap`

Codex CLI, Gemini CLI, Grok, aider, your own scripts — anything you can run in a terminal can appear on the floor. Claude Code reports itself through hooks; for everything else there's a zero-dependency wrapper:

```bash
node scripts/gander-wrap.js --name Codex --project shop -- codex exec "fix the failing tests"
node scripts/gander-wrap.js --name Gemini -- gemini -p "review this repo"
node scripts/gander-wrap.js --name Aider --parent wrap:Codex:1234 -- aider --message "add tests"
```

The wrapped command runs exactly as it would unwrapped (stdio passes straight through; if the bridge is down it still runs). While it lives, Gander shows a tile: **thinking** when quiet, **coding** while it prints (with its latest output line as the live log), 🎉 **done** on exit 0, **error** otherwise — which also means desktop/Telegram/Slack **error alerts fire for non-Claude tools too**. `--parent` nests one wrapped run under another as a sub-agent tile.

## 3. Anything that can POST JSON — the event API

The wrapper is just a client of the open ingestion API. A tool with its own hook system (Codex `notify`, CI jobs, cron scripts, other machines) can post directly:

```bash
curl -X POST http://localhost:3131/api/event -H "Content-Type: application/json" \
  -d '{"agentId":"mybot-1","name":"MyBot","project":"shop","state":"coding","log":"refactoring auth"}'
```

Valid states: `idle thinking coding spawning reading testing searching error done awaiting`. Post `state:"awaiting"` with an `awaitMsg` and the tile lands in the 🔔 Needs-you rail; post `{"remove":true}` to clear a tile. Full field list: [ARCHITECTURE.md](ARCHITECTURE.md).

## What works for non-Claude tools vs what stays Claude-only

| Works with ANY tool (wrap / event API) | Claude Code only (hooks + transcripts + CLI) |
|---|---|
| Live floor tiles: states, goals, live log lines | Auto-attach (sessions appear with zero wiring) |
| Sub-agent nesting + connectors (`--parent`) | Usage & cost analytics, per-session gauges, replay, history |
| 🔔 Needs-you rail (post `awaiting`) + error alerts (desktop / Telegram / Slack) | ⚡ Dispatch: Allow/Deny permission buttons, instant replies, ⤳ Resume |
| Activity feed, global search, Mosaic + Office views | 📋 Task queue, ⎇ worktrees, 🧪 test gate, `/task` from chat (they launch `claude`) |
| 🤖 Process robots / server room (OS-level; non-Claude leftovers show with their ports) | Tune (prompt habits, repeated work), skills-usage counts |
| Projects panel: folders, git status / commit / push, GitHub PRs & issues | Skills / agents / commands / MCP management, CLAUDE.md audit, Memory panel |
| Ambient smart-light / webhook alerts | Plan-window quota pacing, Claude Desktop tile, 💤 stalled-mid-goal heuristic |

Two practical notes: replying from a tile ("send a message back") needs a channel *into* the tool, which only exists for Claude Code sessions — for wrapped tools the tile is read-only telemetry with a Kill switch via its process. And the cost panel prices unknown models at $0 (never Claude rates), so mixed floors don't lie about spend — add real rates under `pricing` in aoc-config.json if you want them counted.
