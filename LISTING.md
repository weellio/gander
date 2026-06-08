# Hivemind — Gumroad listing copy (draft)

> Draft marketing copy for the Gumroad product page. Edit freely.

---

## Title
**Hivemind — a live mission-control dashboard for your Claude Code agents**

## Subtitle / tagline
See every Claude Code session and sub-agent as animated avatars, know the instant one needs you, and reply from anywhere — all on your own machine.

## Short description (the blurb under the title)
Running Claude Code across a dozen terminals and losing track of what's happening? Hivemind turns all of it into one screen: a grid of avatars that act out what each agent is doing — thinking, coding, reading, spawning, testing, erroring — grouped by project, linked parent-to-child, with information visibly flowing down the tree. When an agent needs your input, you get a Telegram ping. Reply right from the dashboard (or from Telegram) without hunting for the right window.

## What it does
- **Watch everything at once** — one tile per session and sub-agent, live, color-coded by state.
- **Never miss a prompt** — agents that need input glow and pulse, and ping your Telegram.
- **Reply from anywhere** — send a message or stop an agent from the dashboard or by replying in Telegram.
- **See the org chart** — recursive parent→child links with animated flow, so you can tell which agent spawned which.
- **Make it yours** — pixel-art, abstract, or your own images per agent (and per action). Five layouts.
- **Inspect & reuse** — see each session's skills, hooks, agents, and sub-agents; copy a skill from one project to another in two clicks.

## Why it's different
**100% local. Your code never leaves your machine.** No cloud account, no telemetry, no servers — a tiny local bridge serves the dashboard and your Claude Code hooks feed it directly. The only thing that goes out is an optional Telegram alert that *you* configure with *your* bot.

## Who it's for
Developers and teams running multiple Claude Code agents who want observability and control without babysitting a wall of terminals.

## What you get
- The Hivemind app (dashboard + local bridge)
- One-command install/uninstall (Windows, macOS, Linux — needs Node.js)
- Auto-attaches to every project via Claude Code hooks
- Free updates

## Requirements
- [Node.js](https://nodejs.org) and Claude Code
- Optional: a Telegram bot (for away-from-desk alerts)

## Setup (60 seconds)
1. Download and unzip.
2. `node install.js`
3. Run `/hooks` in Claude Code (or restart). Done — agents start appearing.

## Pricing
One-time purchase. (Suggested: $29 — solo dev, lifetime updates.)

## FAQ
**Does my code get uploaded anywhere?** No. Everything runs locally; the dashboard is served from `localhost`.
**Will it slow Claude down?** No — events are fire-and-forget; if the dashboard is closed, hooks no-op instantly.
**Do I need a Telegram bot?** Only if you want phone alerts. Everything else works without it.
**Which OSes?** Anywhere Node.js runs — Windows, macOS, Linux.
