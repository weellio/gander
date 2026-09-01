'use strict';
// bridge/forensics.js — spend forensics: where the tokens actually went, and
// whether the spend was worth it. Deterministic, zero model calls — one
// streaming pass over ~/.claude transcripts + git, like usage.js and patterns.js.
//
//   SF3 waste scan       — the same file re-read many times in one session
//                          (context churn), and MCP servers declared but never
//                          called (context you pay for every turn, unused).
//   SF1 productive spend — each session's cost joined with whether its project
//                          landed a commit around then: shipped vs exploratory.
//
// The analysis logic is pure (computeWaste / computeProductivity) so it's
// unit-testable; the I/O wrappers around it are thin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const RE_READ_THRESHOLD = 3;   // one session reading one file this many times = churn
const COMMIT_WINDOW_MIN = 90;  // a commit within this of a session's last activity = it shipped

// ── transcript scan (incremental cache, mirrors patterns.js) ──────────────────
function transcriptFiles(root, sinceMs, cap) {
  const files = [];
  let dirs; try { dirs = fs.readdirSync(root); } catch (_) { return files; }
  for (const d of dirs) {
    let names; try { names = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of names) {
      const p = path.join(root, d, f);
      try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs) files.push({ p, mtime: st.mtimeMs, size: st.size }); } catch (_) {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, cap);
}

// Parse ONE transcript: per-file Read/Edit counts + MCP servers called.
// Day-independent, so a cached entry stays valid as the window slides.
async function parseFile(p) {
  const r = { proj: '', reads: {}, mcp: {}, edits: {}, bashN: 0, searchN: 0, taskN: 0 };
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"assistant"')) { if (!r.proj && line.includes('"cwd"')) { const m = line.match(/"cwd":"([^"]+)"/); if (m) r.proj = path.basename(m[1].replace(/\\\\/g, '/')); } continue; }
    if (!line.includes('"tool_use"')) continue;
    if (line.length > 2_000_000) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (!r.proj && o.cwd) r.proj = path.basename(String(o.cwd));
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const name = b.name || '';
      const fp = b.input && b.input.file_path ? String(b.input.file_path) : '';
      if (name === 'Read' && fp) r.reads[fp] = (r.reads[fp] || 0) + 1;
      else if ((name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') && fp) r.edits[fp] = (r.edits[fp] || 0) + 1;
      else if (name === 'Bash') r.bashN++;
      else if (name === 'Grep' || name === 'Glob' || name === 'WebSearch' || name === 'WebFetch') r.searchN++;
      else if (name === 'Task' || name === 'Agent') r.taskN++;
      else if (name.startsWith('mcp__')) { const server = name.split('__')[1] || name; r.mcp[server] = (r.mcp[server] || 0) + 1; }
    }
  }
  return r;
}

// ── pure analysis ─────────────────────────────────────────────────────────────
// perSession: [{ session, proj, reads:{path:n}, mcp:{server:n} }]
// declaredMcp: string[] of MCP servers configured anywhere.
function computeWaste(perSession, declaredMcp) {
  const reReads = [];
  const usedServers = new Set();
  for (const s of perSession) {
    for (const [server] of Object.entries(s.mcp || {})) usedServers.add(server);
    for (const [file, n] of Object.entries(s.reads || {})) {
      if (n >= RE_READ_THRESHOLD) reReads.push({ project: s.proj || '', session: s.session, file, reads: n });
    }
  }
  reReads.sort((a, b) => b.reads - a.reads);
  const deadMcp = [...new Set(declaredMcp || [])].filter((m) => !usedServers.has(m)).sort();
  return {
    reReads: reReads.slice(0, 40),
    reReadTotal: reReads.length,
    deadMcp,
    usedMcp: [...usedServers].sort(),
  };
}

// SF2 edit quality — how often an edit lands first try. A file edited exactly
// once in a session = one-shot; edited multiple times = reworked (iterating,
// or fixing a bad edit). oneShotRate is the share of edited files that stuck.
// cost-per-edit needs the window's total spend, passed in.
function computeEditQuality(perSession, totalCostUSD) {
  let oneShot = 0, reworked = 0, edits = 0;
  const reworkedTop = [];
  for (const s of perSession) {
    for (const [file, n] of Object.entries(s.edits || {})) {
      edits += n;
      if (n === 1) oneShot++;
      else { reworked++; reworkedTop.push({ project: s.proj || '', session: s.session, file, edits: n }); }
    }
  }
  reworkedTop.sort((a, b) => b.edits - a.edits);
  const editedFiles = oneShot + reworked;
  return {
    edits, editedFiles, oneShot, reworked,
    oneShotRate: editedFiles > 0 ? Math.round((oneShot / editedFiles) * 100) : null,
    costPerEdit: edits > 0 && totalCostUSD > 0 ? totalCostUSD / edits : null,
    reworkedTop: reworkedTop.slice(0, 8),
  };
}

