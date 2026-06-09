# Recording the demo GIF

The README has a reserved slot for `docs/demo.gif`. Record it, drop it here, and uncomment the
image line near the top of `README.md`.

## What to capture (8–14s, looped)
1. The **Office floor** with a handful of agents working — glowing workers, traces flowing.
2. **Click an agent** → the modal opens (current task / reply / cost).
3. A worker **finishes** → the confetti pop, then it clocks out.
4. (optional) The status bar **💰 cost** ticking, or press `/` to show the command palette.

Keep it punchy — no dead air. ~900px wide is plenty for GitHub.

## Easiest tool (Windows)
- **ScreenToGif** (free): drag the recorder over the browser region, record, trim, Save as GIF.
  Set it to ~12–15 fps to keep the file small.

## Or from a screen recording (OBS/clip → optimized GIF with ffmpeg)
```bash
# 1) make a good palette, 2) render a small, crisp gif (~900px, 14fps)
ffmpeg -i clip.mp4 -vf "fps=14,scale=900:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i clip.mp4 -i palette.png -lavfi "fps=14,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse" docs/demo.gif
```
Aim for **< 5 MB**. If it's bigger, drop fps to 10 or width to 760.

Hand it to me and I'll optimize + wire it into the README.
