'use strict';
// bridge/lessons.js — are the agents actually getting better?
//
// Two jobs, one incremental pass over ~/.claude transcripts:
//
//   1. TREND. Per day: typed prompts, "it didn't work" turns (correction /
//      pasted-error, same classifier as Tune), tool calls, and tool errors.
//      The panel plots RATES, not counts — a busy week has more failures just
//      because it has more work, and a count would read that as getting worse.
//
//   2. LESSONS. Tool errors are grouped by a normalised signature. One that
//      recurs across several sessions becomes a candidate rule. You edit it and
//      promote it (it is appended to a CLAUDE.md under a marker), or dismiss it.
//      Each promoted lesson is then MEASURED: its signature's rate after the
//      promotion vs before. Adding rules is easy; knowing whether a rule helped
//      is the part that makes this improvement rather than accumulation — a
//      rule with no effect is still paid for in context on every turn.
//
// Deterministic — no model calls. The per-file tallies are additive, so a
// growing live transcript is read by byte offset: only the new bytes, ever.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { classifyPrompt, userText, isInjected } = require('./patterns.js');

const CACHE_VERSION = 2;
const MAX_SIGS_PER_FILE = 300;
const LESSON_MARK = 'gander:lesson:';
const SECTION = '## Lessons learned (Gander)';

// ── error signatures ─────────────────────────────────────────────────────────
// Measured on real transcripts: the FIRST line of an error is usually useless.
// Python leads with "Traceback (most recent call last):" (the exception is the
// LAST line), Node leads with "node:internal/modules/cjs/loader:1423" (the
// message is a few lines down), Bash leads with "Exit code 1".
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STRONG = /^[\w.$]*(Error|Exception|Warning)\b\s*[:\[]|^Error\b|^fatal:|^error\b/i;
const WEAK = /(error|exception|failed|failure|not found|cannot|can't|could not|couldn't|denied|unexpected|invalid|timed out|refused|no such|not installed|does not exist|is not recognized|blocked|missing|unable)/i;
// git's line-ending chatter rides along in stderr on every commit — never the failure
const NOISE = /^(exit code \d+|<\/?tool_use_error>|at .+|\^+|~+|-+|=+|\s*\|.*|warning: in the working copy of .*)$/i;

// Failing tests are the dev loop working, not an agent mistake to learn from.
// They still count toward the error rate; they just never become a lesson.
const NORMAL_WORK = /^AssertionError\b|\btests? failed\b|\bfailing tests?\b|^not ok \d|^✖/i;

// A user saying "no" to a tool is not the agent failing — keep it out of the rate.
function isRejection(text) {
  return /the user doesn'?t want to (proceed|take this action)|tool use was rejected|user (denied|rejected)/i.test(text);
}

function errorText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return '';
}

// The one line that says what went wrong.
function keyLine(text) {
  const lines = String(text || '').replace(ANSI, '').split(/\r?\n/)
    .map((s) => s.replace(/<\/?tool_use_error>/g, '').trim())
    .filter((s) => s && !NOISE.test(s));
  if (!lines.length) return '';
  if (/Traceback \(most recent call last\)/.test(text)) {
    for (let i = lines.length - 1; i >= 0; i--) if (STRONG.test(lines[i])) return lines[i];
  }
  return lines.find((s) => STRONG.test(s)) || lines.find((s) => WEAK.test(s)) || lines[0];
}

