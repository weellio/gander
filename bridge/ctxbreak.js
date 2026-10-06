'use strict';
// What is filling a session's context window.
//
// The gauge (usage.js) says how FULL the window is: the latest assistant turn's
// input + cache write + cache read. This module says WHAT is in there, so the user
// can act on it (/compact, or stop re-reading that 4,000-line file).
//
// Only what is in context right now counts. A compaction writes
//
//   { type:"system", subtype:"compact_boundary", compactMetadata:{ preTokens, postTokens?,
//     preservedMessages:{ uuids:[…] } } }
//   { type:"user", isCompactSummary:true, message:{ content:"This session is being continued…" } }
//
// and everything before the boundary is gone, except the few messages listed in
// preservedMessages (a partial compact keeps the last exchange). So a boundary
// RESETS the tallies; the preserved messages are re-added from a small rolling
// window of recent per-message contributions.
//
// Where the characters go:
//   conversation  user-typed text + assistant text (+ pasted images)
//   thinking      assistant thinking blocks
//   toolCalls     tool_use inputs (JSON length)
//   toolResults   tool_result content, per tool name (via tool_use_id), images = 1600 tokens
//   injected      <system-reminder> blocks, isMeta lines, rendered attachments
//                 (CLAUDE.md, memory, hook output, skill listings, date, env…)
//   summary       the compact summary itself
//
// The transcript never shows the system prompt or the tool definitions, so the
// characters can only ever account for part of the real total. breakdown() turns
// characters into tokens (~4 chars/token) and calls the remainder 'baseline'. If
// the estimate overshoots the real total, the visible part is scaled down to fit.
//
// Reading follows sessionmeta.js: incremental by byte offset, at most 1 MB inline,
// anything bigger caught up in the background 1 MB at a time with a setImmediate
// between steps. A cold read of a big transcript first scans for the LAST
// compaction boundary (a raw byte search, ~1 ms per MB) and only parses from a
// little before it, since everything earlier is out of context anyway.

const fs = require('fs');
const { StringDecoder } = require('string_decoder');

const STEP = 1024 * 1024;          // bytes per bounded step
const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1600;
const IMAGE_CHARS = IMAGE_TOKENS * CHARS_PER_TOKEN;
const TOP_N = 8;
const BIG_RESULT_CHARS = 1000 * CHARS_PER_TOKEN;   // "big" tool result: about 1k tokens or more
const MAX_NAMES = 5000;            // tool_use_id -> { name, detail }
const MAX_RECENT = 400;            // per-message contributions kept for preserved segments
const BACKUP = 16 * 1024 * 1024;   // parse this far before the last boundary (preserved messages live there)
const MARK = Buffer.from('"subtype":"compact_boundary"');
// A thinking block whose text is not stored still carries its encrypted form in
// `signature` (base64). Measured on real transcripts: ~1200 chars of fixed overhead,
// the rest grows with the hidden thinking. A rough guess, but better than calling
// those tokens "system prompt".
const SIG_OVERHEAD = 1200;

const CATS = ['conversation', 'thinking', 'toolCalls', 'toolResults', 'injected', 'summary'];
const LABELS = {
  conversation: 'Conversation',
  thinking: 'Claude’s thinking',
  toolCalls: 'Tool calls',
  toolResults: 'Tool results',
  injected: 'Injected context (CLAUDE.md, reminders)',
  summary: 'Compact summary',
  // the remainder: real total minus what the transcript shows. It holds the system prompt and tool
  // definitions, but ALSO estimation error (hidden thinking, ~4 chars/token being generous for code),
  // so it is labelled as "not shown", not claimed to be the system prompt (measured: 87k here vs a 34k prompt).
  baseline: 'Not shown in the transcript (system prompt, tools, estimate gap)',
};
const NOTE = 'Shares are estimated from the transcript (about 4 characters per token), scaled to the real total Claude Code reported.';
const NOTE_NO_TOTAL = 'Shares are estimated from the transcript (about 4 characters per token). Claude Code has not reported a context size since the last compaction yet, so there is no real total to scale to.';

