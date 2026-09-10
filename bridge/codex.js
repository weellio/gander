'use strict';
// OpenAI Codex (CLI + Desktop) on the floor — read what Codex writes to disk.
//
//   $CODEX_HOME (default ~/.codex)/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl
//     append-only JSONL, one object per line: { timestamp, ordinal, type, payload }
//       session_meta            { id, cwd, originator ("Codex Desktop"|"codex_cli"…), cli_version, model_provider, source }
//       turn_context            { turn_id, cwd, model?, workspace_roots }
//       event_msg               payload.type: task_started · token_count{info.total_token_usage}
//                               · task_complete{last_agent_message} · turn_aborted{reason} · error
//                               · exec_approval_request / apply_patch_approval_request (needs a human)
//       response_item           payload.type: message{role,content[]} · function_call{name,arguments}
//                               · custom_tool_call{name,input} · reasoning · *_output
//   $CODEX_HOME/state_5.sqlite      threads (title, model, git_branch, tokens_used…)   ┐ optional, via node:sqlite
//   $CODEX_HOME/goals_1.sqlite      thread_goals (objective, status: active/paused/    │ (best-effort; the JSONL
//                                   blocked/usage_limited/budget_limited/completed)     │  alone is enough for tiles)
//   $CODEX_HOME/queue_1.sqlite      queued_items (follow-ups waiting per thread)        ┘
//
// The rollout is parsed INCREMENTALLY (byte offset per file) so a 100 MB
// transcript costs one read, not one read per tick. Sessions whose file was
// touched inside `liveWindowMs` become tiles; the rest are history.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = () => process.env.GANDER_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// ── rollout discovery ────────────────────────────────────────────────────────
function listRollouts(home, sinceMs) {
  const out = [];
  const root = path.join(home || HOME(), 'sessions');
  let years = []; try { years = fs.readdirSync(root); } catch (_) { return out; }
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    let months = []; try { months = fs.readdirSync(path.join(root, y)); } catch (_) { continue; }
    for (const m of months) {
      let days = []; try { days = fs.readdirSync(path.join(root, y, m)); } catch (_) { continue; }
      for (const d of days) {
        const dir = path.join(root, y, m, d);
        let files = []; try { files = fs.readdirSync(dir); } catch (_) { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const p = path.join(dir, f);
          let st; try { st = fs.statSync(p); } catch (_) { continue; }
          if (sinceMs && st.mtimeMs < sinceMs) continue;
          out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size, id: f.replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '').replace(/\.jsonl$/, '') });
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ── event → state ────────────────────────────────────────────────────────────
const READ_RE = /\b(cat|type|Get-Content|gc|ls|dir|Get-ChildItem|rg|grep|find|findstr|Select-String|head|tail|sed -n|git (log|status|diff|show|blame)|tree)\b/;
const TEST_RE = /\b(npm (test|run test)|pytest|jest|vitest|mocha|node --test|go test|cargo test|dotnet test|phpunit|rspec|playwright test)\b/;
const SEARCH_RE = /\b(web_search|search|fetch|curl|wget|Invoke-WebRequest|iwr)\b/;
function classifyTool(name, argText) {
  const n = String(name || '').toLowerCase();
  const a = String(argText || '');
  if (n === 'wait' || n === 'sleep') return 'thinking';
  if (/spawn|subagent|delegate|task/.test(n)) return 'spawning';
  if (/apply_patch|write|edit|create_file|str_replace/.test(n)) return 'coding';
  if (/read|list|view|glob|grep|search/.test(n)) return /search|web/.test(n) ? 'searching' : 'reading';
  if (n === 'exec' || n === 'shell' || n === 'local_shell' || n === 'bash' || n === 'container.exec' || n === 'exec_command') {
    if (TEST_RE.test(a)) return 'testing';
    if (/apply_patch|>\s*[\w./\\-]+|Set-Content|Out-File|tee /.test(a)) return 'coding';
    if (READ_RE.test(a)) return 'reading';
    if (SEARCH_RE.test(a)) return 'searching';
    return 'coding';
  }
  if (/image|generate/.test(n)) return 'coding';
  return 'coding';
}
const str = (v, n = 160) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && (c.text || c.input_text || c.output_text)) || '').join(' ');
}
function cmdOf(p) {
  // exec input is usually JS like: text(await tools.exec_command({cmd:"…"})) — or plain JSON args
  // approval events carry the command directly (array or string); tool calls carry it inside input/arguments
  if (Array.isArray(p.command)) return p.command.join(' ');
  if (typeof p.command === 'string' && p.command) return p.command;
  const raw = p.input !== undefined ? String(p.input) : (p.arguments !== undefined ? String(p.arguments) : '');
  const m = raw.match(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : raw;
}

// A session's parse state; `apply(obj)` folds one rollout line into it.
function newSession(id) {
  return {
    id, cwd: '', model: '', originator: '', cliVersion: '', source: '', startedAt: 0, lastAt: 0,
    state: 'thinking', log: '', lastMessage: '', firstUser: '', awaitMsg: '', turns: 0, completedTurns: 0,
    tokens: { input: 0, cached: 0, output: 0, total: 0 }, toolCalls: 0, errors: 0, aborted: 0,
    _turnOpen: false,
  };
}
function apply(s, obj) {
  if (!obj || typeof obj !== 'object') return;
  const p = obj.payload || {};
  const ts = Date.parse(obj.timestamp || '') || 0;
  if (ts) { if (!s.startedAt) s.startedAt = ts; if (ts > s.lastAt) s.lastAt = ts; }
  switch (obj.type) {
    case 'session_meta':
      s.cwd = p.cwd || s.cwd; s.originator = p.originator || s.originator; s.cliVersion = p.cli_version || s.cliVersion; s.source = p.source || s.source;
      if (p.model) s.model = p.model;
      return;
    case 'turn_context':
      if (p.cwd) s.cwd = p.cwd;
      if (p.model) s.model = p.model;
      return;
    case 'token_usage_record':
      return;
    case 'event_msg': {
      const t = p.type;
      if (t === 'task_started') { s.turns++; s._turnOpen = true; s.state = 'thinking'; s.awaitMsg = ''; if (p.model) s.model = p.model; return; }
      if (t === 'token_count') {
        const u = (p.info && p.info.total_token_usage) || {};
        s.tokens = { input: Number(u.input_tokens) || 0, cached: Number(u.cached_input_tokens) || 0, output: Number(u.output_tokens) || 0, total: Number(u.total_tokens) || 0 };
        if (p.info && p.info.model) s.model = p.info.model;
        return;
      }
      if (t === 'task_complete') { s._turnOpen = false; s.completedTurns++; s.state = 'idle'; if (p.last_agent_message) { s.lastMessage = str(p.last_agent_message, 400); s.log = str(p.last_agent_message); } return; }
      if (t === 'turn_aborted') { s._turnOpen = false; s.aborted++; s.state = 'idle'; s.log = 'interrupted' + (p.reason ? ' (' + p.reason + ')' : ''); return; }
      if (t === 'error' || t === 'stream_error') { s.errors++; s.state = 'error'; s.log = str(p.message || p.error || 'error'); return; }
      if (t === 'exec_approval_request' || t === 'apply_patch_approval_request' || t === 'request_user_input' || t === 'elicitation_request') {
        s.state = 'awaiting'; s.awaitMsg = t === 'apply_patch_approval_request' ? 'wants to apply a patch' : ('wants to run: ' + str(cmdOf(p) || p.reason || 'a command', 100)); s.log = s.awaitMsg; return;
      }
      if (t === 'agent_message') { if (p.message) { s.log = str(p.message); s.lastMessage = str(p.message, 400); } return; }
      if (t === 'exec_command_begin') { s.state = classifyTool('exec', Array.isArray(p.command) ? p.command.join(' ') : p.command); s.log = str(Array.isArray(p.command) ? p.command.join(' ') : p.command); s.toolCalls++; return; }
      return;
    }
    case 'response_item': {
      const t = p.type;
      if (t === 'message') {
        const txt = textOf(p.content);
        if (p.role === 'user' && !s.firstUser && txt && !txt.startsWith('<')) s.firstUser = str(txt, 300);
        else if (p.role === 'assistant' && txt) { s.log = str(txt); s.lastMessage = str(txt, 400); }
        return;
      }
      if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') {
        const cmd = cmdOf(p);
        s.toolCalls++;
        if (s._turnOpen || s.state !== 'idle') { s.state = classifyTool(p.name || (t === 'local_shell_call' ? 'exec' : ''), cmd); }
        s.log = str((p.name && p.name !== 'exec' ? p.name + ' ' : '') + cmd) || s.log;
        return;
      }
      if (t === 'function_call_output' || t === 'custom_tool_call_output') {
        const out = String(p.output || '');
        if (/\b(error|exception|failed|Traceback)\b/i.test(out.slice(0, 400)) && /exit code [1-9]|non-zero|Traceback|Error:/.test(out.slice(0, 400))) { s.errors++; }
        return;
      }
      if (t === 'reasoning') { if (s._turnOpen) s.state = 'thinking'; return; }
      return;
    }
    default: return;
  }
}

