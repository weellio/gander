# Changelog

Gander uses calendar versions: `v<year>.<month>` for a monthly release, `v<year>.<month>.<n>` for a fix in between. Every entry below is a `feat:` or `fix:` commit on `main`.

## v2026.10 — 2026-10-14

### Added
- **Danger guard hold**: a blocked command is parked while you decide; Allow once runs it on the spot, and a late Allow tells the session to retry by itself. Hook timeout raised to 590 s; re-run `node install.js` once.
- **"Hey Gander" voice control**: wake word, a small grammar (start, queue, reply, stop, allow, deny, status, who needs me, open a panel, mute), spoken answers, push-to-talk on V. Browser speech recognition, nothing installed.
- **Claude connector**: the bridge is a read-only MCP server at `/mcp` with one tool per dataset; one-click cloudflared tunnel, fetched and kept alive by the bridge; optional fixed address through a Cloudflare named tunnel. Claude Dashboards can run live queries on Gander.
- **Datasets API**: `GET /api/datasets/<id>` as JSON or CSV, and a one-file data pack.
- **gander-feed mod**: on Claude Code 2.1.287+, in-process hooks post the engine's own cost, context fill and plan windows, so a session's figures are exact instead of estimated. Gated by CLI version with a fallback to the classic hooks.
- **What fills the context window**, diff previews on approvals, cheaper-model what-if, session fork, runbook export, prompt templates.
- Danger guard, stop-asking-me suggestions, same-file collision warnings, quiet hours, the away card, cost per queue task, agent scorecards, replay clips.
- **GPU & local models** panel with one-click Unload and Free the GPU.

### Fixed
- Sub-agent tokens and cost were counted about twice.
- The launcher was killed mid-boot and took the new bridge with it.
- GPU polling made games stutter; the driver is no longer polled.
- The connector answered a missing token with 401, which made claude.ai assume OAuth.
- Test bridges shared the real config file and switched the connector off.

## v2026.09 — 2026-09-30

### Added
- Improvement tracking: rework and tool-error rates over 60 days, error families, measured CLAUDE.md rules.
- Phone console with Allow / Deny, the Setup check that lints hooks, skills, agents and MCP servers.
- Real plan percentages in the header via the status line; warnings before context fills or a limit stops the work.
- 13 more hook events wired; session facts read from the transcript (title, mode, artifacts, files).
- Stale-CLI detection with a one-click Claude update.
- Real sub-agent task names on the floor, plus a roster of every agent ever run.
- A $4 USB-powered ambient alert lamp: firmware and build guide; single-colour LED strips.
- Advanced settings: every bridge knob in the UI, one-click bridge restart; a model pricing editor.
- OpenAI Codex sessions on the floor: native rollout reader, cost, goals.
- Agent Teams on the floor (experimental); replies delivered straight into a session's cross-session inbox.

### Fixed
- One bridge per machine (six sessions had left nine running).
- Process bots spilled out of small offices into the next room.
- A slow process scan silently emptied the server room.
- Every installer hook is verified, not a stale copy, with a manifest/installer/health parity test.

## Earlier — June to August 2026

The office floor and Mosaic views, pixel-art geese, the needs-you rail, Dispatch (bridge-hosted sessions), the coordination board, the task queue with worktrees and a test gate, Telegram and Slack alerts, the usage panel parsed from transcripts, session replay, the VS Code extension, fleet (multi-machine), and the PWA. 354 commits since 2026-06-07.
