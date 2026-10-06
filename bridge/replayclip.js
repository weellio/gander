'use strict';
// Gander replay clip — turn a session replay (bridge/replay.js build() output)
// into ONE self-contained, auto-playing HTML page: a 16:9 "brag reel" of what
// the agent did (state ribbon, moving playhead, live tool ticker, token + $
// counters, final summary card). Open it, screen-record it, or capture it with
// Playwright at 1920x1080. Zero external resources; inline CSS + JS only.
//
// Public API:  module.exports = { renderClip }
//   renderClip(replay, opts?) -> string (a complete HTML document)
//     replay — what replay.build() returns ({ ok, project, durationMs, events, ... });
//              ok:false / missing / empty events render a "nothing to replay" frame.
//     opts   — { title, project, model, seconds = 30, theme: 'dark'|'light',
//                maxEvents = 2000 }
//   Page query params: ?seconds=N (playback length), ?t=0..1 (jump + pause, for
//   stills), ?speed=0.5|1|2, ?theme=dark|light, ?controls=0 (hide the buttons).
//   Capture hook: window.__ganderClip = { seek(p), play(), pause(), pos() }.
//
// Safety: every session-derived string reaches the page either HTML-escaped
// (server side) or via textContent (client side). The data rides in a
// <script type="application/json"> block with '<', '>', '&', U+2028/9 escaped
// as \uXXXX, so '</script' or '<!--' inside a transcript cannot break out.

const STATES = ['thinking', 'coding', 'reading', 'testing', 'searching', 'spawning', 'error', 'done', 'idle'];
const SI = Object.fromEntries(STATES.map((s, i) => [s, i]));
const MAX_EVENTS = 2000;     // embedded events cap (all state changes kept first)
const MAX_SEGS = 900;        // ribbon segments cap (~2px each at 1728px wide)
const MAX_ERR_TICKS = 400;
const DETAIL_CAP = 140;
const TITLE_CAP = 160;
const IDLE_GAP_MS = 90_000;  // a real gap longer than this is "idle" ...
const HOLD_MS = 15_000;      // ... the prior state holds this long on the reel,
const IDLE_SHOW_MS = 45_000; // ... then this much idle is shown (the rest is cut)
const DEFAULT_SECONDS = 30;

// Label prefixes replay.js (via parser.detailForTool) puts in front of details.
const CAP_PREFIX = { Read: 'Read', Write: 'Write', Edit: 'Edit', MultiEdit: 'MultiEdit' };
const LOW_PREFIX = { grep: 'Grep', glob: 'Glob', ls: 'LS', search: 'WebSearch', fetch: 'WebFetch' };
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch']);
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const KIND_CODE = { tool: 'T', error: 'E', prompt: 'P', text: 'X', done: 'D' };

// ── Small helpers ────────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** One-line, control-char-free, length-capped text. */
function clean(s, cap) {
  if (s == null) return '';
  // eslint-disable-next-line no-control-regex
  let one = String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cap && one.length > cap) one = one.slice(0, cap - 1) + '…';
  return one;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON that is inert inside a <script> element: no '<', '>', '&' or JS line separators. */
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function clampSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SECONDS;
  return Math.min(3600, Math.max(1, n));
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Recover { tool, detail } from a replay event. replay.js only keeps a human
 * label ("Read C:\x.js", "grep foo", a raw Bash command, a Task description),
 * so the tool name is inferred from the label prefix + state. An explicit
 * e.tool (future replay versions) wins.
 */
function splitTool(e) {
  const label = clean(e.label, 400);
  if (e.tool) return { tool: clean(e.tool, 40), detail: label };
  switch (e.kind) {
    case 'prompt': return { tool: 'Prompt', detail: label };
    case 'error': return { tool: 'Error', detail: label };
    case 'text': return { tool: 'Claude', detail: label };
    case 'done': return { tool: 'Note', detail: label };
    case 'tool': break;
    default: return { tool: 'Event', detail: label };
  }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(label);
  const first = m ? m[1] : '';
  const rest = m && m[2] ? m[2] : '';
  if (CAP_PREFIX[first]) return { tool: CAP_PREFIX[first], detail: rest };
  // lowercase prefixes are only trustworthy when the state isn't Bash's
  if (LOW_PREFIX[first] && e.state !== 'coding' && e.state !== 'testing') {
    return { tool: LOW_PREFIX[first], detail: rest };
  }
  if (e.state === 'spawning') return { tool: 'Task', detail: label };
  if (e.state === 'coding' || e.state === 'testing') return { tool: 'Bash', detail: label };
  // unknown tools: detailForTool returns just the tool name
  if (/^[\w.:-]+$/.test(label)) return { tool: clean(label, 40), detail: '' };
  return { tool: 'Tool', detail: label };
}

/**
 * Build a "make this detail readable on a reel" function for one session:
 * paths under the session cwd become relative (Windows, forward-slash and
 * Git-Bash /d/... spellings, any case) and a leading `cd <dir> &&` / `cd <dir>;`
 * is dropped from shell commands. Never returns an empty string for a
 * non-empty input.
 */
