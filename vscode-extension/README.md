# Gander — VS Code extension

Runs the **same** Gander dashboard inside a VS Code panel, next to your editor and the
integrated terminal. It is a thin wrapper: it loads whatever the bridge serves at
`http://localhost:3131` — the identical dashboard the standalone web app uses. **No forked
app.** Browser users open the URL; VS Code users get it in a tab. One bridge, one dashboard.

## What it does

- Adds a **Gander icon to the Activity Bar** (the left rail, like other extensions) — click
  it for a sidebar view with the live dashboard embedded. Its title bar has ↻ reload and
  ↗ open-as-full-tab buttons.
- Adds a **🚀 Gander** status-bar button and a **"Gander: Open Dashboard"** command, which
  open the dashboard as a full editor tab (via the built-in Simple Browser).
- If the bridge isn't running and `gander.autostart` is on, it starts it from the repo's
  `bridge/launch.js` using VS Code's bundled Node (no dependency on `node` being on PATH).

## Try it (dev)

From this folder in VS Code:

1. Open the **`vscode-extension`** folder in VS Code.
2. Press **F5** — this launches an **Extension Development Host** window with the extension loaded.
3. In that window, click **🚀 Gander** in the status bar (or run **"Gander: Open Dashboard"** from the Command Palette).

No build step, no `npm install` — it's plain JS using the `vscode` API + Node built-ins.

## Package / install

```bash
npm i -g @vscode/vsce
cd vscode-extension && vsce package        # produces gander-vscode-<version>.vsix
# then: VS Code → Extensions → ⋯ → Install from VSIX…
```

## Settings

| Setting | Default | What |
| --- | --- | --- |
| `gander.url` | `http://localhost:3131` | The running bridge's URL (change only if you set `AOC_PORT`). |
| `gander.autostart` | `true` | Start the bridge from the repo if it isn't reachable. |
| `gander.bridgePath` | `""` | Absolute path to the repo's `bridge/launch.js` — only if autostart can't find it (extension installed outside the repo). |
| `gander.openOnStartup` | `false` | Open the panel automatically when VS Code starts. |

## Notes & roadmap

- The bridge is normally already running (a Claude Code session's `SessionStart` hook launches it), so the extension usually just loads the URL.
- **Next (Tier 2):** deliver replies / quick-keys through VS Code's terminal API (`terminal.sendText()`) for sessions hosted in the integrated terminal — reliable targeting with no SendKeys / window-guessing.