// ---------------------------------------------------------------------------
// tallies
// ---------------------------------------------------------------------------
function zeroCat() { const o = {}; for (const k of CATS) o[k] = 0; return o; }

function blank() {
  return {
    cat: zeroCat(), byTool: new Map(), biggest: [], results: 0, bigResults: 0,
    ctx: 0, ctxId: '', model: '', since: '', compactions: 0,
    names: new Map(), recent: new Map(),
  };
}

// Never mutate cat/byTool/biggest/recent in place on a reset: view() folds the
// unfinished last line into a shallow clone that shares these with the real state.
function resetAt(s, j) {
  s.cat = zeroCat(); s.byTool = new Map(); s.biggest = []; s.results = 0; s.bigResults = 0;
  const md = j.compactMetadata || {};
  s.ctx = Number(md.postTokens) || 0;   // provisional: the real size arrives with the next turn
  s.ctxId = '';
  s.compactions++;
  if (j.timestamp) s.since = String(j.timestamp);
  const keep = md.preservedMessages && Array.isArray(md.preservedMessages.uuids) ? md.preservedMessages.uuids : [];
  const old = s.recent;
  s.recent = new Map();
  for (const u of keep) { const d = old.get(u); if (d) { apply(s, d); s.recent.set(u, d); } }
}

function pushBiggest(s, r) {
  const b = s.biggest;
  if (b.length >= TOP_N && r.chars <= b[b.length - 1].chars) return;
  const out = b.slice();
  let i = out.length;
  while (i > 0 && out[i - 1].chars < r.chars) i--;
  out.splice(i, 0, { tool: r.tool, detail: r.detail, chars: r.chars });
  if (out.length > TOP_N) out.length = TOP_N;
  s.biggest = out;
}

function apply(s, d) {
  for (const k of CATS) if (d.cat[k]) s.cat[k] += d.cat[k];
  for (const r of d.results) {
    s.byTool.set(r.tool, (s.byTool.get(r.tool) || 0) + r.chars);
    s.results++;
    if (r.chars >= BIG_RESULT_CHARS) s.bigResults++;
    pushBiggest(s, r);
  }
}

// ---------------------------------------------------------------------------
// one transcript line -> contribution
// ---------------------------------------------------------------------------
// <system-reminder>…</system-reminder> spans count as injected, the rest as `rest`.
function splitReminders(str) {
  const OPEN = '<system-reminder>', CLOSE = '</system-reminder>';
  let inj = 0, i = 0;
  for (;;) {
    const a = str.indexOf(OPEN, i);
    if (a < 0) break;
    const b = str.indexOf(CLOSE, a + OPEN.length);
    const end = b < 0 ? str.length : b + CLOSE.length;
    inj += end - a;
    i = end;
  }
  return { injected: inj, rest: str.length - inj };
}

function isImage(b) { return b && (b.type === 'image' || b.type === 'document'); }

function oneLine(v) { return String(v).replace(/\s+/g, ' ').trim().slice(0, 120); }

function detailOf(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['file_path', 'command', 'pattern', 'url', 'path', 'query', 'skill', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) return oneLine(input[k]);
  }
  return '';
}

function remember(s, id, name, detail) {
  if (!id) return;
  if (s.names.size >= MAX_NAMES && !s.names.has(id)) s.names.delete(s.names.keys().next().value);
  s.names.set(id, { name: String(name || 'unknown'), detail });
}

// text-ish content (string or blocks) -> adds to d.cat[into], reminders to injected
function addText(d, content, into) {
  if (typeof content === 'string') {
    const p = splitReminders(content);
    d.cat.injected += p.injected; d.cat[into] += p.rest;
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') addText(d, b.text, into);
    else if (isImage(b)) d.cat[into] += IMAGE_CHARS;
  }
}