function makeShortener(cwd) {
  let re = null;
  const c = String(cwd || '').replace(/[\\/]+$/, '');
  if (c.length >= 3) {
    const parts = c.split(/[\\/]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const alts = [parts.join('[\\\\/]+')];
    const drive = /^([A-Za-z]):$/.exec(c.split(/[\\/]/)[0] || '');
    if (drive) alts.push('/' + drive[1] + '/' + parts.slice(1).join('/'));
    re = new RegExp('(?:' + alts.join('|') + ')(?:[\\\\/]+|(?=["\'\\s]|$))', 'gi');
  }
  return (s) => {
    if (!s) return s;
    let out = s;
    const cd = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/i.exec(out);
    // only drop the cd when a real command follows it (labels arrive pre-truncated: "cd \"…\" && p…")
    if (cd && out.slice(cd[0].length).replace(/…$/, '').trim().length >= 4) out = out.slice(cd[0].length);
    if (re) out = out.replace(re, '');
    return out.trim() || s;
  };
}

/** Pick which event indices to embed: all state changes first, then even fill. */
function sampleIndices(states, max) {
  const n = states.length;
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const must = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1 || states[i] !== states[i - 1]) must.push(i);
  }
  if (must.length >= max) {
    // even more state changes than budget: even-sample them, keep both ends
    const out = new Set([must[0], must[must.length - 1]]);
    const step = (must.length - 1) / (max - 1);
    for (let k = 0; out.size < max && k < max; k++) out.add(must[Math.round(k * step)]);
    return [...out].sort((a, b) => a - b).slice(0, max);
  }
  const keep = new Set(must);
  const others = [];
  for (let i = 0; i < n; i++) if (!keep.has(i)) others.push(i);
  const budget = max - keep.size;
  const step = others.length / budget;
  for (let k = 0; k < budget; k++) keep.add(others[Math.min(others.length - 1, Math.floor(k * step))]);
  return [...keep].sort((a, b) => a - b);
}

/** Merge adjacent same-state segments and drop empty ones. */
function mergeSegs(segs) {
  const out = [];
  for (const s of segs) {
    if (!(s[1] > s[0])) continue;
    const last = out[out.length - 1];
    if (last && last[2] === s[2] && Math.abs(last[1] - s[0]) < 1e-9) last[1] = s[1];
    else out.push([s[0], s[1], s[2]]);
  }
  return out;
}

/** Too many segments to draw: bucket into `bins` equal slices, dominant state wins. */
function binSegs(segs, bins) {
  const w = segs.length ? segs[segs.length - 1][1] / bins : 0;
  if (!(w > 0)) return segs;
  const acc = Array.from({ length: bins }, () => new Float64Array(STATES.length));
  for (const [a, b, s] of segs) {
    let i = Math.min(bins - 1, Math.floor(a / w));
    while (i < bins) {
      const lo = Math.max(a, i * w);
      const hi = Math.min(b, (i + 1) * w);
      if (hi <= lo) break;
      acc[i][s] += hi - lo;
      i++;
    }
  }
  const out = [];
  for (let i = 0; i < bins; i++) {
    let best = -1, bw = 0;
    for (let s = 0; s < STATES.length; s++) if (acc[i][s] > bw) { bw = acc[i][s]; best = s; }
    if (best >= 0) out.push([i * w, (i + 1) * w, best]);
  }
  return mergeSegs(out);
}

