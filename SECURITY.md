# Security and privacy

Gander runs on your machine, reads your Claude Code data, and can act on your sessions. This page says exactly what it touches, what leaves the machine, and how to turn each part off. If something here is wrong or missing, open an issue.

## What Gander reads

| Data | Where | Why |
|---|---|---|
| Hook events | Claude Code sends them to the bridge on `localhost` | The floor: who is thinking, coding, waiting, erroring |
| Transcripts | `~/.claude/projects/**/*.jsonl` | Cost, tokens, context fill, replay, forensics, sub-agent roster |
| Session registry | `~/.claude/sessions/` | Deliver replies into a session's own inbox |
| Your Claude settings | `~/.claude/settings.json`, a project's `.claude/` | Setup check, the Projects panel, permission-rule suggestions |
| Git | `git` commands in your project folders | Commits per project, shipped-percent, diff previews |
| Processes and ports | `tasklist` / `ps`, `netstat` / `lsof`, `nvidia-smi` | The server room, the GPU panel |
| Codex sessions | `$CODEX_HOME/sessions` | Codex tiles, if you use Codex |

It reads. It never uploads any of this.

## What leaves the machine

Nothing, unless you switch a feature on. Each outbound connection, and its switch:

| Connection | Switch | What is sent |
|---|---|---|
| Telegram Bot API | Settings → Telegram | Alert text you asked for, your replies back |
| Slack webhook / Socket Mode | Settings → Slack | The same alerts |
| An ambient-alert webhook or script | Settings → Ambient alerts | A small JSON event (project, state) |
| npm registry | Always, cached 6 h | A GET for the latest Claude Code version number, to offer the Update button |
| License check | Only if you entered a license key | The key |
| cloudflared tunnel | Settings → Claude connector → Connect | Opens an outbound tunnel so claude.ai can reach `/mcp` only; see below |
| cloudflared download | First Connect, once | A GET to GitHub releases for the official binary |

There is no telemetry, no analytics beacon, no crash reporting, no account.

## The bridge's network surface

- The bridge listens on `127.0.0.1:3131` only. A request from any other address, a non-loopback `Host` header, or a cross-site `Origin` is refused. That defeats DNS rebinding and browser-side CSRF.
- Remote access (phone console, fleet) is off by default. When you switch it on, every request from outside loopback must carry the access token you set. See [docs/REMOTE.md](docs/REMOTE.md).
- The Claude connector (`/mcp`) has its own gate: it validates `Origin`, requires its token for every call that does not come from this machine (a tunnel's calls count as remote even though they arrive on loopback), refuses remote calls while switched off, and exposes only read-only tools. The rest of the bridge is never reachable through the tunnel.
- The gander-feed mod posts to the bridge on loopback only and sends nothing anywhere else.

## What Gander can do to your sessions

These are the write paths. Every one is something you click, say, or configure.

- Send a reply or a stop to a session (its inbox, or the queued channel it picks up at its next turn).
- Answer a permission prompt with Allow or Deny, through Claude Code's own `PermissionRequest` hook.
- Hold a dangerous shell command (the danger guard) until you click Allow once or Keep blocked; this works in every permission mode, bypass included. The guard never runs anything; it only answers Claude Code's hook.
- Start a new session in a project folder, with the permission mode you chose in Settings. Gander injects no API key; sessions use your own Claude login and plan.
- Queue tasks, and with worktrees on, create branches and merge green ones; with review-before-merge, nothing merges without you.
- Kill a process from the server room, when you click End.

Gander never edits your files and never runs shell commands on its own initiative.

## What the installer changes

`node install.js` (or `setup.bat` / `setup.sh`) merges hook entries into `~/.claude/settings.json` (or the project's `.claude/settings.json` with `--project`). It backs the file up first to `settings.json.gander-bak`, touches only hook groups that point at Gander's own scripts, and `node uninstall.js` removes exactly those. The plugin route (`/plugin install gander@gander`) installs the same hooks through Claude Code's plugin system and nothing else.

## Secrets on disk

Tokens you enter (Telegram, Slack, access token, connector token, Cloudflare tunnel token) are stored in `bridge/aoc-config.json`, which is gitignored. Settings shows a connector token so you can paste it into claude.ai; the others are never echoed back after saving.

## Reporting a problem

Open an issue on GitHub, or email b@bworldtools.com for anything you would rather not post publicly.