// SF4 task-type breakdown — classify each session by its dominant tool
// activity and attribute its cost there, so you can see whether the money
// went to writing code, exploring, running things, searching, or delegating.
// sessionsWithCost: [{ session, costUSD, edits:{},reads:{}, bashN,searchN,taskN }]
const TASK_TYPES = { coding: 'edited files', exploring: 'reading files', running: 'running commands', searching: 'searching', orchestrating: 'delegating to sub-agents' };
function classifySession(s) {
  const code = Object.values(s.edits || {}).reduce((a, b) => a + b, 0);
  const read = Object.values(s.reads || {}).reduce((a, b) => a + b, 0);
  const scores = { coding: code * 2, exploring: read, running: s.bashN || 0, searching: (s.searchN || 0) * 1.5, orchestrating: (s.taskN || 0) * 3 };
  let best = null, top = 0;
  for (const [k, v] of Object.entries(scores)) if (v > top) { top = v; best = k; }
  return top > 0 ? best : null;
}
function computeTaskTypes(sessionsWithCost) {
  const by = {};
  let total = 0;
  for (const s of sessionsWithCost || []) {
    const cost = Number(s.costUSD) || 0;
    const t = classifySession(s);
    if (!t || cost <= 0) continue;
    (by[t] || (by[t] = { type: t, label: TASK_TYPES[t], costUSD: 0, sessions: 0 })).costUSD += cost;
    by[t].sessions++;
    total += cost;
  }
  const list = Object.values(by).sort((a, b) => b.costUSD - a.costUSD)
    .map((x) => ({ ...x, pct: total > 0 ? Math.round((x.costUSD / total) * 100) : 0 }));
  return { byType: list, total };
}

// Join sessions (cost + lastActive + project) with commits (project + time).
// A session "shipped" if a commit in its project landed within COMMIT_WINDOW_MIN
// of its last activity. commitsByProject: { [projectName]: number[] (ms epochs) }
function computeProductivity(sessions, commitsByProject, windowMin) {
  const win = (windowMin || COMMIT_WINDOW_MIN) * 60000;
  let productiveCost = 0, abandonedCost = 0, productive = 0, abandoned = 0;
  const abandonedTop = [];
  for (const s of sessions || []) {
    const cost = Number(s.costUSD) || 0;
    const la = typeof s.lastActive === 'number' ? s.lastActive : Date.parse(s.lastActive);   // usage stores ISO strings
    if (cost <= 0 || !la) continue;
    const commits = commitsByProject[s.project] || commitsByProject[s.projectPath] || [];
    const shipped = commits.some((c) => Math.abs(c - la) <= win);
    if (shipped) { productive++; productiveCost += cost; }
    else { abandoned++; abandonedCost += cost; abandonedTop.push({ project: s.project, costUSD: cost, lastActive: s.lastActive }); }
  }
  abandonedTop.sort((a, b) => b.costUSD - a.costUSD);
  const total = productiveCost + abandonedCost;
  return {
    productive, abandoned,
    productiveCost, abandonedCost,
    shippedPct: total > 0 ? Math.round((productiveCost / total) * 100) : null,
    abandonedTop: abandonedTop.slice(0, 12),
  };
}

// Declared MCP servers: global (~/.claude.json mcpServers) + each project's .mcp.json.
function declaredMcpServers(projectPaths) {
  const out = new Set();
  try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); for (const k of Object.keys(j.mcpServers || {})) out.add(k); } catch (_) {}
  for (const p of projectPaths || []) {
    try { const m = JSON.parse(fs.readFileSync(path.join(p, '.mcp.json'), 'utf8')); for (const k of Object.keys(m.mcpServers || {})) out.add(k); } catch (_) {}
  }
  return [...out];
}

// ── public: run the waste scan over the last N days ───────────────────────────
const _cache = new Map();   // path -> { mtime, size, ...parseFile }
async function scanWaste(opts = {}) {
  const t0 = Date.now();
  const days = Math.max(1, Math.min(90, Number(opts.days) || 30));
  const root = opts.root || path.join(os.homedir(), '.claude', 'projects');
  const files = transcriptFiles(root, Date.now() - days * 86400e3, 400);
  const perSession = [];
  const live = new Set();
  for (const f of files) {
    live.add(f.p);
    let ent = _cache.get(f.p);
    if (!ent || ent.mtime !== f.mtime || ent.size !== f.size) {
      ent = { mtime: f.mtime, size: f.size, ...(await parseFile(f.p)) };
      _cache.set(f.p, ent);
    }
    perSession.push({ session: path.basename(f.p).replace(/\.jsonl$/i, ''), proj: ent.proj, reads: ent.reads, mcp: ent.mcp, edits: ent.edits });
  }
  for (const k of [..._cache.keys()]) if (!live.has(k)) _cache.delete(k);
  const declared = declaredMcpServers(opts.projectPaths);
  return {
    ...computeWaste(perSession, declared),
    editQuality: computeEditQuality(perSession, Number(opts.totalCostUSD) || 0),
    _perSession: perSession,   // raw, for the endpoint's task-type join; stripped before sending
    days, scanMs: Date.now() - t0,
  };
}

// Commit timestamps (ms epochs) for a repo over the last N days — precise time
// (%at) so SF1 can window-join against a session's last activity.
function commitTimes(cwd, days) {
  return new Promise((resolve) => {
    require('child_process').execFile('git', ['-C', cwd, 'log', `--since=${days}.days`, '--pretty=format:%at', '-n', '200'],
      { timeout: 12000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout || '').split('\n').map((l) => Number(l) * 1000).filter((n) => Number.isFinite(n) && n > 0));
      });
  });
}

module.exports = { scanWaste, computeWaste, computeEditQuality, computeTaskTypes, computeProductivity, declaredMcpServers, commitTimes, RE_READ_THRESHOLD, COMMIT_WINDOW_MIN };