// ── incremental reader ───────────────────────────────────────────────────────
const cache = new Map();   // path -> { offset, tail, session }
function readSession(file, sizeHint) {
  let c = cache.get(file);
  const st = (() => { try { return fs.statSync(file); } catch (_) { return null; } })();
  if (!st) { cache.delete(file); return null; }
  if (c && st.size < c.offset) c = null;          // truncated/rotated: start over
  if (!c) { c = { offset: 0, tail: '', session: newSession(path.basename(file).replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '').replace(/\.jsonl$/, '')) }; cache.set(file, c); }
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - c.offset;
      const buf = Buffer.alloc(Math.min(len, 64 * 1024 * 1024));
      let pos = c.offset, remaining = len;
      while (remaining > 0) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, remaining), pos);
        if (n <= 0) break;
        pos += n; remaining -= n;
        const chunk = c.tail + buf.toString('utf8', 0, n);
        const lines = chunk.split('\n');
        c.tail = lines.pop();
        for (const line of lines) { if (!line.trim()) continue; try { apply(c.session, JSON.parse(line)); } catch (_) {} }
      }
      c.offset = pos;
    } finally { fs.closeSync(fd); }
  }
  c.session.fileMtime = st.mtimeMs; c.session.fileSize = st.size; c.session.file = file;
  return c.session;
}
function parseLines(lines) { const s = newSession('inline'); for (const l of lines) { if (!l) continue; if (typeof l === 'string' && !l.trim()) continue; try { apply(s, typeof l === 'string' ? JSON.parse(l) : l); } catch (_) {} } return s; }

