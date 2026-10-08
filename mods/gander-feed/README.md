# gander-feed

A Claude Code **mod** (a plugin of in-process function hooks, Claude Code 2.1.287+) that feeds the [Gander](../../README.md) dashboard what the classic hooks never report, and draws a one-line Gander band above the prompt.

## What it sends to the bridge

Every event goes to `POST http://127.0.0.1:3131/api/mod` as JSON with `kind`, `session_id` and `cwd`:

| Hook | `kind` | Carries |
|---|---|---|
| `session.start` | `hello` | Claude Code version, model, surface, interactive or not |
| `session.measure` | `measure` | context tokens / window / percent, rate-limit windows (`five_hour`, `seven_day`), session cost in USD |
| `turn.start` | `turn-start` | turn id |
| `turn.step` | `step` | one model request: model, effort, message count, the sub-agent id when inside a sub-agent loop |
| `turn.complete` | `turn` | how the turn ended and its usage (input, output, cache read, cache write, model) |
| `agent.spawn` | `spawn` | sub-agent type, description, model, agent id |
| `session.end` | `bye` | why the session ended |

While a session's feed is fresh (under two minutes old), the dashboard shows these figures badged **exact** in place of the transcript estimate. After that, or after `bye`, the estimate takes over again.

## The band and `/gander`

Above the prompt: `Gander: 2 need you · $1.25 · ctx 40% · http://localhost:3131/` with a **Hide** button. It polls the bridge every 15 seconds (configurable) and hides itself while the bridge is unreachable. `/gander` prints the same line, or how to start the bridge when it is down.

## Install

From the dashboard: **⚙ Settings → App configuration → Install mod**. The button only appears when the CLI Gander launches is 2.1.287 or newer.

From a shell: `node install.js --mods` (same gate, prints the reason when it skips).

By hand, in any terminal session:

```text
/plugin marketplace add <path to this checkout>
/plugin install gander-feed@gander
```

Open sessions load it after `/reload-plugins`; new sessions load it on start. Sessions hosted by the VS Code extension do not load mods yet, and other providers (Codex, Desktop) never do; Gander's classic hooks keep covering them.

## Options (`/config`, or `--config` on install)

| Field | Default | Meaning |
|---|---|---|
| `bridgeUrl` | `http://127.0.0.1:3131` | where the bridge listens |
| `band` | `true` | draw the band above the prompt |
| `pollSeconds` | `15` | how often the band asks the bridge for the needs-you count |

## Developing

```text
claude plugin validate mods/gander-feed
claude plugin test mods/gander-feed
claude --plugin-dir mods/gander-feed      # load it for one session without installing
```

Everything the mod does is best-effort: a bridge that is down costs the session nothing and blocks nothing. The hooks that could gate the engine (`agent.spawn`) carry a fallback that always lets the engine continue.
