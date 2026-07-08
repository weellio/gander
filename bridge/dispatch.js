'use strict';
// Gander Dispatch — bridge-hosted Claude Code sessions (zero dependencies).
//
// Instead of opening a terminal window and typing into it, the bridge spawns
// `claude -p --input-format stream-json --output-format stream-json` and OWNS
// the session loop: replies go straight down stdin (instant, no window
// automation), permission prompts arrive as structured `control_request`
// lines (subtype can_use_tool) the dashboard can Allow/Deny, and turn results
// stream back with cost + rate-limit info. Runs on the user's own `claude`
// login — plan quota, no API key injected — exactly like typing in a terminal.
//
// Verified empirically against claude CLI 2.1.66 (see docs in README):
//   stdin  <- {type:'user', message:{role:'user', content:'...'}}
//   stdout -> system/init · assistant · user(tool_result) · result
//   stdout -> {type:'control_request', request_id, request:{subtype:'can_use_tool',
//              tool_name, input, permission_suggestions, tool_use_id}}
//   stdin  <- {type:'control_response', response:{subtype:'success', request_id,
//              response:{behavior:'allow', updatedInput} | {behavior:'deny', message}}}
//   stdout -> {type:'rate_limit_event', rate_limit_info:{rateLimitType:'five_hour', resetsAt, ...}}
//
// The pure line-classifier (handleLine) is separated from process management
// so it can be unit-tested without spawning the CLI.

const { spawn } = require('child_process');
const path = require('path');
const { stateForTool, detailForTool } = require('./parser.js');

// ── module state ─────────────────────────────────────────────────────────────
const sessions = new Map();          // sessionId -> sess (temp key until init arrives)
let reqSeq = 1;
let lastRateLimit = null;            // latest rate_limit_event seen on ANY dispatched session

// Wired by the server via init(): how dispatch talks back to the registry/alerts.
const hooks = {
  onEvent: () => {},                 // (ev) -> feed server upsert (same shape as /api/event)
  onPermission: () => {},            // (sess, perm) -> a can_use_tool arrived (alerting)
  onPermissionResolved: () => {},    // (sess, perm, behavior) -> answered / cancelled
  onRateLimit: () => {},             // (info) -> plan-quota telemetry
  onExit: () => {},                  // (sess) -> the CLI process ended
  log: (...a) => console.log(...a),
};
function init(h) { Object.assign(hooks, h || {}); }