// Normalise so the same failure in a different folder, file or line number
// groups together: paths, quoted values, numbers and hex become placeholders.
function signature(tool, text) {
  const line = keyLine(text);
  if (!line) return null;
  let s = line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi, '<url>')          // before paths: http://x/y is not a path
    .replace(/[a-zA-Z]:[\\/][^\s'"`,;)]*/g, '<path>')              // C:\x\y  d:/x
    .replace(/(^|[\s'"(=])\/(?:[\w.@~-]+\/)+[\w.@~-]*/g, '$1<path>') // /usr/bin/x
    .replace(/(['"`])(?:(?!\1).){1,80}\1/g, '$1…$1')                // quoted values
    .replace(/\b0x[0-9a-f]+\b/gi, '#')
    .replace(/\b\d+(\.\d+)*\b/g, '#')
    .replace(/: (?:-c|eval): line/g, ': line')                      // bash -c vs eval: same quoting mistake
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  if (!s) return null;
  // Bash and PowerShell fail the same way for the same reason — one lesson, not two
  const t = /^(bash|powershell)$/i.test(tool || '') ? 'Shell' : (tool || 'tool');
  const errorish = (STRONG.test(line) || WEAK.test(line)) && !NORMAL_WORK.test(line);
  return { sig: t + ': ' + s, errorish, line: line.slice(0, 240) };
}

// ── per-file parse (incremental) ─────────────────────────────────────────────
function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function blankEntry() { return { v: CACHE_VERSION, size: 0, mtime: 0, offset: 0, proj: '', days: {}, sigs: {}, ids: {} }; }
function dayOf(e, k) { return e.days[k] || (e.days[k] = { prompts: 0, corrections: 0, toolCalls: 0, toolErrors: 0 }); }

const TOOL_USE_RE = /"type":"tool_use","id":"([\w-]+)","name":"([^"]+)"/g;
const TS_RE = /"timestamp":"([^"]+)"/;

function foldLine(e, line, fallbackMs) {
  if (line.length > 4_000_000) return;
  const tsm = TS_RE.exec(line);
  const ts = (tsm && Date.parse(tsm[1])) || fallbackMs;
  if (!e.proj) { const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line); if (m) { try { e.proj = path.basename(JSON.parse('"' + m[1] + '"')); } catch (_) {} } }

  // assistant tool calls: counted by regex, no JSON.parse — these are most lines
  if (line.includes('"type":"assistant"') && line.includes('"tool_use"')) {
    TOOL_USE_RE.lastIndex = 0;
    let m, n = 0;
    while ((m = TOOL_USE_RE.exec(line))) { e.ids[m[1]] = m[2]; n++; }
    if (n) dayOf(e, dayKey(ts)).toolCalls += n;
    // the id → name map only has to bridge a call to its result a few lines on
    const keys = Object.keys(e.ids);
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 200)) delete e.ids[k];
    return;
  }
  if (!line.includes('"type":"user"')) return;
  const hasResult = line.includes('"tool_result"');
  const hasError = line.includes('"is_error":true');
  if (hasResult && !hasError) return;             // ordinary tool output: nothing to count

  let o; try { o = JSON.parse(line); } catch (_) { return; }
  if (!o || o.type !== 'user' || !o.message) return;
  const day = dayOf(e, dayKey(ts));

  if (hasError && Array.isArray(o.message.content)) {
    for (const b of o.message.content) {
      if (!b || b.type !== 'tool_result' || !b.is_error) continue;
      const text = errorText(b);
      if (isRejection(text)) continue;
      day.toolErrors++;
      const sg = signature(e.ids[b.tool_use_id] || 'tool', text);
      if (!sg || !sg.errorish) continue;          // "ok" / "compile OK" on a non-zero exit: counted, never a lesson
      let s = e.sigs[sg.sig];
      if (!s) {
        if (Object.keys(e.sigs).length >= MAX_SIGS_PER_FILE) continue;
        s = e.sigs[sg.sig] = { n: 0, d: {}, sample: sg.line };
      }
      s.n++;
      const dk = dayKey(ts);
      s.d[dk] = (s.d[dk] || 0) + 1;
    }
    return;
  }

  if (o.isMeta) return;
  const t = userText(o.message);
  if (!t || isInjected(t) || /<command-name>/.test(t)) return;
  day.prompts++;
  const k = classifyPrompt(t);
  if (k === 'correction' || k === 'errpaste') day.corrections++;
}

async function readNew(file, e, st) {
  if (st.size < e.offset) { const fresh = blankEntry(); Object.assign(e, fresh); }   // truncated/rotated
  if (st.size === e.offset) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size - e.offset, 1024 * 1024));
    let pos = e.offset, tail = '';
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const chunk = tail + buf.toString('utf8', 0, n);
      const lines = chunk.split('\n');
      tail = lines.pop();
      for (const l of lines) if (l) foldLine(e, l, st.mtimeMs);
      // Yield between 1 MB chunks. A cold scan is seconds of parsing, and the
      // bridge is single-threaded: blocking it that long makes hook POSTs time
      // out (emit.js gives up after 5s) and sessions silently stop reporting.
      await new Promise((r) => setImmediate(r));
    }
    // only COMPLETE lines are consumed; a half-written last line is re-read next time
    e.offset = pos - Buffer.byteLength(tail, 'utf8');
  } finally { fs.closeSync(fd); }
  e.size = st.size; e.mtime = st.mtimeMs;
  return true;
}