function resultChars(d, content) {
  // returns tool-result chars; reminders inside a result go to injected
  if (typeof content === 'string') {
    const p = splitReminders(content);
    d.cat.injected += p.injected;
    return p.rest;
  }
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      const p = splitReminders(b.text);
      d.cat.injected += p.injected; n += p.rest;
    } else if (isImage(b)) n += IMAGE_CHARS;
    else n += JSON.stringify(b).length;
  }
  return n;
}

function userDelta(s, j, d) {
  const content = j.message && j.message.content;
  if (j.isCompactSummary) {
    d.cat.summary += typeof content === 'string' ? content.length : JSON.stringify(content || '').length;
    return;
  }
  if (j.isMeta) { addText(d, content, 'injected'); return; }
  if (typeof content === 'string') { addText(d, content, 'conversation'); return; }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_result') {
      const hit = s.names.get(b.tool_use_id);
      const chars = resultChars(d, b.content);
      d.cat.toolResults += chars;
      d.results.push({ tool: hit ? hit.name : 'unknown', detail: hit ? hit.detail : '', chars });
    } else if (b.type === 'text' && typeof b.text === 'string') addText(d, b.text, 'conversation');
    else if (isImage(b)) d.cat.conversation += IMAGE_CHARS;
  }
}

function assistantDelta(s, j, d) {
  const m = j.message || {};
  if (m.model === '<synthetic>') return false;   // local placeholder, never sent
  // message.model drops the window suffix ("claude-opus-5-5" vs the attachment's
  // "claude-opus-5-5[1m]"): keep the longer id when it names the same model
  if (m.model && !(s.model && s.model.indexOf(String(m.model)) === 0)) s.model = String(m.model);
  const u = m.usage;
  if (u && typeof u === 'object') {
    const ctx = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
    // lines sharing one message.id repeat the same usage: the latest line wins, never summed
    if (ctx > 0) { s.ctx = ctx; s.ctxId = String(m.id || ''); }
  }
  const content = m.content;
  if (typeof content === 'string') { d.cat.conversation += content.length; return true; }
  if (!Array.isArray(content)) return true;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') d.cat.conversation += b.text.length;
    else if (b.type === 'thinking') {
      const t = typeof b.thinking === 'string' ? b.thinking.length : 0;
      const sig = typeof b.signature === 'string' ? b.signature.length : 0;
      d.cat.thinking += t || Math.max(0, Math.round((sig - SIG_OVERHEAD) * 0.75));
    } else if (b.type === 'redacted_thinking') {
      d.cat.thinking += Math.round((typeof b.data === 'string' ? b.data.length : 0) * 0.75);
    } else if (b.type === 'tool_use') {
      remember(s, b.id, b.name, detailOf(b.input));
      d.cat.toolCalls += String(b.name || '').length + JSON.stringify(b.input == null ? {} : b.input).length;
    }
  }
  return true;
}

function attachmentDelta(s, j, d) {
  const a = j.attachment || {};
  if (a.type === 'model' && a.identity && a.identity.modelId) s.model = String(a.identity.modelId);
  if (!Array.isArray(j.rendered)) return;          // not sent to the model (snapshots, records…)
  // a message typed while Claude was busy arrives as an attachment, but it is conversation
  const into = a.type === 'queued_command' ? 'conversation' : 'injected';
  for (const r of j.rendered) {
    if (!r) continue;
    const c = r.content;
    if (typeof c === 'string') d.cat[into] += c.length;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string') d.cat[into] += b.text.length;
        else if (isImage(b)) d.cat[into] += IMAGE_CHARS;
      }
    }
  }
}

