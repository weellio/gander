'use strict';

// Token-usage & cost analytics over Claude Code session transcripts.
// Streams ~/.claude/projects/<encoded-cwd>/<session>.jsonl line-by-line (readline),
// aggregates token usage from assistant-message lines, and prices it.
//
// Public API:  module.exports = { summary }
// summary() is cached in-module with a 60s TTL.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ---------------------------------------------------------------------------
// PRICING — USD per 1,000,000 tokens. Edit here to update rates.
// Matched against the model id by substring (first hit wins). Unknown -> sonnet.
// ---------------------------------------------------------------------------
const PRICING = {
  opus:   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  sonnet: { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  haiku:  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
};

function rateFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('sonnet')) return PRICING.sonnet;
  if (m.includes('haiku')) return PRICING.haiku;
  return PRICING.sonnet; // default
}

function costOf(model, input, output, cacheWrite, cacheRead) {
  const r = rateFor(model);
  return (
    (input / 1e6) * r.input +
    (output / 1e6) * r.output +
    (cacheWrite / 1e6) * r.cacheWrite +
    (cacheRead / 1e6) * r.cacheRead
  );
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const TTL_MS = 60 * 1000;
let _cache = null;
let _cacheAt = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Decode an encoded dir name back into something path-like, used only as a
// fallback when a line has no cwd. e.g. "d--Files-sourcecode-Claude-Dashboard".
function decodeDirName(name) {
  if (!name) return '';
  // Leading "<drive>--" -> "<drive>:\", remaining "-" -> "\"
  const m = name.match(/^([a-zA-Z])--(.*)$/);
  if (m) return m[1] + ':\\' + m[2].replace(/-/g, '\\');
  return name.replace(/-/g, path.sep);
}

function basenameOf(p) {
  if (!p) return '(unknown)';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

function dayKey(ts) {
  // 'YYYY-MM-DD' in local time
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function listJsonlFiles(root) {
  // Recursive: transcripts live at <encoded-cwd>/<session>.jsonl AND nested
  // sub-agent transcripts at <encoded-cwd>/<session>/subagents/agent-*.jsonl.
  // `dir` is kept as the top-level encoded-cwd dir name for the decode fallback.
  const out = [];
  const walk = (dir, topDir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, topDir);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: full, dir: topDir });
    }
  };
  let top;
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const d of top) if (d.isDirectory()) walk(path.join(root, d.name), d.name);
  return out;
}

function streamLines(file, onObj) {
  return new Promise((resolve) => {
    let stream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
    } catch (_) {
      return resolve();
    }
    stream.on('error', () => resolve());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        return; // skip bad lines
      }
      try {
        onObj(obj);
      } catch (_) {
        /* never let one record break the stream */
      }
    });
    rl.on('close', resolve);
    rl.on('error', () => resolve());
  });
}