// ── cache + store ────────────────────────────────────────────────────────────
const memo = new Map();
function loadJson(p, dflt) {
  if (memo.has(p)) return memo.get(p);
  let c = null;
  try { c = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  if (!c || typeof c !== 'object') c = dflt();
  memo.set(p, c);
  return c;
}
function saveJson(p, c) {
  try { fs.writeFileSync(p + '.tmp', JSON.stringify(c)); fs.renameSync(p + '.tmp', p); } catch (_) {}
}

function transcriptFiles(root, sinceMs) {
  const out = [];
  let dirs; try { dirs = fs.readdirSync(root); } catch (_) { return out; }
  for (const d of dirs) {
    let names; try { names = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of names) {
      const p = path.join(root, d, f);
      try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs) out.push({ p, st }); } catch (_) {}
    }
  }
  return out.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 600);
}

const defaults = () => ({ lessons: [], dismissed: [] });

function paths(opts) {
  const o = opts || {};
  return {
    root: o.root || path.join(os.homedir(), '.claude', 'projects'),
    cachePath: o.cachePath || path.join(__dirname, 'aoc-lessons-cache.json'),
    storePath: o.storePath || path.join(__dirname, 'aoc-lessons.json'),
  };
}

// ── measuring a lesson ───────────────────────────────────────────────────────
// Rate = hits of the signature per 100 tool calls, over the days that had ANY
// tool calls (an idle weekend is not evidence of anything). Compared across the
// same span before and after promotion, capped at 14 days each side.
const SPAN = 14;
function measure(lesson, series, sigDays) {
  const pDay = dayKey(lesson.promotedAt);
  const before = series.filter((d) => d.date < pDay && d.toolCalls > 0).slice(-SPAN);
  const after = series.filter((d) => d.date > pDay && d.toolCalls > 0).slice(0, SPAN);
  const rate = (days) => {
    const calls = days.reduce((s, d) => s + d.toolCalls, 0);
    const hits = days.reduce((s, d) => s + (sigDays[d.date] || 0), 0);
    return { days: days.length, calls, hits, rate: calls ? (hits / calls) * 100 : 0 };
  };
  const b = rate(before), a = rate(after);
  let verdict, note;
  if (a.days < 3) { verdict = 'measuring'; note = `${a.days} active day${a.days === 1 ? '' : 's'} since — needs 3`; }
  // 2 hits before and 0 after is not "down 100%" — it's noise. Say so.
  else if (b.hits + a.hits < 5) { verdict = 'measuring'; note = `too few hits to judge yet (${b.hits} before, ${a.hits} after)`; }
  else if (b.hits === 0) { verdict = a.hits ? 'worse' : 'measuring'; note = a.hits ? 'appeared only after the rule' : 'no hits either side yet'; }
  else if (a.rate <= b.rate * 0.5) { verdict = 'working'; note = `down ${Math.round((1 - a.rate / b.rate) * 100)}%`; }
  else if (a.days >= 7 && a.rate >= b.rate * 0.8) { verdict = 'no-effect'; note = 'no real change — it may not be earning its place in context'; }
  else if (a.rate > b.rate) { verdict = 'worse'; note = `up ${Math.round((a.rate / b.rate - 1) * 100)}%`; }
  else { verdict = 'measuring'; note = `down ${Math.round((1 - a.rate / b.rate) * 100)}% so far`; }
  return { before: b, after: a, verdict, note };
}

