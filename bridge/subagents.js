'use strict';
// Sub-agents, read from what Claude Code writes to disk.
//
// Every sub-agent the Agent tool spawns leaves two files behind:
//
//   ~/.claude/projects/<project-slug>/<sessionId>/subagents/
//       agent-<agentId>.jsonl        the sub-agent's own transcript (usage per turn)
//       agent-<agentId>.meta.json    { agentType, description, toolUseId, spawnDepth, requestShape }
//
// `description` is the human name the Agent tool was called with ("Write teams.js
// unit tests") — the same label Claude Code's own agent map shows, and far more
// useful on the floor than the generic "general-purpose". The transcript carries
// the tokens, so cost and duration come from the same place.
//
// These files OUTLIVE the session, so this also gives a roster of every sub-agent
// ever run, long after its tile has clocked out.
//
// The hook that tells us a sub-agent exists carries `transcript_path` for the
// PARENT session (…/<sessionId>.jsonl); the sub-agent folder sits right next to
// it at …/<sessionId>/subagents, so no path guessing is needed.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = () => process.env.GANDER_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

// …/projects/<slug>/<sessionId>.jsonl  ->  …/projects/<slug>/<sessionId>/subagents
function dirFor(transcriptPath) {
  const t = String(transcriptPath || '');
  if (!t) return '';
  return path.join(t.replace(/\.jsonl$/i, ''), 'subagents');
}

// ── metadata (tiny file, cached forever — it never changes after spawn) ──────
const metaCache = new Map();   // agentId -> { description, agentType, … } | null
function meta(agentId, dir) {
  if (!agentId) return null;
  if (metaCache.has(agentId)) {
    const hit = metaCache.get(agentId);
    if (hit) return hit;                       // negative results are retried below
  }
  const dirs = dir ? [dir] : allDirs();
  for (const d of dirs) {
    const f = path.join(d, `agent-${agentId}.meta.json`);
    try {
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const out = {
        description: String(j.description || '').slice(0, 200),
        agentType: String(j.agentType || '').slice(0, 80),
        toolUseId: j.toolUseId || undefined,
        background: j.requestShape === 'background',
        dir: d,
      };
      metaCache.set(agentId, out);
      return out;
    } catch (_) {}
  }
  metaCache.set(agentId, null);                // remember the miss, but allow a later retry
  return null;
}
// the meta file is written at spawn; if a hook beats it to disk, this clears the miss
function forget(agentId) { metaCache.delete(agentId); }

// ── transcript stats, read incrementally (byte offset per file) ─────────────
const statCache = new Map();   // file -> { offset, tail, s, end }
function blankStats(agentId) {
  return {
    agentId, model: '', cwd: '', startedAt: 0, endedAt: 0, toolUses: 0, turns: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
    toolErrors: 0, endedOnError: false,
  };
}

// A tool_result with is_error that is really the HUMAN saying no (permission
// prompt declined) — not the agent failing, so it never counts as an error.
const REJECTED = /doesn['’]t want to proceed|tool use was rejected|user (?:has )?(?:denied|rejected)/i;
function resultText(b) {
  const c = b && b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return '';
}

// `end` tracks how the transcript finishes, folded line by line so the
// incremental reader never has to look back:
//   last: ''         nothing seen yet
//         'final'    an assistant line with text and no tool call (the agent's answer)
//         'tool_use' an assistant line that called a tool (still working / cut off)
//         'result'   a user line carrying tool results
//   lastResultError: was the most recent (non-rejection) tool_result an error?
function foldLine(s, line, end) {
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  const ts = Date.parse(j.timestamp || '') || 0;
  if (ts) { if (!s.startedAt || ts < s.startedAt) s.startedAt = ts; if (ts > s.endedAt) s.endedAt = ts; }
  if (j.cwd && !s.cwd) s.cwd = String(j.cwd);
  const m = j.message || {};
  if (m.model) s.model = String(m.model);
  const u = m.usage;
  if (u) {
    // Claude Code writes one line per content block (thinking / text / tool_use)
    // of the SAME API message, each repeating that message's usage — with
    // output_tokens growing as it streams. Count each message once, at its
    // latest usage: replace the earlier line's contribution, don't add to it.
    const now = {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheWrite: Number(u.cache_creation_input_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
    };
    const id = (end && (m.id || j.requestId)) || '';
    const prev = id ? end.msgs.get(id) : null;
    if (!prev) s.turns++;
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) s.tokens[k] += now[k] - (prev ? prev[k] : 0);
    if (id) end.msgs.set(id, now);
  }
  if (!Array.isArray(m.content)) return;
  const role = m.role || j.type;
  let toolUse = 0, text = false, results = 0;
  for (const b of m.content) {
    if (!b) continue;
    if (b.type === 'tool_use') { s.toolUses++; toolUse++; }
    else if (b.type === 'text' && String(b.text || '').trim()) text = true;
    else if (b.type === 'tool_result') {
      if (b.is_error === true && REJECTED.test(resultText(b))) continue;   // human said no
      results++;
      const err = b.is_error === true;
      if (err) s.toolErrors++;
      if (end) end.lastResultError = err;
    }
  }
  if (!end) return;
  if (role === 'assistant') {
    if (toolUse) end.last = 'tool_use';
    else if (text) end.last = 'final';
    // thinking-only lines leave the state alone
  } else if (results) {
    end.last = 'result';
  }
}
function stats(agentId, dir) {
  const md = meta(agentId, dir);
  const d = dir || (md && md.dir) || '';
  if (!d) return null;
  const file = path.join(d, `agent-${agentId}.jsonl`);
  let st; try { st = fs.statSync(file); } catch (_) { return null; }

  let c = statCache.get(file);
  if (c && st.size < c.offset) c = null;                 // truncated/rotated → start over
  if (!c) { c = { offset: 0, tail: '', s: blankStats(agentId), end: { last: '', lastResultError: false, msgs: new Map() } }; statCache.set(file, c); }

  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size - c.offset, 8 * 1024 * 1024));
      let pos = c.offset, left = st.size - c.offset;
      while (left > 0) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
        if (n <= 0) break;
        pos += n; left -= n;
        const chunk = c.tail + buf.toString('utf8', 0, n);
        const lines = chunk.split('\n');
        c.tail = lines.pop();
        for (const l of lines) { if (l.trim()) foldLine(c.s, l, c.end); }
      }
      c.offset = pos;
    } finally { fs.closeSync(fd); }
  }
  const s = c.s;
  s.tokens.total = s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead;
  s.durationMs = s.endedAt && s.startedAt ? s.endedAt - s.startedAt : 0;
  s.fileMtime = st.mtimeMs;
  // ended badly = no closing answer from the agent, or its last tool call failed
  s.finished = c.end.last === 'final';
  s.endedOnError = !s.finished || c.end.lastResultError;
  return s;
}

