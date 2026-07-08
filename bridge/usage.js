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
  fable:  { input: 10, output: 50, cacheWrite: 12.50, cacheRead: 1.00 },  // Fable 5 / Mythos 5
};
const ZERO = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

// Optional per-model price overrides from bridge/aoc-config.json, so non-Anthropic
// or local backends (e.g. routed through claude-code-router) get priced correctly:
//   { "pricing": { "deepseek": { "input": 0.27, "output": 1.10 },
//                  "gemini-2.5-flash": { "input": 0.30, "output": 2.50 } } }
// Keys match as case-insensitive substrings of the model id (first hit wins);
// cacheWrite/cacheRead default to 1.25x / 0.1x input if you omit them.
const CONFIG_PATH = path.join(__dirname, 'aoc-config.json');
function pricingOverrides() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); return c && c.pricing && typeof c.pricing === 'object' ? c.pricing : {}; }
  catch (_) { return {}; }
}
function normRate(r) {
  r = r || {};
  const inp = Number(r.input) || 0;
  return {
    input: inp,
    output: Number(r.output) || 0,
    cacheWrite: r.cacheWrite != null ? Number(r.cacheWrite) || 0 : inp * 1.25,
    cacheRead: r.cacheRead != null ? Number(r.cacheRead) || 0 : inp * 0.1,
  };
}

function rateFor(model, overrides) {
  const m = String(model || '').toLowerCase();
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      if (key && m.includes(String(key).toLowerCase())) return normRate(overrides[key]);
    }
  }
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('sonnet')) return PRICING.sonnet;
  if (m.includes('haiku')) return PRICING.haiku;
  if (m.includes('fable') || m.includes('mythos')) return PRICING.fable;
  return ZERO;   // non-Claude / local / unknown → unpriced unless set in config.pricing
}

// Context window (tokens) per model — for the "how full / near auto-compact" gauge.
// Claude Code auto-compacts as the context approaches the model limit, so fill %
// (latest turn's context size ÷ this) is a usable "compact soon" signal.
function contextMaxFor(model, observed) {
  // Current Claude models are 200k context; some offer a 1M beta window. We can't
  // always tell the window from the id, so if a turn's observed context already
  // exceeds 200k the session must be on the larger window — step up so the fill %
  // stays meaningful instead of pinning at 100%.
  if (observed && observed > 200000) return 1000000;
  return 200000;
}

function costOf(model, input, output, cacheWrite, cacheRead, overrides) {
  const r = rateFor(model, overrides);
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
  const overrides = pricingOverrides();   // per-model price overrides (config) — for non-Claude backends

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

  // Rolling 5-hour window — the granularity subscription plans meter on. Pure
  // "recent burn" telemetry: how much landed in the last 5h across all sessions.
  // (The window's actual reset time comes live from dispatch rate_limit_events.)
  const windowStartMs = Date.now() - 5 * 3600 * 1000;
  const window5h = { costUSD: 0, tokens: 0, outputTokens: 0, messages: 0 };

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
      const cost = costOf(model, input, output, cacheWrite, cacheRead, overrides);

      // rolling 5h window
      if (ts) {
        const tms = Date.parse(ts);
        if (tms >= windowStartMs) { window5h.costUSD += cost; window5h.tokens += tokens; window5h.outputTokens += output; window5h.messages++; }
      }

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
        p = { path: cwd, tokens: 0, costUSD: 0, sessions: new Set(), lastActive: null, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        projects.set(pk, p);
      }
      p.tokens += tokens;
      p.costUSD += cost;
      p.input += input;
      p.output += output;
      p.cacheWrite += cacheWrite;
      p.cacheRead += cacheRead;
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
        s = {
          sessionId, project: cwd, tokens: 0, costUSD: 0, lastActive: null,
          input: 0, output: 0, cacheWrite: 0, cacheRead: 0, outputCost: 0,
          ctxTokens: 0, ctxModel: model, ctxTs: null,
        };
        sessions.set(sessionId, s);
      }
      s.tokens += tokens;
      s.costUSD += cost;
      s.input += input;
      s.output += output;
      s.cacheWrite += cacheWrite;
      s.cacheRead += cacheRead;
      s.outputCost += (output / 1e6) * rateFor(model, overrides).output;
      if (ts && (!s.lastActive || ts > s.lastActive)) s.lastActive = ts;
      // Latest turn's context size = everything fed to the model that turn
      // (fresh input + cache write + cache read). Tracks the most recent turn so
      // ctxTokens reflects "how full is it right now", which drives the fill gauge.
      if (!s.ctxTs || (ts && ts >= s.ctxTs)) {
        s.ctxTs = ts;
        s.ctxTokens = input + cacheWrite + cacheRead;
        s.ctxModel = model;
      }
    });
  }

  // byProject
  const byProject = Array.from(projects.values())
    .map((p) => {
      const inputSide = p.input + p.cacheWrite + p.cacheRead;
      return {
        project: basenameOf(p.path),
        path: p.path,
        tokens: p.tokens,
        costUSD: p.costUSD,
        sessions: p.sessions.size,
        lastActive: p.lastActive,
        // why two projects with very different token counts can cost the same:
        effRate: p.tokens > 0 ? p.costUSD / (p.tokens / 1e6) : 0,   // $ per million tokens
        cacheHit: inputSide > 0 ? p.cacheRead / inputSide : 0,      // share of input-side tokens served from cache
      };
    })
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

  // bySession — cost/tokens + efficiency gauges keyed by sessionId, for live
  // per-agent lookup in the agent modal:
  //   outShare  — output's share of spend (output is 5x input; high = verbose)
  //   cacheHit  — fraction of input-side tokens served from cache (high = efficient)
  //   ctxPct    — latest turn's context ÷ model limit (high = near auto-compact)
  const bySession = {};
  for (const s of sessions.values()) {
    const inputSide = s.input + s.cacheWrite + s.cacheRead;
    const ctxMax = contextMaxFor(s.ctxModel, s.ctxTokens);
    bySession[s.sessionId] = {
      costUSD: s.costUSD,
      tokens: s.tokens,
      input: s.input,
      output: s.output,
      cacheWrite: s.cacheWrite,
      cacheRead: s.cacheRead,
      outShare: s.costUSD > 0 ? s.outputCost / s.costUSD : 0,
      cacheHit: inputSide > 0 ? s.cacheRead / inputSide : 0,
      ctxTokens: s.ctxTokens,
      ctxMax,
      ctxPct: ctxMax > 0 ? Math.min(1, s.ctxTokens / ctxMax) : 0,
    };
  }

  return {
    totals,
    byProject,
    byModel,
    byDay,
    topSessions,
    bySession,
    window5h,
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
    window5h: { costUSD: 0, tokens: 0, outputTokens: 0, messages: 0 },
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