// ── scan ─────────────────────────────────────────────────────────────────────
async function scan(opts) {
  const t0 = Date.now();
  const o = opts || {};
  const days = Math.max(7, Math.min(120, Number(o.days) || 60));
  const minCount = Math.max(2, Number(o.minCount) || 3);
  const minSessions = Math.max(1, Number(o.minSessions) || 2);
  const { root, cachePath, storePath } = paths(o);
  const now = o.now || Date.now();
  const since = now - days * 86400e3;

  const cache = loadJson(cachePath, () => ({ v: CACHE_VERSION, files: {} }));
  if (cache.v !== CACHE_VERSION || !cache.files) { cache.v = CACHE_VERSION; cache.files = {}; }
  const files = transcriptFiles(root, since);
  let parsed = 0, dirty = false;
  const live = new Set();
  for (const { p, st } of files) {
    live.add(p);
    let e = cache.files[p];
    if (!e || e.v !== CACHE_VERSION) e = cache.files[p] = blankEntry();
    try { if (await readNew(p, e, st)) { parsed++; dirty = true; } } catch (_) {}
    await new Promise((r) => setImmediate(r));
  }
  for (const p of Object.keys(cache.files)) if (!live.has(p)) { delete cache.files[p]; dirty = true; }
  if (dirty) saveJson(cachePath, cache);

  // daily series across the window, zero days included so the x-axis is honest
  const byDay = new Map();
  for (let t = since; t <= now; t += 86400e3) byDay.set(dayKey(t), { date: dayKey(t), prompts: 0, corrections: 0, toolCalls: 0, toolErrors: 0 });
  const sigAgg = new Map();
  for (const p of live) {
    const e = cache.files[p];
    for (const [k, d] of Object.entries(e.days)) {
      const row = byDay.get(k);
      if (!row) continue;
      row.prompts += d.prompts; row.corrections += d.corrections; row.toolCalls += d.toolCalls; row.toolErrors += d.toolErrors;
    }
    for (const [sig, s] of Object.entries(e.sigs)) {
      let a = sigAgg.get(sig);
      if (!a) sigAgg.set(sig, (a = { sig, n: 0, sessions: 0, projects: new Set(), d: {}, samples: [], first: '', last: '' }));
      let inWindow = 0;
      for (const [dk, c] of Object.entries(s.d)) {
        if (!byDay.has(dk)) continue;
        a.d[dk] = (a.d[dk] || 0) + c; inWindow += c;
        if (!a.first || dk < a.first) a.first = dk;
        if (!a.last || dk > a.last) a.last = dk;
      }
      if (!inWindow) continue;
      a.n += inWindow; a.sessions++;
      if (e.proj) a.projects.add(e.proj);
      if (a.samples.length < 2 && !a.samples.includes(s.sample)) a.samples.push(s.sample);
    }
  }
  const series = [...byDay.values()];

  const store = loadJson(storePath, defaults);
  const taken = new Set(store.lessons.filter((l) => !l.retiredAt).map((l) => l.sig).concat(store.dismissed || []));
  const candidates = [...sigAgg.values()]
    .filter((a) => a.n >= minCount && a.sessions >= minSessions && !taken.has(a.sig))
    .sort((x, y) => y.n - x.n || y.sessions - x.sessions)
    .slice(0, 25)
    .map((a) => ({
      sig: a.sig, tool: a.sig.split(':')[0], count: a.n, sessions: a.sessions,
      projects: [...a.projects].slice(0, 6), first: a.first, last: a.last, samples: a.samples,
      draft: draftRule(a),
      spark: series.map((d) => a.d[d.date] || 0),
    }));

  const lessons = store.lessons.map((l) => {
    const a = sigAgg.get(l.sig);
    const sigDays = a ? a.d : {};
    return { ...l, effect: measure(l, series, sigDays), spark: series.map((d) => sigDays[d.date] || 0) };
  });

  return {
    generatedAt: now, days, minCount, minSessions, series, candidates, lessons,
    totals: {
      files: files.length, parsed, scanMs: Date.now() - t0,
      prompts: series.reduce((s, d) => s + d.prompts, 0), toolCalls: series.reduce((s, d) => s + d.toolCalls, 0),
      toolErrors: series.reduce((s, d) => s + d.toolErrors, 0), corrections: series.reduce((s, d) => s + d.corrections, 0),
    },
  };
}

// A starting point to edit, not a finished rule — the panel makes you read it.
const DRAFTS = [
  [/^Edit: string to replace not found/i, 'Before an Edit, Read the exact lines being replaced in this turn — never edit from memory of an earlier read.'],
  [/file has not been read yet/i, 'Read a file in the current session before Write or Edit on it.'],
  [/file has been modified since read/i, 'Re-read a file right before editing it if anything else may have touched it (a build, a formatter, another agent).'],
  [/unicodeencodeerror: …charmap…/i, 'On Windows, run Python with PYTHONIOENCODING=utf-8 (or write output to a file) — the console is cp1252 and cannot print emoji or arrows.'],
  [/command timed out/i, 'Run anything that may take over a minute in the background, and wait on its completion instead of blocking.'],
  [/file does not exist\. note: your current working directory is/i, 'Use absolute paths for file tools — the working directory drifts after a `cd`.'],
  [/unexpected eof while looking for matching/i, 'Do not inline multi-line scripts in a shell command; write them to a file first (quotes and backslashes get mangled).'],
  [/cannot find module/i, 'Check the module path relative to the script (and that dependencies are installed) before running Node.'],
  [/playwright.*timeout.*exceeded/i, 'Before driving Playwright, confirm the page is served (curl it first); use wait_until="domcontentloaded" and a short explicit timeout instead of the 30s default.'],
  [/err_connection_refused/i, 'Start the server in the background and wait until it is actually listening before pointing a browser or curl at it.'],
  [/unterminated string literal/i, 'Do not inline multi-line scripts in a shell command; write them to a file first (quotes and backslashes get mangled).'],
  [/filenotfounderror|no such file or directory/i, 'Check a path exists (and use absolute paths) before reading it — the working directory drifts between commands.'],
  [/is not recognized as (the name|an internal)/i, 'This is Windows: use the matching Windows/PowerShell command, not the Unix one.'],
];
function draftRule(a) {
  const body = a.sig.slice(a.sig.indexOf(':') + 2);
  for (const [re, text] of DRAFTS) if (re.test(a.sig) || re.test(body)) return text;
  return `Avoid this recurring ${a.sig.split(':')[0]} failure (${a.n}× in ${a.sessions} sessions): "${a.samples[0] || body}".`;
}

