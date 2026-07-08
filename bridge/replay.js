'use strict';
// Gander session replay — turn a session transcript (.jsonl) into a scrubber-
// friendly timeline: chronological events (prompts, assistant text, tool calls,
// errors, done) each stamped with ms-since-start plus CUMULATIVE tokens/cost,
// so "what did that agent do for 40 minutes and $6" is answerable in a glance.
// Deterministic: parsed from ~/.claude transcripts. No model calls, costs nothing.
//
// Public API:  module.exports = { build }
//   build(sessionId, opts?) -> { ok:true, sessionId, project, cwd, startedAt,
//     endedAt, durationMs, totalTokens, totalCostUSD, events:[...] } | { ok:false, error }
//   opts.file — explicit transcript path (tests); otherwise the transcript is
//   located under ~/.claude/projects like transcript.js does.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// Reuse the shipped tool → dashboard-state mapping + human detail strings.
const { stateForTool, detailForTool } = require('./parser.js');
// Reuse the shipped price table (USD per 1M tokens, keyed by model-family substring).
const { PRICING } = require('./usage.js');

const SESSION_ID_RE = /^[\w-]+$/;
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const MAX_EVENTS = 2000;   // keep the FIRST 2000, then one synthetic truncation note
const LABEL_CAP = 90;

// ── Pricing (same scheme as usage.js: case-insensitive substring, unknown = $0) ──
function rateFor(model) {
  const m = String(model || '').toLowerCase();
  for (const key of Object.keys(PRICING)) {
    if (m.includes(key)) return PRICING[key];
  }
  if (m.includes('mythos')) return PRICING.fable; // usage.js prices Mythos as Fable
  return null; // unknown / local model → unpriced
}

function costOf(model, u) {
  const r = rateFor(model);
  if (!r) return 0;
  return (
    (u.input / 1e6) * r.input +
    (u.output / 1e6) * r.output +
    (u.cacheWrite / 1e6) * r.cacheWrite +
    (u.cacheRead / 1e6) * r.cacheRead
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────
function head(s, cap = LABEL_CAP) {
  if (s == null) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > cap ? one.slice(0, cap - 1) + '…' : one;
}

/** Flatten a tool_result content field (string | block array) to plain text. */
function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' ? b.text || '' : String(b)))
      .join(' ');
  }
  if (typeof content === 'object') return content.text || '';
  return String(content);
}

/** Extract the plain text of a user prompt (string content or text blocks). */
function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && b.text) parts.push(b.text);
  }
  return parts.join(' ');
}

/**
 * Scan PROJECTS_ROOT for <sessionId>.jsonl — direct children plus one level
 * of subdirectories (sub-agent sessions), same approach as transcript.js.
 */
