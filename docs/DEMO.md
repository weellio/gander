# The no-install demo

**https://weellio.github.io/gander/demo/** — the dashboard with no bridge behind it.
A stranger opens the URL and sees the office floor with four made-up sessions:
geese walking between desks, states changing, a sub-agent spawning and clocking
out, the needs-you rail holding one pending permission, the cost header ticking.
Read-only clicks work (tile modal, Office/Mosaic, Usage and the other panels).
Anything that would write shows a toast: *Demo mode: install Gander to do this for real.*

## How it is built

Same Svelte app, one extra module, no bridge.

| Piece | What it does |
|---|---|
| `web/src/demo-shim.js` | Imported by `main.js` only when the bundle is built with `VITE_DEMO=1`. Replaces `window.fetch` for `/api/...` with canned answers, keeps the swarm alive (a goose changes state every ~3 s, a sub-agent spawns every ~12 s and finishes, the feed rotates, today's spend creeps up, `api-gateway` stays `awaiting` with its permission), answers every POST with `{ok:true, demo:true}` plus the toast, stubs `WebSocket`, injects the amber **DEMO** banner, and marks the first-run tour as seen. |
| `web/demo/*.json` | The canned answers, one file per endpoint (`state`, `feed`, `usage`, `projects`, `subagents`, … and `configs.json` for the small config endpoints). Times are stored as offsets (`updatedAgo`, `lastActiveAgoMs`, `dayAgo`) and rebased to "now" when the page loads, so the demo never looks stale. |
| `web/scripts/gen-demo-data.mjs` | Writes `web/demo/*.json`. All data is invented — nothing from a real machine goes on the public page. |
| `web/vite.demo.config.js` | Extends `vite.config.js`: base `/gander/demo/`, output `docs/demo`, `VITE_DEMO=1`, prefixes the few hard-coded absolute asset URLs (`/art/`, `/goose.png`, `/actions/`) with the base, drops the service-worker registration. |
| `web/scripts/build-demo.mjs` | Cross-platform `npm run build:demo`: runs Vite with that config, then copies the four sprite sheets from `assets/` to `docs/demo/art/` and the fixtures to `docs/demo/demo/`. |

The real build (`npm run build` → `dashboard/dist/`) is untouched: the shim import
sits behind a build-time constant and is tree-shaken out, and the fixtures live
outside `public/`.

## Rebuild / refresh

```powershell
cd web
npm run demo:data     # only if you changed gen-demo-data.mjs (regenerates web/demo/*.json)
npm run build:demo    # -> docs/demo/  (GitHub Pages serves the docs/ folder on main)
```

Commit `docs/demo/` and push; Pages picks it up.

To check it locally the way Pages serves it (under `/gander/demo/`), any static
server that maps `/gander/` to `docs/` works; the build uses absolute
`/gander/demo/...` URLs, so opening `docs/demo/index.html` from disk will not.

## What the demo cannot do

- Anything that needs a bridge: launching sessions, answering permissions,
  sending keys, killing processes, saving settings, routines, the task queue,
  board posts, component generation, CLAUDE.md audits. All of these toast.
- Transcript-derived panels (Replay, Search, Session transcript) show a short
  canned conversation for the `web-shop` session only.
- The GPU chip shows an invented RTX card with one local model loaded.
- Voice control and desktop notifications are off; the alert chime may play
  when the browser allows audio.