// ── cost ─────────────────────────────────────────────────────────────────────
// priceFor(model) -> { input, output, cacheRead } USD per million tokens, or null (= free, Gander's rule for unpriced models)
function cost(tokens, price) {
  if (!price || !tokens) return 0;
  const cached = Number(tokens.cached) || 0, input = Math.max(0, (Number(tokens.input) || 0) - cached), output = Number(tokens.output) || 0;
  const cr = price.cacheRead !== undefined ? price.cacheRead : (price.input || 0) * 0.1;
  return (input * (price.input || 0) + cached * cr + output * (price.output || 0)) / 1e6;
}

// ── optional sqlite extras (titles, goals, queued follow-ups) ────────────────
let sqliteMod = null, sqliteTried = false;
function sqlite() { if (!sqliteTried) { sqliteTried = true; try { sqliteMod = require('node:sqlite'); } catch (_) { sqliteMod = null; } } return sqliteMod; }
function openRo(p) { const m = sqlite(); if (!m || !fs.existsSync(p)) return null; try { return new m.DatabaseSync(p, { readOnly: true }); } catch (_) { return null; } }
let extrasCache = { at: 0, val: null };
function extras(home, maxAgeMs = 5000) {
  if (Date.now() - extrasCache.at < maxAgeMs && extrasCache.val) return extrasCache.val;
  const h = home || HOME();
  const val = { threads: new Map(), goals: [], queued: 0, available: false };
  const st = openRo(path.join(h, 'state_5.sqlite'));
  if (st) {
    val.available = true;
    try { for (const r of st.prepare('select id, title, model, git_branch, agent_nickname, tokens_used, archived, first_user_message, updated_at from threads').all()) val.threads.set(r.id, r); } catch (_) {}
    try { st.close(); } catch (_) {}
  }
  const g = openRo(path.join(h, 'goals_1.sqlite'));
  if (g) { try { val.goals = g.prepare('select thread_id, objective, status, tokens_used, token_budget, time_used_seconds, updated_at_ms from thread_goals').all(); } catch (_) {} try { g.close(); } catch (_) {} }
  const q = openRo(path.join(h, 'queue_1.sqlite'));
  if (q) { try { val.queued = Number(q.prepare('select count(*) c from queued_items').get().c) || 0; } catch (_) {} try { q.close(); } catch (_) {} }
  extrasCache = { at: Date.now(), val };
  return val;
}