// ── Data preparation (pure, testable) ────────────────────────────────────────
function prepare(replay, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const r = replay && typeof replay === 'object' ? replay : {};
  const maxEvents = Math.max(2, Math.min(MAX_EVENTS, Math.floor(num(o.maxEvents)) || MAX_EVENTS));
  const project = clean(o.project || r.project || '', 80);
  const base = {
    v: 1,
    title: clean(o.title || r.title || project || 'Session replay', TITLE_CAP),
    project,
    model: clean(o.model || r.model || '', 60),
    startedAt: typeof r.startedAt === 'string' ? clean(r.startedAt, 40) : null,
    seconds: clampSeconds(o.seconds),
    theme: o.theme === 'light' ? 'light' : 'dark',
    states: STATES,
  };
  const raw = Array.isArray(r.events) ? r.events.filter((e) => e && typeof e === 'object') : [];

  if (r.ok === false || raw.length === 0) {
    return {
      ...base,
      empty: true,
      reason: r.ok === false ? clean(r.error || 'replay failed', DETAIL_CAP) : 'This session has no recorded activity yet.',
      durationMs: num(r.durationMs),
      activeMs: 0,
      totals: { tokens: num(r.totalTokens), cost: num(r.totalCostUSD), tools: 0, errors: 0, prompts: 0, files: 0, filesEdited: 0, events: 0 },
      share: {},
      segs: [], errs: [], ev: [],
    };
  }

  // normalize every event (full list — segments + totals use all of them)
  const evs = [];
  const shorten = makeShortener(r.cwd);
  let prevT = 0;
  for (const e of raw) {
    const t = Math.max(prevT, num(e.t));
    prevT = t;
    const split = splitTool(e);
    const tool = split.tool;
    const detail = e.kind === 'prompt' ? split.detail : shorten(split.detail);
    let state = SI[e.state] !== undefined ? e.state : 'thinking';
    if (e.kind === 'tool' && SEARCH_TOOLS.has(tool)) state = 'searching';
    if (e.kind === 'tool' && (tool === 'Task' || tool === 'Agent')) state = 'spawning';
    if (e.kind === 'error') state = 'error';
    evs.push({ t, kind: KIND_CODE[e.kind] || 'X', state, tool, detail: clean(detail, DETAIL_CAP), tokens: num(e.tokens), cost: num(e.costUSD) });
  }
  const n = evs.length;

  // compressed reel clock: long idle gaps are cut down to HOLD + IDLE_SHOW
  const comp = new Array(n);
  comp[0] = 0;
  for (let i = 1; i < n; i++) {
    const gap = evs[i].t - evs[i - 1].t;
    comp[i] = comp[i - 1] + (gap > IDLE_GAP_MS ? HOLD_MS + IDLE_SHOW_MS : gap);
  }
  let span = comp[n - 1];
  if (!(span > 0) && n > 1) { // every timestamp identical: space events evenly
    for (let i = 0; i < n; i++) comp[i] = i * 1000;
    span = comp[n - 1];
  }
  const endHold = span > 0 ? span * 0.02 : 3000;
  const tail = span > 0 ? span * 0.04 : 2000;
  const total = span + endHold + tail;

  let segs = [];
  let activeMs = 0;
  for (let i = 0; i < n; i++) {
    const s = SI[evs[i].state];
    const a = comp[i];
    if (i === n - 1) { segs.push([a, a + endHold, s]); break; }
    const gap = evs[i + 1].t - evs[i].t;
    activeMs += Math.min(gap, IDLE_GAP_MS);
    if (gap > IDLE_GAP_MS) {
      segs.push([a, a + HOLD_MS, s]);
      segs.push([a + HOLD_MS, comp[i + 1], SI.idle]);
    } else {
      segs.push([a, comp[i + 1], s]);
    }
  }
  // per-state share of the reel (before the closing "done" tail)
  const share = {};
  for (const [a, b, s] of segs) share[STATES[s]] = (share[STATES[s]] || 0) + (b - a);
  const shareTotal = span + endHold;
  for (const k of Object.keys(share)) share[k] = shareTotal > 0 ? r5(share[k] / shareTotal) : 0;

  segs.push([span + endHold, total, SI.done]);
  segs = mergeSegs(segs.map(([a, b, s]) => [a / total, b / total, s]));
  if (segs.length > MAX_SEGS) segs = binSegs(segs, MAX_SEGS);
  segs = segs.map(([a, b, s]) => [r5(a), r5(b), s]);

  // totals over the FULL list
  let tools = 0, errors = 0, prompts = 0;
  const files = new Set();
  const edited = new Set();
  const toolCount = new Array(n);
  for (let i = 0; i < n; i++) {
    const e = evs[i];
    if (e.kind === 'T') {
      tools++;
      if (FILE_TOOLS.has(e.tool) && e.detail) {
        const key = e.detail.toLowerCase().replace(/\\/g, '/');
        files.add(key);
        if (EDIT_TOOLS.has(e.tool)) edited.add(key);
      }
    } else if (e.kind === 'E') errors++;
    else if (e.kind === 'P') prompts++;
    toolCount[i] = tools;
  }
  const last = evs[n - 1];
  const totals = {
    tokens: Math.max(num(r.totalTokens), last.tokens),
    cost: r6(Math.max(num(r.totalCostUSD), last.cost)),
    tools, errors, prompts,
    files: files.size,
    filesEdited: edited.size,
    events: n,
  };

  const errs = [];
  const errSeen = new Set();
  for (let i = 0; i < n && errs.length < MAX_ERR_TICKS; i++) {
    if (evs[i].kind !== 'E') continue;
    const p = Math.round((comp[i] / total) * 2000) / 2000;
    if (errSeen.has(p)) continue;
    errSeen.add(p);
    errs.push(p);
  }

  // embedded events: [p, stateIdx, kind, tool, detail, tokens, cost, realT, toolCount]
  const keep = sampleIndices(evs.map((e) => e.state), maxEvents);
  const ev = keep.map((i) => {
    const e = evs[i];
    return [r5(comp[i] / total), SI[e.state], e.kind, e.tool, e.detail, Math.round(e.tokens), r6(e.cost), Math.round(e.t), toolCount[i]];
  });

  return {
    ...base,
    empty: false,
    durationMs: num(r.durationMs) || Math.max(0, last.t - evs[0].t),
    activeMs: Math.round(activeMs),
    totals, share, segs, errs, ev,
  };
}