// ── cost (same rule as everywhere else: unpriced model = $0, never guessed) ──
function cost(tokens, price) {
  if (!price || !tokens) return 0;
  const cr = price.cacheRead !== undefined ? price.cacheRead : (price.input || 0) * 0.1;
  const cw = price.cacheWrite !== undefined ? price.cacheWrite : (price.input || 0) * 1.25;
  return ((tokens.input || 0) * (price.input || 0)
        + (tokens.output || 0) * (price.output || 0)
        + (tokens.cacheRead || 0) * cr
        + (tokens.cacheWrite || 0) * cw) / 1e6;
}

// ── discovery across every project + session on this machine ────────────────
let dirsCache = { at: 0, list: [] };
function allDirs(maxAgeMs = 10000) {
  if (Date.now() - dirsCache.at < maxAgeMs) return dirsCache.list;
  const out = [];
  const root = PROJECTS();
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) {}
  for (const p of projects) {
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(root, p), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) {}
    for (const sdir of sessions) {
      const sub = path.join(root, p, sdir, 'subagents');
      try { if (fs.existsSync(sub)) out.push(sub); } catch (_) {}
    }
  }
  dirsCache = { at: Date.now(), list: out };
  return out;
}

const projectOf = (cwd) => path.basename(String(cwd || '').replace(/^\\\\\?\\/, '')) || '';
const sessionOfDir = (d) => path.basename(path.dirname(d));

// Every sub-agent on disk inside the date window, newest first (unlimited).
// `days` bounds the scan by transcript mtime. Shared by roster() and scorecard().
// Each entry is { row, mtime, finished } — mtime/finished stay out of the row.
function collect(opts = {}) {
  const now = opts.now || Date.now();
  const days = opts.days === undefined ? 14 : Number(opts.days);
  const since = days > 0 ? now - days * 86400e3 : 0;
  const dirs = opts.dir ? [opts.dir] : allDirs(0);
  const out = [];
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => /^agent-.*\.meta\.json$/.test(f)); } catch (_) { continue; }
    for (const f of files) {
      const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      const jsonl = path.join(d, `agent-${agentId}.jsonl`);
      let st; try { st = fs.statSync(jsonl); } catch (_) { continue; }
      if (since && st.mtimeMs < since) continue;
      const md = meta(agentId, d) || {};
      const s = stats(agentId, d);
      if (!s) continue;
      out.push({
        mtime: st.mtimeMs,
        finished: !!s.finished,
        row: {
          agentId,
          sessionId: sessionOfDir(d),
          project: projectOf(s.cwd),
          description: md.description || '',
          agentType: md.agentType || '',
          background: !!md.background,
          model: s.model,
          tokens: { ...s.tokens },   // copy: stats() returns a live cache object that keeps growing
          costUSD: cost(s.tokens, opts.priceFor ? opts.priceFor(s.model) : null),
          durationMs: s.durationMs,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          toolUses: s.toolUses,
          turns: s.turns,
          toolErrors: s.toolErrors,
          endedOnError: !!s.endedOnError,
        },
      });
    }
  }
  out.sort((a, b) => (b.row.startedAt || 0) - (a.row.startedAt || 0));
  return out;
}