function findFile(sessionId) {
  const target = sessionId + '.jsonl';
  let projectDirs;
  try { projectDirs = fs.readdirSync(PROJECTS_ROOT); } catch (_) { return null; }

  for (const dirName of projectDirs) {
    const dirPath = path.join(PROJECTS_ROOT, dirName);
    let stat;
    try { stat = fs.statSync(dirPath); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;

    const direct = path.join(dirPath, target);
    if (fs.existsSync(direct)) return direct;

    let sub;
    try { sub = fs.readdirSync(dirPath); } catch (_) { continue; }
    for (const subName of sub) {
      const subPath = path.join(dirPath, subName);
      let subStat;
      try { subStat = fs.statSync(subPath); } catch (_) { continue; }
      if (!subStat.isDirectory()) continue;
      const nested = path.join(subPath, target);
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
}

function streamLines(file, onObj) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
    } catch (e) {
      return reject(e);
    }
    stream.on('error', reject);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return; } // skip bad lines
      try { onObj(obj); } catch (_) { /* never let one record break the stream */ }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// ── Core build ───────────────────────────────────────────────────────────────
/**
 * Build the replay timeline for a session.
 * @param {string} sessionId
 * @param {object} [opts]  opts.file — explicit transcript path (tests)
 * @returns {Promise<object>} { ok:true, ...timeline } or { ok:false, error }
 */
async function build(sessionId, opts = {}) {
  let filePath;
  if (opts.file) {
    filePath = opts.file;
    if (!fs.existsSync(filePath)) return { ok: false, error: 'session not found' };
  } else {
    if (!sessionId || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      return { ok: false, error: 'invalid session id' };
    }
    filePath = findFile(sessionId);
    if (!filePath) return { ok: false, error: 'session not found' };
  }

  let cwd = null;
  let startMs = null;   // first parseable timestamp in the file = session start
  let lastMs = null;    // last parseable timestamp seen
  let cumTokens = 0;
  let cumCost = 0;
  let dropped = 0;      // events past the MAX_EVENTS cap
  const seen = new Set(); // dedup streaming partials (same requestId / message id)
  const events = [];

  // t (ms since start) for the current line; timestamps are optional per line,
  // so a missing one inherits the last known clock position.
  const tOf = (obj) => {
    const ms = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!isNaN(ms)) {
      if (startMs === null) startMs = ms;
      lastMs = ms;
    }
    return lastMs !== null && startMs !== null ? lastMs - startMs : 0;
  };

  const push = (t, ts, kind, state, label) => {
    if (events.length >= MAX_EVENTS) { dropped++; return; }
    events.push({ t, ts, kind, state, label, tokens: cumTokens, costUSD: cumCost });
  };

  try {
    await streamLines(filePath, (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (!cwd && obj.cwd) cwd = obj.cwd;

      // Meta lines (caveats, command echoes) aren't operator or agent activity.
      if (obj.isMeta) return;

      const type = obj.type;
      if (type !== 'user' && type !== 'assistant') return;
      const msg = obj.message;
      if (!msg || typeof msg !== 'object') return;

      const t = tOf(obj);
      const ts = obj.timestamp || null;

      if (type === 'assistant') {
        // Dedup streaming duplicates: the same response is logged many times
        // under one requestId / message id — count (and show) it once.
        const dedupId = obj.requestId || msg.id;
        if (dedupId) {
          if (seen.has(dedupId)) return;
          seen.add(dedupId);
        }

        // Price this message's usage exactly like usage.js, then every event
        // it produces carries the new cumulative totals.
        if (msg.usage) {
          const u = {
            input: Number(msg.usage.input_tokens) || 0,
            output: Number(msg.usage.output_tokens) || 0,
            cacheWrite: Number(msg.usage.cache_creation_input_tokens) || 0,
            cacheRead: Number(msg.usage.cache_read_input_tokens) || 0,
          };
          cumTokens += u.input + u.output + u.cacheWrite + u.cacheRead;
          cumCost += costOf(msg.model, u);
        }

        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && block.text && block.text.trim()) {
            push(t, ts, 'text', 'thinking', head(block.text));
          } else if (block.type === 'tool_use') {
            const name = block.name || 'tool';
            const input = block.input || {};
            push(t, ts, 'tool', stateForTool(name, input), head(detailForTool(name, input)));
          }
        }
        return;
      }

      // type === 'user'
      const content = msg.content;
      if (Array.isArray(content)) {
        let sawToolResult = false;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type !== 'tool_result') continue;
          sawToolResult = true;
          if (block.is_error) {
            push(t, ts, 'error', 'error', head(resultText(block.content)) || 'tool error');
          }
          // successful tool_results are noise on a timeline — skip
        }
        if (sawToolResult) return;
      }

      // Plain text = the operator's turn start.
      const text = promptText(content).trim();
      if (text) push(t, ts, 'prompt', 'thinking', head(text));
    });
  } catch (e) {
    return { ok: false, error: 'could not read session: ' + e.message };
  }

  if (dropped > 0) {
    const t = lastMs !== null && startMs !== null ? lastMs - startMs : 0;
    events.push({
      t,
      ts: lastMs !== null ? new Date(lastMs).toISOString() : null,
      kind: 'done',
      state: 'idle',
      label: `…timeline truncated: ${dropped} more event${dropped === 1 ? '' : 's'} not shown`,
      tokens: cumTokens,
      costUSD: cumCost,
    });
  }

  const durationMs = startMs !== null && lastMs !== null ? Math.max(0, lastMs - startMs) : 0;

  return {
    ok: true,
    sessionId: sessionId || null,
    // split on BOTH separators — a transcript written on Windows can be parsed
    // on Linux (CI), where path.basename() won't split "C:\a\b"
    project: cwd ? (String(cwd).split(/[\\/]/).filter(Boolean).pop() || null) : null,
    cwd: cwd || null,
    startedAt: startMs !== null ? new Date(startMs).toISOString() : null,
    endedAt: lastMs !== null ? new Date(lastMs).toISOString() : null,
    durationMs,
    totalTokens: cumTokens,
    totalCostUSD: cumCost,
    events,
  };
}

module.exports = { build, _test: { rateFor, costOf, head, findFile } };