// ── Page assets ──────────────────────────────────────────────────────────────
const CSS = `
:root{color-scheme:dark;
  --bg:#0b0e14;--bg2:#121722;--panel:#151b28;--line:#263043;--text:#eef2f8;--muted:#8d99ae;--accent:#7dd3fc;
  --s-thinking:#b18cff;--s-coding:#4f7cff;--s-reading:#22d3ee;--s-testing:#a3e635;--s-searching:#ffb020;
  --s-spawning:#ff6fb5;--s-error:#ff4d4d;--s-done:#3ddc97;--s-idle:#3a4356;--ink:#0b0e14}
:root[data-theme="light"]{color-scheme:light;
  --bg:#f4f6fa;--bg2:#ffffff;--panel:#ffffff;--line:#d9dfea;--text:#111827;--muted:#5b6578;--accent:#0369a1;
  --s-thinking:#8b5cf6;--s-coding:#2f5ee8;--s-reading:#0891b2;--s-testing:#65a30d;--s-searching:#d97706;
  --s-spawning:#db2777;--s-error:#dc2626;--s-done:#059669;--s-idle:#c6cdd9;--ink:#ffffff}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--text)}
body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:"Cascadia Mono",Consolas,"SF Mono",Menlo,"DejaVu Sans Mono",monospace}
#stage{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;padding:64px 96px 56px;
  display:grid;grid-template-rows:auto minmax(0,1fr) auto;row-gap:36px;overflow:hidden;
  background:radial-gradient(1200px 700px at 85% -10%,var(--bg2),transparent 70%),var(--bg)}
header{min-width:0}
.eyebrow{font-size:22px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}
h1{margin:12px 0 0;font-size:66px;line-height:1.06;font-weight:800;letter-spacing:-.02em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:1500px;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}
.chip{font-size:24px;padding:6px 16px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--panel);white-space:nowrap;max-width:720px;overflow:hidden;text-overflow:ellipsis}
.chip b{color:var(--text);font-weight:600}
main{display:grid;grid-template-columns:minmax(0,1fr) 540px;column-gap:48px;min-height:0}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:20px;min-height:0;overflow:hidden}
.ticker{display:flex;flex-direction:column;padding:22px 28px 14px}
.ptitle{font-size:20px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);display:flex;justify-content:space-between}
#list{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;margin-top:8px}
.row{display:grid;grid-template-columns:120px 14px 190px minmax(0,1fr) 128px;align-items:center;column-gap:16px;
  height:58px;flex:none;border-top:1px solid var(--line);transition:opacity .3s}
.row:first-child{border-top:0}
.row .tm{font-size:20px;color:var(--muted);text-align:right}
.row .dot{width:14px;height:14px;border-radius:50%}
.row .tool{font-size:25px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .det{font-size:22px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .st{font-size:16px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;text-align:right;color:var(--muted)}
.row.k-E .tool,.row.k-E .det{color:var(--s-error)}
.row.k-P .det{color:var(--text);font-style:italic}
.row.enter{animation:enter .35s ease-out both}
@keyframes enter{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
.side{display:grid;grid-template-rows:auto minmax(0,1fr) minmax(0,1fr) auto;gap:16px;min-height:0}
.now{display:flex;align-items:center;gap:18px;padding:16px 26px}
.now .lbl{font-size:20px;font-weight:700;letter-spacing:.16em;color:var(--muted)}
.now .pill{font-size:34px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:6px 22px;border-radius:12px;color:var(--ink);transition:background .2s}
.ctr{padding:14px 26px;display:flex;flex-direction:column;justify-content:center}
.ctr .lbl{font-size:20px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.ctr .big{font-size:70px;line-height:1;margin:6px 0 4px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}
.ctr .sub{font-size:20px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.mini{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.mini .big{font-size:48px}
footer{min-width:0}
.axis{display:flex;justify-content:space-between;font-size:20px;color:var(--muted);height:30px;position:relative}
#clock{position:absolute;top:0;transform:translateX(-50%);font-size:22px;font-weight:700;color:var(--text);white-space:nowrap}
#ticks{position:relative;height:16px;margin-top:4px}
#ticks i{position:absolute;bottom:2px;width:3px;height:12px;margin-left:-1px;border-radius:2px;background:var(--s-error)}
#ribbon{position:relative;height:72px;border-radius:14px;overflow:hidden;background:var(--s-idle);cursor:pointer}
#ribbon .seg{position:absolute;top:0;bottom:0}
#ribbon .seg span{position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:18px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink);white-space:nowrap}
#veil{position:absolute;top:0;bottom:0;right:0;background:var(--bg);opacity:.62;pointer-events:none}
#head{position:absolute;top:-10px;bottom:-10px;width:4px;margin-left:-2px;background:var(--text);border-radius:2px;pointer-events:none;box-shadow:0 0 0 2px var(--bg)}
.rwrap{position:relative}
.legend{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:20px;font-size:21px}
.legend span{display:flex;align-items:center;gap:8px;color:var(--muted)}
.legend span b{color:var(--text);font-weight:600}
.legend i{width:18px;height:18px;border-radius:5px;display:inline-block}
#controls{position:absolute;top:44px;right:64px;display:flex;gap:8px;transition:opacity .4s}
#controls button{font:inherit;font-size:20px;font-weight:700;min-width:56px;height:46px;padding:0 14px;border-radius:12px;border:1px solid var(--line);
  background:var(--panel);color:var(--text);cursor:pointer}
#controls button[aria-pressed="true"]{background:var(--text);color:var(--bg)}
#controls button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
body.idle-mouse #controls,body.no-controls #controls{opacity:0;pointer-events:none}
#summary{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(11,14,20,.84);background:color-mix(in srgb,var(--bg) 84%,transparent);
  opacity:0;pointer-events:none;transition:opacity .6s}
#summary.show{opacity:1;pointer-events:auto}
.card{width:1400px;padding:56px 64px;background:var(--panel);border:1px solid var(--line);border-radius:28px;box-shadow:0 30px 80px rgba(0,0,0,.35)}
.card h2{margin:10px 0 0;font-size:56px;line-height:1.1;font-weight:800;letter-spacing:-.02em;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:40px}
.tile{border:1px solid var(--line);border-radius:18px;padding:22px 28px;background:var(--bg2)}
.tile .v{font-size:64px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .k{font-size:21px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.tile .s{font-size:19px;color:var(--muted);margin-top:2px}
.sbar{display:flex;height:22px;border-radius:8px;overflow:hidden;margin-top:34px;background:var(--s-idle)}
.brand{margin-top:22px;font-size:20px;color:var(--muted);display:flex;justify-content:space-between}
#empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center}
body.is-empty #empty{display:flex}
body.is-empty main,body.is-empty footer,body.is-empty #controls{visibility:hidden}
#empty .big{font-size:84px;font-weight:800;letter-spacing:-.02em}
#empty p{font-size:28px;color:var(--muted);max-width:1200px;margin:16px auto 0}
`;

