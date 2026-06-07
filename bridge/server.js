#!/usr/bin/env node
// Agent Ops Center — minimal bridge server (zero dependencies).
//
// Serves the dashboard and exposes a tiny event API so an orchestrator
// (Claude Code, a script, or a human) can push agent lifecycle events that
// the dashboard renders live. The stream-json auto-parser (parser.js) will
// later POST to the same /api/event endpoint; for now events are pushed by hand.
//
//   node bridge/server.js --port 3131
//
// API:
//   GET  /api/state           -> { agents: [...] }   (dashboard polls this)
//   POST /api/event           -> upsert/remove an agent, body is JSON:
//        { agentId, name?, shirt?, state?, detail?, parentId?, log?, remove? }
//   POST /api/reset           -> clear the registry
//
// Static files are served from ../dashboard.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { createParser } = require('./parser.js');

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 3131;
})();

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const DIST_DIR = path.join(DASHBOARD_DIR, 'dist');
// Serve the built Svelte app from dashboard/dist when present; otherwise fall
// back to the legacy static dashboard. Lets the migration land incrementally.
function webRoot() {
  try { return fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : DASHBOARD_DIR; } catch (_) { return DASHBOARD_DIR; }
}

// ── In-memory agent registry ────────────────────────────────────────────────
/** @type {Map<string, object>} */
const agents = new Map();
const VALID_STATES = ['idle', 'thinking', 'coding', 'spawning', 'reading', 'error', 'testing', 'done'];

// Per-project mute list (the per-project "opt-in" control): hook events from a
// muted project are dropped. Persisted so the choice survives bridge restarts.
const MUTE_FILE = path.join(__dirname, 'aoc-mutes.json');
let muted = new Set();
try { muted = new Set(JSON.parse(fs.readFileSync(MUTE_FILE, 'utf8'))); } catch (_) {}
function saveMutes() { try { fs.writeFileSync(MUTE_FILE, JSON.stringify([...muted])); } catch (_) {} }

// Derive a friendly project name from a session's working directory.
function projectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

// ── Operator command queue ───────────────────────────────────────────────────
// The dashboard queues commands for a running session; they're delivered through
// the Claude Code hook RETURN CHANNEL: a 'message' is injected when the agent's
// Stop hook fires (decision:block), a 'stop' denies the next tool (PreToolUse).
const commands = new Map(); // sessionId -> [{ id, type, text, ts }]
let cmdSeq = 1;
function queueCommand(sessionId, type, text) {
  if (!sessionId) return { error: 'sessionId required' };
  if (!['message', 'stop'].includes(type)) return { error: 'type must be message|stop' };
  const q = commands.get(sessionId) || [];
  const cmd = { id: cmdSeq++, type, text: String(text || ''), ts: Date.now() };
  q.push(cmd);
  commands.set(sessionId, q);
  return { ok: true, queued: cmd };
}
function takeCommand(sessionId, predicate) {
  const q = commands.get(sessionId);
  if (!q || !q.length) return null;
  const i = q.findIndex(predicate);
  if (i === -1) return null;
  const [cmd] = q.splice(i, 1);
  if (!q.length) commands.delete(sessionId);
  return cmd;
}

function upsert(ev) {
  const id = String(ev.agentId);
  if (!id || id === 'undefined') return { error: 'agentId required' };

  if (ev.remove) {
    const cur = agents.get(id);
    if (cur && cur.root) {           // keep session roots; just return them to idle
      cur.state = 'idle'; cur.updatedAt = Date.now();
      return { ok: true, kept: id };
    }
    agents.delete(id);
    return { ok: true, removed: id };
  }

  const existing = agents.get(id) || { id, logLines: [], createdAt: Date.now() };
  if (ev.name !== undefined) existing.name = ev.name;
  if (ev.shirt !== undefined) existing.shirt = ev.shirt;
  if (ev.parentId !== undefined) existing.parentId = String(ev.parentId);
  if (ev.project !== undefined) existing.project = ev.project;
  if (ev.sessionId !== undefined) existing.sessionId = ev.sessionId;
  if (ev.root !== undefined) existing.root = ev.root;
  if (ev.detail !== undefined) existing.detail = ev.detail;
  if (ev.state !== undefined) {
    if (!VALID_STATES.includes(ev.state)) return { error: `invalid state: ${ev.state}` };
    existing.state = ev.state;
  }
  if (!existing.state) existing.state = 'idle';
  if (ev.log) {
    existing.logLines.unshift(String(ev.log));
    if (existing.logLines.length > 8) existing.logLines.pop();
  }
  existing.updatedAt = Date.now();
  agents.set(id, existing);
  return { ok: true, agent: existing };
}