// ── actions ──────────────────────────────────────────────────────────────────
function claudeMdFor(target, cwd, home) {
  if (target === 'project') {
    if (!cwd || !fs.existsSync(cwd)) throw new Error('project folder not found');
    return path.join(cwd, 'CLAUDE.md');
  }
  return path.join(home || os.homedir(), '.claude', 'CLAUDE.md');
}

// Appends under one marked section so a retire can remove exactly this line and
// nothing else — the rest of the file is the user's and is never rewritten.
function promote(body, opts) {
  const b = body || {};
  const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!b.sig || !text) return { error: 'sig and text required' };
  const { storePath } = paths(opts);
  const store = loadJson(storePath, defaults);
  if (store.lessons.some((l) => l.sig === b.sig && !l.retiredAt)) return { error: 'already promoted' };
  let file;
  try { file = claudeMdFor(b.target === 'project' ? 'project' : 'global', b.cwd, opts && opts.home); } catch (e) { return { error: e.message }; }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch (_) {}
  const nl = cur.includes('\r\n') ? '\r\n' : '\n';
  const line = `- ${text} <!-- ${LESSON_MARK}${id} -->`;
  let next;
  const lines = cur.split(/\r?\n/);
  const at = lines.findIndex((s) => s.trim() === SECTION);
  if (at >= 0) {
    // insert after the section's LAST bullet (oldest first, so the order you
    // promoted them in is the order you read them in), stopping at the next heading
    let last = at, i = at + 1;
    while (i < lines.length && !/^#/.test(lines[i])) { if (/^- /.test(lines[i])) last = i; i++; }
    lines.splice(last === at ? at + 1 : last + 1, 0, line);
    next = lines.join(nl);
  } else {
    next = cur.replace(/\s*$/, '') + (cur.trim() ? nl + nl : '') + SECTION + nl + line + nl;
  }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, next); }
  catch (e) { return { error: 'could not write ' + file + ': ' + e.message }; }
  const lesson = { id, sig: b.sig, text, target: b.target === 'project' ? 'project' : 'global', file, project: b.project || '', promotedAt: (opts && opts.now) || Date.now() };
  store.lessons.push(lesson);
  saveJson(storePath, store);
  return { ok: true, lesson };
}

function retire(body, opts) {
  const { storePath } = paths(opts);
  const store = loadJson(storePath, defaults);
  const l = store.lessons.find((x) => x.id === (body && body.id));
  if (!l) return { error: 'no such lesson' };
  let removed = false;
  try {
    const cur = fs.readFileSync(l.file, 'utf8');
    const lines = cur.split(/\r?\n/);
    const kept = lines.filter((s) => !s.includes(LESSON_MARK + l.id));
    removed = kept.length !== lines.length;
    if (removed) fs.writeFileSync(l.file, kept.join(cur.includes('\r\n') ? '\r\n' : '\n'));
  } catch (_) {}
  l.retiredAt = (opts && opts.now) || Date.now();
  saveJson(storePath, store);
  return { ok: true, removed };
}

function dismiss(body, opts) {
  if (!body || !body.sig) return { error: 'sig required' };
  const { storePath } = paths(opts);
  const store = loadJson(storePath, defaults);
  store.dismissed = store.dismissed || [];
  if (!store.dismissed.includes(body.sig)) store.dismissed.push(body.sig);
  saveJson(storePath, store);
  return { ok: true };
}

module.exports = { scan, promote, retire, dismiss, signature, keyLine, measure, _reset: () => memo.clear() };
