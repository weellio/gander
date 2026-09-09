# Gander — install & configuration

Setup, optional features, and every configuration knob. See also: [README](../README.md) · [FEATURES.md](FEATURES.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [FAQ.md](FAQ.md) · [REMOTE.md](REMOTE.md) (phone / multi-machine).

**Requirements:** [Node.js](https://nodejs.org) and Claude Code.

## One-step setup (recommended)

Clone the repo, then from the Gander folder run the setup script for your OS:

```bash
# Windows
setup.bat                  # global: every Claude session on this machine reports in
setup.bat --project        # only sessions started in this folder

# macOS / Linux
./setup.sh                 # global   (use --project to scope to this folder)
```

It checks for Node, wires Gander's hooks into your Claude Code `settings.json` (without touching your other settings), and prints the next steps. The dashboard is **prebuilt** (`dashboard/dist`) — nothing to compile just to run it.

Prefer to do it by hand? The setup scripts just call the installer:

```bash
node install.js            # global   (or: node install.js --project)
```

Then, in any open session run `/hooks` (or restart) to load the hooks. To remove everything:

```bash
node uninstall.js          # or: node uninstall.js --project
```

On your next session the `SessionStart` hook starts the bridge and opens the dashboard at `http://localhost:3131/`. As Claude works, tiles light up automatically — and you can **send messages or stop** any session right from its tile.

## Optional setup

These are app-wide settings, configured from the dashboard's **⚙ Settings → App configuration** drawer (saved to `bridge/aoc-config.json`). *(Per-project hooks/MCP/`settings.json` live in **Manage → Projects** instead — expand a project.)*

- **⚡ Gander Dispatch** — flip on **Host sessions in the bridge**: ▶ Start / ＋ New task with a goal (and ⤳ Resume replies) run over bidirectional stream-json inside the bridge instead of opening a terminal. Instant replies, dashboard-native permission Allow/Deny, live rate-limit telemetry. Toggle **off anytime** to return to the classic terminal method, or per-launch via *"open a terminal window instead"* in ＋ New task. A goal-less ▶ Start always opens a terminal (an interactive session needs a keyboard).
- **Telegram** — paste a bot token + your chat id to get pinged when a session needs you, and reply or `/stop` from your phone. Also: **`/task <project> <goal>`** queues new work from the chat, **`/queue`** lists it.
- **Slack** — paste an incoming-webhook URL (api.slack.com/apps → Incoming Webhooks) and every alert Telegram gets is mirrored to a Slack channel. For **two-way control** (`/task`, `/queue`, `/stop`, and replies typed as `project: your message` from Slack), also add: an **app-level token** (your app's Basic Information → App-Level Tokens, scope `connections:write`, with **Socket Mode** switched on) and a **bot token** (OAuth & Permissions → scope `chat:write`; under Event Subscriptions subscribe the bot to `message.im` — plus `message.channels` if you want to talk to it in channels — and invite it). No public URL or tunnel needed — the bridge connects out via Socket Mode.
- **Cost budget** — a daily / per-session spend cap. Session caps de-escalate as a **circuit breaker**: steered to wrap up at 70%, final warning at 90%, and (with **Enforce** on) **Stopped** at the cap; crossing the daily cap stops every active session.
- **⎇ Worktree isolation** (📋 Task queue panel) — each queue task runs in its own git worktree + branch so tasks can run in the same project in parallel; the bridge merges back on completion (conflicts keep the branch).
- **👀 Review before merge** (📋 Task queue panel) — with worktrees on, hold every green branch for *your* review instead of auto-merging: the task lands in the 🔔 rail (and pings Telegram / desktop) with **View diff**, **✓ Approve & merge**, and **✎ Request changes** — which keeps the branch and queues a follow-up task that starts by merging it and carries your note.
- **Permission prompts from the rail (any session)** — installed automatically with the hooks: Gander registers a `PermissionRequest` hook, so when *any* Claude session (terminal, VS Code, `claude agents`, not just Dispatch-hosted ones) stops to ask "Allow this command?", the prompt shows up in the 🔔 rail with **Allow / Deny** buttons, pings Telegram/Slack/desktop, and the hook hands your answer back to Claude. Not answered within ~10 minutes? The hook steps aside and Claude shows its normal terminal prompt — it never blocks you. (Sessions launched with `bypass` permissions never ask, so nothing appears.)
- **Agent Teams (experimental)** — nothing to configure: run Claude with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and the team roster, task list and mailboxes Claude writes under `~/.claude/teams` / `~/.claude/tasks` appear as a **👥 Agent teams** strip on the dashboard; the installer also registers the `TeammateIdle` / `TaskCreated` / `TaskCompleted` hooks so task events land in the feed. Re-run `node install.js` after upgrading Gander to pick up newly added hooks.
- **Status line** — `node scripts/gander-statusline.js --install` writes a `statusLine` into `~/.claude/settings.json` so every terminal shows Gander's needs-you / queue / escalation / gem counts beside model, context %, and cost. `--uninstall` restores whatever you had before.
- **Open-in-editor command** — only if "Open in VS Code" can't auto-detect your editor; point it at `code.cmd`, `codium`, etc.
- **Desktop alerts (no browser needed)** — the **bridge itself** pops a native OS notification (Windows toast · macOS `osascript` · Linux `notify-send`, zero-dep) on needs-you / error / runaway. Unlike the in-app chime, this fires with the dashboard closed, so you get pinged even if you live in the terminal (e.g. `claude agents`). Toggle in Settings → App configuration → **Desktop alerts**, with a Test button.
- **Ambient alerts (smart light / webhook)** — fire a webhook (POST JSON) and/or a shell command on key moments (a session needs you, errored, runaway cost, task done, all-clear) so a smart light blinks across the room and you don't have to sit at the screen. Per-scenario **colour** (name or `#hex`) and **pattern** (solid/blink/pulse/breathe/strobe/rainbow) with a live preview swatch and a Test button. **Built-in LIFX** support drives a bulb directly (paste a token, no hub/glue); or point the webhook/command at Home Assistant, IFTTT, Govee, or any script. The bulb is optional — the webhook fires regardless.
- **Idle nudge** — wake parked sessions so a queued reply delivers immediately. **The bridge runs this itself — no Windows scheduled task or cron needed.** In **Settings → App configuration → Wake idle sessions**, turn on **Wake on send** (fires the moment you reply) and/or set a **nudge interval** in minutes (0 = off). It finds each idle session's window (VS Code or terminal) by PID and types a wake — keep the Claude terminal focused in each window.

## Optional: inside VS Code

Prefer everything in one window? A thin **VS Code extension** in [`vscode-extension/`](../vscode-extension/) puts Gander in VS Code like any other extension:

- **Goose icon in the Activity Bar** (the left rail) — click it to dock the live dashboard in the sidebar next to your code, with ↻ reload and ↗ open-as-tab buttons in its title bar.
- **🚀 Gander** status-bar button / **"Gander: Open Dashboard"** command — the full dashboard as an editor tab (via the built-in Simple Browser), roomier for the Office floor and grid views.
- If the bridge isn't reachable, it can **autostart** it from the repo (`gander.autostart`).

It's a wrapper, not a fork: it loads the *same* dashboard the bridge serves — browser users open `localhost:3131`, VS Code users see the identical app. Install the packaged `.vsix` (Extensions → ⋯ → *Install from VSIX…*), or open the folder and press **F5** to develop. See [vscode-extension/README.md](../vscode-extension/README.md).

## Alternative: as a Claude Code plugin

```text
/plugin marketplace add <this-repo-or-path>
/plugin install gander@gander
```

## Configuration reference

`bridge/aoc-config.json` (gitignored) or env vars:

- **Port** — `AOC_PORT` (default `3131`).
- **Network** — the bridge binds to **`127.0.0.1` only** by default and rejects cross-origin / non-loopback-`Host` requests, so a LAN neighbour or a malicious web page can't drive it (it spawns processes and writes config). To reach it from another machine on a **trusted** network, set `AOC_ALLOW_REMOTE=1` (or `{ "allowRemote": true }`) — this binds `0.0.0.0` and drops the guard, so only do it on a network you trust.
- **Access token (set it before allowRemote!)** — `{ "accessToken": "..." }` (or `AOC_TOKEN`). When set, every **non-loopback** request must present it: `X-Gander-Token` header, `?token=...` on first load (sets a cookie), or the cookie. Loopback stays frictionless. Constant-time compared; the bridge warns at boot if remote access is on with no token. Phone/Tailscale/cloudflared recipes: **[REMOTE.md](REMOTE.md)**.
- **Fleet peers** — `{ "fleet": { "peers": [{ "name": "laptop", "url": "http://100.x.y.z:3131", "token": "..." }], "intervalMs": 5000 } }` (or Settings → Fleet). This bridge becomes the **hub**: it polls each peer's `/api/state` (sending the token) and merges their agents onto the floor, tagged 🖥 with the machine name; replies/stops to remote tiles are forwarded to the owning bridge.
- **Telegram alerts/replies** — `{ "telegramToken": "...", "telegramChatId": "...", "dashboardUrl": "..." }` (or `AOC_TG_TOKEN` / `AOC_TG_CHAT` / `AOC_DASH_URL`). For inbound replies, the bot must have no webhook — use a dedicated bot via `"telegramReplyToken"` if needed.
- **Slack alerts (outbound)** — `{ "slackWebhook": "https://hooks.slack.com/services/…" }` (or `AOC_SLACK_WEBHOOK`). Mirrors alert messages; leave empty to disable.
- **Slack inbound (Socket Mode)** — `{ "slackAppToken": "xapp-…", "slackBotToken": "xoxb-…", "slackChannel": "C0123…" }`. Both tokens enable two-way chat control; `slackChannel` is where bot-token alerts post when no webhook is set (optional — defaults to wherever you last messaged the bot).
- **Queue test gate** — the gate auto-detects `npm test` (real script) or `node --test` (a `test/` dir). Override per project with `{ "testCmds": { "myproject": "pytest -q" } }` or globally with `{ "testCmd": "make test" }`; toggle the gate itself in the 📋 queue panel.
- **Avatar images** — imported from the dashboard (**Images…** / **Action images…**), stored in the browser's localStorage.
- **Inbox delivery** — `{ "inboxDeliver": true }` (default). Replies to terminal / VS Code sessions are written straight into the session's cross-session inbox (reported by the hooks) instead of being queued for the next Stop hook or typed into a window. Set `false` to force the classic queued channel.
- **Stalled-session threshold** — `{ "stallMinutes": 3 }`. A session with a stated goal that ends its turn on a question and sits idle this long is flagged 💤 *went quiet mid-goal* in the 🔔 rail (plus a one-time desktop toast). `0` disables the check.
- **Runaway burn threshold** — `{ "burnAlert": 5.0 }` ($/min, default `5.0`). An active session gets the red "runaway" highlight only when its smoothed spend stays above this for two samples in a row (so a single big turn doesn't trip it). The visual can be toggled per-browser in Settings → *Cost & burn alerts*. Note: spend is *estimated* from token counts at API list prices.
- **Model pricing** — `{ "pricing": { "deepseek": { "input": 0.27, "output": 1.10 } } }`. Gander prices Claude models (Opus/Sonnet/Haiku/Fable) at Anthropic list rates out of the box. Keys here match as **case-insensitive substrings** of the model id and override those rates, so a non-Anthropic or local backend (see *other models* below) is costed correctly. `input`/`output` are USD per million tokens; `cacheWrite`/`cacheRead` default to 1.25× / 0.1× input if omitted. Any model that matches neither the built-ins nor your overrides is treated as **free** ($0) rather than charged Claude rates.
- **New session options** (Settings → *App configuration* → *New session options*, applied to **▶ Start** and **＋ New task**):
  - **Claude command / path** — `{ "claudeCmd": "" }`. Runs `claude` on PATH by default; if you get *"'claude' is not recognized"*, set the full path (`where claude` / `which claude`, e.g. `C:\Users\you\.local\bin\claude.exe`).
  - **Permission mode** — `{ "launchPermMode": "" }`: `""` (ask, default) · `acceptEdits` · `plan` · `bypass`. **`bypass`** launches with `--dangerously-skip-permissions` so Claude won't prompt before edits/commands — handy if you don't want to babysit prompts, but only use it on projects you trust. *(The one-time "trust this folder" prompt has no bypass flag, but Claude remembers it per folder after you accept once.)*
  - **Extra flags** — `{ "launchFlags": "" }`: appended verbatim, e.g. `--model sonnet`.

### Every JSON key (for scripted / headless setups)

Most knobs are set from **⚙ Settings**, which writes `bridge/aoc-config.json`. If you provision machines by hand, these are the keys the bridge actually reads (defaults in brackets):

| Key | What it does |
|---|---|
| `dispatch` [false] | ⚡ Gander Dispatch on/off (Settings → Host sessions in the bridge). |
| `inboxDeliver` [true] | Write replies straight into a session's cross-session inbox. |
| `claudeCmd` · `launchPermMode` · `launchFlags` | New-session options (see above). |
| `dailyBudget` · `sessionBudget` [0 = off] · `budgetEnforce` [false] | 💸 Cost budget caps + hard stop. |
| `burnAlert` [5.0] · `stallMinutes` [3] · `longRunMinutes` [0 = off] | Runaway $/min, went-quiet-mid-goal, and "still grinding after N minutes" nudges. |
| `osNotify` [false] | Native desktop toasts from the bridge. |
| `nudgeOnSend` [false] · `nudgeInterval` [0 = off, minutes] | Wake idle sessions (see *Idle nudge*). |
| `editorCmd` [auto] | Open-in-editor command. |
| `ambient` | Smart-light / webhook alerts — the JSON mirrors the Settings form (per-scenario colour + pattern, `webhook`, `command`, `lifx.token` / `lifx.selector`). Easiest to set once from the UI and copy the block. |
| `boardInject` [true] | Append the coordination-board briefing to launched prompts. |
| `queueTelegram` [false] | Telegram ping when a queue task finishes (failures always ping). |
| `autoRetire` [true] · `retireDoneSec` [180] · `retireClosedSec` [60] · `retireIdleSec` [1500] · `retireStaleActiveSec` [1800] | How long tiles linger before clocking out: finished sub-agents, truly closed sessions, idle sessions, orphaned "active" tiles. |
| `telegramToken` · `telegramChatId` · `telegramReplyToken` · `dashboardUrl` | Telegram (see above). |
| `slackWebhook` · `slackAppToken` · `slackBotToken` · `slackChannel` | Slack (see above). |
| `fleet` `{ peers, intervalMs }` | Fleet hub polling (see above). A Settings save keeps a hand-edited `intervalMs`. |
| `pricing` · `testCmds` · `testCmd` · `allowRemote` · `accessToken` | See the rows above. |
| `license` | Optional licence key (also `AOC_LICENSE`). |

Queue settings (`enabled`, `maxSlots`, `worktrees`, `testGate`, `review`) live in `bridge/aoc-queue.json` under `cfg` and are set from the 📋 panel. Project roots/known folders live in `bridge/aoc-projects.json`.

**Environment overrides** (mostly for tests and unusual layouts): `AOC_PORT`, `AOC_ALLOW_REMOTE`, `AOC_TOKEN`, `AOC_TG_TOKEN` / `AOC_TG_CHAT` / `AOC_DASH_URL`, `AOC_SLACK_WEBHOOK`, `AOC_LICENSE`, `AOC_BOARD_FILE`, `AOC_QUEUE_FILE`, `GANDER_SETTINGS` (which `settings.json` the installer edits), `GANDER_SESSIONS_DIR` / `GANDER_TEAMS_DIR` / `GANDER_TASKS_DIR` (where Claude Code's session registry / team files are read from).

## Using other models (claude-code-router)

> Running a different agent CLI entirely (Codex, Gemini CLI, Grok, aider…)? See **[OTHER-MODELS.md](OTHER-MODELS.md)** — this section is for other models *inside* Claude Code, which keeps every feature working.

Gander watches **Claude Code**, not a specific model — so it works unchanged when you route Claude Code to other backends (DeepSeek, Gemini, OpenRouter, a local Ollama model…) with [claude-code-router](https://github.com/musistudio/claude-code-router). The router only changes *where* Claude Code sends requests (`ANTHROPIC_BASE_URL`); the hooks still fire and the transcript is still written, so every session and sub-agent shows up the same.

- **Watch routed sessions** — nothing to do. Run `ccr code` (or set `ANTHROPIC_BASE_URL` and use `claude`) and they appear on the dashboard.
- **Launch routed sessions from Gander** — either set `ANTHROPIC_BASE_URL=http://localhost:3456` in your environment (so **▶ Start** / **＋ New task** route automatically), or point the **claude command** (Settings → *App configuration* → *New session options*) at the router.
- **Keep cost honest** — add the provider's rates under **`pricing`** (above). Without it, a non-Claude model is treated as **free** rather than charged Claude prices, so the cost panel won't lie either way.