function projectFromCwd(cwd) {
  const parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

function truncate(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── pure line classifier ─────────────────────────────────────────────────────
// Mutates sess bookkeeping (sessionId, busy, pending) and returns what the
// caller must do: registry events to apply, control responses to write back,
// and any permission / rate-limit / result signals.
function handleLine(sess, obj) {
  const out = { events: [], responses: [], permission: null, rateLimit: null, result: null };
  if (!obj || typeof obj !== 'object') return out;
  const base = () => ({
    agentId: 'sess:' + sess.sessionId, sessionId: sess.sessionId, cwd: sess.cwd,
    project: sess.project, root: true, name: sess.project, dispatch: true,
  });

  switch (obj.type) {
    case 'system': {
      if (obj.subtype === 'init') {
        if (obj.session_id) sess.sessionId = obj.session_id;
        if (obj.model) sess.model = obj.model;
        if (!sess.announced) {
          sess.announced = true;
          out.events.push({ ...base(), state: 'thinking', log: 'dispatched · ' + sess.project });
        }
      }
      break;
    }
    case 'assistant': {
      if (!sess.sessionId) break;
      const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_use') out.events.push({ ...base(), state: stateForTool(b.name, b.input), log: detailForTool(b.name, b.input) });
        else if (b.type === 'text' && b.text && b.text.trim()) out.events.push({ ...base(), state: 'thinking', lastMessage: truncate(b.text, 2000) });
      }
      break;
    }
    case 'user': {
      if (!sess.sessionId) break;
      const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
      for (const b of content) {
        if (b && b.type === 'tool_result' && b.is_error) {
          out.events.push({ ...base(), state: 'error', log: truncate(flatText(b.content), 100) || 'tool error' });
        }
      }
      break;
    }
    case 'control_request': {
      const r = obj.request || {};
      if (r.subtype === 'can_use_tool') {
        const perm = {
          requestId: obj.request_id,
          tool: r.tool_name || 'tool',
          input: r.input || {},
          detail: truncate(detailForTool(r.tool_name, r.input), 160),
          suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
          toolUseId: r.tool_use_id || null,
          ts: Date.now(),
        };
        sess.pending.set(perm.requestId, perm);
        out.permission = perm;
        out.events.push({ ...base(), state: 'awaiting', awaitMsg: `needs permission: ${perm.tool} ${perm.detail}`.trim(), log: 'permission: ' + perm.tool });
      } else {
        // Unknown control request — answer so the CLI never hangs on us.
        out.responses.push({ type: 'control_response', response: { subtype: 'error', request_id: obj.request_id, error: 'unsupported by Gander dispatch' } });
      }
      break;
    }
    case 'rate_limit_event': {
      if (obj.rate_limit_info) { out.rateLimit = obj.rate_limit_info; lastRateLimit = { ...obj.rate_limit_info, at: Date.now() }; }
      break;
    }
    case 'result': {
      sess.busy = false;
      sess.lastResult = { ok: !obj.is_error, costUSD: obj.total_cost_usd, turns: obj.num_turns, ms: obj.duration_ms, at: Date.now() };
      out.result = sess.lastResult;
      if (sess.sessionId) {
        out.events.push({
          ...base(), state: obj.is_error ? 'error' : 'idle',
          log: obj.is_error ? ('turn failed: ' + truncate(obj.result || obj.subtype, 80)) : 'turn complete (dispatch)',
          lastMessage: obj.result ? truncate(obj.result, 2000) : undefined,
        });
      }
      break;
    }
    default: break;
  }
  return out;
}

function flatText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' ? b.text || '' : String(b))).join(' ');
  return content.text || '';
}

// ── args builder (no user text ever rides in argv — prompts go via stdin) ────
function buildArgs({ resume, permMode } = {}) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
  if (permMode === 'bypass') args.push('--dangerously-skip-permissions');
  else if (permMode === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
  else if (permMode === 'plan') args.push('--permission-mode', 'plan');
  if (resume && /^[\w-]+$/.test(String(resume))) args.push('--resume', String(resume));
  return args;
}

// ── process management ───────────────────────────────────────────────────────
function writeLine(sess, obj) {
  try { if (sess.proc && sess.proc.stdin.writable) { sess.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } } catch (_) {}
  return false;
}

function applyOutcome(sess, out) {
  for (const ev of out.events) { try { hooks.onEvent(ev); } catch (_) {} }
  for (const resp of out.responses) writeLine(sess, resp);
  if (out.permission) { try { hooks.onPermission(sess, out.permission); } catch (_) {} }
  if (out.rateLimit) { try { hooks.onRateLimit(lastRateLimit); } catch (_) {} }
}

/**
 * Start a bridge-hosted session.
 * @param {object} o { cwd, prompt, resume?, permMode?, cli?, extraFlags? }
 * @returns {{ok:true, key:string}|{error:string}}
 */