/* The browser half. Serialized with Function#toString, so it must be fully
   self-contained (no closures over module scope) and must never touch
   innerHTML with session data — textContent only. */
function clientMain() {
  var D;
  try { D = JSON.parse(document.getElementById('clip-data').textContent); } catch (e) { D = { empty: true, reason: 'Clip data could not be read.', ev: [], segs: [], errs: [], totals: {}, states: [], share: {} }; }
  var STATES = D.states || [];
  var q;
  try { q = new URLSearchParams(location.search); } catch (e) { q = { get: function () { return null; } }; }
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  var color = function (s) { return 'var(--s-' + (STATES[s] || 'idle') + ')'; };
  var ink = function (s) { return STATES[s] === 'idle' || !STATES[s] ? 'var(--text)' : 'var(--ink)'; };
  var clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };

  var th = q.get('theme');
  if (th === 'dark' || th === 'light') document.documentElement.setAttribute('data-theme', th);
  if (q.get('controls') === '0') document.body.classList.add('no-controls');
  var seconds = parseFloat(q.get('seconds'));
  if (!(seconds > 0)) seconds = D.seconds || 30;
  seconds = clamp(seconds, 1, 3600);
  var speed = parseFloat(q.get('speed'));
  if ([0.5, 1, 2].indexOf(speed) < 0) speed = 1;

  // ── formatting ──
  function fmtDur(ms) {
    ms = Math.max(0, ms || 0);
    var s = Math.round(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (m) return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
    return sec + 's';
  }
  function fmtTok(n) {
    n = Math.round(n || 0);
    if (n < 10000) return n.toLocaleString('en-US');
    var u = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
    var v = n / u[0];
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + u[1];
  }
  function fmtUsd(x) {
    x = x || 0;
    var dp = x > 0 && x < 0.1 ? 3 : 2;
    return '$' + x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function plural(n, w) { n = n || 0; return n.toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's'); }
  function label(s) { var n = STATES[s] || 'idle'; return n.charAt(0).toUpperCase() + n.slice(1); }

  // ── stage scaling: design once at 1920x1080, letterbox to any window ──
  var stage = $('stage');
  function fit() {
    var w = window.innerWidth || 1920, h = window.innerHeight || 1080;
    var s = Math.min(w / 1920, h / 1080);
    stage.style.transform = 'translate(' + ((w - 1920 * s) / 2) + 'px,' + ((h - 1080 * s) / 2) + 'px) scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ── static header ──
  var T = D.totals || {};
  $('title').textContent = D.title || 'Session replay';
  document.title = (D.title || 'Session replay') + ' · Gander replay';
  var meta = $('meta');
  function chip(k, v) { if (!v) return; var c = el('span', 'chip'); if (k) c.appendChild(document.createTextNode(k + ' ')); c.appendChild(el('b', null, v)); meta.appendChild(c); }
  chip('Project', D.project);
  chip('Duration', fmtDur(D.durationMs) + (D.activeMs && D.activeMs < D.durationMs * 0.9 ? ' · ' + fmtDur(D.activeMs) + ' active' : ''));
  chip('Model', D.model);
  chip('', fmtDate(D.startedAt));

  if (D.empty || !D.ev || !D.ev.length) {
    document.body.classList.add('is-empty');
    $('emptyWhy').textContent = D.reason || 'This session has no recorded activity yet.';
    window.__ganderClip = { seek: function () {}, play: function () {}, pause: function () {}, pos: function () { return 0; }, empty: true };
    return;
  }

  var EV = D.ev, SEG = D.segs || [];
  var P = 0, I_STATE = 1, I_KIND = 2, I_TOOL = 3, I_DET = 4, I_TOK = 5, I_USD = 6, I_REAL = 7, I_N = 8;

  // ── ribbon ──
  var ribbon = $('ribbon');
  for (var i = 0; i < SEG.length; i++) {
    var sg = SEG[i], seg = el('div', 'seg');
    seg.style.left = (sg[0] * 100) + '%';
    seg.style.width = ((sg[1] - sg[0]) * 100 + 0.02) + '%';
    seg.style.background = color(sg[2]);
    seg.title = label(sg[2]);
    if (sg[1] - sg[0] > 0.065) { var sp = el('span', null, label(sg[2])); sp.style.color = ink(sg[2]); seg.appendChild(sp); }
    ribbon.insertBefore(seg, $('veil'));
  }
  var ticks = $('ticks');
  (D.errs || []).forEach(function (p) { var t = el('i'); t.style.left = (p * 100) + '%'; t.title = 'error'; ticks.appendChild(t); });
  $('axStart').textContent = 'Start';
  $('axEnd').textContent = fmtDur(D.durationMs);

  // ── legend: every state present, with its share, text not color alone ──
  var legend = $('legend'), present = {};
  SEG.forEach(function (s) { present[s[2]] = 1; });
  for (var s = 0; s < STATES.length; s++) {
    if (!present[s]) continue;
    var item = el('span'), sw = el('i');
    sw.style.background = color(s);
    item.appendChild(sw);
    item.appendChild(el('b', null, label(s)));
    var sh = D.share && D.share[STATES[s]];
    if (sh) item.appendChild(document.createTextNode(' ' + Math.max(1, Math.round(sh * 100)) + '%'));
    legend.appendChild(item);
  }

  // ── ticker ──
  var TICK = [];
  for (i = 0; i < EV.length; i++) { var k = EV[i][I_KIND]; if (k === 'T' || k === 'E' || k === 'P') TICK.push(i); }
  var ROWS = 8, list = $('list'), rowCache = {}, shownTick = -1;
  function makeRow(idx) {
    var e = EV[idx], row = el('div', 'row k-' + e[I_KIND]);
    row.appendChild(el('span', 'tm mono', '+' + fmtDur(e[I_REAL] - EV[0][I_REAL])));
    var dot = el('span', 'dot'); dot.style.background = color(e[I_STATE]); row.appendChild(dot);
    row.appendChild(el('span', 'tool', e[I_KIND] === 'P' ? 'You' : e[I_TOOL]));
    row.appendChild(el('span', 'det' + (e[I_KIND] === 'P' ? '' : ' mono'), e[I_DET] || ''));
    row.appendChild(el('span', 'st', STATES[e[I_STATE]] || ''));
    return row;
  }
  function renderTicker(count, animate) { // count = how many TICK entries are visible
    if (count === shownTick) return;
    var from = Math.max(0, count - ROWS), keep = {}, nodes = [];
    for (var j = from; j < count; j++) {
      var idx = TICK[j], node = rowCache[idx];
      if (!node) { node = makeRow(idx); if (animate && j >= shownTick) node.classList.add('enter'); rowCache[idx] = node; }
      node.style.opacity = String(1 - (count - 1 - j) * 0.09);
      keep[idx] = 1; nodes.push(node);
    }
    for (var key in rowCache) if (!keep[key]) delete rowCache[key];
    while (list.firstChild) list.removeChild(list.firstChild);
    nodes.forEach(function (nd) { list.appendChild(nd); });
    $('tickCount').textContent = count ? count + ' / ' + TICK.length : '';
    shownTick = count;
  }

  // ── lookup helpers ──
  function lastEvAt(p) { // index of last EV with EV.p <= p, or -1
    var lo = 0, hi = EV.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (EV[mid][P] <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function stateAt(p) {
    var lo = 0, hi = SEG.length - 1, ans = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (SEG[mid][0] <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return SEG.length ? SEG[ans][2] : 0;
  }
  function tickCountAt(evIdx) { // TICK entries with EV index <= evIdx
    var lo = 0, hi = TICK.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (TICK[mid] <= evIdx) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans + 1;
  }

  // ── summary card ──
  $('sumTitle').textContent = D.title || 'Session replay';
  var grid = $('sumGrid');
  function tile(k, v, sub) { var t = el('div', 'tile'); t.appendChild(el('div', 'k', k)); t.appendChild(el('div', 'v', v)); if (sub) t.appendChild(el('div', 's', sub)); grid.appendChild(t); }
  tile('Tool calls', (T.tools || 0).toLocaleString('en-US'), plural(T.prompts, 'prompt') + ' · ' + plural(T.errors, 'error'));
  tile('Files touched', T.files ? String(T.files) : '—', T.files ? (T.filesEdited || 0) + ' edited' : 'no file tools');
  tile('Total cost', fmtUsd(T.cost), D.model || 'API-equivalent');
  tile('Duration', fmtDur(D.durationMs), D.activeMs ? fmtDur(D.activeMs) + ' active' : '');
  tile('Tokens', fmtTok(T.tokens), Math.round(T.tokens || 0).toLocaleString('en-US') + ' total');
  var topState = null, topShare = 0;
  for (var nm in (D.share || {})) if (nm !== 'idle' && D.share[nm] > topShare) { topShare = D.share[nm]; topState = nm; }
  tile('Mostly', topState ? topState.charAt(0).toUpperCase() + topState.slice(1) : '—', topState ? Math.round(topShare * 100) + '% of the reel' : '');
  var sbar = $('sumBar');
  SEG.forEach(function (sg2) { var b = el('div'); b.style.width = ((sg2[1] - sg2[0]) * 100) + '%'; b.style.background = color(sg2[2]); sbar.appendChild(b); });
  $('sumBrand').textContent = (D.project ? D.project + ' · ' : '') + fmtDate(D.startedAt);

  // ── frame render ──
  var pos = 0, playing = false, lastTs = null, raf = 0, prevIdx = -2;
  function render(animate) {
    var idx = lastEvAt(pos);
    var tok = 0, usd = 0, nt = 0, real = 0;
    if (idx >= 0) {
      var a = EV[idx], b = EV[idx + 1];
      var p1 = b ? b[P] : 1, f = p1 > a[P] ? clamp((pos - a[P]) / (p1 - a[P]), 0, 1) : 1;
      var tokB = b ? b[I_TOK] : Math.max(T.tokens || 0, a[I_TOK]);
      var usdB = b ? b[I_USD] : Math.max(T.cost || 0, a[I_USD]);
      var realB = b ? b[I_REAL] : EV[0][I_REAL] + (D.durationMs || 0);
      tok = a[I_TOK] + (tokB - a[I_TOK]) * f;
      usd = a[I_USD] + (usdB - a[I_USD]) * f;
      real = a[I_REAL] + Math.max(0, realB - a[I_REAL]) * f - EV[0][I_REAL];
      nt = a[I_N];
      if (pos >= 1) { tok = Math.max(T.tokens || 0, tok); usd = Math.max(T.cost || 0, usd); nt = T.tools || nt; }
    }
    $('tok').textContent = fmtTok(tok);
    $('tokSub').textContent = Math.round(tok).toLocaleString('en-US') + ' tokens';
    $('usd').textContent = fmtUsd(usd);
    $('nTools').textContent = String(nt);
    var ne = 0; (D.errs || []).forEach(function (p) { if (p <= pos) ne++; });
    $('nErr').textContent = String(ne);
    var st = stateAt(pos);
    var pill = $('pill');
    pill.textContent = label(st);
    pill.style.background = color(st);
    pill.style.color = ink(st);
    $('axStart').style.opacity = pos < 0.1 ? '0' : '1';
    $('axEnd').style.opacity = pos > 0.9 ? '0' : '1';
    var pct = (pos * 100) + '%';
    $('head').style.left = pct;
    $('veil').style.left = pct;
    var clock = $('clock');
    clock.textContent = 'T+ ' + fmtDur(real);
    clock.style.left = clamp(pos, 0.045, 0.955) * 100 + '%';
    if (idx !== prevIdx) { renderTicker(tickCountAt(idx), animate); prevIdx = idx; }
    $('summary').classList.toggle('show', pos >= 0.999);
  }

  function frame(ts) {
    raf = 0;
    if (!playing) return;
    if (lastTs != null) pos += (ts - lastTs) / (seconds * 1000) * speed;
    lastTs = ts;
    if (pos >= 1) { pos = 1; playing = false; syncBtn(); }
    render(true);
    if (playing) raf = requestAnimationFrame(frame);
  }
  function play() { if (pos >= 1) seek(0); playing = true; lastTs = null; syncBtn(); if (!raf) raf = requestAnimationFrame(frame); }
  function pause() { playing = false; syncBtn(); }
  function seek(p) { pos = clamp(+p || 0, 0, 1); shownTick = -1; rowCache = {}; prevIdx = -2; render(false); }
  function restart() { seek(0); play(); }

  // ── controls ──
  var btnPlay = $('bPlay');
  function syncBtn() { btnPlay.textContent = playing ? '❚❚ Pause' : '▶ Play'; btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
  btnPlay.addEventListener('click', function () { playing ? pause() : play(); });
  $('bRestart').addEventListener('click', restart);
  var speedBtns = document.querySelectorAll('[data-speed]');
  function syncSpeed() { for (var j = 0; j < speedBtns.length; j++) speedBtns[j].setAttribute('aria-pressed', String(+speedBtns[j].getAttribute('data-speed') === speed)); }
  for (var j = 0; j < speedBtns.length; j++) speedBtns[j].addEventListener('click', function () { speed = +this.getAttribute('data-speed'); syncSpeed(); });
  syncSpeed();
  ribbon.addEventListener('click', function (ev) { var r = ribbon.getBoundingClientRect(); seek((ev.clientX - r.left) / r.width); });
  document.addEventListener('keydown', function (ev) {
    if (ev.code === 'Space' || ev.key === ' ') { ev.preventDefault(); playing ? pause() : play(); }
    else if (ev.key === 'r' || ev.key === 'R') restart();
    else if (ev.key === 'ArrowRight') seek(pos + 0.05);
    else if (ev.key === 'ArrowLeft') seek(pos - 0.05);
  });
  var idleTimer = 0;
  function wake() { document.body.classList.remove('idle-mouse'); clearTimeout(idleTimer); idleTimer = setTimeout(function () { if (playing) document.body.classList.add('idle-mouse'); }, 2500); }
  document.addEventListener('mousemove', wake);
  wake();

  window.__ganderClip = { seek: function (p) { pause(); seek(p); }, play: play, pause: pause, pos: function () { return pos; }, empty: false };

  var tq = q.get('t');
  if (tq !== null && tq !== '' && isFinite(+tq)) { seek(+tq); syncBtn(); }
  else { seek(0); play(); }
}

// ── HTML ─────────────────────────────────────────────────────────────────────
function renderClip(replay, opts) {
  const data = prepare(replay, opts);
  const title = escapeHtml(data.title);
  return [
    '<!doctype html>',
    `<html lang="en" data-theme="${data.theme}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`,
    '<meta name="generator" content="Gander replay clip">',
    `<title>${title} · Gander replay</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    '<div id="stage">',
    '<header>',
    '<div class="eyebrow">Gander · Session replay</div>',
    `<h1 id="title">${title}</h1>`,
    '<div class="meta" id="meta"></div>',
    '</header>',
    '<main>',
    '<section class="panel ticker" aria-label="Latest tool events">',
    '<div class="ptitle"><span>Live activity</span><span id="tickCount"></span></div>',
    '<div id="list" aria-live="off"></div>',
    '</section>',
    '<aside class="side">',
    '<div class="panel now"><span class="lbl">NOW</span><span class="pill" id="pill">Idle</span></div>',
    '<div class="panel ctr"><div class="lbl">Tokens</div><div class="big" id="tok">0</div><div class="sub" id="tokSub"></div></div>',
    '<div class="panel ctr"><div class="lbl">Cost</div><div class="big" id="usd">$0.00</div><div class="sub">API-equivalent, cumulative</div></div>',
    '<div class="mini"><div class="panel ctr"><div class="lbl">Tool calls</div><div class="big" id="nTools">0</div></div>',
    '<div class="panel ctr"><div class="lbl">Errors</div><div class="big" id="nErr">0</div></div></div>',
    '</aside>',
    '</main>',
    '<footer>',
    '<div class="axis"><span id="axStart"></span><span id="clock"></span><span id="axEnd"></span></div>',
    '<div class="rwrap"><div id="ticks" aria-hidden="true"></div>',
    '<div id="ribbon" role="img" aria-label="Session state timeline"><div id="veil"></div><div id="head"></div></div></div>',
    '<div class="legend" id="legend"></div>',
    '</footer>',
    '<div id="controls" role="toolbar" aria-label="Playback">',
    '<button id="bRestart" type="button" aria-label="Restart">⟲ Restart</button>',
    '<button id="bPlay" type="button" aria-label="Play">▶ Play</button>',
    '<button type="button" data-speed="0.5">0.5x</button>',
    '<button type="button" data-speed="1">1x</button>',
    '<button type="button" data-speed="2">2x</button>',
    '</div>',
    '<div id="summary" aria-live="polite"><div class="card">',
    '<div class="eyebrow">Session wrapped</div>',
    '<h2 id="sumTitle"></h2>',
    '<div class="grid" id="sumGrid"></div>',
    '<div class="sbar" id="sumBar" aria-hidden="true"></div>',
    '<div class="brand"><span id="sumBrand"></span><span>Replayed with Gander</span></div>',
    '</div></div>',
    '<div id="empty"><div><div class="big">Nothing to replay</div><p id="emptyWhy"></p></div></div>',
    '</div>',
    '<noscript><p style="position:fixed;bottom:8px;left:8px">This replay needs JavaScript to play.</p></noscript>',
    `<script type="application/json" id="clip-data">${safeJson(data)}</script>`,
    `<script>(${clientMain.toString()})();</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

module.exports = { renderClip, _test: { prepare, splitTool, sampleIndices, makeShortener, safeJson, escapeHtml, STATES } };
