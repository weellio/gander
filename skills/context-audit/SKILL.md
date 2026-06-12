---
name: context-audit
description: Use when the user wants to cut Claude Code token cost or asks "why is this session so expensive / what's eating my tokens / trim my CLAUDE.md / reduce context". Audits the always-on context a project re-sends every turn (CLAUDE.md, memory, MCP servers, skills, agents), ranks it by per-turn token cost, and proposes concrete trims — including a leaner CLAUDE.md rewrite. Pairs with the Gander dashboard's per-session cache-hit / context-fill gauges.
---

# Context Audit

Find what a project pays for on **every single turn** and cut it. The expensive thing in a long Claude Code session is rarely the user's prompt — it's the **always-on context** (system prompt + CLAUDE.md + loaded tools/skills + conversation) that gets re-sent each turn and billed as cache-read. Shave 5k tokens off something that loads every turn and you save it across the whole session.

## The model (read first)
- **Output** costs ~5× input — but it's usually a small share of a long session's spend.
- **Cache-read** is cheap per token (~1/10th input) but you pay it on the **whole context, every turn** — so a 50-turn session re-reads its context ~50×. That multiplier is where the money goes.
- Therefore: the highest-leverage cut is anything **fixed and re-sent every turn**. In order of typical size: the conversation itself (→ `/compact`), CLAUDE.md files, enabled **MCP servers** (their tool schemas), available **skills** (name + description listed each turn), memory, agents, hooks.

## Step 1 — Get the live signal (if Gander is running)
Ground the audit in real spend before guessing. The bridge runs on `http://localhost:3131`:

```bash
curl -s http://localhost:3131/api/usage
```

In `bySession`, find this project's sessions and read: `cacheHit`, `outShare`, `ctxPct`, `costUSD`.
- **High `cacheHit` (>90%) + low `outShare` (<15%)** → the lever is **context size**, not verbosity. Focus on CLAUDE.md / MCP / `/compact`.
- **High `outShare` (>25%)** → answers are verbose; a terse-output style helps more than trimming context.
- **High `ctxPct` (>70%)** → recommend `/compact` now (also surfaced as a button in the Gander agent modal).

If the bridge isn't up, skip to Step 2 — the file audit stands on its own.

## Step 2 — Inventory the always-on context
Measure each item's size. Rough token estimate: **tokens ≈ characters ÷ 4** (use ÷3.5 for dense code/markdown). Count chars:

```bash
# bash / macOS / Linux
wc -c CLAUDE.md ~/.claude/CLAUDE.md 2>/dev/null
find . -name CLAUDE.md -not -path '*/node_modules/*' -exec wc -c {} +
```
```powershell
# Windows PowerShell
(Get-Content .\CLAUDE.md -Raw -ErrorAction SilentlyContinue).Length
(Get-Content $env:USERPROFILE\.claude\CLAUDE.md -Raw -ErrorAction SilentlyContinue).Length
```

Inventory, each as ~tokens/turn:
1. **CLAUDE.md** — global (`~/.claude/CLAUDE.md`) + project + any nested ones in the working tree. All in-scope ones load every turn.
2. **MCP servers** — list enabled ones (`.mcp.json` in the project, `enabledMcpjsonServers` / `enableAllProjectMcpServers` in `.claude/settings.json`, and `~/.claude.json`). **Each enabled server injects all its tool schemas into every turn** — often the biggest hidden cost. Note which ones the session actually *used* (check the transcript / Gander activity); unused = pure waste.
3. **Skills** — every available skill's `name` + `description` is listed each turn (progressive disclosure). Count them and total the description lengths (`~/.claude/skills/*/SKILL.md` + project `.claude/skills`). Long descriptions on rarely-used skills add up.
4. **Memory** — `~/.claude/CLAUDE.md` memory blocks / `MEMORY.md` + any auto-loaded memory files.
5. **Agents & hooks** — agent front matter and hook output that lands in context.

## Step 3 — Rank and decide
Sort the inventory by tokens/turn, largest first. For each, ask one question: **is this needed on every turn?**
- **Needed every turn** → compress it (Step 4), don't remove.
- **Needed sometimes** → move the detail into an on-demand **skill** or a file the agent Reads when relevant, leaving a one-line pointer in CLAUDE.md. (This is the core move: progressive disclosure beats always-on.)
- **Not needed here** → disable it for this project (esp. MCP servers — use `disabledMcpjsonServers`, or the Gander **Config** panel).

Quantify: `tokens_saved/turn × typical_turns × cache-read_price` (Opus cache-read ≈ $1.50/M, Sonnet ≈ $0.30/M). Show the per-session dollar estimate so the trim is justified.

## Step 4 — Deliverables
Produce, concretely:
1. **A ranked table** — item · ~tokens/turn · used? · verdict (keep / compress / defer / disable).
2. **A leaner CLAUDE.md rewrite** — same meaning, fewer tokens. Cut: restated defaults, narrative prose, duplicated history, anything the code/README already says. Keep: non-obvious constraints, commands, conventions. Show the before/after char (≈token) count.
3. **An MCP/skill trim list** — exactly which servers to disable for this project and which skill descriptions to tighten, with the per-turn savings each.

## Step 5 — Re-measure (and the cache caveat)
- **Editing CLAUDE.md mid-session busts the prompt cache** (forces a full cache-*write* at ~1.25× input that turn). So savings show up on the **next** session, not the one you're in — don't be alarmed by a one-turn cost bump.
- After the next session runs, re-check `cacheHit` / `ctxPct` / `costUSD` in `/api/usage` (or the Gander modal) to confirm the drop.

## Safety
- **Read-only by default.** Audit and *propose*; let the user apply CLAUDE.md edits and MCP changes. Never delete a memory or disable a server without showing what it is and confirming.
- Don't over-trim: cutting a real constraint makes Claude guess wrong, then you pay for the redo. Compress wording, preserve meaning.