function start(o) {
  const cwd = o && o.cwd;
  if (!cwd) return { error: 'cwd required' };
  const prompt = String((o && o.prompt) || '').trim();
  if (!prompt) return { error: 'dispatch needs a task — give it a goal (or launch a terminal session instead)' };
  if (o.resume && !/^[\w-]+$/.test(String(o.resume))) return { error: 'bad session id' };

  const rawCli = (o && o.cli && String(o.cli).trim()) || 'claude';
  const cliQ = (/\s/.test(rawCli) && !/^["']/.test(rawCli)) ? `"${rawCli}"` : rawCli;
  const args = buildArgs(o);
  // extraFlags is operator-set (Settings), validated upstream against shell metachars.
  const extra = (o && o.extraFlags ? String(o.extraFlags).replace(/[\r\n]+/g, ' ').trim() : '');
  const cmd = `${cliQ} ${args.join(' ')}${extra ? ' ' + extra : ''}`;

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_?CODE/i.test(k)) delete env[k];   // independent top-level session

  const key = 'dispatch-' + (reqSeq++);
  const sess = {
    key, sessionId: o.resume || null, cwd, project: projectFromCwd(cwd),
    proc: null, buf: '', pending: new Map(), busy: true, announced: false,
    startedAt: Date.now(), model: null, lastResult: null, exited: false,
  };

  let proc;
  try {
    // shell:true so the npm .cmd shim resolves on Windows; the command line holds
    // only bridge-built flags — the prompt goes over stdin as JSON, never argv.
    proc = spawn(cmd, { cwd, shell: true, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { return { error: e.message }; }
  sess.proc = proc;
  sessions.set(key, sess);

  proc.stdout.on('data', (d) => {
    sess.buf += d;
    let nl;
    while ((nl = sess.buf.indexOf('\n')) !== -1) {
      const line = sess.buf.slice(0, nl).trim();
      sess.buf = sess.buf.slice(nl + 1);
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
      const hadSid = !!sess.sessionId;
      const out = handleLine(sess, obj);
      // once the real session id is known, re-key the map so lookups by session id work
      if (!hadSid && sess.sessionId) sessions.set(sess.sessionId, sess);
      applyOutcome(sess, out);
    }
  });
  proc.stderr.on('data', (d) => { const s = String(d).trim(); if (s) hooks.log('[dispatch:' + (sess.sessionId || key).slice(0, 8) + '] ' + s.slice(0, 300)); });
  proc.on('error', (e) => { hooks.log('[dispatch] spawn error: ' + e.message); finish(sess, 'error: ' + e.message); });
  proc.on('exit', (code) => finish(sess, 'exited (' + code + ')'));

  writeLine(sess, { type: 'user', message: { role: 'user', content: prompt } });
  hooks.log(`[dispatch] started ${key} in ${cwd}${o.resume ? ' (resume ' + o.resume + ')' : ''}`);
  return { ok: true, key };
}

function finish(sess, why) {
  if (sess.exited) return;
  sess.exited = true; sess.busy = false;
  // cancel pending permissions so the dashboard doesn't offer dead buttons
  for (const perm of sess.pending.values()) { try { hooks.onPermissionResolved(sess, perm, 'cancelled'); } catch (_) {} }
  sess.pending.clear();
  if (sess.sessionId) {
    try { hooks.onEvent({ agentId: 'sess:' + sess.sessionId, sessionId: sess.sessionId, cwd: sess.cwd, project: sess.project, root: true, name: sess.project, dispatch: true, state: 'idle', closed: true, log: 'dispatch session ' + why }); } catch (_) {}
  }
  sessions.delete(sess.key);
  if (sess.sessionId) sessions.delete(sess.sessionId);
  try { hooks.onExit(sess); } catch (_) {}
  hooks.log(`[dispatch] ${sess.sessionId || sess.key} ${why}`);
}

function get(sessionId) { return sessions.get(String(sessionId)) || null; }
function isHosted(sessionId) { const s = get(sessionId); return !!(s && !s.exited); }

/** Send a user message straight down the session's stdin (instant delivery). */
function send(sessionId, text) {
  const sess = get(sessionId);
  if (!sess || sess.exited) return { error: 'not a dispatched session' };
  const t = String(text || '').trim();
  if (!t) return { error: 'empty message' };
  if (!writeLine(sess, { type: 'user', message: { role: 'user', content: t } })) return { error: 'session stdin not writable' };
  sess.busy = true;
  try { hooks.onEvent({ agentId: 'sess:' + sess.sessionId, sessionId: sess.sessionId, cwd: sess.cwd, project: sess.project, root: true, name: sess.project, dispatch: true, state: 'thinking', log: 'operator: ' + truncate(t, 60) }); } catch (_) {}
  return { ok: true, delivered: 'dispatch' };
}

/** Interrupt the current turn (the CLI equivalent of pressing Esc). */
function interrupt(sessionId) {
  const sess = get(sessionId);
  if (!sess || sess.exited) return { error: 'not a dispatched session' };
  writeLine(sess, { type: 'control_request', request_id: 'gander-int-' + (reqSeq++), request: { subtype: 'interrupt' } });
  return { ok: true };
}

/** End the session: close stdin (graceful), force-kill if it lingers. */
function stop(sessionId) {
  const sess = get(sessionId);
  if (!sess) return { error: 'not a dispatched session' };
  try { sess.proc.stdin.end(); } catch (_) {}
  setTimeout(() => { try { if (!sess.exited) sess.proc.kill(); } catch (_) {} }, 8000).unref();
  return { ok: true };
}

/** Answer a pending can_use_tool permission request. */
function answerPermission(sessionId, requestId, opts) {
  const sess = get(sessionId);
  if (!sess || sess.exited) return { error: 'not a dispatched session' };
  const perm = sess.pending.get(String(requestId));
  if (!perm) return { error: 'no such pending permission (already answered?)' };
  const behavior = opts && opts.behavior === 'allow' ? 'allow' : 'deny';
  const inner = behavior === 'allow'
    ? { behavior: 'allow', updatedInput: perm.input, ...(opts && opts.applySuggestions && perm.suggestions.length ? { updatedPermissions: perm.suggestions } : {}) }
    : { behavior: 'deny', message: String((opts && opts.message) || 'Denied by the operator from the Gander dashboard.') };
  if (!writeLine(sess, { type: 'control_response', response: { subtype: 'success', request_id: perm.requestId, response: inner } })) return { error: 'session stdin not writable' };
  sess.pending.delete(perm.requestId);
  try { hooks.onPermissionResolved(sess, perm, behavior); } catch (_) {}
  if (sess.sessionId) {
    try { hooks.onEvent({ agentId: 'sess:' + sess.sessionId, sessionId: sess.sessionId, cwd: sess.cwd, project: sess.project, root: true, name: sess.project, dispatch: true, state: 'thinking', log: (behavior === 'allow' ? '✓ allowed ' : '✕ denied ') + perm.tool }); } catch (_) {}
  }
  return { ok: true, behavior };
}

/** All pending permission requests across hosted sessions (for /api/state + /api/permissions). */
function pendingList() {
  const out = [];
  const seen = new Set();
  for (const sess of sessions.values()) {
    if (seen.has(sess.key) || sess.exited) continue;
    seen.add(sess.key);
    for (const p of sess.pending.values()) {
      out.push({ sessionId: sess.sessionId, project: sess.project, cwd: sess.cwd, requestId: p.requestId, tool: p.tool, detail: p.detail, input: p.input, suggestions: p.suggestions, ts: p.ts });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Summary of live hosted sessions (for /api/state). */
function list() {
  const out = [];
  const seen = new Set();
  for (const sess of sessions.values()) {
    if (seen.has(sess.key) || sess.exited) continue;
    seen.add(sess.key);
    out.push({ sessionId: sess.sessionId, key: sess.key, project: sess.project, cwd: sess.cwd, busy: sess.busy, model: sess.model, startedAt: sess.startedAt, pending: sess.pending.size, lastResult: sess.lastResult });
  }
  return out;
}

function rateLimit() { return lastRateLimit; }

// Never leave hidden claude processes behind when the bridge dies.
process.on('exit', () => { for (const s of sessions.values()) { try { if (!s.exited && s.proc) s.proc.kill(); } catch (_) {} } });

module.exports = {
  init, start, send, interrupt, stop, answerPermission,
  get, isHosted, pendingList, list, rateLimit,
  // exposed for unit tests (no CLI spawn needed)
  _test: { handleLine, buildArgs, projectFromCwd },
};
