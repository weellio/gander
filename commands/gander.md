---
description: Open the Gander dashboard in your browser (and report whether the bridge is running)
---

Open the Gander agent dashboard for the user and report its status. This is a quick, safe local action — just do it, don't ask for confirmation.

The dashboard port is **3131** unless the `AOC_PORT` environment variable is set (use that value if present).

1. **Check if the bridge is running:**
   `curl -s -o /dev/null -w "%{http_code}" http://localhost:3131/api/state`

2. **If it returns `200`** — the bridge is up. Open the dashboard in the default browser:
   - Windows: `start "" "http://localhost:3131/"`
   - macOS: `open "http://localhost:3131/"`
   - Linux: `xdg-open "http://localhost:3131/"`

   Then tell the user in one line: **Gander is running — opened http://localhost:3131** (note the Health panel inside confirms uptime/status).

3. **If it does not respond** — the bridge is down. Start it:
   - Find the launcher path from the **SessionStart** hook in the user's global settings (`~/.claude/settings.json` → `hooks.SessionStart`) — it runs `node <gander-repo>/bridge/launch.js`. Run that exact command.
   - `launch.js` starts the bridge detached and opens the browser itself.
   - Tell the user it's starting at http://localhost:3131.

Keep the reply to one or two lines: status + the URL. Don't over-explain.