function snapshot() {
  const list = Array.from(agents.values());
  const byProject = {};
  for (const a of list) {
    const pj = a.project || 'unknown';
    if (!byProject[pj]) byProject[pj] = { project: pj, total: 0, sessions: new Set(), states: {} };
    byProject[pj].total++;
    if (a.sessionId) byProject[pj].sessions.add(a.sessionId);
    byProject[pj].states[a.state] = (byProject[pj].states[a.state] || 0) + 1;
  }
  const projects = Object.values(byProject).map((p) => ({
    project: p.project, total: p.total, sessions: p.sessions.size, states: p.states, muted: muted.has(p.project),
  }));
  const pending = {};
  for (const [sid, q] of commands) if (q.length) pending[sid] = q.length;
  return { agents: list, projects, muted: [...muted], pending };
}

// ── Claude Code hook payload → registry events ───────────────────────────────
// Maps the raw JSON a Claude Code hook POSTs to /api/hook into agent updates,
// so the dashboard is driven automatically by real tool activity (no piping).
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function toolDetail(p) {
  const i = p.tool_input || {};
  if (i.file_path) return ' ' + String(i.file_path).split(/[\\/]/).pop();
  if (i.command) return ' ' + String(i.command).slice(0, 40);
  if (i.pattern) return ' /' + i.pattern + '/';
  if (i.description) return ' ' + String(i.description).slice(0, 40);
  return '';
}

function toolState(name, input) {
  if (!name) return 'thinking';
  if (/^(Read|Glob|LS|NotebookRead)$/.test(name)) return 'reading';
  if (/^(Grep|WebSearch|WebFetch)$/.test(name)) return 'reading';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return 'coding';
  if (name === 'Bash') {
    const c = ((input && input.command) || '').toLowerCase();
    return /\b(test|jest|pytest|vitest|mocha|go test|cargo test)\b/.test(c) ? 'testing' : 'coding';
  }
  if (name === 'Task') return 'spawning';
  if (/^mcp__/.test(name)) return 'reading';
  return 'thinking';
}