// One entry per sub-agent, newest first. `days` bounds the scan by file mtime.
function roster(opts = {}) {
  const now = opts.now || Date.now();
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 400));
  const kept = collect(opts).slice(0, limit).map((e) => e.row);
  const sum = (f) => kept.reduce((n, r) => n + (f(r) || 0), 0);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const today = kept.filter((r) => r.endedAt >= dayStart.getTime());
  return {
    subagents: kept,
    totals: {
      count: kept.length, today: today.length,
      tokens: sum((r) => r.tokens.total), costUSD: sum((r) => r.costUSD),
      tokensToday: today.reduce((n, r) => n + r.tokens.total, 0),
      costToday: today.reduce((n, r) => n + r.costUSD, 0),
      toolUses: sum((r) => r.toolUses),
    },
    byType: Object.values(kept.reduce((m, r) => {
      const k = r.agentType || 'unknown';
      m[k] = m[k] || { agentType: k, count: 0, tokens: 0, costUSD: 0 };
      m[k].count++; m[k].tokens += r.tokens.total; m[k].costUSD += r.costUSD;
      return m;
    }, {})).sort((a, b) => b.tokens - a.tokens),
  };
}

// Agent scorecards: how well each sub-agent TYPE works, so you can see which
// ones are worth reaching for. Same opts as roster() (days, dir, now, priceFor),
// plus `limit` (default 2000 — scorecards want every run in the window) and
// `liveMs` (default 120000): a run with no closing answer whose transcript was
// written in the last liveMs is still in flight and is left out, so a busy agent
// never shows up as one that "ended on error".
//   toolErrorRate   = tool errors per 100 tool uses (1 decimal)
//   endedOnErrorPct = % of runs with no final answer or a failing last tool call
//   sample: 'small' when runs < 3 — too few to judge, the UI should say so
const SMALL_SAMPLE = 3;
const round = (n, dp) => { const f = 10 ** dp; return Math.round((Number(n) || 0) * f) / f; };
function scorecard(opts = {}) {
  const now = opts.now || Date.now();
  const liveMs = opts.liveMs === undefined ? 120000 : Math.max(0, Number(opts.liveMs) || 0);
  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 2000));
  const groups = new Map();
  for (const e of collect(opts).slice(0, limit)) {
    if (!e.finished && liveMs && now - e.mtime < liveMs) continue;   // still running
    const r = e.row;
    const k = r.agentType || 'unknown';
    let g = groups.get(k);
    if (!g) { g = { agentType: k, runs: 0, cost: 0, dur: 0, tools: 0, errors: 0, ended: 0, last: 0 }; groups.set(k, g); }
    g.runs++;
    g.cost += r.costUSD || 0;
    g.dur += r.durationMs || 0;
    g.tools += r.toolUses || 0;
    g.errors += r.toolErrors || 0;
    if (r.endedOnError) g.ended++;
    const at = r.endedAt || r.startedAt || 0;
    if (at > g.last) g.last = at;
  }
  const out = [...groups.values()].map((g) => {
    const row = {
      agentType: g.agentType,
      runs: g.runs,
      avgCostUSD: round(g.cost / g.runs, 6),
      avgDurationMs: Math.round(g.dur / g.runs),
      avgToolUses: round(g.tools / g.runs, 1),
      toolErrorRate: g.tools ? round((g.errors / g.tools) * 100, 1) : 0,
      endedOnErrorPct: Math.round((g.ended / g.runs) * 100),
      totalCostUSD: round(g.cost, 6),
      lastRunAt: g.last,
    };
    if (g.runs < SMALL_SAMPLE) row.sample = 'small';
    return row;
  });
  out.sort((a, b) => (b.runs - a.runs) || (b.lastRunAt - a.lastRunAt) || a.agentType.localeCompare(b.agentType));
  return out;
}

// What a live tile should show for this sub-agent: its real task name + spend.
function describe(agentId, transcriptPath, priceFor) {
  const dir = dirFor(transcriptPath);
  const md = meta(agentId, dir && fs.existsSync(dir) ? dir : undefined);
  if (!md) { forget(agentId); return null; }        // meta not on disk yet — retry next event
  const s = stats(agentId, md.dir || dir);
  return {
    name: md.description || md.agentType || '',
    agentType: md.agentType || '',
    background: !!md.background,
    tokens: s ? { ...s.tokens } : null,
    model: s ? s.model : '',
    durationMs: s ? s.durationMs : 0,
    toolUses: s ? s.toolUses : 0,
    toolErrors: s ? s.toolErrors : 0,
    costUSD: s ? cost(s.tokens, priceFor ? priceFor(s.model) : null) : 0,
  };
}

module.exports = {
  PROJECTS, dirFor, meta, forget, stats, cost, roster, scorecard, describe, allDirs,
  _reset: () => { metaCache.clear(); statCache.clear(); dirsCache = { at: 0, list: [] }; },
};