function foldObj(s, j) {
  if (!j || typeof j !== 'object' || j.isSidechain) return;
  if (j.type === 'system') {
    if (j.subtype === 'compact_boundary') resetAt(s, j);
    return;
  }
  if (j.type !== 'user' && j.type !== 'assistant' && j.type !== 'attachment') return;
  if (!s.since && j.timestamp) s.since = String(j.timestamp);
  const d = { cat: zeroCat(), results: [] };
  if (j.type === 'user') userDelta(s, j, d);
  else if (j.type === 'assistant') { if (!assistantDelta(s, j, d)) return; }
  else attachmentDelta(s, j, d);
  if (j.uuid) {
    if (s.recent.size >= MAX_RECENT) s.recent.delete(s.recent.keys().next().value);
    s.recent.set(String(j.uuid), d);
  }
  apply(s, d);
}

function foldLine(s, line) {
  // cheap pre-filter: progress, snapshots, titles, queue ops… never reach the model
  if (line.indexOf('"type":"user"') < 0 && line.indexOf('"type":"assistant"') < 0
      && line.indexOf('"type":"attachment"') < 0 && line.indexOf('"compact_boundary"') < 0) return;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  try { foldObj(s, j); } catch (_) { /* one odd record never breaks the tally */ }
}

// ---------------------------------------------------------------------------
// bounded incremental reading (the sessionmeta.js pattern)
// ---------------------------------------------------------------------------
const cache = new Map();   // file -> { offset, tail, dec, s, catching, scanned }

function entry(file, st) {
  let c = cache.get(file);
  if (c && st.size < c.offset) c = null;                    // truncated/rotated: start over
  if (!c) { c = { offset: 0, tail: '', dec: new StringDecoder('utf8'), s: blank(), catching: null, scanned: false }; cache.set(file, c); }
  return c;
}

// Fold at most `maxBytes` new bytes. Returns true when caught up to `size`.
function advance(file, c, size, maxBytes) {
  if (size <= c.offset) return true;
  const fd = fs.openSync(file, 'r');
  try {
    const want = Math.min(size - c.offset, maxBytes);
    const buf = Buffer.alloc(Math.min(want, STEP));
    let pos = c.offset, left = want;
    while (left > 0) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
      if (n <= 0) break;
      pos += n; left -= n;
      // StringDecoder keeps a multi-byte character split across two reads intact
      const lines = (c.tail + c.dec.write(buf.subarray(0, n))).split('\n');
      c.tail = lines.pop();
      for (const l of lines) { if (l) foldLine(c.s, l); }
    }
    c.offset = pos;
  } finally { fs.closeSync(fd); }
  return c.offset >= size;
}

// Is there a real top-level compact_boundary line around byte `pos`? Returns its
// line start, or -1.
function boundaryLineStart(fd, pos, size) {
  const W = 256 * 1024;
  const start = Math.max(0, pos - W);
  const len = Math.min(size, pos + W) - start;
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  const rel = pos - start;
  const nl = buf.lastIndexOf(0x0a, rel);
  if (nl < 0 && start > 0) return -1;
  const ls = nl + 1;
  let le = buf.indexOf(0x0a, rel);
  if (le < 0) { if (start + n < size) return -1; le = n; }
  try {
    const j = JSON.parse(buf.toString('utf8', ls, le));
    return j && j.type === 'system' && j.subtype === 'compact_boundary' ? start + ls : -1;
  } catch (_) { return -1; }
}