function mapHookToEvents(p) {
  const project = projectFromCwd(p.cwd);
  const sessionId = p.session_id || 'unknown';
  const rootId = 'sess:' + sessionId;              // each session is its own root node
  const sub = p.agent_id && p.agent_id !== p.session_id;
  const subId = 'agent:' + p.agent_id;
  const base = { project, sessionId };
  switch (p.hook_event_name) {
    case 'SessionStart':
      return [{ ...base, agentId: rootId, name: project, root: true, state: 'thinking', log: 'session started · ' + project }];
    case 'UserPromptSubmit':
      return [{ ...base, agentId: rootId, name: project, root: true, state: 'thinking', log: (p.prompt || 'new prompt').slice(0, 60) }];
    case 'PostToolUse': {
      const id = sub ? subId : rootId;
      const out = [];
      if (sub) out.push({ ...base, agentId: id, parentId: rootId, name: p.agent_type || ('sub-' + String(p.agent_id).slice(0, 6)) });
      else out.push({ ...base, agentId: id, root: true, name: project });
      out.push({ ...base, agentId: id, state: toolState(p.tool_name, p.tool_input), log: (p.tool_name || 'tool') + toolDetail(p) });
      return out;
    }
    case 'PostToolUseFailure': {
      const id = sub ? subId : rootId;
      const out = [];
      if (sub) out.push({ ...base, agentId: id, parentId: rootId, name: p.agent_type || ('sub-' + String(p.agent_id).slice(0, 6)) });
      else out.push({ ...base, agentId: id, root: true, name: project });
      out.push({ ...base, agentId: id, state: 'error', log: (p.tool_name || 'tool') + ' failed' });
      return out;
    }
    case 'SubagentStart':
      return [{ ...base, agentId: subId, parentId: rootId, name: p.agent_type || 'subagent', state: 'spawning', log: 'subagent started' }];
    case 'SubagentStop':
      return [{ ...base, agentId: subId, state: 'done', log: 'subagent finished' }];
    case 'Stop':
      return [{ ...base, agentId: rootId, root: true, name: project, state: 'idle', log: 'turn complete' }];
    case 'SessionEnd':
      return [{ ...base, agentId: rootId, root: true, name: project, state: 'idle', log: 'session ended' }];
    default:
      return [];
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  const base = webRoot();
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(base, path.normalize(rel));
  // prevent path traversal outside the web root
  if (!filePath.startsWith(base)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve(null); }
    });
  });
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  if (url === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, snapshot());
  }

  if (url === '/api/event' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    const result = upsert(body);
    const code = result.error ? 400 : 200;
    if (!result.error) {
      console.log(`[event] ${body.agentId} -> ${body.state || '(meta)'}${body.log ? '  «' + body.log + '»' : ''}`);
    }
    return sendJson(res, code, result);
  }

  if (url === '/api/hook' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    const project = projectFromCwd(body.cwd);
    if (muted.has(project)) return sendJson(res, 200, { ok: true, muted: project, applied: 0 });
    const evs = mapHookToEvents(body);
    for (const ev of evs) upsert(ev);
    if (evs.length) console.log(`[hook] ${body.hook_event_name} (${project}) -> ${evs.map(e => e.agentId + ':' + (e.state || '')).join(', ')}`);

    // Deliver any queued operator command through the hook return channel.
    let deliver = null;
    const sid = body.session_id;
    if (sid) {
      if (body.hook_event_name === 'Stop') {
        const c = takeCommand(sid, (x) => x.type === 'message');
        if (c) deliver = { kind: 'stop-block', text: c.text };
      } else if (body.hook_event_name === 'PreToolUse') {
        const c = takeCommand(sid, (x) => x.type === 'stop');
        if (c) deliver = { kind: 'pretool-deny', text: c.text || 'The operator requested STOP. Stop running tools, end your turn, and wait for further instructions.' };
      }
    }
    if (deliver) console.log(`[deliver] ${sid} <- ${deliver.kind}`);
    return sendJson(res, 200, { ok: true, applied: evs.length, deliver });
  }

  if (url === '/api/mute' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.project) return sendJson(res, 400, { error: 'project required' });
    const unmute = body.muted === false;
    if (unmute) muted.delete(body.project); else muted.add(body.project);
    saveMutes();
    // When muting, drop that project's existing tiles so it leaves the grid immediately.
    if (!unmute) for (const [k, a] of agents) if ((a.project || 'unknown') === body.project) agents.delete(k);
    console.log(`[mute] ${body.project} -> ${unmute ? 'unmuted' : 'muted'}`);
    return sendJson(res, 200, { ok: true, muted: [...muted] });
  }

  if (url === '/api/command' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON' });
    const r = queueCommand(body.sessionId, body.type || 'message', body.text);
    if (!r.error) console.log(`[command] ${body.sessionId} <- ${body.type || 'message'}: ${String(body.text || '').slice(0, 60)}`);
    return sendJson(res, r.error ? 400 : 200, r);
  }

  if (url === '/api/reset' && req.method === 'POST') {
    agents.clear();
    console.log('[reset] registry cleared');
    return sendJson(res, 200, { ok: true });
  }

  return serveStatic(req, res);
});

server.listen(argPort, () => {
  console.log(`Agent Ops Center bridge listening on http://localhost:${argPort}`);
  console.log(`Dashboard:  http://localhost:${argPort}/`);
  console.log(`Push event: POST http://localhost:${argPort}/api/event`);
  startIngest();
});

// ── Optional inline ingest ───────────────────────────────────────────────────
// Feed Claude Code stream-json straight into the registry (no HTTP round-trip),
// so a single process both serves the dashboard AND ingests live events:
//   node bridge/server.js --run "claude -p '...' --output-format stream-json --verbose"
//   claude ... --output-format stream-json --verbose | node bridge/server.js --stdin
function startIngest() {
  const runIdx = process.argv.indexOf('--run');
  const useStdin = process.argv.includes('--stdin');
  if (runIdx === -1 && !useStdin) return;

  const parser = createParser();
  const feed = (line) => {
    let events = [];
    try { events = parser.parse(line); } catch (e) { console.error('[ingest] parse error:', e.message); }
    for (const ev of events) {
      const r = upsert(ev);
      if (!r.error) console.log(`[ingest] ${ev.agentId} -> ${ev.state || '(meta)'}`);
    }
  };

  let source;
  if (runIdx !== -1) {
    const cmd = process.argv[runIdx + 1];
    if (!cmd) { console.error('[ingest] --run needs a command string'); return; }
    console.log(`[ingest] spawning: ${cmd}`);
    const child = spawn(cmd, { shell: true, env: { ...process.env, CLAUDECODE: '' } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => console.log(`[ingest] child exited (code ${code})`));
    source = child.stdout;
  } else {
    console.log('[ingest] reading stream-json from stdin');
    source = process.stdin;
  }

  readline.createInterface({ input: source }).on('line', feed);
}