// ── tick: turn live rollouts into agent events ───────────────────────────────
function projectOf(cwd) { const c = String(cwd || '').replace(/^\\\\\?\\/, ''); return path.basename(c) || 'codex'; }
function tick(opts = {}) {
  const now = opts.now || Date.now();
  const home = opts.home || HOME();
  const liveWindowMs = opts.liveWindowMs || 6 * 3600e3;
  const idleAfterMs = opts.idleAfterMs || 90e3;
  const ex = opts.extras === false ? null : extras(home);
  const events = [];
  for (const r of listRollouts(home, now - liveWindowMs)) {
    const s = readSession(r.path, r.size);
    if (!s || !s.cwd) continue;
    let state = s.state;
    // a turn that looks open but has gone quiet is idle (the rollout is append-only; a crash leaves it "open")
    if ((state === 'thinking' || state === 'coding' || state === 'reading' || state === 'testing' || state === 'searching' || state === 'spawning') && now - s.lastAt > idleAfterMs) state = 'idle';
    const th = ex && ex.threads.get(s.id);
    const price = opts.priceFor ? opts.priceFor(s.model || (th && th.model) || '') : null;
    const ev = {
      agentId: 'codex:' + s.id, root: true, tool: 'codex', name: projectOf(s.cwd), project: projectOf(s.cwd), cwd: String(s.cwd).replace(/^\\\\\?\\/, ''),
      state, log: s.log || (th && th.title ? str(th.title) : ''), model: s.model || (th && th.model) || '',
      goal: (th && th.title ? str(th.title, 200) : '') || s.firstUser || undefined,
      costUSD: cost(s.tokens, price), codex: { tokens: s.tokens, turns: s.turns, toolCalls: s.toolCalls, errors: s.errors, originator: s.originator, cliVersion: s.cliVersion, branch: th && th.git_branch || undefined, lastAt: s.lastAt, startedAt: s.startedAt, awaitMsg: s.awaitMsg || undefined, lastMessage: s.lastMessage || undefined },
    };
    events.push(ev);
  }
  return { events, queued: ex ? ex.queued : 0, goals: ex ? ex.goals : [], sqlite: !!(ex && ex.available), home };
}

// ── history/summary for the API (cheap: first line + stat per file) ─────────
function summary(opts = {}) {
  const home = opts.home || HOME();
  const now = opts.now || Date.now();
  const days = opts.days || 7;
  const list = listRollouts(home, now - days * 86400e3);
  const ex = opts.extras === false ? null : extras(home);
  const sessions = [];
  for (const r of list) {
    const s = readSession(r.path, r.size);   // cached after first read; live ones are already parsed
    if (!s) continue;
    const th = ex && ex.threads.get(s.id);
    const price = opts.priceFor ? opts.priceFor(s.model || (th && th.model) || '') : null;
    sessions.push({ id: s.id, project: projectOf(s.cwd), cwd: String(s.cwd).replace(/^\\\\\?\\/, ''), title: (th && th.title ? str(th.title, 140) : '') || s.firstUser, model: s.model || (th && th.model) || '', originator: s.originator, startedAt: s.startedAt, lastAt: s.lastAt, turns: s.turns, toolCalls: s.toolCalls, errors: s.errors, tokens: s.tokens, costUSD: cost(s.tokens, price), state: s.state, live: now - r.mtimeMs < (opts.liveWindowMs || 6 * 3600e3), file: r.path, sizeMB: Math.round(r.size / 1e5) / 10 });
  }
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const today = sessions.filter((s) => s.lastAt >= dayStart.getTime());
  const sum = (arr, f) => arr.reduce((n, x) => n + (f(x) || 0), 0);
  return {
    home, sqlite: !!(ex && ex.available), queued: ex ? ex.queued : 0, goals: ex ? ex.goals : [],
    sessions,
    totals: { sessions: sessions.length, today: today.length, tokensToday: sum(today, (s) => s.tokens.total), costToday: sum(today, (s) => s.costUSD), tokens: sum(sessions, (s) => s.tokens.total), costUSD: sum(sessions, (s) => s.costUSD) },
    byProject: Object.values(sessions.reduce((m, s) => { const k = s.project; m[k] = m[k] || { project: k, sessions: 0, tokens: 0, costUSD: 0 }; m[k].sessions++; m[k].tokens += s.tokens.total; m[k].costUSD += s.costUSD; return m; }, {})).sort((a, b) => b.tokens - a.tokens),
  };
}

module.exports = { HOME, listRollouts, parseLines, apply, newSession, classifyTool, cost, extras, tick, summary, readSession, _reset: () => { cache.clear(); extrasCache = { at: 0, val: null }; sqliteTried = false; sqliteMod = null; } };