// Cold start on a big file: find the last compaction and skip what it threw away.
async function scanAhead(file, c) {
  const positions = [];
  let pos = 0, size = 0;
  for (;;) {
    let st; try { st = fs.statSync(file); } catch (_) { return; }
    size = st.size;
    if (pos >= size) break;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(STEP + MARK.length - 1, size - pos);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      for (let i = buf.indexOf(MARK, 0); i >= 0 && i < Math.min(STEP, n); i = buf.indexOf(MARK, i + 1)) positions.push(pos + i);
    } finally { fs.closeSync(fd); }
    pos += STEP;
    await new Promise((r) => setImmediate(r));
  }
  if (!positions.length || c.offset !== 0) return;
  const fd = fs.openSync(file, 'r');
  let start = 0;
  try {
    let ls = -1;
    for (let k = positions.length - 1; k >= 0 && ls < 0; k--) ls = boundaryLineStart(fd, positions[k], size);
    if (ls <= 0) return;
    const from = Math.max(0, ls - BACKUP);
    if (from > 0) {
      // first line start at or after `from`; byte ls-1 is a newline, so this always lands
      const probe = Buffer.alloc(Math.min(STEP, ls - from));
      let p = from;
      for (;;) {
        const n = fs.readSync(fd, probe, 0, Math.min(probe.length, ls - p), p);
        if (n <= 0) { start = ls; break; }
        const i = probe.indexOf(0x0a);
        if (i >= 0 && i < n) { start = p + i + 1; break; }
        p += n;
      }
    }
  } finally { fs.closeSync(fd); }
  if (c.offset !== 0) return;
  c.offset = start; c.tail = ''; c.dec = new StringDecoder('utf8');
  c.s.compactions = positions.filter((p) => p < start).length;
}

function catchUp(file, c) {
  if (c.catching) return c.catching;
  c.catching = (async () => {
    try {
      if (!c.scanned && c.offset === 0) {
        c.scanned = true;
        let st0; try { st0 = fs.statSync(file); } catch (_) { return; }
        if (st0.size > STEP) await scanAhead(file, c);
      }
      for (;;) {
        let st; try { st = fs.statSync(file); } catch (_) { return; }
        if (advance(file, c, st.size, STEP)) return;
        await new Promise((r) => setImmediate(r));
      }
    } catch (_) { /* unreadable mid-way: keep what we have */ }
    finally { c.catching = null; }
  })();
  return c.catching;
}

// The current picture. A last line with no trailing newline sits in `tail`; if it
// is already complete JSON it is folded into a CLONE (never the real state), so it
// counts now and is not counted twice once its newline arrives.
function view(c) {
  let s = c.s;
  const t = c.tail;
  if (t && t.charCodeAt(t.length - 1) === 125 /* } */) {
    s = { ...s, cat: { ...s.cat }, byTool: new Map(s.byTool), biggest: s.biggest.slice() };
    s.recent = new Map(s.recent);
    foldLine(s, t);
  }
  return {
    cat: { ...s.cat },
    byTool: Array.from(s.byTool, ([tool, chars]) => ({ tool, chars })),
    biggest: s.biggest.map((b) => ({ ...b })),
    results: s.results, bigResults: s.bigResults,
    ctx: s.ctx, model: s.model, since: s.since, compactions: s.compactions,
  };
}

function emptyView() {
  return { cat: zeroCat(), byTool: [], biggest: [], results: 0, bigResults: 0, ctx: 0, model: '', since: '', compactions: 0 };
}

// Bounded, synchronous: a small backlog is read inline; a big one goes to the
// background and the partial picture so far comes back with `behind` > 0.
function read(transcriptPath) {
  const file = String(transcriptPath || '');
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch (_) { return null; }
  if (!st.isFile()) return null;
  const c = entry(file, st);
  if (!c.catching && st.size - c.offset <= STEP) advance(file, c, st.size, STEP);
  else catchUp(file, c);
  return { ...view(c), behind: Math.max(0, st.size - c.offset) };
}

// Complete, without blocking the event loop.
async function readFull(transcriptPath) {
  const file = String(transcriptPath || '');
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch (_) { return null; }
  if (!st.isFile()) return null;
  const c = entry(file, st);
  await catchUp(file, c);
  let size = c.offset; try { size = fs.statSync(file).size; } catch (_) { /* keep */ }
  return { ...view(c), behind: Math.max(0, size - c.offset) };
}

