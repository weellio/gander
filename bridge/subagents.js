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
const statCache = new Map();   // file -> { offset, tail, s }
function blankStats(agentId) {
  return {
    agentId, model: '', cwd: '', startedAt: 0, endedAt: 0, toolUses: 0, turns: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
  };
}
function foldLine(s, line) {
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  const ts = Date.parse(j.timestamp || '') || 0;
  if (ts) { if (!s.startedAt || ts < s.startedAt) s.startedAt = ts; if (ts > s.endedAt) s.endedAt = ts; }
  if (j.cwd && !s.cwd) s.cwd = String(j.cwd);
  const m = j.message || {};
  if (m.model) s.model = String(m.model);
  const u = m.usage;
  if (u) {
    s.turns++;
    s.tokens.input += Number(u.input_tokens) || 0;
    s.tokens.output += Number(u.output_tokens) || 0;
    s.tokens.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
    s.tokens.cacheRead += Number(u.cache_read_input_tokens) || 0;
  }
  if (Array.isArray(m.content)) {
    for (const b of m.content) if (b && b.type === 'tool_use') s.toolUses++;
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
  if (!c) { c = { offset: 0, tail: '', s: blankStats(agentId) }; statCache.set(file, c); }

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
        for (const l of lines) { if (l.trim()) foldLine(c.s, l); }
      }
      c.offset = pos;
    } finally { fs.closeSync(fd); }
  }
  const s = c.s;
  s.tokens.total = s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead;
  s.durationMs = s.endedAt && s.startedAt ? s.endedAt - s.startedAt : 0;
  s.fileMtime = st.mtimeMs;
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

// One entry per sub-agent, newest first. `days` bounds the scan by file mtime.
function roster(opts = {}) {
  const now = opts.now || Date.now();
  const days = opts.days === undefined ? 14 : Number(opts.days);
  const since = days > 0 ? now - days * 86400e3 : 0;
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 400));
  const dirs = opts.dir ? [opts.dir] : allDirs(0);
  const rows = [];
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
      rows.push({
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
      });
    }
  }
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const kept = rows.slice(0, limit);
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
    costUSD: s ? cost(s.tokens, priceFor ? priceFor(s.model) : null) : 0,
  };
}

module.exports = {
  PROJECTS, dirFor, meta, forget, stats, cost, roster, describe, allDirs,
  _reset: () => { metaCache.clear(); statCache.clear(); dirsCache = { at: 0, list: [] }; },
};
