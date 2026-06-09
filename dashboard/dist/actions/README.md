# Default action images

Drop one image per agent state here and they become the **built‑in template** for the
"Your image" avatar mode (Mosaic view). Users can still override any of them from the
dashboard's **Action images…** button (stored per‑browser), and these stay as the default.

Expected files (shipped as `.jpg`; keep the names, ~256×256 square is plenty):

```
idle.jpg  thinking.jpg  coding.jpg  spawning.jpg  reading.jpg  testing.jpg  error.jpg  done.jpg
```

Anything in `web/public/` is copied to `dashboard/dist/` on `npm run build`, so they're served
at `/actions/<state>.jpg`. Missing files fall back to a lettered placeholder — no breakage.

Users don't need to touch these to customize — the dashboard's **Action images…** button
overrides any state per‑browser. These are just the out‑of‑the‑box default.