// Canonicalise a path for display (uppercase Windows drive letter).
function canonPath(p) {
  if (!p || typeof p !== 'string') return p;
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}
// Case-insensitive grouping key (Windows paths differ only by drive-letter case).
function projKey(p) { return process.platform === 'win32' ? String(p).toLowerCase() : p; }

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------
async function build() {
  const root = projectsRoot();
  const entries = listJsonlFiles(root);

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
  };

  const projects = new Map(); // cwd -> acc
  const models = new Map();   // model -> acc
  const days = new Map();     // 'YYYY-MM-DD' -> { costUSD, tokens }
  const sessions = new Map(); // sessionId -> acc

  for (const entry of entries) {
    const sessionId = path.basename(entry.file).replace(/\.jsonl$/i, '');
    // Dedup streaming partials: same request/message id is logged many times.
    const seen = new Set();

    await streamLines(entry.file, (o) => {
      if (!o || o.type !== 'assistant') return;
      const msg = o.message;
      if (!msg || !msg.usage) return;

      const u = msg.usage;
      const input = Number(u.input_tokens) || 0;
      const output = Number(u.output_tokens) || 0;
      const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
      const cacheRead = Number(u.cache_read_input_tokens) || 0;

      // Skip duplicate streaming lines for the same response.
      const dedupId = o.requestId || (msg && msg.id);
      if (dedupId) {
        if (seen.has(dedupId)) return;
        seen.add(dedupId);
      }

      const model = msg.model || 'unknown';
      const cwd = canonPath(o.cwd || decodeDirName(entry.dir));
      const ts = o.timestamp || null;
      const tokens = input + output + cacheWrite + cacheRead;
      const cost = costOf(model, input, output, cacheWrite, cacheRead);

      // totals
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.cacheWriteTokens += cacheWrite;
      totals.cacheReadTokens += cacheRead;
      totals.totalTokens += tokens;
      totals.costUSD += cost;

      // by project (case-insensitive key so D:\ and d:\ merge; keep first display path)
      const pk = projKey(cwd);
      let p = projects.get(pk);
      if (!p) {
        p = { path: cwd, tokens: 0, costUSD: 0, sessions: new Set(), lastActive: null };
        projects.set(pk, p);
      }
      p.tokens += tokens;
      p.costUSD += cost;
      p.sessions.add(sessionId);
      if (ts && (!p.lastActive || ts > p.lastActive)) p.lastActive = ts;

      // by model
      let m = models.get(model);
      if (!m) {
        m = { model, tokens: 0, costUSD: 0 };
        models.set(model, m);
      }
      m.tokens += tokens;
      m.costUSD += cost;

      // by day
      const dk = ts && dayKey(ts);
      if (dk) {
        let dd = days.get(dk);
        if (!dd) {
          dd = { costUSD: 0, tokens: 0 };
          days.set(dk, dd);
        }
        dd.costUSD += cost;
        dd.tokens += tokens;
      }

      // by session
      let s = sessions.get(sessionId);
      if (!s) {
        s = { sessionId, project: cwd, tokens: 0, costUSD: 0, lastActive: null };
        sessions.set(sessionId, s);
      }
      s.tokens += tokens;
      s.costUSD += cost;
      if (ts && (!s.lastActive || ts > s.lastActive)) s.lastActive = ts;
    });
  }

  // byProject
  const byProject = Array.from(projects.values())
    .map((p) => ({
      project: basenameOf(p.path),
      path: p.path,
      tokens: p.tokens,
      costUSD: p.costUSD,
      sessions: p.sessions.size,
      lastActive: p.lastActive,
    }))
    .sort((a, b) => b.costUSD - a.costUSD);

  // byModel
  const byModel = Array.from(models.values()).sort((a, b) => b.costUSD - a.costUSD);

  // byDay — last 30 calendar days incl. zero days
  const byDay = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const key = `${y}-${mo}-${da}`;
    const hit = days.get(key);
    byDay.push({ date: key, costUSD: hit ? hit.costUSD : 0, tokens: hit ? hit.tokens : 0 });
  }

  // topSessions — top 10 by cost
  const topSessions = Array.from(sessions.values())
    .map((s) => ({
      sessionId: s.sessionId,
      project: basenameOf(s.project),
      costUSD: s.costUSD,
      tokens: s.tokens,
      lastActive: s.lastActive,
    }))
    .sort((a, b) => b.costUSD - a.costUSD)
    .slice(0, 10);

  // bySession — cost/tokens keyed by sessionId, for live per-agent lookup
  const bySession = {};
  for (const s of sessions.values()) bySession[s.sessionId] = { costUSD: s.costUSD, tokens: s.tokens };

  return {
    totals,
    byProject,
    byModel,
    byDay,
    topSessions,
    bySession,
    generatedAt: new Date().toISOString(),
    fileCount: entries.length,
  };
}

// summary() — public, cached. NOTE: build() is async (readline), but the
// route calls summary() synchronously. We resolve the async build into the
// cache and serve the cached value; the very first call returns an empty
// shell and warms the cache. In practice this is called repeatedly (polling),
// so callers get real data within one TTL window. If you prefer a guaranteed
// fresh first response, await summaryAsync() instead.
let _building = false;

function emptyShape() {
  const byDay = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    byDay.push({ date: `${y}-${mo}-${da}`, costUSD: 0, tokens: 0 });
  }
  return {
    totals: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0 },
    byProject: [],
    byModel: [],
    byDay,
    topSessions: [],
    bySession: {},
    generatedAt: new Date().toISOString(),
    fileCount: 0,
  };
}

async function summaryAsync() {
  const now = Date.now();
  if (_cache && now - _cacheAt < TTL_MS) return _cache;
  _cache = await build();
  _cacheAt = Date.now();
  return _cache;
}

// Synchronous-facing API expected by the route (sendJson(res, 200, usage.summary())).
// Returns the cached value if fresh; otherwise kicks off a rebuild and returns
// the last-known cache (or an empty shell on the very first call).
function summary() {
  const now = Date.now();
  if (_cache && now - _cacheAt < TTL_MS) return _cache;

  if (!_building) {
    _building = true;
    build()
      .then((res) => {
        _cache = res;
        _cacheAt = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        _building = false;
      });
  }

  return _cache || emptyShape();
}

module.exports = { summary, summaryAsync, PRICING };