// ---------------------------------------------------------------------------
// breakdown
// ---------------------------------------------------------------------------
function maxFor(model, observed) {
  const m = String(model || '').toLowerCase();
  let max = 200000;
  if (/(opus|sonnet|fable)/.test(m) && (m.includes('[1m]') || m.includes('1m'))) max = 1000000;
  if (observed && observed > max) max = 1000000;   // already past 200k: must be the big window
  return max;
}

function round3(x) { return Math.round(x * 1000) / 1000; }

function breakdown(transcriptPath, opts) {
  opts = opts || {};
  const v = read(transcriptPath) || { ...emptyView(), behind: 0 };
  const total = Math.max(0, Math.round(v.ctx || 0));
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : maxFor(opts.model || v.model, total);

  const est = {};
  let visible = 0;
  for (const k of CATS) { est[k] = v.cat[k] / CHARS_PER_TOKEN; visible += est[k]; }
  const scale = total > 0 && visible > total ? total / visible : 1;

  const tok = {};
  for (const k of CATS) tok[k] = Math.round(est[k] * scale);
  let baseline = 0;
  if (total > 0) {
    let sum = 0; for (const k of CATS) sum += tok[k];
    baseline = total - sum;
    if (baseline < 0) {                         // rounding overshoot: take it off the biggest
      const big = CATS.reduce((a, k) => (tok[k] > tok[a] ? k : a), CATS[0]);
      tok[big] += baseline; baseline = 0;
    }
  }
  const base = total > 0 ? total : CATS.reduce((a, k) => a + tok[k], 0);
  const share = (n) => (base > 0 ? round3(n / base) : 0);

  const categories = CATS.map((k) => ({ key: k, label: LABELS[k], tokens: tok[k], pct: share(tok[k]) }));
  if (total > 0) categories.push({ key: 'baseline', label: LABELS.baseline, tokens: baseline, pct: share(baseline) });
  const cats = categories.filter((c) => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);

  const toTok = (chars) => Math.round((chars / CHARS_PER_TOKEN) * scale);
  const byTool = v.byTool
    .map((t) => ({ tool: t.tool, tokens: toTok(t.chars) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_N)
    .map((t) => ({ ...t, pct: share(t.tokens) }));
  const biggest = v.biggest.slice(0, TOP_N).map((b) => ({ tool: b.tool, detail: b.detail, tokens: toTok(b.chars) }));

  const pct = total > 0 ? Math.min(1, round3(total / maxTokens)) : 0;

  // advice: at most two short sentences, worst first
  const tips = [];
  if (pct >= 0.85) tips.push('Nearly full: Claude will auto-compact soon.');
  // telling someone to /compact at 5% full is noise; with no real total, judge the shares alone
  const worthIt = total === 0 || pct >= 0.2;
  if (worthIt && biggest.length && base > 0 && biggest[0].tokens / base >= 0.15) {
    const b = biggest[0];
    tips.push('One ' + b.tool + ' result is ' + Math.round((b.tokens / base) * 100) + '% of the context'
      + (b.detail ? ' (' + b.detail + ')' : '') + '. /compact will drop it.');
  }
  if (worthIt && tips.length < 2 && visible > 0 && est.toolResults / visible >= 0.5) {
    const n = v.bigResults || v.results;
    tips.push('Tool results are most of it: ' + n + (n === 1 ? ' big file read or command output' : ' big file reads and command outputs')
      + '. /compact now and ask it to keep only the conclusions.');
  }
  const advice = tips.slice(0, 2).join(' ').replace(/[—–]/g, '-');

  return {
    totalTokens: total,
    maxTokens,
    pct,
    categories: cats,
    byTool,
    biggest,
    since: v.since || '',
    compactions: v.compactions || 0,
    behind: v.behind || 0,
    advice,
    estimated: true,
    note: total > 0 || visible === 0 ? NOTE : NOTE_NO_TOTAL,
  };
}

module.exports = { read, readFull, breakdown, _reset: () => cache.clear() };
