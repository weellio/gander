---
name: agent-ops
description: Control the Gander dashboard — open/show it, restart the bridge, reset the agent tiles, or check status. Use when the user asks to open/show the agent dashboard, start or stop the visualizer, or clear the agents.
---

# Gander — control

Gander is a live dashboard that visualizes this session's Claude Code agents and sub-agents as animated avatar tiles. A small local **bridge server** holds the agent registry and serves the dashboard at `http://localhost:3131/`. Claude Code **hooks** push real tool activity to it automatically, so normally it "just works" once the plugin is installed — this skill is for manual control.

The bridge + dashboard live under the plugin root (`${CLAUDE_PLUGIN_ROOT}` in hook/MCP contexts). When running commands from this skill, use the plugin's `bridge/` and `dashboard/` folders.

## Open / start the dashboard
Run the launcher. It starts the bridge if it isn't already running and opens the dashboard once:

```
node "<plugin-root>/bridge/launch.js"
```

If the browser tab doesn't open, navigate to `http://localhost:3131/` manually.

## Check status
A quick request to the state endpoint tells you if the bridge is up and how many agents are tracked:

- PowerShell: `Invoke-RestMethod http://localhost:3131/api/state`
- curl: `curl -s http://localhost:3131/api/state`

## Reset the tiles
Clears all agents back to just the root Orchestrator:

- PowerShell: `Invoke-RestMethod -Method Post http://localhost:3131/api/reset`
- curl: `curl -s -X POST http://localhost:3131/api/reset`

## Stop the bridge
Stop the Node process serving port 3131:

- PowerShell: `Get-NetTCPConnection -LocalPort 3131 | Select-Object -Expand OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }`
- macOS/Linux: `lsof -ti:3131 | xargs kill`

## Drive it from a one-off Claude run (no hooks)
You can also pipe a headless run straight into the bridge:

```
claude -p "task" --output-format stream-json --verbose | node "<plugin-root>/bridge/server.js" --stdin
```

## Notes
- Default port is `3131`; override with the `AOC_PORT` environment variable (and update the hook URLs in `hooks/hooks.json` to match).
- Avatar style (pixel art / abstract / GIF) and grid layout (Solo / Squad / War Room / Broadcast / Mosaic) are selectable from the dashboard top bar.
- To use your own GIF avatars, drop files in `dashboard/assets/avatars/` and list them in `dashboard/assets/avatars/manifest.json`.
